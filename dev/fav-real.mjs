// fav-real.mjs — 用元素点击点「收藏」并验证状态变化（不再用坐标）
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
const world = async fid => (await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'x' + Math.random().toString(36).slice(2, 6) })).result?.executionContextId
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, expression: expr })).result?.result?.value

const rf = (await tree()).find(f => /web\/frame\/recommend\//.test(f.url))
const rctx = await world(rf.id)

// 1) 若已有浮层就复用，否则打开第一张卡
let open = await ev(rctx, `!!document.querySelector('.like-icon-and-text')`)
if (!open) {
  console.log('open overlay:', await ev(rctx, `(() => { const c=document.querySelectorAll('.candidate-card-wrap')[0]; (c.querySelector('.row.name-wrap')||c).click(); return 'clicked'; })()`))
  for (let i = 0; i < 24 && !open; i++) { await sleep(500); open = await ev(rctx, `!!document.querySelector('.like-icon-and-text')`) }
}
if (!open) { console.log('收藏 控件未出现'); process.exit(2) }
console.log('控件状态(点击前):', await ev(rctx, `(() => { const e=document.querySelector('.like-icon-and-text'); return JSON.stringify({cls:e.className, text:e.innerText.trim(), html:e.innerHTML.slice(0,200)}); })()`))
console.log('候选人:', await ev(rctx, `(document.querySelector('.candidate-card-wrap')?.innerText||'').replace(/\\s+/g,' ').slice(0,40)`))

// 2) 元素点击
console.log('click:', await ev(rctx, `(() => { const e=document.querySelector('.like-icon-and-text'); e.click(); return 'clicked .like-icon-and-text'; })()`))
for (let i = 0; i < 12; i++) {
  await sleep(800)
  const st = await ev(rctx, `(() => { const e=document.querySelector('.like-icon-and-text'); return e ? JSON.stringify({cls:e.className, text:e.innerText.trim()}) : 'gone'; })()`)
  const toast = await ev(rctx, `(() => { const t=[...document.querySelectorAll('[class*=toast],[class*=tip],[class*=message]')].map(e=>(e.innerText||'').trim()).filter(Boolean); return t.join('|').slice(0,120); })()`)
  console.log(`t+${((i + 1) * 0.8).toFixed(1)}s`, st, '| toast:', toast)
  if (/已收藏|取消收藏/.test(String(st))) break
}
ws.close()
