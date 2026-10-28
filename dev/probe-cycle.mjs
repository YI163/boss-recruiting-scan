// probe-cycle.mjs — 完整走一遍：开卡 → 收藏 → 观察面板 → 逐个关闭策略，打印每步状态
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
const ev = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, awaitPromise: true, expression: expr })).result?.result?.value
const frames = async () => await tree()
const recId = async () => (await frames()).find(f => /web\/frame\/recommend\//.test(f.url))?.id

const stateExpr = `JSON.stringify((()=>{
  const q = s => { const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect();
    const cx=b.left+b.width/2, cy=b.top+b.height/2, el=document.elementFromPoint(cx,cy);
    return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height),
      inVp: b.width>0&&b.height>0&&b.right>0&&b.bottom>0&&b.left<innerWidth&&b.top<innerHeight,
      hit: !!el && (el===e || e.contains(el) || el.contains(e))} }
  return { fav: q('.like-icon-and-text'), close: q('.close-btn'), footer: q('.dialog-footer'), vw:innerWidth, vh:innerHeight };
})())`

const ctx1 = await world(await recId())
console.log('BEFORE:', await ev(ctx1, stateExpr))
// 开第一张卡
console.log('open card:', await ev(ctx1, `(()=>{const n=document.querySelector('.row.name-wrap');if(!n)return 'no-name';n.click();return 'ok'})()`))
await sleep(1500)
let rid = await recId(); let ctx = await world(rid)
console.log('AFTER OPEN:', await ev(ctx, stateExpr))
// 收藏
console.log('click fav:', await ev(ctx, `(()=>{const e=document.querySelector('.like-icon-and-text');if(!e)return 'no-fav';e.click();return 'ok'})()`))
await sleep(1500)
console.log('AFTER FAV:', await ev(ctx, stateExpr))
// 策略1：点 .close-btn
console.log('s1 close-btn:', await ev(ctx, `(()=>{const e=document.querySelector('.close-btn');if(!e)return 'no-el';e.click();return 'ok'})()`))
await sleep(1200)
console.log('S1:', await ev(ctx, stateExpr))
// 策略2：Escape（Input 域）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(1200)
console.log('S2:', await ev(ctx, stateExpr))
// 策略3：找所有含 close 且在视口内的元素
console.log('s3 visible-close candidates:', await ev(ctx, `JSON.stringify([...document.querySelectorAll('[class*=close]')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&b.right>0&&b.bottom>0&&b.left<innerWidth&&b.top<innerHeight}).map(e=>({cls:e.className.toString().slice(0,40),x:Math.round(e.getBoundingClientRect().left),y:Math.round(e.getBoundingClientRect().top)})))`))
ws.close()
