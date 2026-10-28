// probe-overlay.mjs — 打开第一张卡片的简历浮层，定位「收藏」控件并截图（只读，不点收藏）
import fs from 'node:fs'
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const NAV = 'https://www.zhipin.com/web/chat/recommend'

const list = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
let id = 0
const p = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } })
const send = (m, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params })) })
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')

const tree = async () => { const { result } = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) })(result.frameTree); return out }
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

// 若已有浮层先关掉
if ((await tree()).some(f => /c-resume/.test(f.url))) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(800)
}

let fr = (await tree()).find(f => /web\/frame\/recommend\//.test(f.url))
if (!fr) { console.log('navigate…'); await send('Page.navigate', { url: NAV + '?t=' + Date.now() }); await sleep(12000); fr = (await tree()).find(f => /web\/frame\/recommend\//.test(f.url)) }
if (!fr) { console.log('no recommend frame'); process.exit(1) }

let off = null
for (let i = 0; i < 20 && !off; i++) {
  off = (await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height}})()` })).result.value
  if (!off) { await sleep(1200); fr = (await tree()).find(f => /web\/frame\/recommend\//.test(f.url)) || fr }
}
if (!off) { console.log('no iframe offset after 24s'); process.exit(1) }
const w1 = (await send('Page.createIsolatedWorld', { frameId: fr.id, worldName: 'ov' })).result.executionContextId
let rect = null
for (let i = 0; i < 10 && !rect; i++) {
  rect = (await send('Runtime.evaluate', { contextId: w1, returnByValue: true, expression: `(()=>{const c=document.querySelectorAll('.candidate-card-wrap')[0];if(!c)return null;c.scrollIntoView({block:'center'});const n=c.querySelector('a,[class*="name"],h3,[class*="geek-name"]')||c;const b=n.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height,txt:(c.innerText||'').replace(/\\s+/g,' ').slice(0,60)}})()` })).result.value
  if (!rect) await sleep(1200)
}
if (!rect) { console.log('no card after wait'); process.exit(1) }
console.log('offset', JSON.stringify(off), '\ncard', JSON.stringify(rect))
const cx = off.x + rect.x + Math.min(rect.w * 0.5, 160), cy = off.y + rect.y + Math.min(rect.h * 0.5, 22)
await click(cx, cy)
let ov = null
for (let i = 0; i < 20; i++) { await sleep(500); ov = (await tree()).find(f => /c-resume/.test(f.url)); if (ov) break }
console.log('overlay frame:', ov ? ov.id : 'NOT OPEN')
if (!ov) process.exit(1)

const w2 = (await send('Page.createIsolatedWorld', { frameId: ov.id, worldName: 'ov2' })).result.executionContextId
const dump = (await send('Runtime.evaluate', {
  contextId: w2, returnByValue: true, expression: `(() => {
  const out = [];
  document.querySelectorAll('*').forEach(e => {
    const t = (e.textContent || '').replace(/\\s+/g, '').trim();
    if (!t || t.length > 12) return;
    if (!/^(收藏|已收藏|取消收藏|打招呼|联系Ta|立即沟通|关闭|下载|分享)$/.test(t)) return;
    const b = e.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return;
    out.push({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 50), text: t, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) });
  });
  return JSON.stringify({ bodyLen: document.body.innerText.length, hits: out.slice(0, 30) });
})()` })).result.value
console.log('\n--- overlay 内部命中 ---\n' + dump)

// 顶层文档里也找一遍（浮层可能渲染在顶层）
const topDump = (await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
  const out = [];
  document.querySelectorAll('*').forEach(e => {
    const t = (e.textContent || '').replace(/\\s+/g, '').trim();
    if (!t || t.length > 12) return;
    if (!/^(收藏|已收藏|取消收藏|打招呼|联系Ta)$/.test(t)) return;
    const b = e.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return;
    out.push({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 50), text: t, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) });
  });
  return JSON.stringify({ clientWidth: document.documentElement.clientWidth, hits: out.slice(0, 30) });
})()` })).result.value
console.log('\n--- 顶层文档命中 ---\n' + topDump)

const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 })
fs.writeFileSync('C:\\Users\\<you>\\boss-work\\overlay.png', Buffer.from(shot.data, 'base64'))
console.log('\nscreenshot -> C:\\Users\\<you>\\boss-work\\overlay.png')
ws.close()
