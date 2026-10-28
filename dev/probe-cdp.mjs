// probe-cdp.mjs — 连 9333 调试实例，核对登录身份 + 推荐牛人页是否可采（只读，无点击）
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const NAV = 'https://www.zhipin.com/web/chat/recommend'

const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.filter(t => t.type === 'page').find(p => /zhipin\.com/.test(p.url)) || list.filter(t => t.type === 'page')[0]
if (!target) { console.error('no page target'); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise(res => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable')
await send('Runtime.enable')

async function evalTop(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.error) return { error: r.error }
  return r.result?.result?.value
}

console.log('initial url:', await evalTop('location.href'))
await send('Page.navigate', { url: NAV + '?t=' + Date.now() })
for (let i = 0; i < 20; i++) { await sleep(1000); await send('Page.getFrameTree') }

const tree = await send('Page.getFrameTree')
const flat = []
;(function walk(node, depth) {
  flat.push({ id: node.frame.id, url: node.frame.url, depth })
  for (const c of node.childFrames || []) walk(c, depth + 1)
})(tree.result.frameTree, 0)

console.log('\n--- frames ---')
flat.forEach(f => console.log(`${'  '.repeat(f.depth)}${f.id.slice(0, 8)} ${f.url.slice(0, 120)}`))

const rf = flat.find(f => /web\/frame\/recommend/.test(f.url))
console.log('\nrecommend frame:', rf ? rf.id : '(none)')

const top = await evalTop(`(()=>{
  const t = document.body.innerText.replace(/\\s+/g,' ').trim();
  return JSON.stringify({
    href: location.href,
    head: t.slice(0,120),
    hasLoginWord: /登录|注册/.test(t.slice(0,200)),
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight
  })
})()`)
console.log('\n--- top ---\n' + top)

if (rf) {
  const world = await send('Page.createIsolatedWorld', { frameId: rf.id, worldName: 'probe' })
  const ctxId = world.result?.executionContextId
  const r = await send('Runtime.evaluate', {
    contextId: ctxId,
    returnByValue: true,
    awaitPromise: true,
    expression: `(()=>{
      const cards = Array.from(document.querySelectorAll('.candidate-card-wrap'));
      const rect = (()=>{ const ifr = Array.from(document.querySelectorAll('iframe'))[0]; const r = ifr?.getBoundingClientRect(); return r ? {x:r.x,y:r.y,w:r.width,h:r.height} : null })();
      return JSON.stringify({
        readyState: document.readyState,
        bodyLen: (document.body.innerText||'').length,
        text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,200),
        cards: cards.length,
        first: cards[0] ? (cards[0].innerText||'').replace(/\\s+/g,' ').slice(0,160) : null,
        tabs: Array.from(document.querySelectorAll('*')).filter(e=>/^(推荐|精选|最新)$/.test((e.textContent||'').trim())&&e.children.length===0).map(e=>{const r=e.getBoundingClientRect();return {t:e.textContent.trim(),x:Math.round(r.x),y:Math.round(r.y)}}).slice(0,6)
      })
    })()`
  })
  console.log('\n--- recommend frame ---\n' + (r.result?.result?.value ?? JSON.stringify(r.error || r.result)))
}
ws.close()
