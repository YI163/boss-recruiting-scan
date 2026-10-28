// probe-open-close.mjs — 单步：开第一张卡 → 用真实鼠标点右上角 X（绝对坐标）→ 报告是否关闭
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
const topId = async () => { const r = await send('Page.getFrameTree'); return r.result.frameTree.frame.id }
const tree = async () => { const r = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) })(r.result.frameTree); return out }
const world = async fid => (await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'k' + Math.random().toString(36).slice(2, 6) })).result?.executionContextId
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, awaitPromise: true, expression: expr })).result?.result?.value
const recId = async () => (await tree()).find(f => /web\/frame\/recommend\//.test(f.url))?.id
const snap = async () => {
  const rid = await recId(); if (!rid) return 'no-recommend-frame'
  const ctx = await world(rid)
  return await ev(ctx, `JSON.stringify((()=>{const q=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)}};return {fav:q('.like-icon-and-text'),close:q('.close-btn'),favTxt:(document.querySelector('.like-icon-and-text')||{}).innerText||''}})())`)
}
async function realClick (x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

console.log('url:', page.url, '| before:', await snap())
const rid = await recId()
let ctx = await world(rid)
// 开第一张卡（元素点击，安全：只是打开简历面板）
console.log('open card:', await ev(ctx, `(()=>{const n=document.querySelector('.row.name-wrap');if(!n)return 'no-name';n.click();return 'ok'})()`))
await sleep(1500)
console.log('after open:', await snap())

// 绝对坐标 = 顶层 iframe 偏移 + 帧内 X 中心
const tctx = await world(await topId())
const off = await ev(tctx, `(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top}})()`)
ctx = await world(await recId())
const c = await ev(ctx, `(()=>{const e=document.querySelector('.close-btn');if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`)
console.log('iframe offset:', off, 'close center:', c)
if (off && c) {
  const ax = Math.round(off.x + c.x), ay = Math.round(off.y + c.y)
  console.log('--- 单次真实点击', ax, ay, '---')
  await realClick(ax, ay)
  await sleep(1200)
  console.log('after click X:', await snap())
}
ws.close()
