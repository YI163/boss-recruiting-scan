// fav-once.mjs — 用「元素定位 + DOM.getFrameOwner/getBoxModel 精确偏移 + 命中测试」替代坐标猜测
// 目标：1) 打印推荐页/浮层的帧关系与偏移；2) 找到浮层里真正的「收藏」控件；3) 按元素中心点击并自校验
import fs from 'node:fs'
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const page = pages.find(p => /zhipin\.com\/web\/(chat|frame)/.test(p.url)) || pages[0]
console.log('page:', page.url)
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable')

// 帧树（含父子关系）
const tree = await send('Page.getFrameTree')
const frames = new Map() // id -> {url, parent}
;(function walk(node, parent) {
  frames.set(node.frame.id, { url: node.frame.url, parent })
  ;(node.childFrames || []).forEach(c => walk(c, node.frame.id))
})(tree.result.frameTree, null)

// 帧相对父文档的偏移（用 DOM.getFrameOwner + getBoxModel 的 content quad，精确到内容盒）
const offsetCache = new Map()
async function frameOffset(frameId) {
  if (offsetCache.has(frameId)) return offsetCache.get(frameId)
  const f = frames.get(frameId)
  if (!f || !f.parent) { offsetCache.set(frameId, { x: 0, y: 0 }); return { x: 0, y: 0 } }
  const owner = await send('DOM.getFrameOwner', { frameId })
  if (owner.error) { offsetCache.set(frameId, { x: 0, y: 0 }); return { x: 0, y: 0 } }
  const nodeId = owner.result.backendNodeId
  const box = await send('DOM.getBoxModel', { backendNodeId: nodeId })
  const q = box.result?.model?.content || box.result?.model?.border
  const parentOff = await frameOffset(f.parent)
  const off = { x: parentOff.x + q[0], y: parentOff.y + q[1] }
  offsetCache.set(frameId, off)
  return off
}

async function world(frameId, name) {
  const r = await send('Page.createIsolatedWorld', { frameId, worldName: name })
  return r.result.executionContextId
}
const evalIn = async (ctx, expression) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, awaitPromise: true, expression })).result?.result?.value
const evalTop = async expression => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression })).result?.result?.value

// 等推荐帧 + 卡片稳定（两帧同一 rect）
let rfId = null, rfOff = null, cardSig = ''
for (let i = 0; i < 40; i++) {
  const rec = [...frames.entries()].find(([, v]) => /web\/frame\/recommend\//.test(v.url))
  if (rec) {
    rfId = rec[0]
    const off = await frameOffset(rfId)
    const ctx = await world(rfId, 'stab' + i)
    const sig = await evalIn(ctx, `(()=>{const c=document.querySelectorAll('.candidate-card-wrap');if(!c.length)return '0';const b=c[0].getBoundingClientRect();return c.length+':'+Math.round(b.x)+','+Math.round(b.y)+','+Math.round(b.width)})()`)
    if (sig && sig !== '0' && sig === cardSig && off) { rfOff = off; break }
    cardSig = sig || ''
  }
  await sleep(1000)
}
if (!rfId || !rfOff) { console.log('recommend frame / cards not stable'); process.exit(1) }
console.log('recommend frame:', rfId, 'offset', JSON.stringify(rfOff), 'cards sig', cardSig)

// 找第一张卡片的可点元素（姓名行），并按元素中心点击
const rfCtx = await world(rfId, 'pick')
const card = await evalIn(rfCtx, `(() => {
  const c = document.querySelectorAll('.candidate-card-wrap')[0];
  if (!c) return null;
  c.scrollIntoView({block:'center'});
  const row = c.querySelector('.row.name-wrap') || c.querySelector('.name-wrap') || c;
  const b = row.getBoundingClientRect();
  const cx = b.left + Math.min(60, b.width/2), cy = b.top + b.height/2;
  const hit = document.elementFromPoint(cx, cy);
  return JSON.stringify({cx:Math.round(cx), cy:Math.round(cy), w:Math.round(b.width), h:Math.round(b.height),
    hitTag: hit && hit.tagName, hitCls: hit && (hit.className||'').toString().slice(0,50),
    hitInside: !!(hit && (hit===row || row.contains(hit) || hit.contains(row))),
    txt:(c.innerText||'').replace(/\\s+/g,' ').slice(0,50)});
})()`)
console.log('card:', card)
const cd = JSON.parse(card)
await sleep(300)
const px = Math.round(rfOff.x + cd.cx), py = Math.round(rfOff.y + cd.cy)
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}
await clickAt(px, py)
console.log('clicked card at', px, py)

let ovId = null
for (let i = 0; i < 20; i++) {
  await sleep(500)
  const r = await send('Page.getFrameTree')
  const found = []
  ;(function walk(n) { if (/c-resume/.test(n.frame.url)) found.push(n.frame.id); (n.childFrames || []).forEach(walk) })(r.result.frameTree)
  if (found.length) { ovId = found[0]; break }
}
if (!ovId) { console.log('overlay frame not found'); ws.close(); process.exit(2) }
const ovOff = await frameOffset(ovId)
console.log('overlay frame:', ovId, 'offset', JSON.stringify(ovOff))

const ovCtx = await world(ovId, 'ovdump')
console.log('overlay text:', await evalIn(ovCtx, `(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)`))
const hits = await evalIn(ovCtx, `(() => {
  const out = [];
  document.querySelectorAll('*').forEach(e => {
    const t = (e.textContent||'').replace(/\\s+/g,'');
    if (!/^(收藏|已收藏|取消收藏|收藏简历)$/.test(t)) return;
    const b = e.getBoundingClientRect();
    if (!b.width || !b.height) return;
    const cx = b.left + b.width/2, cy = b.top + b.height/2;
    const hit = document.elementFromPoint(cx, cy);
    out.push({tag:e.tagName, cls:(e.className||'').toString().slice(0,60), text:t,
      x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height),
      cx:Math.round(cx), cy:Math.round(cy), selfHit: !!(hit && (hit===e || e.contains(hit))),
      hitCls: hit ? (hit.className||'').toString().slice(0,40) : null});
  });
  return JSON.stringify(out);
})()`)
console.log('收藏 candidates:', hits)
fs.writeFileSync('C:\\Users\\<you>\\boss-work\\overlay-dump.json', String(hits))
const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 })
fs.writeFileSync('C:\\Users\\<you>\\boss-work\\overlay.png', Buffer.from(shot.data, 'base64'))
console.log('screenshot -> overlay.png')
ws.close()
