// flow.mjs —— A（Chrome+CDP）与 C（ego）共用的唯一流程实现。
// 入口层只负责两件事：① 提供 transport（怎么读页面、怎么点）② 提供 io（判定器、软审文件、状态落盘）。
// 流程本身（岗位轮转 → 每岗位看 N 张 → 规则筛 → 先审后点 → 收藏校验 → 节奏/配额 → 汇总）全部在这里，两边不允许再各写一份。
//
// transport 约定（全部 async）：
//   probe()              → { ok, label, href, loggedIn, cards:[{ i, name, age, text, cid }] }
//   sources()            → [{ key, label, text }]            岗位清单（空数组=不分岗位，单流）
//   selectSource(src)    → { label }                         选中某个岗位并等卡片稳定
//   openCard(card)       → { open, hasFav, favText, dialogText }
//   fav()                → { ok, favText }                    点收藏并等文案变「已收藏」
//   close()              → void                               关详情
//   scroll()             → { cards }                           往下滚一屏，返回当前卡片数
//   wait(ms)             → void
//
// io 约定：
//   judge(texts)         → [{ card_id, ... }] | null           null=判定器致命失败
//   softAsk(card, ov)    → { approved: true|false|null, reason }  null=超时
//   state                → { favorites, cycles, startedAt, date }（引擎读写，入口负责持久化）
//   saveState()          → void
//   onFav(card, brief)   → void                               收藏成功后的账本写入（known/real_names/passes）
//   onDecision(rec)      → void                               逐张留痕
//   writeSummary(obj)    → void
//   log(...args)         → void

export const HARD = { spacingMin: 15000, favGapMin: 12000, favCap: 60, cycleCap: 200, maxMinutes: 180 };

const sleepish = (t, ms) => t.wait(ms);

