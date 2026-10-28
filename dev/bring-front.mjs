// bring-front.mjs — 把 9333 调试实例的窗口拉到前台（最小干预：只置顶，不改页面）
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'

const list = await (await fetch(`${CDP}/json/list`)).json()
const pages = list.filter(t => t.type === 'page')
if (!pages.length) { console.error('no page target'); process.exit(1) }
const target = pages.find(p => /zhipin\.com/.test(p.url)) || pages[0]

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise(res => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})
await new Promise(r => ws.addEventListener('open', r))

await send('Page.enable')
const bt = await send('Page.bringToFront')
const win = await send('Browser.getWindowForTarget', { targetId: target.id })
if (win?.result?.windowId) {
  const b = await send('Browser.getWindowBounds', { windowId: win.result.windowId })
  if (b?.result?.bounds?.windowState !== 'normal') {
    await send('Browser.setWindowBounds', { windowId: win.result.windowId, bounds: { windowState: 'normal' } })
  }
  await send('Browser.setWindowBounds', { windowId: win.result.windowId, bounds: { windowState: 'normal' } })
}
ws.close()
console.log(JSON.stringify({ ok: true, title: target.title, url: target.url, bringToFront: !bt.error }, null, 2))
