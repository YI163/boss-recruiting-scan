// probe-hit.mjs — 不点击，只问：绝对点 (1022,58) 在顶层文档命中谁？帧内命中谁？
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
const frames = await tree()
console.log('url:', page.url)
console.log('frames:', frames.map(f => f.url.slice(0, 70)).join('\n         '))
const top = frames[0]
const tctx = await world(top.id)
const off = await ev(tctx, `(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height}})()`)
console.log('iframe rect(top):', off)
const rf = frames.find(f => /web\/frame\/recommend\//.test(f.url))
const rctx = await world(rf.id)
const c = await ev(rctx, `(()=>{const e=document.querySelector('.close-btn');if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`)
console.log('close center(frame):', c)
if (off && c) {
  const ax = Math.round(off.x + c.x), ay = Math.round(off.y + c.y)
  console.log('abs:', ax, ay)
  console.log('顶层 elementFromPoint ->', await ev(tctx, `(()=>{const e=document.elementFromPoint(${ax},${ay});if(!e)return null;return {tag:e.tagName,cls:(e.className||'').toString().slice(0,60),id:e.id}})()`))
  console.log('顶层 documentElement 滚动:', await ev(tctx, `JSON.stringify({sw:document.documentElement.scrollLeft,sh:document.documentElement.scrollTop,iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,zoom:getComputedStyle(document.body).zoom})`))
  console.log('帧内 elementFromPoint ->', await ev(rctx, `(()=>{const e=document.elementFromPoint(${c.x},${c.y});if(!e)return null;return {tag:e.tagName,cls:(e.className||'').toString().slice(0,60)}})()`))
}
ws.close()
