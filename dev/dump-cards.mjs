// dump-cards.mjs — 从推荐帧导出全部卡片文本到 cards-sample.jsonl（只读）
import fs from 'node:fs'
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const OUT = process.env.OUT || 'C:\\Users\\<you>\\boss-work\\cards-sample.jsonl'

const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.filter(t => t.type === 'page')[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')

const tree = await send('Page.getFrameTree')
const flat = []
;(function walk(n, d) { flat.push({ id: n.frame.id, url: n.frame.url }); for (const c of n.childFrames || []) walk(c, d + 1) })(tree.result.frameTree, 0)
const rf = flat.find(f => /web\/frame\/recommend/.test(f.url))
if (!rf) { console.error('no recommend frame; current url:', flat.map(f => f.url).join('\n')); process.exit(1) }

const world = await send('Page.createIsolatedWorld', { frameId: rf.id, worldName: 'dump' })
const ctx = world.result.executionContextId

// 先看页面顶部的职位名（顶层）
const topR = await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const t=document.body.innerText.replace(/\\s+/g,' ');return t.slice(0,300)})()` })
console.log('TOP:', topR.result?.result?.value)

let cards = []
for (let k = 0; k < 10; k++) {
  const r = await send('Runtime.evaluate', {
    contextId: ctx, returnByValue: true, awaitPromise: true,
    expression: `Array.from(document.querySelectorAll('.candidate-card-wrap')).map(c=>(c.innerText||'').replace(/\\s+/g,' ').trim())`
  })
  cards = r.result?.result?.value || []
  if (cards.length >= 5) break
  await sleep(1000)
}
fs.writeFileSync(OUT, cards.map(c => JSON.stringify({ card: c })).join('\n') + '\n', { mode: 0o600 })
console.log(`\ncards=${cards.length} -> ${OUT}`)
cards.forEach((c, i) => console.log(`\n[${i}] ${c.slice(0, 420)}`))
ws.close()
