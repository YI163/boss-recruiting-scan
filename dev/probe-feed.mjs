// probe-feed.mjs — 回到推荐流：导航 → 开卡片 → 真实点击 X → 报状态（单次点击）
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const page = pages.find(p => /zhipin/.test(p.url)) || pages[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (m, p = {}, tmo = 25000) => Promise.race([
  new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }),
  sleep(tmo).then(() => ({ timeout: true }))
])
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')
const tree = async () => { const r = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) })(r.result.frameTree); return out }
const world = async fid => (await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'k' + Math.random().toString(36).slice(2, 6) })).result?.executionContextId
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, awaitPromise: true, expression: expr })).result?.result?.value
const feedId = async () => (await tree()).find(f => /web\/frame\/recommend\/\?/.test(f.url))?.id
const snap = async () => {
  const fid = await feedId(); if (!fid) return { frames: (await tree()).map(f => f.url.slice(0, 60)) }
  const ctx = await world(fid)
  const v = await ev(ctx, `(()=>{const q=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width)}};return {cards:document.querySelectorAll('.candidate-card-wrap').length,fav:q('.like-icon-and-text'),close:q('.close-btn'),favTxt:(document.querySelector('.like-icon-and-text')||{}).innerText||''}})()`)
  return v
}
async function realClick (x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

await send('Page.navigate', { url: 'https://www.zhipin.com/web/chat/recommend?t=' + Date.now() })
await sleep(9000)
console.log('frames:', (await tree()).map(f => f.url.slice(0, 64)).join('\n        '))
console.log('state:', JSON.stringify(await snap()))
const fid = await feedId()
if (!fid) { console.log('no feed frame'); ws.close(); process.exit(0) }
let ctx = await world(fid)
console.log('open card:', await ev(ctx, `(()=>{const n=document.querySelector('.row.name-wrap');if(!n)return 'no-name';n.click();return 'ok'})()`))
await sleep(1600)
console.log('after open:', JSON.stringify(await snap()))
const tctx = await world((await tree())[0].id)
const off = await ev(tctx, `(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top}})()`)
ctx = await world(await feedId())
const c = await ev(ctx, `(()=>{const e=document.querySelector('.close-btn');if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`)
if (off && c) {
  const ax = Math.round(off.x + c.x), ay = Math.round(off.y + c.y)
  console.log('--- 单次真实点击', ax, ay, '---')
  await realClick(ax, ay)
  await sleep(1400)
  console.log('after click X:', JSON.stringify(await snap()))
}
ws.close()
