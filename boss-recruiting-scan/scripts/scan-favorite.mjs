#!/usr/bin/env node
// scan-favorite.mjs — BOSS 推荐流「采集 → 判定 → 开浮层 → 收藏 → 审核闸门」
// 用法：
//   node scan-favorite.mjs [--soft-review] [favTarget]     正常跑（收藏目标默认 5；流程在 core/flow.mjs）
//   FAV_DRY_RUN=1 node scan-favorite.mjs 2 1                只判定不点收藏（联调）
//   node scan-favorite.mjs --rollback "真实姓名或card_id,..."  取消收藏
//   node scan-favorite.mjs --batch                           把攒够的待审记录手动结批（exit 42）
//   node scan-favorite.mjs --accept-only                     只接受上一批审核结果（不采集、不收藏、不连 CDP）
//   node scan-favorite.mjs --soft-review 2 5                 点收藏前停一下：写 soft_pack.json，等 soft_ok.json 给 approved（超时 exit 44）
// 环境变量：CDP_URL BOSS_WORK PYTHON_BIN JUDGE_PY SPACING FAV_GAP APPLY_FILTER SKILL_CONFIG
// 硬约束（代码 clamp，env/config 只能更严不能更松）：轮间隔 ≥15s；收藏间隔 ≥12s；
//   日收藏 ≤60；日轮次 ≤200；连续运行 ≤3h；遇验证/登录失效立即停并锁当天。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cleanupKnown } from './known-cleanup.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333'
// 默认工作目录：macOS/Linux 仍是 /tmp/boss（与文档一致）；Windows 用 %TEMP%\boss，避免落到 C:\tmp
const DEFAULT_BASE = process.platform === 'win32' ? path.join(os.tmpdir(), 'boss') : '/tmp/boss'
const BASE = process.env.BOSS_WORK || DEFAULT_BASE
// Python 解释器：显式 PYTHON_BIN 优先；未设置时探测「真的能跑」的那个
// （Windows 上 python3/python 常是应用商店空壳：能执行但 exit 9009、无任何输出）
function resolvePython(bins) {
  for (const bin of bins) {
    if (!bin) continue
    try {
      const r = spawnSync(bin, ['-c', 'import sys; sys.stdout.write(sys.version)'], { encoding: 'utf8', timeout: 15000 })
      if (r.status === 0 && /\d+\.\d+/.test(r.stdout || '')) return bin
    } catch { /* 探测失败，换下一个候选 */ }
  }
  return ''
}
const PY_CANDIDATES = process.platform === 'win32' ? ['python3', 'python', 'py'] : ['python3', 'python']
const PY = process.env.PYTHON_BIN || resolvePython(PY_CANDIDATES) || PY_CANDIDATES[0]
const JUDGE_PY = process.env.JUDGE_PY || path.join(HERE, 'judge.py')
const NAV = 'https://www.zhipin.com/web/chat/recommend'
const FAV_DRY_RUN = process.env.FAV_DRY_RUN === '1'
const APPLY_FILTER = process.env.APPLY_FILTER !== '0'

// ---------- 配置与硬上限 ----------
const HARD = { spacingMin: 15000, favGapMin: 12000, favCap: 60, cycleCap: 200, maxMinutes: 180 }
const cfgPath = process.env.SKILL_CONFIG || path.join(HERE, '..', 'config.json')
let CFG = {}
try { CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch (e) {
  if (fs.existsSync(cfgPath)) { console.log(`FATAL config.json 解析失败（JSON 语法错误）：${cfgPath}\n  ${e.message}`); process.exit(2) }
  if (!process.env.SKILL_CONFIG) console.log(`NOTE: 未找到 ${cfgPath}，使用内置默认值（可从 config.example.json 复制）`)
}
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const SPACING = Math.max(HARD.spacingMin, num(process.env.SPACING, num(CFG?.pacing?.cycleSleepMs, 18000)))
const FAV_GAP = Math.max(HARD.favGapMin, num(process.env.FAV_GAP, num(CFG?.pacing?.favoriteGapMs, 12500)))
// ---------- 节奏抖动（不是绕过风控，只是去掉「精确到毫秒的机器周期」） ----------
// 已有的 SPACING / FAV_GAP 是下限；抖动只在 [base×(1-JITTER), base×(1+JITTER)] 内取整，
// 且任何情况下都不低于 HARD 下限。JITTER_PCT=0 可关掉（回到固定周期）。
const JITTER = Math.min(0.5, Math.max(0, num(process.env.JITTER_PCT, 0.25)))
const jitterOf = base => Math.round(base + (Math.random() * 2 - 1) * base * JITTER)
const pacedSpacing = () => Math.max(HARD.spacingMin, jitterOf(SPACING))
const pacedFavGap = () => Math.max(HARD.favGapMin, jitterOf(FAV_GAP))
// 阅读/操作之间的小停顿（不含任何「随机点击」，只延后下一次真实动作）
const dwell = (lo = 300, hi = 1200) => sleep(lo + Math.floor(Math.random() * (hi - lo + 1)))
const DAILY_FAV_CAP = Math.min(HARD.favCap, Math.max(1, num(CFG?.pacing?.dailyFavoriteCap, HARD.favCap)))
const DAILY_CYCLE_CAP = Math.min(HARD.cycleCap, Math.max(1, num(CFG?.pacing?.dailyCycleCap, HARD.cycleCap)))
const MAX_RUN_MS = Math.min(HARD.maxMinutes, Math.max(1, num(CFG?.pacing?.maxContinuousMinutes, HARD.maxMinutes))) * 60000
// 审核闸门间隔：可设 1..5（默认 5）。
// 1 = 每收藏 1 人就停轮送审（先小后大，最稳）；大于 5 会被压到 5（一次压太多人待审容易漏审）。
const REVIEW_EVERY = (() => {
  const raw = num(process.env.REVIEW_EVERY, num(CFG?.batch?.reviewEvery, 5))
  let v = Math.round(raw)
  if (!Number.isFinite(v) || v < 1) v = 1
  if (v > 5) { console.log(`WARN: reviewEvery=${raw} 超过 5，已按 5 处理（一次压太多人待审容易漏审）`); v = 5 }
  if (v !== 5) console.log(`NOTE: reviewEvery=${v} —— 每收藏 ${v} 人就停轮送审`)
  return v
})()
// 审核没过的人：接收这批判定后是否「立即取消收藏」。
// 1（默认）= 自动回滚被拒者，不需要人工再跑 --rollback；0 = 退回旧行为（先提示，人工回滚）。
const AUTO_ROLLBACK_REJECTED = num(process.env.AUTO_ROLLBACK_REJECTED, CFG?.batch?.autoRollbackRejected === false ? 0 : 1) !== 0
// 软条件审核（可选，默认关）：
//   关着（默认）= 纯脚本：判定器过了就直接收藏，不需要 agent 介入。
//   开着 = 每张判过的卡在「点收藏之前」停下来，把卡片全文 + 详情浮层文本写成 soft_pack.json，
//          等 agent 写 soft_ok.json 给出 approved/reason 再继续：
//            approved=true  → 点收藏；
//            approved=false → 只关详情页，不收藏（下一张）。
//   超时不等于同意：SOFT_TIMEOUT_MIN（默认 15 分钟）内没人给结论就 exit 44，绝不擅自收藏。
const SOFT_REVIEW = process.argv.includes('--soft-review') || num(process.env.SOFT_REVIEW, 0) !== 0
const SOFT_TIMEOUT_MS = Math.max(1, num(process.env.SOFT_TIMEOUT_MIN, 15)) * 60000
const TAB_OFFSET = { '推荐': 56, '精选': 116, '最新': 176 }
// 「精选」一律不收藏：该页的富集卡片要「搜索畅聊卡」才能开聊（付费资源），
// 且卡片/浮层结构与推荐流不同，在这里点收藏等于把节奏和预算放到错的页面上。
const TABS_DISALLOWED = ['精选']
const TAB_NAMES = Array.isArray(CFG?.batch?.tabs) ? CFG.batch.tabs : ['推荐', '最新']
TABS_DISALLOWED.forEach(n => {
  if (TAB_NAMES.includes(n)) console.log(`WARN: config.batch.tabs 含「${n}」，已忽略（铁律：精选页开聊需搜索畅聊卡，本 skill 不在精选页收藏）`)
})
const TABS = TAB_NAMES.filter(n => !TABS_DISALLOWED.includes(n)).map(n => TAB_OFFSET[n]).filter(x => Number.isFinite(x))
const TAB_X = TABS.length ? TABS : [TAB_OFFSET['推荐'], TAB_OFFSET['最新']]

fs.mkdirSync(BASE, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cardId = t => crypto.createHash('sha1').update(String(t), 'utf8').digest('hex').slice(0, 16)
const digestOf = arr => crypto.createHash('sha1').update(arr.join('\n')).digest('hex').slice(0, 16)
// 本地日（Asia/Shanghai），避免 UTC 跨日导致配额/停线失效
const localDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const log = o => fs.appendFileSync(path.join(BASE, 'fav15.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n', { mode: 0o600 })
const writeJSON = (p, obj) => { const t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj, null, 1), { mode: 0o600 }); fs.renameSync(t, p); fs.chmodSync(p, 0o600) }
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const wantOf = o => String(o?.want ?? o?.期望 ?? '').trim()

const appendJSONL = (p, obj) => fs.appendFileSync(p, JSON.stringify(obj) + '\n', { mode: 0o600 })

// ---------- 状态与启动闸门 ----------
const todayStr = localDay()
const MODE = process.argv[2] === '--rollback' || process.argv[2] === '--batch'
// 只接受上一批审核结果：不采集、不收藏、不需要 CDP，也不受停线/配额影响
const ACCEPT_ONLY = process.argv[2] === '--accept-only'
// 节奏自检：打印抖动后的实际间隔分布，确认永远不低于硬下限（不连 CDP、不读写 daily_state）
if (process.argv[2] === '--pacing-selftest') {
  const n = 12
  const s = Array.from({ length: n }, () => pacedSpacing())
  const g = Array.from({ length: n }, () => pacedFavGap())
  console.log('spacing base', SPACING, '±' + Math.round(JITTER * 100) + '%', 'min', Math.min(...s), 'max', Math.max(...s), 'floor', HARD.spacingMin)
  console.log('  samples', s.join(','))
  console.log('favGap  base', FAV_GAP, '±' + Math.round(JITTER * 100) + '%', 'min', Math.min(...g), 'max', Math.max(...g), 'floor', HARD.favGapMin)
  console.log('  samples', g.join(','))
  const ok = Math.min(...s) >= HARD.spacingMin && Math.min(...g) >= HARD.favGapMin
  console.log(ok ? 'PACING_OK' : 'PACING_FAIL')
  process.exit(ok ? 0 : 2)
}
// 判定器单次运行（调试/CI 用；不读 daily_state、不受停线影响）
if (process.argv[2] === '--judge-run') {
  const cardsFile = process.argv[3]
  if (!cardsFile) { console.log('usage: scan-favorite.mjs --judge-run <cards.jsonl>'); process.exit(2) }
  if (!fs.existsSync(cardsFile)) { console.log(`FATAL --judge-run 输入文件不存在：${cardsFile}`); process.exit(2) }
  const cards = fs.readFileSync(cardsFile, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l).card } catch { return '' } })
    .filter(c => typeof c === 'string' && c.trim())
  const res = runJudge(cards)
  console.log('JUDGE_OK', JSON.stringify(res.map(r => ({ cid: r.card_id, name: r.name, c3: r.c3_months }))))
  process.exit(0)
}
// 判定契约自检（不读 daily_state、不受停线影响）
if (process.argv[2] === '--selfcheck-judge') { process.exit(selfcheckJudge()) }
const statePath = path.join(BASE, 'daily_state.json')
let state = readJSON(statePath, null)
if (!state || state.date !== todayStr) state = { date: todayStr, favorites: 0, cycles: 0, startedAt: Date.now(), batchSeq: state?.batchSeq || 0, pendingBatch: state?.pendingBatch || null, sinceBatch: state?.sinceBatch || 0, pendingRecords: state?.pendingRecords || [] }
state.batchSeq = state.batchSeq || 0
state.sinceBatch = state.sinceBatch || 0
state.pendingRecords = state.pendingRecords || []
const saveState = () => writeJSON(statePath, state)

