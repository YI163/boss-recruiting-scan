// check-favs.mjs — 打开「收藏牛人」列表，只读核对收藏是否真的存在
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
const world = async fid => (await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'c' + Math.random().toString(36).slice(2, 6) })).result?.executionContextId
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: expr })).result?.result?.value

await send('Page.navigate', { url: 'https://www.zhipin.com/web/chat/interaction?status=9' })
let fr = null
for (let i = 0; i < 40 && !fr; i++) { await sleep(900); fr = (await tree()).find(f => /recommend\/interaction/.test(f.url)) }
if (!fr) { console.log('收藏列表帧未出现'); process.exit(2) }
const ctx = await world(fr.id)
let items = []
for (let i = 0; i < 20; i++) {
  items = (await ev(ctx, `Array.from(document.querySelectorAll('.card-item')).map(c=>(c.innerText||'').replace(/\\s+/g,' ').trim()).slice(0,12)`)) || []
  if (items.length) break
  await sleep(900)
}
console.log('收藏牛人列表条数(前12):', items.length)
items.forEach((t, i) => console.log(`  ${i + 1}. ${t.slice(0, 70)}`))
ws.close()
