// probe-close2.mjs — 浮层到底还开着吗？.close-btn 点得动吗？
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
const rf = frames.find(f => /web\/frame\/recommend\//.test(f.url))
console.log('page:', page.url)
console.log('frames:', frames.map(f => f.url.slice(0, 50)).join(' | '))
const ctx = await world(rf.id)
const state = `JSON.stringify((()=>{
  const q = s => { const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect();
    const cs=getComputedStyle(e); return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height),disp:cs.display,vis:cs.visibility,op:cs.opacity,txt:(e.innerText||'').replace(/\\s+/g,'').slice(0,12)} }
  return { fav: q('.like-icon-and-text'), close: q('.close-btn'), footer: q('.dialog-footer'), resumeWrap: q('#resume') };
})())`
console.log('state:', await ev(ctx, state))

// 试试点 .close-btn
console.log('click .close-btn ->', await ev(ctx, `(()=>{const e=document.querySelector('.close-btn');if(!e)return 'no-el';e.click();return 'clicked'})()`))
await sleep(1200)
console.log('after click:', await ev(ctx, state))

// 再试 Escape（Input 域）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(1000)
console.log('after Esc:', await ev(ctx, state))
ws.close()