const stopPath = path.join(BASE, 'STOP_TODAY')
const restPath = path.join(BASE, 'REST_UNTIL')
const stopHit = fs.existsSync(stopPath) && fs.readFileSync(stopPath, 'utf8').includes(todayStr)
let restHit = 0
if (fs.existsSync(restPath)) { const u = Number((fs.readFileSync(restPath, 'utf8').split('\n')[0] || '0')); if (Number.isFinite(u) && u > Date.now()) restHit = u }
const quotaHit = state.favorites >= DAILY_FAV_CAP ? 'DAILY_FAV_CAP(' + state.favorites + ')'
  : state.cycles >= DAILY_CYCLE_CAP ? 'DAILY_CYCLE_CAP(' + state.cycles + ')'
  : (state.startedAt ? (Date.now() - state.startedAt > MAX_RUN_MS ? 'RUN_LIMIT' : null) : null)
// 注意：停线/配额检查被移到了「接受上一批审核结果」之后（见文件下方）。
// 顺序反了会出现：当天收藏到顶 → 先被 RUN_LIMIT 拦下 → 最后一批永远结不清（审计缺口 D16）。

// 中断恢复：已有满 5 条待审记录但没生成 batch（上次在 closeOverlay/退出时被打断）
if (!MODE && !FAV_DRY_RUN && !state.pendingBatch && state.pendingRecords.length >= REVIEW_EVERY) {
  writeReviewBatch(state.pendingRecords.slice(0, REVIEW_EVERY))
}
// 审核闸门：未审的 batch 必须先审核（校验 digest 与 approved ids），否则拒绝继续。
// 抽成函数是为了支持 --accept-only：只接受上一批，不采集、不收藏、也不需要 CDP（审计缺口 D15）。
async function acceptPendingBatch() {
  if (!state.pendingBatch || FAV_DRY_RUN) return false
  const n = state.pendingBatch
  const batch = readJSON(path.join(BASE, `review_batch_${n}.json`), null)
  const ok = readJSON(path.join(BASE, `review_ok_${n}.json`), null)
  const ids = (batch?.candidates || []).map(c => c.card_id)
  const ap = Array.isArray(ok?.approved_card_ids) ? ok.approved_card_ids : []
  const rj = Array.isArray(ok?.rejected_card_ids) ? ok.rejected_card_ids : []
  const covered = new Set([...ap, ...rj])
  const valid = !!batch && !!ok && ok.batch === n && ok.digest === batch.digest
    && ap.length + rj.length === ids.length && ids.every(id => covered.has(id))
    && ap.every(id => ids.includes(id)) && rj.every(id => ids.includes(id))
    && !ap.some(id => rj.includes(id))
  if (!valid) {
    const digestOk = !!ok && ok.digest === (batch?.digest || '')
    const coverOk = ids.length === ap.length + rj.length && ids.every(id => covered.has(id))
    if (!digestOk) console.log(`REVIEW_PENDING batch=${n} — digest 不一致：review_ok_${n}.json 应为 "${batch?.digest || ''}"（当前 "${ok?.digest || '缺失'}"）`)
    else if (!coverOk) console.log(`REVIEW_PENDING batch=${n} — approved+rejected 未覆盖全部候选（应为 ${ids.length} 个，收到 ${ap.length + rj.length} 个或含未知 id）`)
    else console.log(`REVIEW_PENDING batch=${n} — review_ok_${n}.json 的 batch/approved/rejected 字段不合法或存在重叠`)
    console.log(`模板：{"batch":${n},"digest":"${batch?.digest || ''}","approved_card_ids":[...],"rejected_card_ids":[...]}`)
    process.exit(42)
  }
  if (rj.length) {
    const cand = new Map((batch?.candidates || []).map(c => [c.card_id, c]))
    const stillOf = kf => rj.filter(id => {
      if (kf.has(id)) return true
      const c = cand.get(id)
      return !!(c && c.name && c.age != null && kf.has(`${c.name}|${c.age}`))
    })
    let still = stillOf(new Set(readJSON(path.join(BASE, 'known_fav.json'), [])))
    // 「审核没过就立刻取消收藏」：默认 AUTO_ROLLBACK_REJECTED=1，接收这批判定后自动回滚被拒者，
    // 不需要人工再跑 --rollback；回滚失败才留 rollback_queue.json 等下次重试。
    if (still.length && AUTO_ROLLBACK_REJECTED) {
      const r = await autoRollbackRejected(n, batch, still)
      if (r.missed.length) {
        seedRollbackQueue(r.missed)
        console.log(`AUTO_ROLLBACK 未完成 batch=${n}：${r.missed.length} 人仍可能在收藏中 → 已写 rollback_queue.json，下次运行会先重试`)
        process.exit(42)
      }
      still = stillOf(new Set(readJSON(path.join(BASE, 'known_fav.json'), [])))
    }
    if (still.length) { console.log(`REJECTED_STILL_FAVORITED batch=${n}: ${still.join(',')} — 先 --rollback 再继续（或设 AUTO_ROLLBACK_REJECTED=1 让它自动取消）`); process.exit(42) }
    if (rj.length) {
      const rejPath = path.join(BASE, 'rejected.json')
      const cur = readJSON(rejPath, [])
      const have = new Set(cur.flatMap(x => [x.card_id, `${x.name}|${x.age}`]))
      for (const id of rj) {
        const c = cand.get(id) || {}
        if (!have.has(id)) { cur.push({ card_id: id, name: c.name, age: c.age, want: wantOf(c), ts: new Date().toISOString() }); have.add(id); have.add(`${c.name}|${c.age}`) }
      }
      writeJSON(rejPath, cur)
    }
    console.log(`WARN: batch ${n} 有 ${rj.length} 人被拒（已确认不在 known_fav；已写入 rejected.json，后续不会再收藏）`)
  }
  state.pendingBatch = null; saveState()
  console.log(`review_ok_${n} accepted (${(ok.approved_card_ids || []).length} approved)`)
  return true
}

