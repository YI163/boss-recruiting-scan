// probe-dialog.mjs — 只看不点：dump 弹出层的结构、关闭相关元素、遮罩
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

console.log('--- 所有 close 相关元素（视口内）---')
console.log(await ev(ctx, `JSON.stringify([...document.querySelectorAll('[class*=close],[class*=Close]')].map(e=>{const b=e.getBoundingClientRect();return {tag:e.tagName,cls:(e.className||'').toString().slice(0,40),x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)}}).filter(x=>x.w>0&&x.h>0))`))
console.log('\n--- popup wrapper 结构（截断）---')
console.log(await ev(ctx, `(()=>{const w=document.querySelector('.boss-popup__wrapper');if(!w)return 'none';return w.outerHTML.slice(0,1200)})()`))
console.log('\n--- popup 内的按钮/可点元素 ---')
console.log(await ev(ctx, `JSON.stringify([...document.querySelectorAll('.boss-popup__wrapper button, .boss-popup__wrapper [role=button], .boss-popup__wrapper a, .boss-popup__wrapper [class*=btn]')].map(e=>{const b=e.getBoundingClientRect();return {tag:e.tagName,cls:(e.className||'').toString().slice(0,44),x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height),txt:(e.innerText||'').replace(/\\s+/g,'').slice(0,8)}}).filter(o=>o.w>0))`))
console.log('\n--- 是否有遮罩 ---')
console.log(await ev(ctx, `JSON.stringify([...document.querySelectorAll('[class*=mask],[class*=overlay]')].map(e=>{const b=e.getBoundingClientRect();return {cls:(e.className||'').toString().slice(0,40),x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)}}).filter(o=>o.w>0))`))
console.log('\n--- close-btn 外层 HTML ---')
console.log(await ev(ctx, `(()=>{const e=document.querySelector('.close-btn');return e?e.outerHTML.slice(0,400):'none'})()`))
ws.close()
