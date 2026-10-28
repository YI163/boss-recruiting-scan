// probe-context.mjs — 验证 Runtime.evaluate 的默认上下文到底落在哪个 frame
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const list = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
let id = 0
const p = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } })
const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')

const t = await send('Page.getFrameTree')
const rootId = t.result.frameTree.frame.id
const frames = []
;(function w(n, d) { frames.push({ id: n.frame.id, url: n.frame.url, d }); (n.childFrames || []).forEach(c => w(c, d + 1)) })(t.result.frameTree, 0)
console.log('root:', rootId)
frames.forEach(f => console.log(`  [${f.d}] ${f.id.slice(0, 8)} ${f.url.slice(0, 90)}`))

const probe = `(() => {
  const ifs = Array.from(document.querySelectorAll('iframe')).length;
  return JSON.stringify({ href: location.href.slice(0, 90), title: document.title.slice(0, 30), iframes: ifs });
})()`

const noCtx = await send('Runtime.evaluate', { returnByValue: true, expression: probe })
console.log('\n[无 contextId]', JSON.stringify(noCtx.result), JSON.stringify(noCtx.error || null))

const w = await send('Page.createIsolatedWorld', { frameId: rootId, worldName: 'ctx-probe' })
const withCtx = await send('Runtime.evaluate', { contextId: w.result.executionContextId, returnByValue: true, expression: probe })
console.log('[根帧孤立世界]', JSON.stringify(withCtx.result?.result?.value), JSON.stringify(withCtx.error || null))
ws.close()