// --accept-only：只接受上一批审核结果（不采集、不收藏、不连 CDP）
if (ACCEPT_ONLY) {
  const accepted = await acceptPendingBatch()
  if (accepted) process.exit(0)
  console.log(state.pendingBatch ? `ACCEPT_ONLY: batch=${state.pendingBatch} 还不能接受（原因见上面的 REVIEW_PENDING 提示）` : 'ACCEPT_ONLY: 当前没有待审批次')
  process.exit(state.pendingBatch ? 42 : 0)
}

// 先接受上一批，再检查停线/配额
if (!MODE && !FAV_DRY_RUN) await acceptPendingBatch()

if (MODE) {
  // 纠正模式：撤回误点/结批/接受审核不受停线与配额影响（auditor X1）
  if (stopHit || restHit || quotaHit) console.log('注意：存在停止/配额状态（' + (stopHit ? 'STOP_TODAY' : restHit ? 'REST_UNTIL' : quotaHit) + '），--rollback/--batch/--accept-only 仍允许执行')
} else {
  if (stopHit) { console.log('STOP_TODAY: 今天已因风险信号停止'); process.exit(2) }
  if (restHit) { console.log('REST_UNTIL 未到，休息中：', new Date(restHit).toISOString()); process.exit(2) }
  if (quotaHit) { console.log(quotaHit, '已达上限'); process.exit(2) }
}
function targetFav() { return Math.max(1, Number(process.argv[3] || 5)) }
if (!MODE && targetFav() > DAILY_FAV_CAP - state.favorites) {
  const rem = Math.max(1, DAILY_FAV_CAP - state.favorites)
  console.log(`WARN: TARGET ${targetFav()} 超过今日剩余额度（剩 ${DAILY_FAV_CAP - state.favorites}），自动夹到 ${rem}`)
  process.argv[3] = String(rem)
}
saveState()

// ---------- CDP ----------
let ws, id = 0
const pend = new Map()
async function connect() {
  let list
  try { list = await (await fetch(CDP + '/json/list')).json() } catch (e) {
    console.log(`FATAL 无法连接 Chrome 调试端口 ${CDP} —— 请确认：1) Chrome 以 --remote-debugging-port=9333 启动；2) CDP_URL 与环境一致；3) 端口未被占用。底层错误：${e.message}`)
    process.exit(2)
  }
  const t = list.find(x => x.type === 'page' && /zhipin/.test(x.url))
  if (!t) throw new Error('找不到 BOSS 页面（先打开推荐页）')
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')) })
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) } }
}
const send = (method, params = {}) => {
  const i = ++id
  const p = new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + method)), 25000))])
}
const frames = async () => { const { frameTree } = await send('Page.getFrameTree'); const out = []; const w = n => { out.push({ id: n.frame.id, url: n.frame.url }); (n.childFrames || []).forEach(w) }; w(frameTree); return out }
const recFrame = async () => (await frames()).find(f => /web\/frame\/recommend\//.test(f.url))
// 浮层是否真的打开：看推荐帧里的 boss-popup 面板是否存在且不在离场过渡中。
// 踩过的坑：① c-resume 画布帧关闭后仍常驻，用帧树判断会永远为真；
//          ② 面板关不掉时 Vue 会卡在 v-leave/v-leave-active（opacity 仍为 1），必须按类名排除。
const cResumeOpen = async () => {
  try {
    const rf = await recFrame()
    if (!rf) return false
    return !!(await evalIn(rf.id, `(()=>{const a=[...document.querySelectorAll('.boss-popup__wrapper')].filter(w=>!/v-leave/.test(w.className));const d=a[a.length-1];if(!d)return false;const b=d.getBoundingClientRect();return b.width>0&&b.height>0})()`))
  } catch { return false }
}
const evalTop = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value
async function evalIn(frameId, expr) {
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'boss-scan', grantUniveralAccess: true })
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: expr, contextId: executionContextId, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error('eval:' + JSON.stringify(exceptionDetails).slice(0, 160))
  return result.value
}
async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

// ---------- 安全停线（顶层 + 各 iframe 正文 + URL + 登录） ----------
const RISK_RE = /passport\/verify|_security_check|verify\.html|安全验证|操作频繁|请求过于频繁|访问异常|环境异常/
const LOGIN_RE = /注册登录|请登录|扫码登录/
async function riskScan() {
  const urls = (await frames().catch(() => [])).map(f => f.url).join('\n')
  const top = await evalTop('location.href+"\\n"+document.title+"\\n"+(document.body?document.body.innerText.slice(0,3000):"")').catch(() => '')
  if (RISK_RE.test([urls, top].join('\n'))) return 'security'
  const fs2 = (await frames().catch(() => [])).filter(f => /^https?:/.test(f.url)).slice(0, 6)
  for (const f of fs2) {
    try {
      const t = await evalIn(f.id, 'document.body?document.body.innerText.slice(0,800):""')
      if (RISK_RE.test(t || '')) return 'security'
    } catch { /* 跨域帧跳过 */ }
  }
  if (LOGIN_RE.test(top || '') && !/退出登录/.test(top || '')) return 'login'
  return null
}
async function stopRisk(kind) {
  try { const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); fs.writeFileSync(path.join(BASE, 'security_' + Date.now() + '.jpg'), Buffer.from(data, 'base64'), { mode: 0o600 }) } catch { /* 截图失败不阻塞 */ }
  fs.writeFileSync(stopPath, todayStr + '\n' + kind + '\n', { mode: 0o600 })
  console.log('SECURITY STOP:', kind, '— 已截图并写 STOP_TODAY')
  process.exit(2)
}
async function assertSafe() { const k = await riskScan(); if (k) await stopRisk(k) }

// ---------- 判定 ----------
function runJudge(cards) {
  const valid = (cards || []).filter(c => typeof c === 'string' && c.trim())
  if (!valid.length) { console.log('FATAL 没有任何有效卡片（页面抽取为空或全为空串）'); process.exit(2) }
  const tmp = path.join(BASE, '.live_cards.jsonl')
  const OUTS = ['strict3v2_ok.json', 'strict3v2_near.json', 'strict3v2_all.json', 'strict3v2_summary.json']
    .map(n => path.join(BASE, n))
  // 防 stale：先删上一轮的全部判定输出；判定器若不产出，下面必然 FATAL（不能消费旧结果）
  for (const p of OUTS) fs.rmSync(p, { force: true })
  fs.writeFileSync(tmp, valid.map(c => JSON.stringify({ card: c })).join('\n') + '\n', { mode: 0o600 })
  try {
    execFileSync(PY, [JUDGE_PY, tmp], { cwd: BASE, stdio: 'pipe', env: { ...process.env, BOSS_WORK: BASE } })
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    if (e.code === 'ENOENT' || e.status === 9009) {
      console.log(`FATAL 找不到可用的 Python 解释器：PYTHON_BIN=${JSON.stringify(process.env.PYTHON_BIN || '(未设置)')}`)
      console.log('  Windows：应用商店的 python3.exe / python.exe 是空壳（exit 9009），请把 PYTHON_BIN 指到真实 python.exe（或用 py 启动器）；macOS/Linux：确认 python3 在 PATH。')
    }
    console.log('FATAL judge failed:', String(e.stderr || e.message).slice(0, 400))
    process.exit(2)
  }
  fs.rmSync(tmp, { force: true })
  // judge 会 import strict2，产生 __pycache__；随手清掉保持目录干净
  fs.rmSync(path.join(HERE, '__pycache__'), { recursive: true, force: true })
  const out = path.join(BASE, 'strict3v2_ok.json')
  if (!fs.existsSync(out)) { console.log('FATAL judge 未产出 strict3v2_ok.json'); process.exit(2) }
  let arr
  try { arr = JSON.parse(fs.readFileSync(out, 'utf8')) } catch (e) {
    console.log('FATAL strict3v2_ok.json 不是合法 JSON:', String(e.message).slice(0, 200)); process.exit(2)
  }
  if (!Array.isArray(arr)) { console.log('FATAL strict3v2_ok.json 不是数组（判定器契约要求数组）'); process.exit(2) }
  // schema 校验：缺字段/类型不对/verdict 非 PASS 一律 FATAL，避免「缺字段被当成通过」
  const REQUIRED = ['card_id', 'name', 'age', 'city', 'want', 'verdict', 'c1_months', 'c1_segments', 'c2_level', 'c3_months', 'c3_segments']
  const bad = []
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i] || {}
    const miss = REQUIRED.filter(k => !(k in r))
    if (miss.length) bad.push(`#${i} 缺字段 ${miss.join(',')}`)
    if (r.verdict !== 'PASS') bad.push(`#${i} verdict=${JSON.stringify(r.verdict)} 非 PASS`)
    if (typeof r.card_id !== 'string' || !/^[0-9a-f]{16}$/.test(r.card_id)) bad.push(`#${i} card_id 非 16hex`)
    if (typeof r.name !== 'string' || !r.name.trim()) bad.push(`#${i} name 为空（必须掩码姓名，如「张**」）`)
    else if (!/^[\u4e00-\u9fffA-Za-z]{1,6}\*{2}$/.test(r.name)) bad.push(`#${i} name=${JSON.stringify(r.name)} 未掩码或格式不符（必须输出如「张**」的「前缀+**」掩码）`)
    else if (/^[0-9a-f]{4}\*\*$/.test(r.name)) bad.push(`#${i} name=${JSON.stringify(r.name)} 是占位掩码（页面文本匹配不到，回滚会失效；请跳过该卡）`)
    if (typeof r.age !== 'number' || !Number.isFinite(r.age)) bad.push(`#${i} age 非数字`)
    if (!Number.isInteger(r.c1_months)) bad.push(`#${i} c1_months 非整数（月数契约）`)
    if (!Number.isInteger(r.c3_months)) bad.push(`#${i} c3_months 非整数（月数契约）`)
    if (!Array.isArray(r.c1_segments)) bad.push(`#${i} c1_segments 非数组`)
    if (!Array.isArray(r.c3_segments)) bad.push(`#${i} c3_segments 非数组`)
    if (typeof r.c2_level !== 'string') bad.push(`#${i} c2_level 非字符串`)
    if (!Array.isArray(r.c2_evidence) && r.c2_level !== 'none') bad.push(`#${i} c2_evidence 非数组`)
    if ('city_rank' in r && (!Number.isInteger(r.city_rank) || r.city_rank < 0 || r.city_rank > 2)) bad.push(`#${i} city_rank 必须是 0/1/2 的整数（判定器可选输出，用于城市优先排序）`)
    if (Number.isInteger(r.c3_months) && r.c3_months < 0) bad.push(`#${i} c3_months 不能为负`)
  }
  if (bad.length) { console.log('FATAL judge 输出未通过 schema 校验（判定器契约如下）:'); bad.slice(0, 10).forEach(x => console.log('  -', x)); process.exit(2) }
  if (!arr.length) {
    const near = (() => { try { return JSON.parse(fs.readFileSync(path.join(BASE, 'strict3v2_near.json'), 'utf8')) } catch { return [] } })()
    const all = (() => { try { const v = JSON.parse(fs.readFileSync(path.join(BASE, 'strict3v2_all.json'), 'utf8')); return Array.isArray(v) ? v.length : 0 } catch { return 0 } })()
    if (!Array.isArray(near) || !near.length) {
      if (!all) { console.log('FATAL 判定器输出全为空（ok/near/all 均为空）—— 检查数据或判定器是否真的在跑'); process.exit(2) }
    }
    console.log(`WARN 判定器本轮 0 条 PASS（near=${Array.isArray(near) ? near.length : 0}, all=${all}）——累计收藏不会增长`)
  }
  // 城市优先/条件强弱排序：city_rank 升序（0 优先）→ c3_months 降序 → 保持原顺序
  arr.sort((a, b) => ((a.city_rank ?? 9) - (b.city_rank ?? 9)) || ((b.c3_months || 0) - (a.c3_months || 0)))
  return arr
}

