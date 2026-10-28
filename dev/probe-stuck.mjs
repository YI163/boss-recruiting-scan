const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const page = pages.find(p => /zhipin/.test(p.url)) || pages[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (m, p = {}, tmo = 20000) => Promise.race([new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), sleep(tmo).then(() => ({ timeout: true }))])
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')
const tree = async () => { const r = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) })(r.result.frameTree); return out }
const world = async fid => (await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'k' + Math.random().toString(36).slice(2, 6) })).result?.executionContextId
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, awaitPromise: true, expression: expr })).result?.result?.value
const frames = await tree()
console.log('url:', page.url)
console.log('frames:', frames.map(f => f.url.slice(0, 50)).join(' | '))
const fid = frames.find(f => /web\/frame\/recommend\/\?/.test(f.url))?.id
const ctx = await world(fid)
console.log('wrapper:', await ev(ctx, `(()=>{const w=document.querySelector('.boss-popup__wrapper');if(!w)return 'none';const b=w.getBoundingClientRect();const cs=getComputedStyle(w);return JSON.stringify({cls:w.className.slice(0,120),x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height),op:cs.opacity,pe:cs.pointerEvents,disp:cs.display})})()`))
console.log('cards:', await ev(ctx, `document.querySelectorAll('.candidate-card-wrap').length`))
console.log('body 前 120 字:', await ev(ctx, `(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120)`))
console.log('name 元素:', await ev(ctx, `(()=>{const n=document.querySelector('.row.name-wrap');if(!n)return 'none';const b=n.getBoundingClientRect();return JSON.stringify({x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height),txt:(n.innerText||'').trim().slice(0,10)})})()`))
console.log('--- 单次元素点击卡片名 ---')
console.log('click:', await ev(ctx, `(()=>{const n=document.querySelector('.row.name-wrap');if(!n)return 'none';n.click();return 'ok'})()`))
await sleep(2500)
console.log('after click wrapper:', await ev(ctx, `(()=>{const w=document.querySelector('.boss-popup__wrapper');if(!w)return 'none';return w.className.slice(0,120)})()`))
console.log('after click fav:', await ev(ctx, `(()=>{const e=document.querySelector('.like-icon-and-text');return e?(e.innerText||'').trim():'none'})()`))
ws.close()
