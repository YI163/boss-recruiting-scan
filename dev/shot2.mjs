// shot2.mjs — 带超时的截图（fromSurface:false 回退），并打印浮层帧的自检信息
import fs from 'node:fs'
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const page = pages.find(p => /zhipin/.test(p.url)) || pages[0]
console.log('page:', page.url)
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (m, p = {}, tmo = 15000) => Promise.race([
  new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }),
  sleep(tmo).then(() => ({ timeout: true }))
])
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')

const r = await send('Page.getFrameTree')
const list = []; (function w(n) { list.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) })(r.result.frameTree)
list.forEach(f => console.log('  frame:', f.url.slice(0, 90)))
const ov = list.find(f => /c-resume/.test(f.url))
if (ov) {
  const ctx = (await send('Page.createIsolatedWorld', { frameId: ov.id, worldName: 'chk' })).result?.executionContextId
  const info = (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: `JSON.stringify({ready:document.readyState, href:location.href.slice(0,80), htmlLen:document.documentElement.outerHTML.length, bodyChildren:document.body?document.body.children.length:-1, head:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,120)})` })).result?.result?.value
  console.log('overlay selfcheck:', info)
}
let shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60 })
if (shot.timeout || !shot.data) {
  console.log('fromSurface screenshot timeout, retry with fromSurface:false')
  shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, fromSurface: false }, 20000)
}
if (shot?.data) { fs.writeFileSync('C:\\Users\\<you>\\boss-work\\now.png', Buffer.from(shot.data, 'base64')); console.log('shot -> now.png') }
else console.log('screenshot failed:', JSON.stringify(shot).slice(0, 200))
ws.close()
