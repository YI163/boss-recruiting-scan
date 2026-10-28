// fav-flow.mjs — 一条龙：打开浮层 → 等浮层内容加载 → 找「收藏」控件 → element.click() → 校验状态
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const page = pages.find(p => /zhipin/.test(p.url)) || pages[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (m, p = {}, tmo = 15000) => Promise.race([
  new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }),
  sleep(tmo).then(() => ({ timeout: true }))
])
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')

const tree = async () => { const r = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push({ url: n.frame.url, id: n.frame.id }); (n.childFrames || []).forEach(w) })(r.result.frameTree); return out || [] }
const world = async fid => (await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'f' + Math.random().toString(36).slice(2, 7) })).result?.executionContextId
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: expr })).result?.result?.value
const evTop = async expr => (await send('Runtime.evaluate', { returnByValue: true, expression: expr })).result?.result?.value

let rf = (await tree()).find(f => /web\/frame\/recommend\//.test(f.url))
if (!rf) { console.log('no recommend frame'); process.exit(1) }
let ctx = await world(rf.id)
const n = await ev(ctx, `document.querySelectorAll('.candidate-card-wrap').length`)
console.log('cards:', n)
if (!ctx || !n) { console.log('no cards'); process.exit(1) }

console.log('open overlay:', await ev(ctx, `(() => { const c=document.querySelectorAll('.candidate-card-wrap')[0]; const row=c.querySelector('.row.name-wrap')||c; row.click(); return row.className; })()`))
let ov = null
for (let i = 0; i < 24; i++) { await sleep(500); ov = (await tree()).find(f => /c-resume/.test(f.url)); if (ov) break }
if (!ov) { console.log('overlay did not open'); process.exit(2) }
const octx = await world(ov.id)
let len = 0
for (let i = 0; i < 20; i++) {
  len = await ev(octx, `(document.body.innerText||'').length`)
  if (len > 200) break
  await sleep(500)
}
console.log('overlay textLen:', len, '| head:', await ev(octx, `(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,160)`))
const cands = await ev(octx, `(() => {
  const out = [];
  document.querySelectorAll('*').forEach(e => {
    const own = Array.from(e.childNodes).filter(x => x.nodeType === 3).map(x => x.textContent).join('').replace(/\\s+/g,'');
    const t = own || (e.textContent||'').replace(/\\s+/g,'');
    if (!/收藏/.test(t) || t.length > 14) return;
    const b = e.getBoundingClientRect();
    out.push({tag:e.tagName, cls:(e.className||'').toString().slice(0,60), title:e.getAttribute('title'), text:t,
      x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height), kids:e.children.length});
  });
  return JSON.stringify(out);
})()`)
console.log('收藏 candidates:', cands)
const cls = await ev(octx, `(() => {
  const out = [];
  document.querySelectorAll('[class*=fav],[class*=collect],[title*=收藏],[class*=star]').forEach(e => {
    const b = e.getBoundingClientRect();
    out.push({tag:e.tagName, cls:(e.className||'').toString().slice(0,60), title:e.getAttribute('title'), txt:(e.textContent||'').replace(/\\s+/g,'').slice(0,12), x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height)});
  });
  return JSON.stringify(out);
})()`)
console.log('fav-ish:', cls)
ws.close()
