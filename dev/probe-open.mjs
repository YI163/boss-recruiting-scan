// probe-open.mjs — 对比三种打开方式：坐标点击 / DOM.click() / 派发 MouseEvent
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter(t => t.type === 'page')
const page = pages.find(p => /zhipin/.test(p.url)) || pages[0]
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
await new Promise(r => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')

const frameIds = async (re) => { const r = await send('Page.getFrameTree'); const out = []; (function w(n) { if (re.test(n.frame.url)) out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) })(r.result.frameTree); return out }
const treeUrls = async () => { const r = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push(n.frame.url.slice(0, 80)); (n.childFrames || []).forEach(w) })(r.result.frameTree); return out }
const rf = (await frameIds(/web\/frame\/recommend\//))[0]
if (!rf) { console.log('no recommend frame'); process.exit(1) }
const ctx = (await send('Page.createIsolatedWorld', { frameId: rf.id, worldName: 'p' })).result.executionContextId
const ev = async (expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, awaitPromise: true, expression: expr })).result?.result?.value

console.log('frames now:', (await treeUrls()).join(' | '))
console.log('overlay open?', (await treeUrls()).some(u => /c-resume/.test(u)))

// 方式 A：DOM.click()
console.log('--- A: element.click() ---')
console.log(await ev(`(() => { const c=document.querySelectorAll('.candidate-card-wrap')[0]; const row=c.querySelector('.row.name-wrap'); row.click(); return 'clicked'; })()`))
await sleep(3000)
console.log('frames:', (await treeUrls()).join(' | '))

if (!(await treeUrls()).some(u => /c-resume/.test(u))) {
  // 方式 B：向卡片内的姓名元素派发完整 mouse 事件序列
  console.log('--- B: dispatch MouseEvent sequence ---')
  console.log(await ev(`(() => {
    const c=document.querySelectorAll('.candidate-card-wrap')[0];
    const t=c.querySelector('.row.name-wrap') || c;
    const b=t.getBoundingClientRect();
    const o={bubbles:true,cancelable:true,composed:true,view:window,clientX:b.left+40,clientY:b.top+b.height/2,button:0,buttons:1};
    t.dispatchEvent(new MouseEvent('mouseover',o));
    t.dispatchEvent(new MouseEvent('mousemove',o));
    t.dispatchEvent(new MouseEvent('mousedown',o));
    t.dispatchEvent(new MouseEvent('mouseup',{...o,buttons:0}));
    t.dispatchEvent(new MouseEvent('click',{...o,buttons:0}));
    return 'dispatched to '+t.className;
  })()`))
  await sleep(3000)
  console.log('frames:', (await treeUrls()).join(' | '))
}
ws.close()
