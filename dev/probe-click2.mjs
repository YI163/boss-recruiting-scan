// probe-click2.mjs — 测量：导航后 9s 点击姓名元素，overlay 多久出现；再测第二次点击是否会关掉它
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const NAV = 'https://www.zhipin.com/web/chat/recommend'

const list = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const target = list[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')
const frames = async () => { const { result } = await send('Page.getFrameTree'); const out = []; const w = n => { out.push(n.frame.url); (n.childFrames || []).forEach(w) }; w(result.frameTree); return out }
const overlayOpen = async () => (await frames()).some(u => /c-resume/.test(u))
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

console.log('navigate…')
await send('Page.navigate', { url: NAV + '?t=' + Date.now() })
await sleep(9000)
let tree = await send('Page.getFrameTree')
let rf = null
;(function walk(n) { if (!rf && /web\/frame\/recommend\//.test(n.frame.url)) rf = n.frame.id; (n.childFrames || []).forEach(walk) })(tree.result.frameTree)
if (!rf) { console.log('no frame, urls:', await frames()); process.exit(1) }

const off = (await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top}})()` })).result.value
const w = (await send('Page.createIsolatedWorld', { frameId: rf, worldName: 'p2' })).result.executionContextId
const rect = (await send('Runtime.evaluate', { contextId: w, returnByValue: true, expression: `(()=>{const c=document.querySelectorAll('.candidate-card-wrap')[0];if(!c)return null;c.scrollIntoView({block:'center'});const n=c.querySelector('a,[class*="name"],h3,[class*="geek-name"]')||c;const b=n.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height}})()` })).result.value
console.log('offset', JSON.stringify(off), 'rect', JSON.stringify(rect))
const cx = off.x + rect.x + Math.min(rect.w * 0.5, 160)
const cy = off.y + rect.y + Math.min(rect.h * 0.5, 22)
console.log(`click #1 @ (${cx.toFixed(0)}, ${cy.toFixed(0)})`)

const t0 = Date.now()
await click(cx, cy)
let openedAt = null
for (let i = 0; i < 20; i++) {
  await sleep(300)
  if (await overlayOpen()) { openedAt = Date.now() - t0; break }
}
console.log('overlay after click#1:', openedAt === null ? 'NOT OPEN in 6s' : `${openedAt}ms`)

await sleep(1200)
console.log('still open before click#2:', await overlayOpen())
await click(cx, cy)
await sleep(1500)
console.log('after click#2 same coords:', await overlayOpen())
console.log('frames now:'); (await frames()).forEach(u => console.log('   ', u.slice(0, 110)))
ws.close()
