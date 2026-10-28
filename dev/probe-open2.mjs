// probe-open2.mjs — 打开浮层后：截图 + 在顶层文档里找「收藏」控件（面板可能由父文档渲染）
import fs from 'node:fs'
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
const world = async fid => (await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'o' + Math.random().toString(36).slice(2, 6) })).result?.executionContextId
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: expr })).result?.result?.value
const evTop = async expr => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result?.result?.value

const rf = (await tree()).find(f => /web\/frame\/recommend\//.test(f.url))
if (!rf) { console.log('no recommend frame'); process.exit(1) }
const rctx = await world(rf.id)
console.log('card0:', (await ev(rctx, `(document.querySelectorAll('.candidate-card-wrap')[0].innerText||'').replace(/\\s+/g,' ').slice(0,40)`)))
console.log('open:', await ev(rctx, `(() => { const c=document.querySelectorAll('.candidate-card-wrap')[0]; (c.querySelector('.row.name-wrap')||c).click(); return 'ok'; })()`))
await sleep(4000)
const frames = await tree()
console.log('frames:', frames.map(f => f.url.slice(0, 70)).join(' | '))

// 顶层文档里的浮层 UI
console.log('\n--- top doc 收藏-ish ---')
console.log(await evTop(`JSON.stringify((() => {
  const out = [];
  document.querySelectorAll('*').forEach(e => {
    const own = Array.from(e.childNodes).filter(x => x.nodeType === 3).map(x => x.textContent).join('').replace(/\\s+/g,'');
    const t = own || (e.textContent||'').replace(/\\s+/g,'');
    if (!/收藏/.test(t) || t.length > 12) return;
    const b = e.getBoundingClientRect();
    out.push({tag:e.tagName, cls:(e.className||'').toString().slice(0,50), t, x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height)});
  });
  return out;
})())`))
console.log('\n--- top doc fav class/title ---')
console.log(await evTop(`JSON.stringify((() => {
  const out = [];
  document.querySelectorAll('[class*=fav],[class*=collect],[title*=收藏],[aria-label*=收藏],[class*=resume],[class*=dialog],[class*=modal]').forEach(e => {
    const b = e.getBoundingClientRect();
    if (!b.width || !b.height) return;
    out.push({tag:e.tagName, cls:(e.className||'').toString().slice(0,60), title:e.getAttribute('title'), x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height)});
  });
  return out.slice(0, 25);
})())`))
console.log('\n--- overlay frame text ---')
const ov = frames.find(f => /c-resume/.test(f.url))
if (ov) {
  const octx = await world(ov.id)
  console.log('len:', await ev(octx, `(document.body.innerText||'').length`), '| html:', String(await ev(octx, `document.body.innerHTML`)).slice(0, 600))
}
const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: false }, 25000)
if (shot?.result?.data) { fs.writeFileSync('C:\\Users\\<you>\\boss-work\\open.png', Buffer.from(shot.result.data, 'base64')); console.log('\nshot -> open.png') }
else console.log('\nshot failed', JSON.stringify(shot).slice(0, 150))
ws.close()
