// probe-close.mjs — 找浮层右上角的关闭控件（元素级），并测试点击后浮层是否消失
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
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: expr })).result?.result?.value

const frames = await tree()
console.log('frames:', frames.map(f => f.url.slice(0, 60)).join(' | '))
const rf = frames.find(f => /web\/frame\/recommend\//.test(f.url))
const ctx = await world(rf.id)
console.log('overlay open?', frames.some(f => /c-resume/.test(f.url)))
console.log('控件状态:', await ev(ctx, `(()=>{const e=document.querySelector('.like-icon-and-text');return e?(e.innerText||'').trim():'none'})()`))
const cands = await ev(ctx, `JSON.stringify((() => {
  const out = [];
  document.querySelectorAll('[class*=close],i[class*=icon],span[class*=close],svg').forEach(e => {
    const b = e.getBoundingClientRect();
    if (!b.width || !b.height) return;
    if (b.top > 140) return;
    out.push({tag:e.tagName, cls:(e.className||'').toString().slice(0,60), x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height), txt:(e.textContent||'').replace(/\\s+/g,'').slice(0,10)});
  });
  return out;
})())`)
console.log('close-ish (top<140):', cands)
ws.close()
