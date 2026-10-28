// probe-all-frames.mjs — 在每一个帧（含 about:srcdoc / shadow root）里找「收藏」控件
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
const list = []; (function w(n, p) { list.push({ id: n.frame.id, url: n.frame.url, parent: p, name: n.frame.name }); (n.childFrames || []).forEach(c => w(c, n.frame.id)) })(r.result.frameTree, null)
for (const f of list) {
  const w = await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'all' + Math.random().toString(36).slice(2, 6) })
  const ctx = w.result?.executionContextId
  if (!ctx) { console.log(`frame ${f.url.slice(0, 50)} -> no ctx`); continue }
  const ev = async expr => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: expr })).result?.result?.value
  const txt = await ev(`(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,120)`)
  const has = await ev(`/收藏/.test(document.body?document.body.innerText:'')`)
  const host = await ev(`(() => { const out=[]; document.querySelectorAll('*').forEach(e=>{ if(e.shadowRoot) out.push(e.tagName+'.'+(e.className||'').toString().slice(0,30)); }); return out.join(',') ; })()`)
  console.log(`\nframe ${f.url.slice(0, 60)}\n  text(${(txt||'').length}): ${txt}\n  含收藏=${has}  shadowHosts=[${host}]`)
  if (has) {
    const hits = await ev(`JSON.stringify((() => { const out=[]; document.querySelectorAll('*').forEach(e=>{ const own=Array.from(e.childNodes).filter(x=>x.nodeType===3).map(x=>x.textContent).join('').replace(/\\s+/g,''); const t=own||(e.textContent||'').replace(/\\s+/g,''); if(!/收藏/.test(t)||t.length>12) return; const b=e.getBoundingClientRect(); out.push({tag:e.tagName,cls:(e.className||'').toString().slice(0,60),t,x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)}); }); return out; })())`)
    console.log('  hits:', hits)
  }
}
ws.close()
