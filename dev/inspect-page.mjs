// inspect-page.mjs — 看当前调试页顶层 iframe 状态
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
const urls = []
;(function w(n) { urls.push(n.frame.url); (n.childFrames || []).forEach(w) })(t.result.frameTree)
console.log('URL:', list[0].url)
urls.forEach(u => console.log('  frame:', u.slice(0, 130)))
const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
  const ifs = Array.from(document.querySelectorAll('iframe')).map(i => {
    const b = i.getBoundingClientRect();
    const src = i.getAttribute('src') || '';
    return { src: src.slice(0, 80), x: b.left, y: b.top, w: b.width, h: b.height };
  });
  return JSON.stringify({
    ready: document.readyState,
    iframes: ifs,
    clientWidth: document.documentElement.clientWidth,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 150)
  });
})()` })
console.log('top:', r.result?.result?.value)
ws.close()