// ---------- 判定契约自检（无需浏览器） ----------
function selfcheckJudge() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-judgecheck-'))
  // 自检用「真能跑的解释器」跑 stub：先按平台探测，探测不到才退回 PYTHON_BIN
  // （语义仍是「不依赖用户配的 judge 解释器」，只是 Windows 上不能写死 python3）
  const selfPy = resolvePython(PY_CANDIDATES) || resolvePython([process.env.PYTHON_BIN])
  if (!selfPy) {
    fs.rmSync(tmp, { recursive: true, force: true })
    console.log('FATAL 找不到可用的 Python 解释器，判定契约自检无法进行（请把 PYTHON_BIN 指向真实 python.exe；Windows 上 py 启动器也算）')
    return 2
  }
  const base = path.join(tmp, 'work'); fs.mkdirSync(base, { recursive: true })
  const cards = path.join(tmp, 'cards.jsonl')
  const card = '20-30K 张** 本周活跃 32岁 8年 硕士 期望 长沙 项目经理 优势 专八 2020.05 2024.08 中联重科股份有限公司 项目经理'
  fs.writeFileSync(cards, JSON.stringify({ card }) + '\n')
  const rec = (over = {}) => ({ card_id: 'a'.repeat(16), name: '张**', age: 32, city: '长沙', want: '项目经理',
    verdict: 'PASS', c1_months: 51, c1_segments: [], c2_level: 'A', c2_evidence: [], c3_months: 51, c3_segments: [], ...over })
  const writeStub = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p }
  const good18 = writeStub('good18.py', `import json,os\nbase=os.environ['BOSS_WORK']\njson.dump([${JSON.stringify(rec({ c3_months: 19 }))}],open(os.path.join(base,'strict3v2_ok.json'),'w'))\n`)
  const noout = writeStub('noout.py', 'import sys\nsys.exit(0)\n')
  const badschema = writeStub('badschema.py', `import json,os\nbase=os.environ['BOSS_WORK']\nr=${JSON.stringify(rec())}\ndel r['c3_months']\njson.dump([r],open(os.path.join(base,'strict3v2_ok.json'),'w'))\n`)
  const run = (judge, extraEnv = {}) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--judge-run', cards], {
    env: { ...process.env, BOSS_WORK: base, JUDGE_PY: judge, PYTHON_BIN: selfPy, ...extraEnv }, encoding: 'utf8' })
  const cleanupTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
  const cases = []
  // 1) 判定层门槛 18 月（c3=19）必须被接受：证明流程层不再硬编码 24
  const r1 = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--judge-run', cards], {
    env: { ...process.env, BOSS_WORK: base, JUDGE_PY: good18, PYTHON_BIN: selfPy }, encoding: 'utf8' })
  cases.push(['c3=19 且 min18 被接受（流程层无 24 月硬编码）', r1.status === 0 && /JUDGE_OK/.test(r1.stdout || '')])
  // 2) 判定器不产出文件 → FATAL exit 2
  const r2 = run(noout)
  cases.push(['判定器不产出 strict3v2_ok.json → exit 2', r2.status === 2 && /未产出/.test(r2.stdout || '')])
  // 3) stale 文件必须被清掉（先放一份合法旧结果，再让判定器不产出）
  fs.writeFileSync(path.join(base, 'strict3v2_ok.json'), JSON.stringify([rec({ card_id: 'deadbeefdeadbeef', name: '旧**' })]))
  const r3 = run(noout)
  cases.push(['stale strict3v2_ok.json 被清理（不消费旧口径）', r3.status === 2])
  // 4) schema 缺字段 → exit 2
  const r4 = run(badschema)
  cases.push(['判定器输出缺 c3_months → schema 校验失败 exit 2', r4.status === 2 && /schema/.test(r4.stdout || '')])
  // 5) 未掩码姓名 → schema 拒绝（隐私边界）
  const badname = writeStub('badname.py', `import json,os\nbase=os.environ['BOSS_WORK']\nr=${JSON.stringify(rec())}\nr['name']='张三'\njson.dump([r],open(os.path.join(base,'strict3v2_ok.json'),'w'))\n`)
  const r5 = run(badname)
  cases.push(['未掩码姓名 → schema 校验失败 exit 2', r5.status === 2 && /未掩码/.test(r5.stdout || '')])
  // 6) 非整数月数 → schema 拒绝（月数契约）
  const badfloat = writeStub('badfloat.py', `import json,os\nbase=os.environ['BOSS_WORK']\nr=${JSON.stringify(rec())}\nr['c1_months']=30.5\njson.dump([r],open(os.path.join(base,'strict3v2_ok.json'),'w'))\n`)
  const r6 = run(badfloat)
  cases.push(['c1_months 非整数 → schema 校验失败 exit 2', r6.status === 2 && /非整数/.test(r6.stdout || '')])
  let bad = 0
  for (const [name, ok] of cases) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) bad++ }
  console.log(`\njudge-contract selftest: ${cases.length - bad}/${cases.length} passed`)
  cleanupTmp()
  return bad === 0 ? 0 : 1
}

