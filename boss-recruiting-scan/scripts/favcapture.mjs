#!/usr/bin/env node
// favcapture.mjs — 抓「互动 → 收藏牛人」列表（含真实任职起止），供审核/核对收藏一致性
// 用法：BOSS_WORK=/tmp/boss FAV_OUT=/tmp/boss/fav_capture.json node favcapture.mjs
// 环境：CDP_URL BOSS_WORK FAV_OUT
// 安全：发现安全验证/登录失效立即退出非零，不抓取。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
// 默认工作目录：macOS/Linux 仍是 /tmp/boss；Windows 用 %TEMP%\boss（与 scan-favorite.mjs 一致）
const DEFAULT_BASE = process.platform === 'win32' ? path.join(os.tmpdir(), 'boss') : '/tmp/boss'
const BASE = process.env.BOSS_WORK || DEFAULT_BASE
const OUT = process.env.FAV_OUT || path.join(BASE, 'fav_capture.json')
const URL_FAV = 'https://www.zhipin.com/web/chat/interaction?status=9'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
// 姓名掩码：定位「N岁」，回溯跳过活动标签/角标后掩姓名 token；已掩码的保持原样
const ACT = new Set(['热搜', '刚刚活跃', '今日活跃', '3日内活跃', '本周活跃', '本月活跃', '2周内活跃', '在线', '面议', '新牛人'])
const isAge = t => /^\d{1,3}岁$/.test(t || '')
const isBadge = t => /^[\d*]{1,4}$/.test(t || '')
const looksName = t => !!t && !ACT.has(t) && !isAge(t) && !isBadge(t) && !t.includes('*') && t.length <= 8
const mask = t => {
  const toks = String(t || '').split(/\s+/).filter(Boolean)
  for (let i = 0; i < toks.length; i++) {
    if (!isAge(toks[i])) continue
    let j = i - 1
    while (j >= 0 && (ACT.has(toks[j]) || isBadge(toks[j]))) j--
    if (j >= 0 && looksName(toks[j])) toks[j] = toks[j].slice(0, 1) + '**'
  }
  return toks.join(' ')
}

let ws, id = 0
const pend = new Map()
const send = (method, params = {}) => {
  const i = ++id
  const p = new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + method)), 25000))])
}
const evalTop = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value
const frames = async () => {
  const { frameTree } = await send('Page.getFrameTree')
  const out = []; const walk = n => { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(walk) }; walk(frameTree); return out
}
async function evalIn(frameId, expr) {
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'fav-cap', grantUniveralAccess: true })
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: expr, contextId: executionContextId, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails).slice(0, 160))
  return result.value
}

async function main() {
  const list = await (await fetch(CDP + '/json/list')).json()
  const t = list.find(x => x.type === 'page' && /zhipin/.test(x.url))
  if (!t) throw new Error('找不到 BOSS 页面（先登录并打开 BOSS）')
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')) })
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } }
  await send('Page.enable')

  const risk = await evalTop('location.href+"\\n"+document.title+"\\n"+(document.body?document.body.innerText.slice(0,3000):"")')
  if (/passport\/verify|_security_check|verify\.html|安全验证/.test(risk || '')) { console.log('SECURITY detected, abort'); process.exit(2) }
  if (/注册登录|请登录|扫码登录/.test(risk || '') && !/退出登录/.test(risk || '')) { console.log('NOT LOGGED IN, abort'); process.exit(2) }

  await send('Page.navigate', { url: URL_FAV })
  let fr = null
  for (let k = 0; k < 40; k++) { await sleep(900); fr = (await frames()).find(f => /recommend\/interaction/.test(f.url)); if (fr) break }
  if (!fr) {
    const risk2 = await evalTop('location.href+"\\n"+document.title+"\\n"+(document.body?document.body.innerText.slice(0,2000):"")').catch(() => '')
    if (/passport\/verify|_security_check|verify\.html|安全验证/.test(risk2 || '')) { console.log('SECURITY after nav, abort'); process.exit(2) }
    if (/注册登录|请登录|扫码登录/.test(risk2 || '') && !/退出登录/.test(risk2 || '')) { console.log('LOGIN required, abort'); process.exit(2) }
    console.log('favorite list iframe not found'); process.exit(2)
  }

  // 收藏列表是懒加载的：帧出现 ≠ 列表渲染完。先等出至少一张卡再读（审计缺口 D14/D19）
  let listReady = false
  for (let t = 0; t < 25; t++) {
    const n = await evalIn(fr.id, 'document.querySelectorAll(".card-item").length').catch(() => 0)
    if (n > 0) { listReady = true; break }
    await sleep(1200)
  }
  if (!listReady) console.log('WARN: 30s 内没读到 .card-item（收藏可能为空，或列表仍在加载）')

  const seen = new Map()
  for (let round = 0; round < 40; round++) {
    const arr = await evalIn(fr.id, 'Array.from(document.querySelectorAll(".card-item")).map(c=>(c.innerText||"").replace(/\\s+/g," ").trim())')
    let add = 0
    for (const c of arr) { const k = c.slice(0, 70); if (!seen.has(k)) { seen.set(k, c); add++ } }
    console.log('round', round, 'cards', arr.length, 'new', add, 'total', seen.size)
    await evalIn(fr.id, '(()=>{const s=[document.scrollingElement,document.documentElement,document.body,...document.querySelectorAll("div,section,main,ul")].filter(e=>e&&e.scrollHeight>e.clientHeight+80);s.forEach(e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event("scroll",{bubbles:true}))});return s.length})()')
    await sleep(2600)
    if (add === 0 && round > 2) break
  }
  const out = [...seen.values()].map(mask)
  // 这个页面会把**历史收藏**一起列出来（老账号十几条很常见），所以不能拿「页面条数」当本轮成绩
  // （审计缺口 D19）。这里用 known_fav.json / known_fav_map.json 里的本轮记录做交集，区分本轮与历史。
  const readJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
  const known = new Set(readJ(path.join(BASE, 'known_fav.json'), []) || [])
  for (const v of Object.values(readJ(path.join(BASE, 'known_fav_map.json'), {}) || {})) known.add(String(v))
  const thisRound = [], historical = []
  for (const c of out) {
    const hit = [...known].some(k => {
      const [nm, age] = String(k).split('|')
      if (!nm) return false
      return c.includes(nm) && (!age || c.includes(age + '岁'))
    })
    ;(hit ? thisRound : historical).push(c)
  }
  fs.writeFileSync(OUT, JSON.stringify({
    captured_at: new Date().toISOString(),
    count: out.length,
    this_round_count: thisRound.length,
    historical_count: historical.length,
    this_round: thisRound,
    historical,
    cards: out,
  }, null, 1), { mode: 0o600 })
  console.log('wrote', OUT, 'total', out.length, 'this_round', thisRound.length, 'historical', historical.length)
  if (historical.length) console.log('提示：该页含历史收藏', historical.length, '条；核对本轮只看 this_round（别拿总条数当成绩）。')
  process.exit(0)
}
main().catch(e => { console.log('FATAL', e.message); process.exit(1) })