export async function runFlow({ t, io, cfg }) {
  const C = {
    target: Math.max(1, cfg.target ?? 2),
    scanPerJob: Math.max(5, cfg.scanPerJob ?? 100),
    maxJobs: Math.max(1, cfg.maxJobs ?? 20),
    jobHint: String(cfg.jobHint || ""),
    softReview: !!cfg.softReview,
    softTimeoutMs: Math.max(60000, cfg.softTimeoutMs ?? 15 * 60000),
    dryRun: !!cfg.dryRun,
    favCap: Math.min(HARD.favCap, Math.max(1, cfg.favCap ?? HARD.favCap)),
    maxMinutes: Math.min(HARD.maxMinutes, Math.max(1, cfg.maxMinutes ?? HARD.maxMinutes)),
    pacedSpacing: cfg.pacedSpacing ?? (() => HARD.spacingMin),
    pacedFavGap: cfg.pacedFavGap ?? (() => HARD.favGapMin),
    dwell: cfg.dwell ?? (async (lo = 300, hi = 1200) => t.wait(lo + Math.floor(Math.random() * (hi - lo + 1)))),
  };
  const log = io.log;
  const state = io.state;
  const seen = new Set();
  const jobStats = [];
  let faved = 0, skipped = 0, noFav = 0, cycles = 0, exit = 0;

  const pre = await t.probe();
  if (pre.loggedIn === false) {
    log("NOT_LOGGED_IN " + (pre.href || ""));
    log("请先登录招聘端（「我要招聘」），再重跑；一次调用会跑完整个循环");
    return { exit: 2, faved, skipped, noFav, cycles, looked: 0, jobs: [] };
  }
  if (!pre.ok) log("PROBE_NOT_READY " + (pre.href || "") + "（页面还没到推荐流，接下来会先导航）");

  let plan = await t.sources();
  if (!plan.length) plan = [{ key: "default", label: "", text: "" }];
  if (C.jobHint) plan = plan.filter((j) => `${j.text || ""}${j.label || ""}`.includes(C.jobHint));
  plan = plan.slice(0, C.maxJobs);
  log(`岗位计划(${plan.length})：` + plan.map((j) => j.text || j.label || j.key).join(" | "));

  const startedAt = Date.now();
  for (const job of plan) {
    if (exit || faved >= C.target) break;
    if (state.favorites >= C.favCap) { log(`DAILY_FAV_CAP(${C.favCap}) 已达上限，停止`); exit = 5; break; }
    if (Date.now() - startedAt > C.maxMinutes * 60000) { log(`MAX_MINUTES(${C.maxMinutes}) 已达上限，停止`); exit = 5; break; }

    if (/精选/.test(String(job.label || job.text || ""))) { log("SKIP_SOURCE 精选页（开聊需搜索畅聊卡，不在精选页收藏）：" + (job.label || job.text)); continue; }
    const sel = await t.selectSource(job);
    log(`▶ 岗位：${sel.label || job.text || job.key}（计划看 ${C.scanPerJob} 张）`);
    let screened = 0, idle = 0;
    const favedBefore = faved;

    while (screened < C.scanPerJob) {
      cycles++; state.cycles = (state.cycles || 0) + 1; io.saveState();
      const st = await t.probe();
      if (!st.ok || !(st.cards || []).length) { log("读不到卡片，换下一个岗位"); break; }
      const cur = await t.probe();
      if (C.jobHint && cur.label && !cur.label.includes(C.jobHint)) { log("SKIP 岗位跳回：" + cur.label); break; }

      const cards = st.cards;
      const fresh = cards.filter((c) => !seen.has(c.cid) && !io.isKnown(c));
      if (!fresh.length) {
        idle++;
        if (idle >= 3) { log(`本岗位到底（连续 ${idle} 次没有新卡），换下一个岗位`); break; }
        const sc = await t.scroll();
        log("滚动加载：", JSON.stringify(sc));
        await t.wait(2200);
        continue;
      }
      idle = 0;
      for (const c of fresh) seen.add(c.cid);
      screened += fresh.length;

      const briefs = io.judge(fresh.map((c) => c.text));
      if (briefs === null) { log("FATAL 判定器失败，停止"); return { exit: 2, faved, skipped, noFav, cycles, looked: seen.size, jobs: jobStats }; }
      const byCid = new Map((briefs || []).map((x) => [x && x.card_id, x]));
      const queue = fresh.filter((c) => byCid.has(c.cid));
      log(`规则筛：通过 ${queue.length} / ${fresh.length}｜本岗位已看 ${screened} / ${C.scanPerJob}｜今日收藏 ${state.favorites}`);

      for (const c of queue) {
        if (faved >= C.target) break;
        if (state.favorites >= C.favCap) { exit = 5; break; }
        if (/\*/.test(String(c.name || ""))) { skipped++; log("SKIP 掩码姓名（无法核对身份）：" + (c.name || c.cid)); io.onDecision({ card_id: c.cid, name: c.name, action: "skip", reason: "masked-name" }); continue; }
        const ov = await t.openCard(c);
        if (!ov || !ov.open) { log("open failed", c.name || c.cid); skipped++; continue; }
        if (!ov.hasFav) {
          noFav++; skipped++;
          log("NO_FAV_CONTROL", c.name || c.cid, "（岗位可能仍是「待」→ 无收藏按钮；不点「打开职位」）");
          io.onDecision({ card_id: c.cid, name: c.name, action: "skip", reason: "no-fav-control" });
          await t.close();
          continue;
        }
        if (C.softReview && !C.dryRun) {
          const v = await io.softAsk(c, ov, C.softTimeoutMs);
          if (v.approved !== true) {
            io.onDecision({ card_id: c.cid, name: c.name, action: "reject", reason: v.reason || "review" });
            log(v.approved === null ? `SOFT_TIMEOUT ${c.name} → 关详情，未收藏` : `SOFT_REJECT ${c.name} → 关详情，未收藏`);
            await t.close();
            if (v.approved === null) { return { exit: 44, faved, skipped, noFav, cycles, looked: seen.size, jobs: jobStats }; }
            skipped++;
            continue;
          }
          log("SOFT_APPROVE", c.name);
        }
        if (C.dryRun) {
          log("DRY would favorite", c.name, c.age);
          io.onDecision({ card_id: c.cid, name: c.name, action: "dry-approve" });
          await t.close();
          continue;
        }
        if (faved > 0) { const g = C.pacedFavGap(); log("pacing wait", g, "ms"); await t.wait(g); }
        await C.dwell(250, 900);
        const r = await t.fav();
        if (r.ok) {
          faved++; state.favorites = (state.favorites || 0) + 1; io.saveState();
          io.onFav(c, byCid.get(c.cid));
          log("favorite", c.name, c.age, "fav");
        } else {
          log("favorite", c.name, c.age, "UNCONFIRMED", r.favText || "");
          exit = 4;
        }
        io.onDecision({ card_id: c.cid, name: c.name, action: r.ok ? "favorite" : "favorite-unconfirmed" });
        await t.close();
        await C.dwell(400, 1200);
      }
      if (faved >= C.target || exit) break;
      const sp = C.pacedSpacing();
      log("轮间隔", sp, "ms");
      await sleepish(t, sp);
    }
    jobStats.push({ job: job.text || job.label || job.key, screened, faved: faved - favedBefore });
    if (!exit) log(`✔ 岗位完成：${job.text || job.key}｜看 ${screened} 张｜收藏 ${faved - favedBefore} 人`);
  }

  const summary = {
    ts: new Date().toISOString(), jobHint: C.jobHint, target: C.target, scanPerJob: C.scanPerJob,
    dryRun: C.dryRun, softReview: C.softReview, faved, skipped, noFav, cycles,
    looked: seen.size, favoritesToday: state.favorites, jobs: jobStats, exit,
  };
  io.writeSummary(summary);
  log(`ROUND_DONE fav=${faved} looked=${seen.size} skipped=${skipped} noFavControl=${noFav} jobs=${jobStats.length}` + (C.dryRun ? " (dry-run)" : ""));
  return { ...summary, exit };
}
