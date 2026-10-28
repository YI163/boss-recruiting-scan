// probe-close3.mjs — 用真实鼠标事件（Input.dispatchMouseEvent）点面板右上角 X，看能否关闭
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const page = pages.find(p => /zhipin/.test(p.url)) || pages[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (m, p = {}, tmo = 20000) => Promise.race([
  new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }),
  sleep(tmo).then(() => ({ timeout: true }))
])
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')
const tree = async () => { const r = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) })(r.result.frameTree); return out }
const world = async fid => (await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'k' + Math.random().toString(36).slice(2, 6) })).result?.executionContextId
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, awaitPromise: true, expression: expr })).result?.result?.value
const recId = async () => (await tree()).find(f => /web\/frame\/recommend\//.test(f.url))?.id

async function clickAt (x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const st = async () => { const ctx = await world(await recId()); return await ev(ctx, `JSON.stringify((()=>{const q=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {y:Math.round(b.top),hit:(()=>{const el=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return !!el&&(el===e||e.contains(el))})()}};return {fav:q('.like-icon-and-text'),close:q('.close-btn'),txt:(document.querySelector('.like-icon-and-text')||{}).innerText}})())`) }

console.log('state:', await st())
// 顶层 iframe 偏移
const off = await ev(await world((await tree())[0].id), `(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top}})()`)
console.log('iframe offset:', off)
const ctx = await world(await recId())
const r = await ev(ctx, `(()=>{const e=document.querySelector('.close-btn');if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`)
console.log('close center (frame-local):', r)
if (off && r) {
  const ax = off.x + r.x, ay = off.y + r.y
  console.log('absolute:', ax, ay)
  await clickAt(ax, ay)
  await sleep(1200)
  console.log('after real click:', await st())
}
ws.close()
