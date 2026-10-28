// CDP 调试助手（只读/诊断用）：state | cards | shot | ax | reload | eval
// 用法：CDP_URL=http://127.0.0.1:9333 BOSS_WORK=/tmp/boss node cdp.mjs <cmd>
// 注意：开浮层/点收藏请用 scan-favorite.mjs（本文件的 open/fav 旧命令已移除）。
import { writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CDP_BASE = process.env.CDP_URL || 'http://127.0.0.1:9333'
// 默认工作目录：macOS/Linux 仍是 /tmp/boss；Windows 用 %TEMP%\boss（与 scan-favorite.mjs 一致）
const DEFAULT_BASE = process.platform === 'win32' ? path.join(os.tmpdir(), 'boss') : '/tmp/boss'
const BASE = process.env.BOSS_WORK || DEFAULT_BASE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pickTarget() {
  const list = await (await fetch(`${CDP_BASE}/json/list`)).json()
  const pages = list.filter((t) => t.type === 'page')
  const boss = pages.find((t) => /zhipin\.com/.test(t.url))
  if (!boss) throw new Error('找不到 BOSS 页面：请先登录并打开 https://www.zhipin.com/web/chat/recommend')
  return boss
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [] }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')) })
    const c = new Cdp(ws)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id)
        c.pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result)
      } else if (msg.method) c.events.push(msg)
    }
    return c
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    const p = new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + method)), 12000))])
  }
}

const NORM = `const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();`

