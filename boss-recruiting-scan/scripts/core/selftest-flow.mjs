// selftest-flow.mjs —— 用假 transport 验证共用流程（不需要浏览器）
// 覆盖：岗位轮转 / scanPerJob 预算 / 去重 / 规则筛 / 先审后点（通过·拒绝·超时）/ 收藏目标 / NO_FAV_CONTROL / 未登录
import { createHash } from "node:crypto";
import { runFlow } from "./flow.mjs";

const sha = (s) => createHash("sha1").update(String(s), "utf8").digest("hex").slice(0, 16);
const PASS_EVERY = 4;

const mkCards = (jobKey, total) => Array.from({ length: total }, (_, i) => {
  const name = `${jobKey}候选人${i}`;
  const age = 20 + (i % 12);
  const text = `${name} ${age}岁 本科 深圳 测试工程师 Java Spring Boot 自动化 5年 ${jobKey}-${i}`;
  return { i, name, age, text, cid: sha(text) };
});

// 假判定器：每 4 张通过 1 张（按文本末位数字），card_id 用与入口一致的 sha1(text)
const judge = (texts) => texts.map((text) => {
  const n = Number(String(text).split("-").pop());
  return Number.isFinite(n) && n % PASS_EVERY === 0 ? { card_id: sha(text), verdict: "PASS" } : null;
}).filter(Boolean);

function makeTransport(jobs, perJob, opts = {}) {
  const cards = new Map(jobs.map((j) => [j.key, mkCards(j.key, perJob)]));
  let cur = null, shown = 0;
  const t = {
    async probe() {
      if (!cur) return { ok: true, label: "", href: "https://www.zhipin.com/web/chat/recommend", loggedIn: true, cards: [] };
      let vis = cards.get(cur).slice(0, shown);
      if (opts.maskFirst && vis.length) vis = [{ ...vis[0], name: "王**" }, ...vis.slice(1)];
      return { ok: true, label: `${cur} _ 深圳 10-11K`, href: "https://www.zhipin.com/web/chat/recommend", loggedIn: true, cards: vis };
    },
    async sources() { return jobs.map((j) => ({ key: j.key, label: j.label, text: j.text })); },
    async selectSource(src) { cur = src.key; shown = opts.startShown ?? 15; return { label: `${cur} _ 深圳 10-11K` }; },
    async openCard(c) {
      if (opts.noFavFor && String(c.name).includes(opts.noFavFor)) return { open: true, hasFav: false, favText: "", dialogText: "" };
      return { open: true, hasFav: true, favText: "收藏", dialogText: `${c.name} 详情` };
    },
    async fav() { return { ok: true, favText: "已收藏" }; },
    async close() {},
    async scroll() { const all = cards.get(cur); shown = Math.min(all.length, shown + (opts.perScroll ?? 15)); return { cards: shown }; },
    async wait() {},
  };
  return { t };
}

function makeIo() {
  const known = new Set();
  const decisions = [], favs = [], summaries = [];
  return {
    log: () => {},
    judge,
    state: { favorites: 0, cycles: 0 },
    saveState: () => {},
    isKnown: (c) => known.has(c.cid),
    onFav: (c) => { known.add(c.cid); favs.push(c.name); },
    onDecision: (r) => decisions.push(r),
    writeSummary: (s) => summaries.push(s),
    decisions, favs, summaries,
  };
}

const cfgBase = {
  target: 2, scanPerJob: 20, maxJobs: 5, jobHint: "",
  softReview: false, softTimeoutMs: 50, dryRun: false,
  favCap: 60, maxMinutes: 180,
  pacedSpacing: () => 1, pacedFavGap: () => 1, dwell: async () => {},
};
const JOBS = [
  { key: "J1", label: "测试工程师", text: "测试工程师 _ 深圳 10-11K 待" },
  { key: "J2", label: "兼职Java", text: "兼职·Java _ 深圳 20-25元/时 待" },
];

let fails = 0;
const ok = (cond, msg) => { console.log(cond ? "ok  " : "FAIL", msg); if (!cond) fails++; };

// 1) 岗位轮转 + scanPerJob 预算 + 去重
{
  const { t } = makeTransport(JOBS, 130);
  const io = makeIo();
  const r = await runFlow({ t, io, cfg: { ...cfgBase, target: 999, dryRun: true } });
  ok(r.jobs.length === 2, `两个岗位都跑了（${r.jobs.length}）`);
  ok(r.jobs.every((j) => j.screened >= 20), `每岗位看满 >=20 张（${r.jobs.map((j) => j.screened).join("/")}）`);
  ok(r.looked >= 40, `去重后共看 ${r.looked} 张`);
  ok(io.decisions.filter((d) => d.action === "dry-approve").length > 0, "dry-run 有 dry-approve 留痕");
}

