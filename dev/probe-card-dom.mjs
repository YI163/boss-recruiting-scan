// probe-card-dom.mjs — 卡片内部到底有没有「收藏」控件
import fs from 'node:fs'
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
const r = await send('Page.getFrameTree')
const list = []; (function w(n) { list.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) })(r.result.frameTree)
const rf = list.find(f => /web\/frame\/recommend\//.test(f.url))
if (!rf) { console.log('no recommend frame'); process.exit(1) }
const ctx = (await send('Page.createIsolatedWorld', { frameId: rf.id, worldName: 'card' })).result?.executionContextId
const ev = async expr => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: expr })).result?.result?.value

console.log('cards:', await ev(`document.querySelectorAll('.candidate-card-wrap').length`))
const html = await ev(`document.querySelectorAll('.candidate-card-wrap')[0].outerHTML`)
console.log('--- card html (2500) ---')
console.log(String(html).slice(0, 2500))
console.log('\n--- text nodes with 收藏 ---')
console.log(await ev(`JSON.stringify((() => { const out=[]; const c=document.querySelectorAll('.candidate-card-wrap')[0]; c.querySelectorAll('*').forEach(e=>{ if(/收藏/.test(e.textContent||'') && (e.textContent||'').length<20){const b=e.getBoundingClientRect(); out.push({tag:e.tagName,cls:(e.className||'').toString().slice(0,40),t:(e.textContent||'').replace(/\\s+/g,''),x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)})}}); return out; })())`))
console.log('\n--- all buttons/clickable in card ---')
console.log(await ev(`JSON.stringify((() => { const out=[]; const c=document.querySelectorAll('.candidate-card-wrap')[0]; c.querySelectorAll('a,button,span[class*=btn],div[class*=btn],i[class*=icon]').forEach(e=>{const b=e.getBoundingClientRect(); out.push({tag:e.tagName,cls:(e.className||'').toString().slice(0,45),t:(e.textContent||'').replace(/\\s+/g,'').slice(0,10),x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)})}); return out; })())`))
fs.writeFileSync('C:\\Users\\<you>\\boss-work\\card0.html', String(html || ''))
ws.close()
