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
const fid = (await tree()).find(f => /web\/frame\/recommend\/\?/.test(f.url))?.id
const ctx = await world(fid)
console.log('wrapper 现在的类与样式:', await ev(ctx, `(()=>{const w=document.querySelector('.boss-popup__wrapper');if(!w)return 'no-wrapper';const cs=getComputedStyle(w);return JSON.stringify({cls:w.className,op:cs.opacity,disp:cs.display,vis:cs.visibility,pe:cs.pointerEvents,z:cs.zIndex})})()`))
console.log('fav 控件可见性:', await ev(ctx, `(()=>{const e=document.querySelector('.like-icon-and-text');if(!e)return null;const b=e.getBoundingClientRect();const cs=getComputedStyle(e);return JSON.stringify({w:Math.round(b.width),h:Math.round(b.height),op:cs.opacity,vis:cs.visibility,disp:cs.display})})()`))
console.log('3 秒后再看:', await new Promise(async r => { await sleep(3000); r(await ev(ctx, `(()=>{const w=document.querySelector('.boss-popup__wrapper');return w?w.className:'gone'})()`)) }))
ws.close()