// 2) 收藏到 target 就停，不进第二个岗位
{
  const { t } = makeTransport(JOBS, 130);
  const io = makeIo();
  const r = await runFlow({ t, io, cfg: { ...cfgBase, target: 2, scanPerJob: 100 } });
  ok(r.faved === 2, `收藏 2 人后停（实际 ${r.faved}）`);
  ok(r.jobs.length === 1, "达目标后不再进第二个岗位");
  ok(io.favs.length === 2, "onFav 调用 2 次");
}

// 3) 软审：拒绝 → 关详情继续，不收藏
{
  const { t } = makeTransport(JOBS.slice(0, 1), 60);
  const io = makeIo();
  io.softAsk = async () => ({ approved: false, reason: "test-reject" });
  const r = await runFlow({ t, io, cfg: { ...cfgBase, target: 5, scanPerJob: 100, softReview: true } });
  ok(r.faved === 0, "全部被拒 → 0 收藏");
  ok(io.decisions.some((d) => d.action === "reject"), "有 reject 留痕");
}

// 4) 软审：通过 → 收藏到 target
{
  const { t } = makeTransport(JOBS.slice(0, 1), 60);
  const io = makeIo();
  io.softAsk = async () => ({ approved: true, reason: "ok" });
  const r = await runFlow({ t, io, cfg: { ...cfgBase, target: 3, scanPerJob: 100, softReview: true } });
  ok(r.faved === 3, `软审通过后收藏 3 人（实际 ${r.faved}）`);
}

// 5) 软审超时 → exit 44，且未收藏
{
  const { t } = makeTransport(JOBS.slice(0, 1), 60);
  const io = makeIo();
  io.softAsk = async () => ({ approved: null, reason: "timeout" });
  const r = await runFlow({ t, io, cfg: { ...cfgBase, target: 3, scanPerJob: 100, softReview: true } });
  ok(r.exit === 44 && r.faved === 0, `超时 exit=44 且 0 收藏（exit=${r.exit} faved=${r.faved}）`);
}

// 6) 无收藏控件 → 跳过并记 no-fav-control
{
  const { t } = makeTransport(JOBS.slice(0, 1), 60, { noFavFor: "候选人0" });
  const io = makeIo();
  const r = await runFlow({ t, io, cfg: { ...cfgBase, target: 5, scanPerJob: 100 } });
  ok(r.noFav >= 1, `记到 NO_FAV_CONTROL（${r.noFav}）`);
  ok(io.decisions.some((d) => d.reason === "no-fav-control"), "decisions 有 no-fav-control");
}

// 7) 未登录 → exit 2
{
  const t = { async probe() { return { ok: false, href: "https://www.zhipin.com/web/user/?ka=bticket", loggedIn: false, cards: [] }; }, async sources() { return []; } };
  const io = makeIo();
  const r = await runFlow({ t, io, cfg: cfgBase });
  ok(r.exit === 2, `未登录 exit=2（${r.exit}）`);
}

// 8) 精选来源 → SKIP_SOURCE 跳过，不选它
{
  const jobs = [{ key: "JX", label: "精选", text: "精选" }, ...JOBS];
  const { t } = makeTransport(jobs, 60);
  const io = makeIo();
  const r = await runFlow({ t, io, cfg: { ...cfgBase, target: 1, scanPerJob: 50 } });
  ok(r.jobs.length === 1, `精选来源被跳过（只跑了 ${r.jobs.length} 个来源）`);
  ok(r.faved === 1, `其他来源仍正常收藏（${r.faved}）`);
}

// 9) 掩码姓名 → 开卡前跳过，记 masked-name
{
  const { t } = makeTransport(JOBS.slice(0, 1), 60, { maskFirst: true });
  const io = makeIo();
  const r = await runFlow({ t, io, cfg: { ...cfgBase, target: 5, scanPerJob: 100 } });
  ok(io.decisions.some((d) => d.reason === "masked-name"), "decisions 有 masked-name");
  ok(!io.favs.some((n) => String(n).includes("*")), "掩码姓名没有被收藏");
}

console.log(fails ? `\nSELFTEST FAILED (${fails})` : "\nSELFTEST OK");
process.exit(fails ? 2 : 0);
