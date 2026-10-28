// probe-fav3.mjs — 不截图，只 dump 浮层里疑似「收藏」的控件（class/title/aria）
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const page = pages.find(p => /zhipin/.test(p.url)) || pages[0]
console.log('page:', page.url)
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (m, p = {}, ms = 20000) => Promise.race([new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) }), sleep(ms).then(() => ({ timeout: true }))])
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')
const treeUrls = async () => { const r = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push({ url: n.frame.url, id: n.frame.id }); (n.childFrames || []).forEach(w) })(r.result.frameTree); return out }
const frames = await treeUrls()
frames.forEach(f => console.log('  frame:', f.url.slice(0, 100)))
const ov = frames.find(f => /c-resume/.test(f.url))
if (!ov) { console.log('no overlay frame'); process.exit(1) }
const ctx = (await send('Page.createIsolatedWorld', { frameId: ov.id, worldName: 'fx' })).result.executionContextId
const ev = async expr => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: expr })).result?.result?.value
console.log('overlay readyState:', await ev(`document.readyState + ' | textLen=' + (document.body.innerText||'').length`))
console.log('text head:', await ev(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 200)`))
const dump = await ev(`(() => {
  const out = [];
  document.querySelectorAll('[class*=fav],[class*=collect],[title*=收藏],[aria-label*=收藏],[class*=star]').forEach(e => {
    const b = e.getBoundingClientRect();
    out.push({tag:e.tagName, cls:(e.className||'').toString().slice(0,70), title:e.getAttribute('title'), aria:e.getAttribute('aria-label'),
      txt:(e.textContent||'').replace(/\\s+/g,'').slice(0,20), x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height)});
  });
  return JSON.stringify(out);
})()`)
console.log('fav-ish elements:', dump)
const btns = await ev(`(() => {
  const out = [];
  document.querySelectorAll('button,a,[role=button],div[class*=btn],span[class*=btn]').forEach(e => {
    const b = e.getBoundingClientRect();
    if (!b.width || !b.height || b.top > 160) return;
    out.push({tag:e.tagName, cls:(e.className||'').toString().slice(0,60), txt:(e.textContent||'').replace(/\\s+/g,'').slice(0,16), x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height)});
  });
  return JSON.stringify(out);
})()`)
console.log('top-area clickables:', btns)
ws.close()
