// probe-esc.mjs — 在推荐帧自己的文档里派发 Escape（不点击），看能否关掉面板
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
const feedId = async () => (await tree()).find(f => /web\/frame\/recommend\/\?/.test(f.url))?.id
const snap = async (ctx) => await ev(ctx, `(()=>{const q=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top)}};return {fav:q('.like-icon-and-text'),close:q('.close-btn'),favTxt:(document.querySelector('.like-icon-and-text')||{}).innerText||''}})()`)

const fid = await feedId()
if (!fid) { console.log('no feed frame'); ws.close(); process.exit(0) }
const ctx = await world(fid)
console.log('before:', JSON.stringify(await snap(ctx)))

// 1) 文档上派发 Escape
console.log('dispatch Escape on document:', await ev(ctx, `(()=>{
  const k = new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true});
  document.dispatchEvent(k); window.dispatchEvent(k);
  const u = new KeyboardEvent('keyup',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true});
  document.dispatchEvent(u); window.dispatchEvent(u);
  return 'sent'
})()`))
await sleep(1200)
console.log('after Escape:', JSON.stringify(await snap(ctx)))

// 2) 祖先链上的 click（不涉及元素坐标）
console.log('ancestors:', await ev(ctx, `(()=>{const e=document.querySelector('.close-btn');if(!e)return null;const out=[];let n=e;for(let i=0;i<5&&n;i++){out.push({tag:n.tagName,cls:(n.className||'').toString().slice(0,50)});n=n.parentElement}return JSON.stringify(out)})()`))
console.log('click parent chain:', await ev(ctx, `(()=>{const e=document.querySelector('.close-btn');if(!e)return 'no-el';let n=e.parentElement;for(let i=0;i<3&&n;i++){try{n.click()}catch(x){}n=n.parentElement}return 'clicked-parents'})()`))
await sleep(1200)
console.log('after parents:', JSON.stringify(await snap(ctx)))
ws.close()