async function main() {
  const cmd = process.argv[2] || 'state'
  console.error('[dbg] pickTarget...')
  const target = await pickTarget()
  console.error('[dbg] target', target && target.url)
  if (!target) throw new Error('no page target')
  const c = await Cdp.connect(target.webSocketDebuggerUrl)
  console.error('[dbg] connected')
  await c.send('Page.enable')
  console.error('[dbg] Page.enable')
  await c.send('Runtime.enable')
  console.error('[dbg] Runtime.enable')
  await c.send('DOM.enable')
  console.error('[dbg] DOM.enable')

  const frames = async () => {
    const { frameTree } = await c.send('Page.getFrameTree')
    const out = []
    const walk = (node, depth) => {
      out.push({ frameId: node.frame.id, url: node.frame.url, parentId: node.frame.parentId || null, depth })
      for (const child of node.childFrames || []) walk(child, depth + 1)
    }
    walk(frameTree, 0)
    return out
  }
  const evalIn = async (frameId, expression) => {
    const { executionContextId } = await c.send('Page.createIsolatedWorld', { frameId, worldName: 'dsh-node', grantUniveralAccess: true })
    const r = await c.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500))
    return r.result.value
  }
  const pickFrame = async (re, requireMatch = true) => {
    const list = await frames()
    const hit = list.find((f) => re.test(f.url))
    if (!hit && requireMatch) throw new Error('frame not found for ' + re + ' :: ' + list.map((f) => f.frameId + ':' + f.url.slice(0, 80)).join(' | '))
    return hit
  }

  const CARDS_QUERY = `JSON.stringify((() => {
    ${NORM}
    const buttons = Array.from(document.querySelectorAll('button')).filter((button) => norm(button.textContent).startsWith('打招呼'));
    const seen = new Set(); const cards = [];
    for (const button of buttons) {
      const card = button.closest('li, article, [class*="card"], [class*="item"], [class*="geek"]') || button.parentElement;
      if (card === null || card === undefined || seen.has(card)) continue;
      seen.add(card);
      const text = norm(card.innerText);
      if (text.length < 10) continue;
      cards.push(text);
    }
    return { total: cards.length, cards, href: location.href, login: /退出登录/.test(document.body ? document.body.innerText : '') };
  })())`


  if (cmd === 'state') {
    const list = await frames()
    const top = list[0]
    const title = await evalIn(top.frameId, 'document.title')
    console.log(JSON.stringify({ url: top.url, title, frames: list }, null, 1))
    return
  }
  if (cmd === 'cards') {
    const feed = await pickFrame(/web\/frame\/recommend/)
    const raw = await evalIn(feed.frameId, CARDS_QUERY)
    const data = JSON.parse(raw)
    console.log(JSON.stringify({ frame: feed.frameId, url: feed.url, total: data.total, login: data.login }, null, 1))
    data.cards.forEach((card, i) => console.log(`#${i} ${card}`))
    return
  }
  if (cmd === 'shot') {
    const shotPath = process.argv[3] || path.join(BASE, 'shot.jpg')
    mkdirSync(path.dirname(shotPath), { recursive: true })
    const m = await c.send('Page.getLayoutMetrics')
    const vp = m.cssVisualViewport
    const shot = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: true, captureBeyondViewport: false, clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 0.5 } })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'), { mode: 0o600 })
    console.log(JSON.stringify({ path: shotPath, width: Math.round(vp.clientWidth), height: Math.round(vp.clientHeight) }))
    return
  }
  if (cmd === 'ax') {
    const needle = process.argv[3] || '收藏'
    await c.send('Accessibility.enable')
    const { nodes } = await c.send('Accessibility.getFullAXTree', { depth: -1 })
    const hits = nodes
      .filter((n) => n.name && n.name.value && String(n.name.value).includes(needle))
      .map((n) => ({ role: n.role && n.role.value, name: n.name.value, backendDOMNodeId: n.backendDOMNodeId, ignored: n.ignored }))
    console.log(JSON.stringify(hits.slice(0, 40), null, 1))
    return
  }
  if (cmd === 'reload') {
    await c.send('Page.reload', { ignoreCache: false })
    await sleep(3500)
    console.log('reloaded')
    return
  }
  if (cmd === 'scroll') {
    const dy = Number(process.argv[3] ?? 1200)
    const feed = await pickFrame(/web\/frame\/recommend/)
    const r0 = await evalIn(feed.frameId, `JSON.stringify((() => { const el = document.scrollingElement || document.body; const before = el.scrollTop; el.scrollTop = el.scrollTop + ${dy}; return { before, after: el.scrollTop, height: el.scrollHeight }; })())`)
    await sleep(1200)
    console.log(r0)
    return
  }
  if (cmd === 'eval') {
    const expr = process.argv[3] || '1'
    const top = (await frames())[0]
    console.log(JSON.stringify(await evalIn(top.frameId, expr), null, 1))
    return
  }

  if (cmd === 'more') {
    const times = Number(process.argv[3] ?? 2)
    let last = 0
    for (let i = 0; i < times; i++) {
      const feed = await pickFrame(/web\/frame\/recommend/)
      try {
        await evalIn(feed.frameId, `JSON.stringify((() => { const el = document.scrollingElement || document.body; el.scrollTop = el.scrollHeight; const scrollers = Array.from(document.querySelectorAll('*')).filter((n) => n.scrollHeight > n.clientHeight + 300 && n.clientHeight > 300); for (const n of scrollers) n.scrollTop = n.scrollHeight; return { scrollers: scrollers.length }; })())`)
      } catch (e) { console.log('scroll eval failed:', e.message) }
      const m = await c.send('Page.getLayoutMetrics')
      const vp = m.cssVisualViewport
      const cx = Math.round(vp.clientWidth / 2)
      const cy = Math.round(vp.clientHeight * 0.75)
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' }).catch(() => {})
      for (let k = 0; k < 4; k++) {
        await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 1500 }).catch((e) => console.log('wheel err', e.message))
        await sleep(400)
      }
      await sleep(2000)
      try {
        const f2 = await pickFrame(/web\/frame\/recommend/)
        const data = JSON.parse(await evalIn(f2.frameId, CARDS_QUERY))
        last = data.total
        console.log('pass', i + 1, 'cards', last)
        if (i > 0 && last === 0) break
      } catch (e) { console.log('count failed:', e.message) }
    }
    console.log('done, cards now', last)
    return
  }
  if (cmd === 'pmore') {
    const times = Number(process.argv[3] ?? 1)
    const top = (await frames())[0]
    const feed = await pickFrame(/web\/frame\/recommend/)
    let last = 0
    for (let i = 0; i < times; i++) {
      const r = await evalIn(top.frameId, `JSON.stringify((() => { const el = document.scrollingElement || document.body; const before = el.scrollTop; el.scrollTop = el.scrollHeight; const scrollers = Array.from(document.querySelectorAll('*')).filter((n) => n.scrollHeight > n.clientHeight + 400 && n.clientHeight > 400); for (const n of scrollers) n.scrollTop = n.scrollHeight; return { before, after: el.scrollTop, sh: el.scrollHeight, scrollers: scrollers.length }; })())`)
      console.log('tops croll', i + 1, r)
      await sleep(2500)
      const raw = await evalIn(feed.frameId, CARDS_QUERY)
      const data = JSON.parse(raw)
      console.log('pass', i + 1, 'cards', data.total)
      last = data.total
    }
    console.log('done, cards now', last)
    return
  }
  if (cmd === 'wheel') {
    const n = Number(process.argv[3] ?? 3)
    const dy = Number(process.argv[4] ?? 1500)
    await c.send('Page.bringToFront')
    const m = await c.send('Page.getLayoutMetrics')
    const vp = m.cssVisualViewport
    const cx = Math.round(vp.clientWidth / 2)
    const cy = Math.round(vp.clientHeight * 0.7)
    for (let i = 0; i < n; i++) {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: dy })
      await sleep(450)
    }
    console.log(JSON.stringify({ wheel: n, dy, at: [cx, cy] }))
    return
  }
  if (cmd === 'dump') {
    // 注意：dump 会写出完整卡片（含 PII），默认写到 BOSS_WORK 且权限 600，用完请删
    const outPath = process.argv[3] || path.join(BASE, 'dump-' + Date.now() + '.json')
    mkdirSync(path.dirname(outPath), { recursive: true })
    const feed = await pickFrame(/web\/frame\/recommend/)
    const raw = await evalIn(feed.frameId, CARDS_QUERY)
    const data = JSON.parse(raw)
    writeFileSync(outPath, JSON.stringify({ url: feed.url, total: data.total, cards: data.cards }, null, 1), { mode: 0o600 })
    console.log(JSON.stringify({ path: outPath, total: data.total, note: '含完整卡片，勿共享/及时删除' }))
    return
  }
  throw new Error('unknown command: ' + cmd)
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(1) })
