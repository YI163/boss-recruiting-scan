// probe-overlay-why.mjs — 浮层为什么是空的：dump HTML / 资源加载 / 结构化信息，并保存截图
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
const ov = list.find(f => /c-resume/.test(f.url))
if (!ov) { console.log('overlay gone'); process.exit(1) }
const ctx = (await send('Page.createIsolatedWorld', { frameId: ov.id, worldName: 'why' })).result?.executionContextId
const ev = async expr => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: expr })).result?.result?.value

console.log('--- overlay outerHTML ---')
console.log(String(await ev(`document.documentElement.outerHTML`)).slice(0, 2800))
console.log('\n--- resources (overlay) ---')
console.log(String(await ev(`JSON.stringify(performance.getEntriesByType('resource').map(e=>({n:e.name.split('/').pop().slice(0,40),d:Math.round(e.duration),s:e.transferSize})).slice(-25))`)).slice(0, 1500))
console.log('\n--- top page text ---')
console.log(String(await (send('Runtime.evaluate', { returnByValue: true, expression: `(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,400)` })).result?.result?.value))

let shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 65, fromSurface: false }, 20000)
if (shot?.result?.data) { fs.writeFileSync('C:\\Users\\<you>\\boss-work\\now.png', Buffer.from(shot.result.data, 'base64')); console.log('\nshot -> now.png', shot.result.data.length) }
else console.log('\nscreenshot failed')
ws.close()
