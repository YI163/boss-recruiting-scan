// probe-overlay2.mjs — 等页面真正稳定后打开浮层，截图并找「收藏」控件（不点任何东西）
import fs from 'node:fs'
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const NAV = 'https://www.zhipin.com/web/chat/recommend'

const list = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
let id = 0
const p = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } })
const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')

const tree = async () => { const { result } = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) })(result.frameTree); return out }
const topEval = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const OFFSET_EXPR = `(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height}})()`

// 关掉可能开着的浮层
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(600)

// 等页面稳定：offset 两次一致 + 卡片数两次一致
let off = null, lastOff = '', lastCards = -1, stable = 0, rf = null
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  rf = (await tree()).find(f => /web\/frame\/recommend\//.test(f.url))
  off = await topEval(OFFSET_EXPR)
  if (!rf || !off) { stable = 0; lastOff = ''; continue }
  const w = (await send('Page.createIsolatedWorld', { frameId: rf.id, worldName: 'ov' + i })).result.executionContextId
  const n = (await send('Runtime.evaluate', { contextId: w, returnByValue: true, expression: 'document.querySelectorAll(".candidate-card-wrap").length' })).result?.result?.value
  const sig = JSON.stringify(off)
  if (n > 0 && sig === lastOff && n === lastCards) { if (++stable >= 2) break } else { stable = 0 }
  lastOff = sig; lastCards = n
}
console.log('stable. offset=', JSON.stringify(off), 'cards=', lastCards)
if (!off) process.exit(1)

const w = (await send('Page.createIsolatedWorld', { frameId: rf.id, worldName: 'rect' })).result.executionContextId
const rect = (await send('Runtime.evaluate', { contextId: w, returnByValue: true, expression: `(()=>{const c=document.querySelectorAll('.candidate-card-wrap')[0];c.scrollIntoView({block:'center'});const n=c.querySelector('a,[class*="name"],h3,[class*="geek-name"]')||c;const b=n.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height,txt:(n.innerText||'').slice(0,40)}})()` })).result?.result?.value
await sleep(500)
const cx = off.x + rect.x + Math.min(rect.w * 0.5, 160), cy = off.y + rect.y + Math.min(rect.h * 0.5, 22)
console.log('card:', JSON.stringify(rect), '-> click', cx.toFixed(0), cy.toFixed(0))
await click(cx, cy)
let ov = null
for (let i = 0; i < 20; i++) { await sleep(500); ov = (await tree()).find(f => /c-resume/.test(f.url)); if (ov) break }
console.log('overlay:', ov ? 'OPEN' : 'NOT OPEN')
if (ov) {
  const ow = (await send('Page.createIsolatedWorld', { frameId: ov.id, worldName: 'ovinner' })).result.executionContextId
  const hits = (await send('Runtime.evaluate', {
    contextId: ow, returnByValue: true, expression: `(() => {
    const out = [];
    document.querySelectorAll('*').forEach(e => {
      const t = (e.textContent || '').replace(/\\s+/g, '').trim();
      if (!t || t.length > 10) return;
      if (!/^(收藏|已收藏|取消收藏)$/.test(t)) return;
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height) return;
      out.push({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 60), text: t, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) });
    });
    return JSON.stringify(out);
  })()` })).result?.result?.value
  console.log('overlay 收藏 hits:', hits)
}
const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 })
fs.writeFileSync('C:\\Users\\<you>\\boss-work\\overlay.png', Buffer.from(shot.data, 'base64'))
console.log('shot -> overlay.png')
ws.close()
