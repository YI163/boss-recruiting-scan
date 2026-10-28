// probe-click.mjs — 诊断：点第一张卡片的姓名元素会发生什么（只读，不点打招呼）
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function targets() { return (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page') }

const list = await targets()
const target = list.find(p => /zhipin\.com/.test(p.url)) || list[0]
console.log('target:', target.title, '|', target.url)

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')

const tree = await send('Page.getFrameTree')
const flat = []
;(function walk(n) { flat.push({ id: n.frame.id, url: n.frame.url }); for (const c of n.childFrames || []) walk(c) })(tree.result.frameTree)
const rf = flat.find(f => /web\/frame\/recommend/.test(f.url))
console.log('recommend frame:', rf ? rf.id : 'NONE')
if (!rf) process.exit(1)

const world = await send('Page.createIsolatedWorld', { frameId: rf.id, worldName: 'probeclick' })
const ctx = world.result.executionContextId
const evIn = async expr => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, awaitPromise: true, expression: expr })).result?.result?.value

const off = await (async () => {
  const r = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height, dpr: window.devicePixelRatio}})()`
  })
  return r.result?.result?.value
})()
console.log('iframe offset:', JSON.stringify(off))

const info = await evIn(`(()=>{
  const c = document.querySelectorAll('.candidate-card-wrap')[0];
  if (!c) return null;
  c.scrollIntoView({block:'center'});
  const n = c.querySelector('a,[class*="name"],h3,[class*="geek-name"]') || c;
  const b = n.getBoundingClientRect();
  const cb = c.getBoundingClientRect();
  const chain = [];
  let e = n; let d = 0;
  while (e && d < 4) { chain.push(e.tagName + '.' + (e.className||'').toString().slice(0,40)); e = e.parentElement; d++ }
  return JSON.stringify({
    nameTag: n.tagName, nameCls: (n.className||'').toString(), nameTxt: (n.innerText||'').slice(0,40),
    rect: {x:b.left,y:b.top,w:b.width,h:b.height},
    cardRect: {x:cb.left,y:cb.top,w:cb.width,h:cb.height},
    chain,
    cardHref: c.querySelector('a[href]') ? c.querySelector('a[href]').getAttribute('href') : null,
    innerA: Array.from(c.querySelectorAll('a')).map(a=>a.getAttribute('href')).slice(0,4)
  })
})()`)
console.log('card/name info:', info)

const parse = JSON.parse(info)
// 策略 A：点姓名元素中心
const ax = off.x + parse.rect.x + parse.rect.w * 0.5
const ay = off.y + parse.rect.y + Math.min(parse.rect.h, 22) * 0.5
console.log(`\n[A] click name @ (${ax.toFixed(0)}, ${ay.toFixed(0)})`)
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: ax, y: ay, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
  await sleep(60)
}
await sleep(2600)

const tree2 = await send('Page.getFrameTree')
const flat2 = []
;(function walk(n) { flat2.push({ id: n.frame.id, url: n.frame.url }); for (const c of n.childFrames || []) walk(c) })(tree2.result.frameTree)
console.log('frames after clickA:')
flat2.forEach(f => console.log('   ', f.url.slice(0, 140)))
const tg2 = await targets()
console.log('page targets:', tg2.map(t => `${t.title} | ${t.url.slice(0, 90)}`))
ws.close()
