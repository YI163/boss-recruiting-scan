// probe-fav2.mjs — 在简历浮层里定位「收藏」控件，用 element.click() 点击并自校验
import fs from 'node:fs'
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

const treeUrls = async () => { const r = await send('Page.getFrameTree'); const out = []; (function w(n) { out.push({ url: n.frame.url, id: n.frame.id }); (n.childFrames || []).forEach(w) })(r.result.frameTree); return out }
const findFrame = async re => (await treeUrls()).find(f => re.test(f.url))
const world = async fid => (await send('Page.createIsolatedWorld', { frameId: fid, worldName: 'w' + Math.random().toString(36).slice(2, 6) })).result.executionContextId
const evIn = async (ctx, expr) => (await send('Runtime.evaluate', { contextId: ctx, returnByValue: true, awaitPromise: true, expression: expr })).result?.result?.value
const evTop = async expr => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr })).result?.result?.value

let ov = await findFrame(/c-resume/)
if (!ov) { console.log('no overlay; open one first'); process.exit(1) }
console.log('overlay:', ov.url.slice(0, 80))
const ovCtx = await world(ov.id)

// 1) 浮层里所有含「收藏」的小元素
console.log('--- candidates ---')
const list = await evIn(ovCtx, `(() => {
  const out = [];
  document.querySelectorAll('*').forEach(e => {
    const own = Array.from(e.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g,'');
    const t = (own || (e.textContent||'').replace(/\\s+/g,''));
    if (!/收藏/.test(t) || t.length > 12) return;
    const b = e.getBoundingClientRect();
    out.push({tag:e.tagName, cls:(e.className||'').toString().slice(0,70), text:t, x:Math.round(b.left), y:Math.round(b.top), w:Math.round(b.width), h:Math.round(b.height), children:e.children.length, clickable: typeof e.click === 'function'});
  });
  return JSON.stringify(out);
})()`)
console.log(list)

// 2) 浮层顶部工具条结构（找带 icon 的按钮）
console.log('--- top bar html (first 900 chars of candidate) ---')
console.log(await evIn(ovCtx, `(() => {
  const el = [...document.querySelectorAll('*')].find(e => /收藏/.test((e.textContent||'').replace(/\\s+/g,'')) && e.getBoundingClientRect().top < 200);
  if (!el) return 'none';
  const box = el.closest('div[class]') || el;
  return box.outerHTML.slice(0, 900);
})()`))

const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 })
fs.writeFileSync('C:\\Users\\<you>\\boss-work\\resume-overlay.png', Buffer.from(shot.data, 'base64'))
console.log('shot -> resume-overlay.png')

// 3) 用 element.click() 点「收藏」，并等待状态变化
console.log('--- click via element.click() ---')
console.log(await evIn(ovCtx, `(() => {
  const cands = [...document.querySelectorAll('*')].filter(e => {
    const own = Array.from(e.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\\s+/g,'');
    const t = own || (e.textContent||'').replace(/\\s+/g,'');
    if (!/^(收藏|收藏简历)$/.test(t)) return false;
    const b = e.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  });
  if (!cands.length) return 'no candidate';
  const e = cands[cands.length - 1];
  e.click();
  return 'clicked <' + e.tagName + ' class=' + (e.className||'').toString().slice(0,50) + '> text=' + (e.textContent||'').replace(/\\s+/g,'');
})()`))
for (let i = 0; i < 10; i++) {
  await sleep(700)
  const txt = await evTop(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 200)`)
  const state = await evIn(ovCtx, `(() => {
    const e = [...document.querySelectorAll('*')].find(x => /^(已收藏|取消收藏|收藏|收藏简历)$/.test((x.textContent||'').replace(/\\s+/g,'')));
    return e ? (e.textContent||'').replace(/\\s+/g,'') : 'none';
  })()`)
  console.log(`t+${((i + 1) * 0.7).toFixed(1)}s 收藏控件=`, state, '| toast?', /收藏成功/.test(txt) ? 'YES' : 'no')
  if (/已收藏|取消收藏/.test(String(state)) || /收藏成功/.test(txt)) break
}
const shot2 = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 })
fs.writeFileSync('C:\\Users\\<you>\\boss-work\\after-fav.png', Buffer.from(shot2.data, 'base64'))
console.log('shot -> after-fav.png')
ws.close()