// ---------- 浮层 / 收藏 / 关闭 ----------
async function closeOverlay() {
  const frame = (await frames()).find(f => /web\/frame\/recommend\//.test(f.url))
  // 浮层的关闭 X 是推荐帧里的 div.close-btn（旧实现按 (clientWidth-126, 57) 猜，实测偏 ~100px）
  if (frame) {
    await evalIn(frame.id, `(()=>{const d=${LIVE_DLG};if(!d)return 'no-live';const e=d.querySelector('.close-btn');if(!e)return 'no-x';e.click();return 'ok'})()`).catch(() => {})
    for (let t = 0; t < 8 && (await cResumeOpen()); t++) await sleep(300)
    // 清掉卡在离场过渡里的垃圾节点：它们会盖住整个 iframe（pointerEvents 仍是 auto），挡住后续点击
    const cleaned = await evalIn(frame.id, `(()=>{const a=[...document.querySelectorAll('.boss-popup__wrapper')].filter(w=>/v-leave/.test(w.className));a.forEach(w=>w.remove());return a.length})()`).catch(() => 0)
    if (cleaned) console.log('overlay cleanup: removed', cleaned, 'stuck node(s)')
    if (!(await cResumeOpen())) return
  }
  // 兜底 1：在推荐帧自己的文档里派发 Escape（顶层 Input 的 Escape 到不了这个帧）
  try {
    const rf = await frames().then(a => a.find(f => /web\/frame\/recommend\//.test(f.url)))
    if (rf) await evalIn(rf.id, `(()=>{const k=new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true});document.dispatchEvent(k);window.dispatchEvent(k)})()`)
  } catch { /* 忽略 */ }
  await sleep(700)
  if (!(await cResumeOpen())) return
  // 兜底 2：按 X 的真实位置点（帧内 rect + 顶层 iframe 偏移），最后才用旧坐标
  if (frame) {
    const r = await evalIn(frame.id, `(()=>{const e=document.querySelector('.close-btn');if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`).catch(() => null)
    const off = await evalTop(`(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top}})()`).catch(() => null)
    if (r && off) { await click(off.x + r.x, off.y + r.y); await sleep(800) }
  }
  if (await cResumeOpen()) {
    const w = (await evalTop('document.documentElement.clientWidth')) || 1431
    await click(w - 126, 57); await sleep(800)
  }
}
async function toastState() {
  return evalTop('(()=>{const t=document.body.innerText;if(t.includes("取消收藏成功"))return "unfav";if(t.includes("收藏成功"))return "fav";return "none"})()')
}
// 收藏控件在「推荐牛人」iframe 里（卡片浮层的右侧工具条），不是顶层文档；
// 旧实现按 (clientWidth-360, 95) 猜坐标，窗口宽度不同就会点空 —— 改成按元素点击 + 读控件自证。
// 页面会累积多个 .boss-popup__wrapper（每次开卡一个，关不掉的会卡在 v-leave），
// 所以只认「最后一个不在离场过渡里」的那一个，其余当作垃圾节点。
const LIVE_DLG = `(()=>{const a=[...document.querySelectorAll('.boss-popup__wrapper')].filter(w=>!/v-leave/.test(w.className));return a.length?a[a.length-1]:null})()`
async function favControlState(frameId) {
  return evalIn(frameId, `(()=>{const d=${LIVE_DLG};if(!d)return 'missing';const e=d.querySelector('.like-icon-and-text');if(!e)return 'missing';
    const t=(e.innerText||'').replace(/\\s+/g,'');
    if(t.includes('已收藏')||t.includes('取消收藏'))return 'fav';
    if(t.includes('收藏'))return 'idle';
    return 'unknown'})()`)
}
async function favClickElement(frameId) {
  return evalIn(frameId, `(()=>{const d=${LIVE_DLG};if(!d)return 'no-el';const e=d.querySelector('.like-icon-and-text');if(!e)return 'no-el';e.click();return 'ok'})()`)
}
async function favorite(w, opts = {}) {
  const restore = opts.restoreOnUnfav !== false
  const frame = (await frames()).find(f => /web\/frame\/recommend\//.test(f.url))
  if (!frame) { console.log('favorite: 推荐帧不存在，无法收藏'); return 'none' }
  const before = await favControlState(frame.id)
  let st = 'none'
  await dwell(250, 900) // 看到浮层到点收藏之间留一点人眼扫读时间
  // 浮层右侧工具条是异步挂载的，最多等 10s 再判定「控件不存在」
  let r = 'no-el'
  for (let t = 0; t < 20; t++) {
    r = await favClickElement(frame.id)
    if (r === 'ok') break
    await sleep(500)
  }
  if (r !== 'ok') {
    const hint = await evalIn(frame.id, `(()=>{const f=document.querySelector('.dialog-footer');return f?('footer:'+f.innerText.replace(/\\s+/g,'')):'no-footer'})()`)
    console.log('favorite: 工具条 10s 内未出现（' + hint + '）')
  }
  if (r === 'ok') {
    for (let i = 0; i < 12; i++) {
      await sleep(700)
      const now = await favControlState(frame.id)
      if (before === 'fav' && now === 'idle') { st = 'unfav'; break }
      if (before !== 'fav' && now === 'fav') { st = 'fav'; break }
    }
    const toast = await toastState()
    if (toast !== 'none') st = toast
  } else {
    console.log('favorite: .like-icon-and-text 未找到，回退坐标点击（可能点空）')
    const fx = w - 360
    await click(fx, 95); await sleep(1700)
    st = await toastState()
    if (st === 'none') { await sleep(600); await click(fx, 95); await sleep(1700); st = await toastState() }
  }
  if (st === 'unfav' && restore) {
    await sleep(400)
    await favClickElement(frame.id)
    for (let i = 0; i < 10; i++) { await sleep(700); if (await favControlState(frame.id) === 'fav') { st = 'fav'; break } }
  }
  return st
}

// ---------- 审核闸门（digest 校验） ----------
function writeReviewBatch(records) {
  // D12：批号取 batchSeq 与 pendingBatch 的较大者 + 1，避免「上一批还没审完又写同号批文件」把证据覆盖掉
  const n = Math.max(Number(state.batchSeq) || 0, Number(state.pendingBatch) || 0) + 1
  const ids = records.map(r => r.card_id)
  writeJSON(path.join(BASE, `review_batch_${n}.json`), {
    batch: n, created_at: new Date().toISOString(), digest: digestOf(ids), declared: records.length,
    candidates: records.map(r => ({
      card_id: r.card_id, name: r.name, name_real: r.name_real || '', age: r.age, city: r.city, want: r.want, verdict: r.verdict,
      c1_months: r.c1_months, c1_segments: r.c1_segments || [], c2_level: r.c2_level, c2_evidence: r.c2_evidence || [],
      c3_months: r.c3_months, c3_segments: r.c3_segments || [], flags: r.flags || []
    }))
  })
  state.batchSeq = n; state.pendingBatch = n; state.sinceBatch = Math.max(0, (state.sinceBatch || 0) - records.length)
  state.pendingRecords = (state.pendingRecords || []).slice(records.length)
  saveState()
  console.log(`REVIEW_REQUIRED batch=${n} (${records.length} 人) — 审核后写 review_ok_${n}.json：{"batch":${n},"digest":"${digestOf(ids)}","approved_card_ids":[...],"rejected_card_ids":[...]}`)
  process.exit(42)
}

// 回滚后把「这个人的收藏」从所有账本里退回去（D17/D18）
function dropRolledBackRecords(key, removedIds = []) {
  const ids = new Set(removedIds)
  const samePerson = (r) => !!r && ((r.card_id && ids.has(r.card_id)) || (key.includes('|') && `${r.name}|${r.age}` === key))
  state.favorites = Math.max(0, (state.favorites || 0) - 1)
  state.sinceBatch = Math.max(0, (state.sinceBatch || 0) - 1)
  const before = (state.pendingRecords || []).length
  state.pendingRecords = (state.pendingRecords || []).filter(r => !samePerson(r))
  saveState()
  if (before !== state.pendingRecords.length) console.log('rollback: 从 pendingRecords 移除', before - state.pendingRecords.length, '条')
  const p = path.join(BASE, 'passes.jsonl')
  if (fs.existsSync(p)) {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    const kept = lines.filter(l => { try { return !samePerson(JSON.parse(l)) } catch { return true } })
    if (kept.length !== lines.length) {
      fs.writeFileSync(p, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 })
      console.log('rollback: 从 passes.jsonl 移除', lines.length - kept.length, '条')
    }
  }
}

// ---------- 回滚 ----------
async function rollback(keys, opts = {}) {
  if (FAV_DRY_RUN) { console.log('FAV_DRY_RUN=1，回滚被禁用'); if (opts.exit === false) return { ok: false, reason: 'dry-run', hits: 0, missed: [...keys] }; process.exit(1) }
  // 回滚接受：真实姓名 / 掩码姓名 / card_id。
  // card_id → 真实姓名（real_names.json 是本脚本在开浮层时抓到的），抓不到的再报错。
  const realNames = readJSON(path.join(BASE, 'real_names.json'), {})
  const bad = []
  const resolved = []
  for (const k of keys) {
    if (/^[0-9a-f]{16}$/.test(k)) {
      const rn = realNames[k]
      if (rn) { resolved.push(rn); console.log('rollback: card_id', k, '→ 真实姓名', rn) } else bad.push(k)
    } else resolved.push(k)
  }
  if (bad.length) { console.log('rollback: 这些 card_id 没有记录真实姓名（real_names.json 里没有），请改传真实姓名：', bad.join(',')); if (opts.exit === false) return { ok: false, reason: 'no-real-name', hits: 0, missed: bad }; process.exit(2) }
  keys = resolved
  await connect(); await send('Page.enable'); await assertSafe()
  await send('Page.navigate', { url: 'https://www.zhipin.com/web/chat/interaction?status=9' })
  let fr = null
  for (let k = 0; k < 40; k++) { await sleep(900); fr = (await frames()).find(f => /recommend\/interaction/.test(f.url)); if (fr) break }
  if (!fr) { console.log('rollback: 找不到收藏牛人列表'); if (opts.exit === false) return { ok: false, reason: 'no-list', hits: 0, missed: [...keys] }; process.exit(2) }
  // D14：收藏列表是懒加载的，帧出现 ≠ 列表渲染完。冷启动第一次直接读会拿到 0 张，
  // 于是被判成「全部未命中」并 exit 2（实测 7 秒误报、同一条命令重试 27 秒才成功）。这里补就绪轮询。
  let listReady = false
  for (let t = 0; t < 25; t++) {
    await sleep(1200)
    const n = await evalIn(fr.id, 'document.querySelectorAll(".card-item").length').catch(() => -1)
    if (n > 0) { listReady = true; break }
  }
  if (!listReady) console.log('WARN rollback: 30s 内没读到任何 .card-item（列表可能为空或仍在加载）')
  const known = new Set(readJSON(path.join(BASE, 'known_fav.json'), []))
  const done = new Set()
  const missed = new Set()
  let hits = 0
  for (let r = 0; r < 30; r++) {
    let cards = []
    for (let t = 0; t < 6; t++) {
      cards = await evalIn(fr.id, 'Array.from(document.querySelectorAll(".card-item")).map(c=>(c.innerText||"").replace(/\\s+/g," ").trim())').catch(() => [])
      if (Array.isArray(cards) && cards.length) break
      await sleep(1200)
    }
    if (!Array.isArray(cards)) cards = []
    let progressed = false
    for (const key of keys) {
      if (done.has(key)) continue
      let idx = cards.findIndex(t => t.includes(key))
      if (idx < 0) {
        // 兼容「真实姓名|年龄」「掩码唐**|27」「仅姓名」：名字按 \\S* 通配，年龄用「N岁」匹配
        const parts = key.split('|')
        const raw = parts[0]
        // 掩码里的 * 视为通配；其余正则元字符先转义
        const nm = raw.includes('*')
          ? raw.split('*').map(seg => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\S*')
          : raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const age = parts[1] && /^\d{1,3}$/.test(parts[1]) ? parts[1] : null
        const re = age ? new RegExp(nm + '(?:\\s+[^\\s]+){0,2}\\s+' + age + '岁') : new RegExp(nm)
        idx = cards.findIndex(t => re.test(t))
      }
      if (idx < 0) { missed.add(key); continue }
      const cardText = cards[idx]
      if (/打招呼|联系Ta|畅聊|搜索畅聊卡/.test(cardText)) { console.log('rollback allowlist block', key); continue }
      // 读卡 → 点击之间可能被懒加载/重排打断（DOM 竞态），读不到 rect 就跳过这一轮，别抛未捕获异常。
      const rect = await evalIn(fr.id, `(()=>{const c=document.querySelectorAll('.card-item')[${idx}];if(!c)return null;c.scrollIntoView({block:'center'});const n=c.querySelector('a,[class*="name"],h4,h3')||c;const b=n.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height}})()`).catch(() => null)
      if (!rect) { console.log('rollback: 卡片已重排，跳过本轮', key); missed.add(key); continue }
      await sleep(600)
      // D14：开浮层用「元素点击优先 + 轮询」，坐标只做兜底。
      // 实测：收藏牛人页按坐标点 (off.x+rect.x+…) 会落空（overlay not opened），
      // 而 c.querySelector('.row.name-wrap').click() 稳定打开浮层（浮层 wrapper 就在 interaction 帧里）。
      // 元素点击给 12s（24×500ms）；坐标兜底只给 8s。el-click 已送达时不再补一次坐标点击，
      // 否则「点了但慢」的情况会重复点同一张卡（同一位置再点一次没有收益，还会让落点在浮层上）。
      const waitOpen = async (tries = 16) => { for (let t = 0; t < tries; t++) { if (await cResumeOpen()) return true; await sleep(500) } return false }
      const elClick = await evalIn(fr.id, `(()=>{const c=document.querySelectorAll('.card-item')[${idx}];if(!c)return 'no-card';const n=c.querySelector('.row.name-wrap')||c.querySelector('[class*="name"]')||c;n.click();return 'el-click'})()`).catch(() => 'err')
      let openedNow = elClick === 'el-click' && (await waitOpen(24))
      if (!openedNow && elClick !== 'el-click') {
        const off = await evalTop(`(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/interaction'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top}})()`)
        if (!off) { console.log('rollback: iframe offset missing'); if (opts.exit === false) return { ok: false, reason: 'no-offset', hits, missed: [...missed] }; process.exit(2) }
        console.log('rollback: element click 未生效，回退坐标点击', key, elClick)
        await click(off.x + rect.x + Math.min(rect.w * 0.5, 160), off.y + rect.y + Math.min(rect.h * 0.5, 22))
        openedNow = await waitOpen(16)
      }
      if (!openedNow) { console.log('rollback: overlay not opened', key); continue }
      const w = (await evalTop('document.documentElement.clientWidth')) || 1431
      const st = await favorite(w, { restoreOnUnfav: false })
      console.log('rollback', key, st)
      if (st === 'unfav') {
        hits++; progressed = true; done.add(key); missed.delete(key)
        const r = cleanupKnown({ base: BASE, key, cardText, known })
        writeJSON(path.join(BASE, 'known_fav.json'), [...r.known])
        writeJSON(path.join(BASE, 'known_fav_map.json'), r.map)
        fs.appendFileSync(path.join(BASE, 'rollbacks.jsonl'),
          JSON.stringify({ ts: Date.now(), key, card_id: (r.removedIds && r.removedIds[0]) || null }) + '\n',
          { mode: 0o600 })
        console.log('rollback cleaned', r.removedKeys.length, 'keys,', r.removedIds.length, 'card_ids')
        // D17/D18：回滚要把「收藏成功」的账也退回去，否则 state.favorites 虚高、pendingRecords/passes
        // 里还留着已回滚的人，下一次 --batch 会把它们重新送审、台账也会多算。
        dropRolledBackRecords(key, r.removedIds || [])
      }
      await closeOverlay(); await sleep(pacedFavGap())
    }
    const before = cards.length
    await evalIn(fr.id, '(()=>{const s=[document.scrollingElement,document.documentElement,document.body,...document.querySelectorAll("div,section,main,ul")].filter(e=>e&&e.scrollHeight>e.clientHeight+80);s.forEach(e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event("scroll",{bubbles:true}))});return s.length})()')
    await sleep(2600)
    if (!progressed && (await evalIn(fr.id, 'document.querySelectorAll(".card-item").length')) <= before) break
  }
  if (hits === 0) { console.log('rollback: 全部未命中（请确认姓名/年龄与收藏页一致）:', [...missed].join(',') || keys.join(',')); if (opts.exit === false) return { ok: false, reason: 'all-missed', hits: 0, missed: [...missed] }; process.exit(2) }
  console.log('rollback done, hits =', hits)
  if (opts.exit === false) return { ok: true, hits, missed: [...missed] }
  process.exit(0)
}

// ---------- 被拒者自动回滚（审核没过就取消收藏） ----------
// connect() 连不上会直接 exit(2)，所以自动回滚前先自己探一下端口；
// 探不到就记 rollback_queue.json，等浏览器在的时候再自动取消，不打断审核流程。
async function cdpReachable() {
  try { const r = await fetch(CDP + '/json/list'); return !!r.ok } catch { return false }
}
async function autoRollbackRejected(n, batch, ids) {
  const realNames = readJSON(path.join(BASE, 'real_names.json'), {})
  const cand = new Map((batch?.candidates || []).map(c => [c.card_id, c]))
  const keys = []
  for (const id of ids) {
    const c = cand.get(id) || {}
    const nm = c.name_real || realNames[id] || c.name
    if (nm && c.age != null) keys.push(`${nm}|${c.age}`)
    else if (nm) keys.push(String(nm))
  }
  if (!keys.length) { console.log(`auto-rollback: batch ${n} 的被拒记录没有可用姓名，无法自动取消收藏`); return { hits: 0, missed: ids } }
  if (!(await cdpReachable())) { console.log('auto-rollback: 现在连不上 Chrome（' + CDP + '），先记 rollback_queue.json，等浏览器在的时候自动取消'); return { hits: 0, missed: ids } }
  console.log(`auto-rollback: batch ${n} 有 ${ids.length} 人被拒 → 立即取消收藏: ${keys.join(', ')}`)
  try {
    const r = await rollback(keys, { exit: false })
    return { hits: r.hits || 0, missed: r.missed || (r.ok ? [] : keys) }
  } catch (e) {
    console.log('auto-rollback 失败:', e.message)
    return { hits: 0, missed: keys }
  }
}
function seedRollbackQueue(keys) {
  const q = readJSON(path.join(BASE, 'rollback_queue.json'), [])
  const s = new Set([...(Array.isArray(q) ? q : []), ...keys])
  writeJSON(path.join(BASE, 'rollback_queue.json'), [...s])
}
async function flushRollbackQueue() {
  const q = readJSON(path.join(BASE, 'rollback_queue.json'), [])
  if (!Array.isArray(q) || !q.length) return
  if (!(await cdpReachable())) { console.log('rollback_queue:', q.length, '个待回滚，但连不上 Chrome，稍后重试'); return }
  console.log('rollback_queue:', q.length, '个待回滚（上次自动回滚未完成），先重试')
  const r = await rollback(q, { exit: false })
  const left = r.missed || []
  if (left.length) { writeJSON(path.join(BASE, 'rollback_queue.json'), left); console.log('rollback_queue: 仍有', left.length, '个未完成') }
  else { try { fs.unlinkSync(path.join(BASE, 'rollback_queue.json')) } catch { /* ignore */ } ; console.log('rollback_queue: 已清空') }
}
// ---------- 软条件审核（可选） ----------
// 判过的卡在点收藏之前停一下，把「卡片全文 + 详情浮层文本」写成 soft_pack.json，
// 等 agent 写 soft_ok.json：{"card_id":"…","approved":true|false,"reason":"…"}。
// 不写就是没结论 → 超时 exit 44，绝不默认通过。
async function softAsk(rf, cid, realName, age, cardText) {
  let dialogText = ''
  try {
    dialogText = await evalIn(rf.id, `(()=>{const ds=[...document.querySelectorAll('.boss-popup__wrapper')].filter(w=>!/v-leave/.test(w.className));if(!ds.length)return '';return (ds[ds.length-1].innerText||'').replace(/\\s+/g,' ').trim().slice(0,4000)})()`)
  } catch { /* 浮层读不到就不带 */ }
  const packPath = path.join(BASE, 'soft_pack.json')
  const okPath = path.join(BASE, 'soft_ok.json')
  writeJSON(packPath, {
    ts: new Date().toISOString(), card_id: cid, name: realName || '', age,
    card_text: String(cardText || '').slice(0, 3000), dialog_text: dialogText,
    ask: '看软条件：证据强度（强动词 vs 参与/了解）、经历连续性与短跳、公司是否外包/驻场、项目是否像真实做过、有无包装痕迹。approved=true 才收藏。',
  })
  console.log('SOFT_REVIEW_REQUIRED', realName || cid, age, '→ 见', packPath)
  const deadline = Date.now() + SOFT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (fs.existsSync(okPath)) {
      let d = null
      try { d = readJSON(okPath, null) } catch { d = null }
      if (d && (String(d.card_id || '') === cid || d.all === true)) {
        try { fs.unlinkSync(okPath) } catch { /* ignore */ }
        return { approved: !!d.approved, reason: String(d.reason || '') }
      }
      if (d && d.card_id && String(d.card_id) !== cid) console.log('soft_ok 的 card_id 不是当前这张（期望', cid, '），已忽略')
    }
    await sleep(2000)
  }
  return { approved: null, reason: 'timeout' }
}

// ---------- 主流程 ----------
// ---------- A 入口：只提供 transport + io，流程本身在 core/flow.mjs ----------
// 两个入口（A=Chrome+CDP / C=ego）共用同一份流程；这里只回答“怎么读页面、怎么点”。

let rfCur = null
let offCur = null

async function frameReady(maxTries = 25) {
  let rf = null, off = null, stableN = -1, stableHits = 0
  for (let t = 0; t < maxTries; t++) {
    await sleep(1200)
    rf = await recFrame().catch(() => null)
    off = rf ? await evalTop(`(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>(i.src||'').includes('/web/frame/recommend/'));if(!f)return null;const b=f.getBoundingClientRect();return {x:b.left,y:b.top}})()`).catch(() => null) : null
    if (!rf || !off) { stableN = -1; stableHits = 0; continue }
    const n = await evalIn(rf.id, 'document.querySelectorAll(".candidate-card-wrap").length').catch(() => -1)
    if (n > 0 && n === stableN) { if (++stableHits >= 2) return { rf, off } } else { stableN = n; stableHits = 0 }
  }
  return { rf, off }
}

async function readCards(rf) {
  const arr = await evalIn(rf.id, `Array.from(document.querySelectorAll('.candidate-card-wrap')).map((c,i)=>({i,name:((c.querySelector('.name')||{}).innerText||'').trim(),text:(c.innerText||'').replace(/\\s+/g,' ').trim()}))`).catch(() => [])
  return (Array.isArray(arr) ? arr : [])
    .filter(c => c && typeof c.text === 'string' && c.text.trim())
    .map(c => {
      const m = /(\d{1,2})\s*岁/.exec(c.text || '')
      return { i: c.i, name: c.name || '', age: m ? Number(m[1]) : 0, text: c.text, cid: cardId(c.text) }
    })
}

async function currentHref() { return await evalTop('location.href').catch(() => '') }

const SRC_LIST = (() => {
  const names = TAB_NAMES.filter(n => !TABS_DISALLOWED.includes(n)).filter(n => Number.isFinite(TAB_OFFSET[n]))
  return names.length ? names : ['推荐', '最新']
})()

// 岗位（source）读取与切换：优先按「岗位」跑（与 ego 入口一致），读不到岗位才退回 tab
async function listJobsA() {
  if (!rfCur) return []
  await evalIn(rfCur.id, `(()=>{const l=document.querySelector('.job-selecter-wrap .ui-dropmenu-label');if(l)l.click();return !!l})()`).catch(() => false)
  await sleep(800)
  const items = await evalIn(rfCur.id, `(()=>{const its=[...document.querySelectorAll('.job-selecter-options .job-item')];return its.map((x,i)=>({i:i,text:(x.innerText||'').replace(/\\s+/g,' ').trim()}))})()`).catch(() => [])
  await evalIn(rfCur.id, `(()=>{const l=document.querySelector('.job-selecter-wrap .ui-dropmenu-label');if(l)l.click();return true})()`).catch(() => false)
  await sleep(400)
  return Array.isArray(items) ? items : []
}

async function pickJobA(i) {
  if (!rfCur) return false
  await evalIn(rfCur.id, `(()=>{const l=document.querySelector('.job-selecter-wrap .ui-dropmenu-label');if(l)l.click();return !!l})()`).catch(() => false)
  await sleep(800)
  const r = await evalIn(rfCur.id, `(()=>{const its=[...document.querySelectorAll('.job-selecter-options .job-item')];const el=its[${i}];if(!el)return 'missing';el.click();return 'ok'})()`).catch(() => 'err')
  await sleep(2600)
  return r === 'ok'
}

const transport = {
  async probe() {
    if (!rfCur) { const r = await frameReady(); rfCur = r.rf; offCur = r.off }
    const href = await currentHref()
    const loggedIn = !/\/web\/(user|passport)\//.test(href || '')
    if (!rfCur) return { ok: false, label: '', href, loggedIn, cards: [] }
    const label = await evalIn(rfCur.id, `(()=>{const l=document.querySelector('.job-selecter-wrap .ui-dropmenu-label');const c=document.querySelector('.tab-item.curr');const j=l?(l.innerText||''):'';const t=c?(c.innerText||''):'';return ((j||t)||'').replace(/\\s+/g,' ').trim()})()`).catch(() => '')
    const cards = await readCards(rfCur)
    return { ok: true, label: label || '', href, loggedIn, cards }
  },
  async sources() {
    if (!rfCur) {
      await send('Page.navigate', { url: NAV })
      const r0 = await frameReady(); rfCur = r0.rf; offCur = r0.off
    }
    const jobs = await listJobsA()
    if (jobs.length) return jobs.map(j => ({ key: String(j.i), label: j.text, text: j.text, mode: 'job' }))
    return SRC_LIST.map((n, i) => ({ key: String(i), label: n, text: n, mode: 'tab' }))
  },
  async selectSource(src) {
    const i = Number(src.key) || 0
    await send('Page.bringToFront')
    await assertSafe()
    await send('Page.navigate', { url: NAV + '?t=' + Date.now() })
    let r = await frameReady(); rfCur = r.rf; offCur = r.off
    if (!rfCur || !offCur) return { label: '' }
    if (src.mode === 'job') {
      await pickJobA(i)
      r = await frameReady(); rfCur = r.rf; offCur = r.off
      const lab = await evalIn(rfCur.id, `(()=>{const l=document.querySelector('.job-selecter-wrap .ui-dropmenu-label');return l?((l.innerText||'').replace(/\\s+/g,' ').trim()):''})()`).catch(() => '')
      return { label: lab || src.label }
    }
    if (APPLY_FILTER) {
      await clickTextIn(rfCur, offCur, '筛选'); await sleep(900)
      await clickTextIn(rfCur, offCur, '应用'); await sleep(900)
      await clickTextIn(rfCur, offCur, '确定'); await sleep(1800)
    }
    if (i > 0) {
      const tabX = TAB_OFFSET[SRC_LIST[i]]
      if (Number.isFinite(tabX)) { await click(offCur.x + tabX, offCur.y + 30); await sleep(3200) }
      if (await cResumeOpen()) { await closeOverlay(); await sleep(600) }
    }
    const tabNow = await evalIn(rfCur.id, `(()=>{const c=document.querySelector('.tab-item.curr');return c?(c.innerText||'').replace(/\\s+/g,''):''})()`).catch(() => '')
    return { label: tabNow || SRC_LIST[i] }
  },
  async openCard(card) {
    if (!rfCur || !offCur) return { open: false }
    const list = await readCards(rfCur)
    let i = list.findIndex(c => c.cid === card.cid)
    if (i < 0) i = card.i
    const rect = await evalIn(rfCur.id, `(()=>{const c=document.querySelectorAll('.candidate-card-wrap')[${i}];if(!c)return null;c.scrollIntoView({block:'center'});const n=c.querySelector('.row.name-wrap')||c.querySelector('a,[class*="name"],h3,[class*="geek-name"]')||c;const b=n.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height,txt:(n.innerText||'').slice(0,60)}})()`)
    if (!rect) { console.log('open: no card', card.cid); return { open: false } }
    if (/打招呼|联系Ta|畅聊|搜索畅聊卡/.test(rect.txt || '')) { console.log('ALLOWLIST BLOCK', card.cid); return { open: false } }
    if (await cResumeOpen()) { await closeOverlay(); for (let t = 0; t < 8 && (await cResumeOpen()); t++) await sleep(500) }
    await dwell(400, 1200)
    const cx = offCur.x + rect.x + Math.min(rect.w * 0.5, 160), cy = offCur.y + rect.y + Math.min(rect.h * 0.5, 22)
    const openBy = await evalIn(rfCur.id, `(()=>{const c=document.querySelectorAll('.candidate-card-wrap')[${i}];if(!c)return 'no-card';const n=c.querySelector('.row.name-wrap')||c.querySelector('a,[class*="name"],h3,[class*="geek-name"]')||c;if(typeof n.click!=='function')return 'no-click';n.click();return 'el-click'})()`)
    if (openBy !== 'el-click') await click(cx, cy)
    for (let t = 0; t < 16 && !(await cResumeOpen()); t++) await sleep(500)
    if (!(await cResumeOpen())) { await click(cx, cy); for (let t = 0; t < 12 && !(await cResumeOpen()); t++) await sleep(500) }
    if (!(await cResumeOpen())) { console.log('overlay not opened', card.cid); return { open: false } }
    await assertSafe()
    const st = await favControlState(rfCur.id)
    const dialogText = await evalIn(rfCur.id, `(()=>{const a=[...document.querySelectorAll('.boss-popup__wrapper')].filter(w=>!/v-leave/.test(w.className));const d=a[a.length-1];return d?((d.innerText||'').replace(/\\s+/g,' ').trim().slice(0,4000)):''})()`).catch(() => '')
    return { open: true, hasFav: st !== 'missing', favText: st === 'missing' ? '' : st, dialogText }
  },
  async fav() {
    const w = (await evalTop('document.documentElement.clientWidth')) || 1431
    const st = await favorite(w)
    return { ok: st === 'fav', favText: st }
  },
  async close() { await closeOverlay() },
  async scroll() {
    if (!rfCur) return { cards: 0 }
    const mv = await evalIn(rfCur.id, `(()=>{const card=document.querySelector('.candidate-card-wrap');
let box=null;
const cands=[];
for (const el of [...document.querySelectorAll('div,section,main,ul')]) { const st=getComputedStyle(el); if(/(auto|scroll)/.test(st.overflowY)&&el.scrollHeight>el.clientHeight+80) cands.push(el) }
if (card) { let n=card.parentElement; while(n){ if(cands.includes(n)){box=n;break} n=n.parentElement } }
if (!box && cands.length) box=cands[0];
const t=box||document.scrollingElement||document.documentElement;
const before=t.scrollTop;
t.scrollTop=before+900;
const d=document.scrollingElement||document.documentElement;
if(!box){ d.scrollTop=d.scrollTop+900; try{window.scrollBy(0,900)}catch(e){} }
return {before:before,after:t.scrollTop,box:!!box,cands:cands.length,sh:t.scrollHeight,ch:t.clientHeight}})()`).catch(() => null)
    if (mv) console.log('滚动加载：', JSON.stringify(mv))
    await sleep(2400)
    return { cards: (await readCards(rfCur)).length }
  },
  async wait(ms) { await sleep(ms) },
}

const known = new Set(readJSON(path.join(BASE, 'known_fav.json'), []))
const knownIds = new Set([...known].filter(x => /^[0-9a-f]{16}$/.test(x)))
const knownKeys = new Set([...known].filter(x => x.includes('|')))
const rejectedArr = readJSON(path.join(BASE, 'rejected.json'), [])
const rejectedIds = new Set(rejectedArr.map(r => r.card_id))
const rejectedNAW = new Set(rejectedArr.map(r => `${r.name}|${r.age}|${wantOf(r)}`))

const io = {
  log: (...a) => console.log(...a),
  judge: texts => runJudge(texts),
  softAsk: async c => softAsk(rfCur, c.cid, c.name || '', c.age, c.text),
  state,
  saveState: () => {
    if (state.favorites >= DAILY_FAV_CAP) { console.log('DAILY_FAV_CAP reached'); process.exit(2) }
    if (state.cycles >= DAILY_CYCLE_CAP) { console.log('DAILY_CYCLE_CAP reached'); process.exit(2) }
    if (state.startedAt && Date.now() - state.startedAt > MAX_RUN_MS) { console.log('RUN_LIMIT 到，休息'); process.exit(2) }
    saveState()
  },
  isKnown: c => knownIds.has(c.cid) || knownKeys.has(`${c.name}|${c.age}`) || rejectedIds.has(c.cid) || rejectedNAW.has(`${c.name}|${c.age}|`),
  onFav: (c, brief) => {
    const nameAge = `${c.name}|${c.age}`
    known.add(c.cid); knownIds.add(c.cid); known.add(nameAge); knownKeys.add(nameAge)
    writeJSON(path.join(BASE, 'known_fav.json'), [...known])
    const favMap = readJSON(path.join(BASE, 'known_fav_map.json'), {})
    favMap[c.cid] = nameAge
    writeJSON(path.join(BASE, 'known_fav_map.json'), favMap)
    const rn = readJSON(path.join(BASE, 'real_names.json'), {})
    rn[c.cid] = c.name
    writeJSON(path.join(BASE, 'real_names.json'), rn)
    appendJSONL(path.join(BASE, 'passes.jsonl'), { ts: new Date().toISOString(), real_name: c.name, ...(brief || {}), card_id: c.cid, name: (brief && brief.name) || c.name, age: c.age })
    state.pendingRecords.push({
      card_id: c.cid, name: (brief && brief.name) || c.name, name_real: c.name, age: c.age,
      city: brief && brief.city, want: brief && brief.want, verdict: brief && brief.verdict,
      c1_months: brief && brief.c1_months, c1_segments: brief && brief.c1_segments,
      c2_level: brief && brief.c2_level, c2_evidence: brief && brief.c2_evidence,
      c3_months: brief && brief.c3_months, c3_segments: brief && brief.c3_segments, flags: brief && brief.flags,
    })
    state.sinceBatch = (state.sinceBatch || 0) + 1
    saveState()
    if (!FAV_DRY_RUN && state.pendingRecords.length >= REVIEW_EVERY) writeReviewBatch(state.pendingRecords.slice(0, REVIEW_EVERY))
  },
  onDecision: rec => log({ card_id: rec.card_id, action: rec.action, reason: rec.reason || '' }),
  writeSummary: s => writeJSON(path.join(BASE, 'round-summary.json'), s),
}

async function main() {
  const { runFlow } = await import(pathToFileURL(path.join(HERE, 'core', 'flow.mjs')).href)
  await connect(); await send('Page.enable'); await assertSafe()
  await flushRollbackQueue()
  const SCAN_PER_JOB = Math.max(5, num(process.env.SCAN_PER_JOB, 100))
  console.log('known_fav', known.size, 'target', targetFav(), 'dry', FAV_DRY_RUN,
    'spacing', SPACING + '±' + Math.round(JITTER * 100) + '%', 'favGap', FAV_GAP + '±' + Math.round(JITTER * 100) + '%',
    'sources', SRC_LIST.join('/'), 'scanPerJob', SCAN_PER_JOB, 'reviewEvery', REVIEW_EVERY, 'softReview', SOFT_REVIEW ? 'on' : 'off')
  const r = await runFlow({
    t: transport,
    io,
    cfg: {
      target: targetFav(), scanPerJob: SCAN_PER_JOB, maxJobs: Math.max(SRC_LIST.length, 20), jobHint: '',
      softReview: SOFT_REVIEW, softTimeoutMs: SOFT_TIMEOUT_MS, dryRun: FAV_DRY_RUN,
      favCap: DAILY_FAV_CAP, maxMinutes: Math.round(MAX_RUN_MS / 60000),
      pacedSpacing, pacedFavGap, dwell,
    },
  })
  if (r && r.exit) process.exit(r.exit)
  console.log('END fav', r.faved, 'looked', r.looked, 'noFavControl', r.noFav, 'dry', FAV_DRY_RUN)
  process.exit(0)
}


async function clickTextIn(rf, off, txt) {
  try {
    const r = await evalIn(rf.id, `(()=>{const t=${JSON.stringify(txt)};const els=Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&(e.textContent||'').trim()===t);if(!els.length)return null;const e=els[els.length-1];const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`)
    if (!r) return false
    await click(off.x + r.x, off.y + r.y); return true
  } catch { return false }
}
function failSoft(msg) {
  fs.writeFileSync(path.join(BASE, 'REST_UNTIL'), String(Date.now() + 30 * 60000) + '\n' + msg + '\n', { mode: 0o600 })
  console.log('REST 30min:', msg); process.exit(2)
}

const arg = process.argv[2]
if (arg === '--batch') {
  if (state.pendingBatch) { console.log(`REVIEW_PENDING batch=${state.pendingBatch} — 先处理它再开新批`); process.exit(42) }
  const recs = readJSON(path.join(BASE, 'daily_state.json'), {})?.pendingRecords || []
  if (!recs.length) { console.log('没有待审候选（pendingRecords 为空）'); process.exit(0) }
  writeReviewBatch(recs.slice(0, REVIEW_EVERY))
}
if (arg === '--rollback') {
  const keys = String(process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!keys.length) { console.log('usage: node scan-favorite.mjs --rollback "真实姓名或card_id,..."'); process.exit(1) }
  rollback(keys).catch(e => { console.log('FATAL', e.message); process.exit(1) })
} else {
  main().catch(e => { console.log('FATAL', e.message); process.exit(1) })
}
