// ego-driver.mjs —— BOSS 推荐流「规则筛 + agent 审 + 收藏」驱动器（ego-browser nodejs）
// 用法（PowerShell 5.1）：
//   cmd /c "\"C:\Program Files\Citro Labs\ego lite\Application\0.6.2.8\ego-browser.exe\" nodejs -e \"await import('file:///C:/Users/<you>/.dsh/skills/boss-recruiting-scan/scripts/ego/ego-driver.mjs')\"" cards
// 子命令：state | cards | review --ids | apply | open <i> | fav <i> | close | decide <json> | round（一次调用内循环）
// 环境变量：EGO_WORK（默认 %TEMP%\boss-ego）、EGO_SPACE、EGO_JOB（岗位名关键词，默认取当前第一个岗位）

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (const a of argv) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) opts[m[1]] = m[2]; else pos.push(a);
}

// ego 的 `nodejs -e` 既不传 argv 也不传自定义环境变量 → 命令走固定 JSON 文件
const CMD_FILE = path.join(os.tmpdir(), "boss-ego-cmd.json");
let fileCmd = null;
if (fs.existsSync(CMD_FILE)) {
  try {
    let raw = fs.readFileSync(CMD_FILE, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    fileCmd = JSON.parse(raw);
    fs.rmSync(CMD_FILE, { force: true });
  } catch (e) {
    console.error("cmd 文件解析失败:", String(e).slice(0, 160));
  }
}

const CMD = (fileCmd && fileCmd.cmd) || pos[0] || "state";
const ARG = String((fileCmd && fileCmd.arg) || pos[1] || "");
if ((fileCmd && fileCmd.help) || opts.help || opts.h || CMD === "help") {
  console.log("用法: 先写命令文件 " + CMD_FILE + "，再执行：");
  console.log(JSON.stringify({ cmd: "round", job: "测试工程师", spaceId: 2, work: "D:\\\\work", target: 2, maxCycles: 3, softReview: true, dryRun: false }));
  console.log("命令: state | cards | open <i> | fav <i> | close | decide | review --ids | apply | round");
  process.exit(0);
}
const WORK = (fileCmd && fileCmd.work) || opts.work || process.env.EGO_WORK || path.join(os.tmpdir(), "boss-ego");
fs.mkdirSync(WORK, { recursive: true });

const SPACE_NAME = (fileCmd && fileCmd.space) || opts.space || process.env.EGO_SPACE || "boss-recruiting-scan";
const JOB_HINT = (fileCmd && fileCmd.job) || opts.job || process.env.EGO_JOB || "";
const SPACE_ID = Number((fileCmd && fileCmd.spaceId) || opts["space-id"] || process.env.EGO_SPACE_ID || 0);
// 用户明确要求继续时置 claim=true，允许从用户手里接管（ego: claimTaskSpace）
const CLAIM = !!(fileCmd && (fileCmd.claim === true || String(fileCmd.claim) === "true")) || opts.claim === true || process.env.EGO_CLAIM === "1";

function log(...a) { console.log(...a); }
function writeJson(name, obj) {
  const p = path.join(WORK, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 1), "utf8");
  return p;
}

// 找到/创建本 skill 的 taskSpace
// ego 的规则：ownership 是 "agent" 时用 takeOverTaskSpace；
// 用户点过「接管」后 ownership 变 "user"，此时 takeOverTaskSpace 无效，只能用 claimTaskSpace
// （ego 文档：claimTaskSpace 仅在用户明确要求继续时使用；这里以命令行参数 claim 显式授权）
async function acquire(space, why) {
  if (space.ownership === "user") {
    if (!CLAIM) {
      throw new Error("task space 已被用户接管（ownership=user）。要用请加 claim:true 再跑：" + JSON.stringify(space));
    }
    log("claim user-owned space(" + space.id + "): " + why);
    return await claimTaskSpace(space.id);
  }
  return await takeOverTaskSpace(space.id);
}

async function getTask() {
  const spaces = await listTaskSpaces();
  const wantId = SPACE_ID;
  const byId = wantId ? spaces.find((s) => s.id === wantId) : null;
  if (byId) return await acquire(byId, "spaceId=" + wantId);
  const hit = spaces.find((s) => s.name === SPACE_NAME);
  if (hit) return await acquire(hit, "name=" + SPACE_NAME);
  const t = await taskSpace(SPACE_NAME);
  await t.page("p1").goto("https://www.zhipin.com/web/chat/recommend");
  return t;
}

// 在 page 里跨同源 iframe 执行（返回 {frame, value}）
async function inRecommend(page, fn) {
  return await page.evaluate(fn);
}

// 读推荐帧里的岗位标签 + 卡片数
// 注意：顶层文档里也有一个 .ui-dropmenu-label（账号下拉「<账号名>」），
// 所以必须"优先选有卡片的文档"，否则会读顶层得到 0 张（历史 bug）
const PROBE = () => {
  const docs = [document];
  for (const f of [...document.querySelectorAll("iframe")]) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {}
  }
  let best = null;
  let fallback = null;
  for (const d of docs) {
    const cards = [...d.querySelectorAll(".candidate-card-wrap")];
    const labEl = d.querySelector(".ui-dropmenu-label");
    if (!cards.length && !labEl) continue;
    const label = (labEl ? labEl.innerText : "").replace(/\s+/g, " ").trim();
    const dtext = (d.body ? d.body.innerText : "").replace(/\s+/g, " ").trim();
    const rec = {
      label,
      cards: cards.length,
      names: cards.map((c) => ((c.querySelector(".name") || {}).innerText || "").trim()),
      texts: cards.map((c) => (c.innerText || "").replace(/\s+/g, " ").trim()),
      navOk: /推荐牛人|职位管理/.test(document.body.innerText || ""),
      href: location.href,
      // 空列表时的定位证据：帧地址、提示语、正文开头
      diag: {
        frames: [...document.querySelectorAll("iframe")].map((f) => (f.src || "").slice(0, 160)),
        hint: (/(开放职位|暂无|加载中|没有更多|推荐牛人)/.exec(dtext) || [""])[0],
        head: dtext.slice(0, 160),
      },
    };
    if (rec.cards > 0) { best = rec; break; }
    if (!fallback) fallback = rec;
  }
  return best || fallback || { label: "", cards: -1, names: [], texts: [], navOk: false, href: location.href };
};

async function ensureJob(page) {
  let st = await inRecommend(page, PROBE);
  if (st.cards < 0) throw new Error("推荐帧没找到（页面可能不在推荐牛人页）：" + st.href);
  if (!JOB_HINT) return st;
  if (st.label.includes(JOB_HINT)) return st;

  // 打开岗位下拉并选中含关键词的岗位
  await page.click(".job-selecter-wrap .ui-dropmenu-label", { timeout: 8000 });
  await page.waitForTimeout(700);
  const items = await page.evaluate(() => {
    const docs = [document];
    for (const f of [...document.querySelectorAll("iframe")]) {
      try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {}
    }
    for (const d of docs) {
      const its = [...d.querySelectorAll(".job-item")];
      if (its.length) return its.map((x, i) => ({ i, text: (x.innerText || "").replace(/\s+/g, " ").trim() }));
    }
    return [];
  });
  const idx = items.findIndex((x) => x.text.includes(JOB_HINT));
  if (idx < 0) throw new Error("岗位下拉里没找到包含「" + JOB_HINT + "」的项：" + JSON.stringify(items));
  await page.click(".job-selecter-options .job-item >> nth=" + idx, { timeout: 8000 });
  await page.waitForTimeout(2500);
  st = await inRecommend(page, PROBE);
  return st;
}

// 等卡片数连续两次相同（最多 20×1.2s）
async function waitCards(page) {
  let prev = -2, hits = 0;
  for (let t = 0; t < 20; t++) {
    const st = await inRecommend(page, PROBE);
    if (st.cards > 0 && st.cards === prev) { hits++; if (hits >= 1) return st; }
    else hits = 0;
    prev = st.cards;
    await page.waitForTimeout(1200);
  }
  return await inRecommend(page, PROBE);
}

// 找当前打开的浮层（返回 {frameDoc?, text, hasFav, hasClose}），跨同源 iframe
const OVERLAY = () => {
  const docs = [document];
  for (const f of [...document.querySelectorAll("iframe")]) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {}
  }
  for (const d of docs) {
    const dlgs = [...d.querySelectorAll(".boss-popup__wrapper")].filter((w) => !/v-leave/.test(w.className));
    if (!dlgs.length) continue;
    const dlg = dlgs[dlgs.length - 1];
    const r = dlg.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) continue;
    const fav = dlg.querySelector(".like-icon-and-text");
    const close = dlg.querySelector(".close-btn");
    return {
      open: true,
      hasFav: !!fav,
      favText: fav ? (fav.innerText || "").replace(/\s+/g, "") : "",
      hasClose: !!close,
      text: (dlg.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000),
    };
  }
  return { open: false };
};

async function ensureOnRecommend(page) {
  const st = await inRecommend(page, PROBE);
  if (st.cards > 0) return st;
  await page.goto("https://www.zhipin.com/web/chat/recommend");
  await page.waitForTimeout(4000);
  return await waitCards(page);
}

async function openDetail(page, i) {
  const sel = ".candidate-card-wrap .name >> nth=" + i;
  for (let t = 0; t < 3; t++) {
    try { await page.click(sel, { timeout: 6000 }); } catch (e) { log("click#%d failed: %s", t + 1, String(e).slice(0, 120)); }
    for (let k = 0; k < 12; k++) {
      await page.waitForTimeout(400);
      const ov = await inRecommend(page, OVERLAY);
      if (ov.open) return ov;
    }
  }
  return await inRecommend(page, OVERLAY);
}

async function closeDetail(page) {
  for (let t = 0; t < 8; t++) {
    try { await page.click(".close-btn", { timeout: 4000 }); } catch (e) {}
    await page.waitForTimeout(500);
    const ov = await inRecommend(page, OVERLAY);
    if (!ov.open) return { closed: true };
  }
  return { closed: false, note: "关不掉（可能卡在 v-leave）" };
}

const task = await getTask();
const page = task.page("p1");

if (CMD === "state") {
  const st = await inRecommend(page, PROBE);
  log(JSON.stringify({ space: SPACE_NAME, work: WORK, ...st, texts: undefined }, null, 1));
} else if (CMD === "cards") {
  let st = await ensureOnRecommend(page);
  if (JOB_HINT) st = await ensureJob(page);
  st = await waitCards(page);
  const cards = st.texts.map((text, i) => ({ i, name: st.names[i] || "", text }));
  const out = { ts: new Date().toISOString(), job: st.label, href: st.href, count: cards.length, cards };
  log("job:", st.label, "| cards:", st.count || cards.length);
  log("saved:", writeJson("cards.json", out));
} else if (CMD === "open") {
  const i = Number(ARG);
  const ov = await openDetail(page, i);
  if (!ov.open) { log("OPEN_FAILED", JSON.stringify(ov)); process.exitCode = 2; }
  else {
    let shot = "";
    try {
      const s = await page.screenshot({ path: path.join(WORK, "card-" + i + ".png") });
      shot = String(s && s.path ? s.path : path.join(WORK, "card-" + i + ".png"));
    } catch (e) { log("shot failed:", String(e).slice(0, 120)); }
    log(JSON.stringify({ i, hasFav: ov.hasFav, favText: ov.favText, hasClose: ov.hasClose, shot, text: ov.text }, null, 1));
    writeJson("last-open.json", { i, ...ov, shot });
  }
} else if (CMD === "fav") {
  const i = Number(ARG);
  let ov = await inRecommend(page, OVERLAY);
  if (!ov.open) ov = await openDetail(page, i);
  if (!ov.open) { log("NO_OVERLAY"); process.exitCode = 2; }
  else if (!ov.hasFav) {
    log("NO_FAV_CONTROL（岗位可能仍是「待」，推荐流 jobid=null，详情页只给「打开职位」）");
    log(JSON.stringify({ i, hasFav: false, favText: ov.favText }, null, 1));
    process.exitCode = 3;
  } else {
    await page.click(".like-icon-and-text", { timeout: 6000 }).catch((e) => log("click fav failed:", String(e).slice(0, 120)));
    let now = "";
    for (let t = 0; t < 12; t++) {
      await page.waitForTimeout(400);
      const o2 = await inRecommend(page, OVERLAY);
      now = o2.favText || "";
      if (/已收藏|取消收藏/.test(now)) break;
    }
    const ok = /已收藏|取消收藏/.test(now);
    log("fav state:", now || "(空)", ok ? "OK" : "UNCONFIRMED");
    log(JSON.stringify({ i, ok, favText: now }, null, 1));
    if (!ok) process.exitCode = 4;
  }
} else if (CMD === "review") {
  const rawIds = (fileCmd && Array.isArray(fileCmd.ids)) ? fileCmd.ids : String((fileCmd && fileCmd.arg) || ARG || "").split(",");
  const ids = rawIds.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0);
  if (!ids.length) { log('review 需要索引，例如 {"cmd":"review","ids":[0,3,5]}'); process.exitCode = 2; }
  const pack = [];
  for (const i of ids) {
    const ov = await openDetail(page, i);
    if (!ov.open) {
      pack.push({ i, open: false, note: "open failed" });
      log("review card", i, "OPEN_FAILED");
      continue;
    }
    let shot = "";
    try {
      const s = await page.screenshot({ path: path.join(WORK, "card-" + i + ".png") });
      shot = String(s && s.path ? s.path : path.join(WORK, "card-" + i + ".png"));
    } catch (e) { log("shot failed:", String(e).slice(0, 120)); }
    pack.push({ i, open: true, hasFav: !!ov.hasFav, favText: ov.favText || "", hasClose: !!ov.hasClose, shot, text: ov.text || "" });
    log("review card", i, ov.hasFav ? "fav-control" : "no-fav-control", shot);
    const c = await closeDetail(page);
    if (!c.closed) log("review card", i, "close failed（可能卡 v-leave）");
    await page.waitForTimeout(600);
  }
  log("saved:", writeJson("review-pack.json", { ts: new Date().toISOString(), count: pack.length, cards: pack }));
} else if (CMD === "apply") {
  const file = (fileCmd && fileCmd.file) || opts.file || path.join(WORK, "decisions.json");
  if (!fs.existsSync(file)) { log("decisions 文件不存在:", file); process.exitCode = 2; }
  else {
    let raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed.decisions || []);
    const gap = Math.max(12000, Number((fileCmd && fileCmd.gap) || opts.gap || process.env.FAV_GAP || 12500));
    const jl = path.join(WORK, "decisions.jsonl");
    let favs = 0, skipped = 0;
    for (const d of arr) {
      const i = Number(d.i);
      const act = String(d.action || d.verdict || "").toLowerCase();
      if (!(act.startsWith("app") || act === "fav" || act === "yes" || act === "pass")) {
        skipped++;
        log("apply skip", i, d.name || "", "|", d.reason || "");
        fs.appendFileSync(jl, JSON.stringify({ ts: new Date().toISOString(), i, name: d.name || "", action: "reject", reason: d.reason || "" }) + "\n", "utf8");
        continue;
      }
      if (favs > 0) { log("pacing wait", gap + " ms"); await page.waitForTimeout(gap); }
      let ov = await inRecommend(page, OVERLAY);
      if (!ov.open) ov = await openDetail(page, i);
      if (!ov.open) { log("apply", i, "OPEN_FAILED"); process.exitCode = 2; continue; }
      if (!ov.hasFav) {
        log("apply", i, "NO_FAV_CONTROL（岗位可能仍是「待」，没有收藏按钮，绝不乱点）");
        await closeDetail(page);
        process.exitCode = 3;
        continue;
      }
      await page.click(".like-icon-and-text", { timeout: 6000 }).catch((e) => log("click fav failed:", String(e).slice(0, 120)));
      let now = "";
      for (let t = 0; t < 12; t++) {
        await page.waitForTimeout(400);
        const o2 = await inRecommend(page, OVERLAY);
        now = o2.favText || "";
        if (/已收藏|取消收藏/.test(now)) break;
      }
      const ok = /已收藏|取消收藏/.test(now);
      if (ok) favs++;
      log("apply", i, d.name || "", ok ? "FAV OK" : "UNCONFIRMED", now);
      fs.appendFileSync(jl, JSON.stringify({ ts: new Date().toISOString(), i, name: d.name || "", action: "approve", fav: ok, reason: d.reason || "" }) + "\n", "utf8");
      await closeDetail(page);
      if (!ok) process.exitCode = 4;
    }
    log("APPLY_DONE fav=" + favs + " skipped=" + skipped);
  }
} else if (CMD === "close") {
  const r = await closeDetail(page);
  log(JSON.stringify(r));
  if (!r.closed) process.exitCode = 2;
} else if (CMD === "decide") {
  const rec = (fileCmd && fileCmd.decide) || JSON.parse(ARG || "{}");
  const p = path.join(WORK, "decisions.jsonl");
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", "utf8");
  log("decided:", p);
} else if (CMD === "round") {
  // 唯一流程：ego 只提供 transport，流程本身在 ../core/flow.mjs（与 A 路线同一份代码）
  const P = fileCmd || {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const crypto = await import("node:crypto");
  const cp = await import("node:child_process");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const HERE = fileURLToPath(new URL(".", import.meta.url));
  const { runFlow, HARD } = await import(pathToFileURL(path.join(HERE, "..", "core", "flow.mjs")).href);
  const sha1 = (s) => crypto.createHash("sha1").update(String(s || ""), "utf8").digest("hex").slice(0, 16);

  const TARGET = Math.max(1, num(P.target, 2));
  const SCAN_PER_JOB = Math.max(5, num(P.scanPerJob, 100));
  const MAX_JOBS = Math.max(1, num(P.maxJobs, 20));
  const SOFT = P.softReview === true || String(P.softReview) === "1";
  const DRY = P.dryRun === true || String(P.dryRun) === "1";
  const FAV_CAP = Math.min(HARD.favCap, Math.max(1, num(P.favCap, HARD.favCap)));
  const MAX_MIN = Math.min(HARD.maxMinutes, Math.max(1, num(P.maxMinutes, HARD.maxMinutes)));
  const SPACING = Math.max(HARD.spacingMin, num(P.spacing, 18000));
  const FAV_GAP = Math.max(HARD.favGapMin, num(P.favGap, 12500));
  const JITTER = Math.min(0.5, Math.max(0, num(P.jitter, 0.25)));
  const SOFT_TIMEOUT_MS = Math.max(60000, num(P.softTimeoutMin, 15) * 60000);
  const jitterOf = (b) => Math.round(b + (Math.random() * 2 - 1) * b * JITTER);
  const pacedSpacing = () => Math.max(HARD.spacingMin, jitterOf(SPACING));
  const pacedFavGap = () => Math.max(HARD.favGapMin, jitterOf(FAV_GAP));
  const dwell = async (lo, hi) => { await page.waitForTimeout(lo + Math.floor(Math.random() * (hi - lo + 1))); };

  const readJson = (f, d) => { try { let raw = fs.readFileSync(f, "utf8"); if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); return JSON.parse(raw); } catch (e) { return d; } };
  const resolvePy = () => {
    const want = String(P.py || process.env.PYTHON_BIN || "").trim();
    const cands = want ? [want, "python3", "python", "py"] : ["python3", "python", "py"];
    for (const b of cands) {
      try {
        const r = cp.spawnSync(b, ["-c", "import sys;sys.stdout.write(sys.version)"], { encoding: "utf8", timeout: 15000 });
        if (r.status === 0 && /\d+\.\d+/.test(r.stdout || "")) return b;
      } catch (e) {}
    }
    return null;
  };
  const PY = resolvePy();
  if (!PY) { log("FATAL 找不到可用的 Python 解释器（判定器需要；设 PYTHON_BIN 或用 py 启动器）"); process.exit(2); }
  const JUDGE = String(P.judge || path.join(HERE, "..", "judge.py"));

  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  let state = readJson(path.join(WORK, "daily_state.json"), null);
  if (!state || state.date !== today()) state = { date: today(), favorites: 0, cycles: 0, startedAt: Date.now() };
  if (!state.startedAt) state.startedAt = Date.now();
  const saveState = () => writeJson("daily_state.json", state);
  const known = readJson(path.join(WORK, "known_fav.json"), {});
  const realNames = readJson(path.join(WORK, "real_names.json"), {});
  const append = (f, o) => fs.appendFileSync(path.join(WORK, f), JSON.stringify(o) + "\n", "utf8");

  function runJudge(texts) {
    const valid = (texts || []).filter((t) => typeof t === "string" && t.trim());
    if (!valid.length) return [];
    const tmp = path.join(WORK, ".ego_cards.jsonl");
    const outs = ["strict3v2_ok.json", "strict3v2_near.json", "strict3v2_all.json", "strict3v2_summary.json"].map((n) => path.join(WORK, n));
    for (const o of outs) fs.rmSync(o, { force: true });
    fs.writeFileSync(tmp, valid.map((t) => JSON.stringify({ card: t })).join("\n") + "\n", "utf8");
    const r = cp.spawnSync(PY, [JUDGE, tmp], { cwd: WORK, encoding: "utf8", timeout: 180000, env: { ...process.env, BOSS_WORK: WORK } });
    fs.rmSync(tmp, { force: true });
    if (r.status !== 0) { log("FATAL judge failed:", String(r.stderr || r.error || "").slice(0, 400)); return null; }
    return readJson(path.join(WORK, "strict3v2_ok.json"), []);
  }

  async function softAsk(c, ov) {
    writeJson("soft_pack.json", {
      ts: new Date().toISOString(), card_id: c.cid, name: c.name, age: c.age,
      card_text: c.text, dialog_text: (ov && ov.dialogText) || "",
      ask: "软条件是否通过？写 soft_ok.json：{\"card_id\":\"…\",\"approved\":true|false,\"reason\":\"…\"}（可 all:true 全部通过）",
    });
    const okFile = path.join(WORK, "soft_ok.json");
    const t0 = Date.now();
    while (Date.now() - t0 < SOFT_TIMEOUT_MS) {
      const a = readJson(okFile, null);
      if (a && (a.all === true || String(a.card_id || "") === c.cid)) {
        fs.rmSync(okFile, { force: true });
        return { approved: a.approved === true || String(a.approved) === "true", reason: String(a.reason || "") };
      }
      await page.waitForTimeout(2000);
    }
    return { approved: null, reason: "timeout" };
  }

  async function listJobs() {
    await page.click(".job-selecter-wrap .ui-dropmenu-label", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);
    const items = await page.evaluate(() => {
      const docs = [document];
      for (const f of [...document.querySelectorAll("iframe")]) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} }
      for (const d of docs) {
        const its = [...d.querySelectorAll(".job-item")];
        if (its.length) return its.map((x, i) => ({ i, text: (x.innerText || "").replace(/\s+/g, " ").trim(), curr: /curr/.test(String(x.className)) }));
      }
      return [];
    });
    await page.click(".job-selecter-wrap .ui-dropmenu-label", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    return items;
  }

  async function pickJob(i) {
    await page.click(".job-selecter-wrap .ui-dropmenu-label", { timeout: 8000 });
    await page.waitForTimeout(700);
    await page.click(".job-selecter-options .job-item >> nth=" + i, { timeout: 8000 });
    await page.waitForTimeout(2500);
    return await waitCards(page);
  }

  const SCROLL_DOWN = () => {
    const docs = [document];
    for (const f of [...document.querySelectorAll("iframe")]) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} }
    for (const d of docs) {
      const cards = d.querySelectorAll(".candidate-card-wrap").length;
      if (!cards) continue;
      const w = d.defaultView || window;
      let el = d.querySelector(".candidate-card-wrap");
      let box = null;
      while (el && el !== d.body) {
        const st = w.getComputedStyle(el);
        if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 80) { box = el; break; }
        el = el.parentElement;
      }
      const before = box ? box.scrollTop : (d.scrollingElement || d.documentElement).scrollTop;
      if (box) box.scrollTop = before + 1000; else (d.scrollingElement || d.documentElement).scrollTop = before + 1000;
      try { w.scrollBy(0, 1000); } catch (e) {}
      const after = box ? box.scrollTop : (d.scrollingElement || d.documentElement).scrollTop;
      return { cards, before, after, boxed: !!box };
    }
    return { cards: 0, note: "no cards" };
  };

  const transport = {
    async probe() {
      const st = await inRecommend(page, PROBE);
      const loggedIn = !/(\/web\/user\/|\/web\/passport\/)/.test(st.href || "");
      const cards = (st.ok === false ? [] : (st.texts || [])).map((text, i) => {
        const m = /(\d{1,2})\s*岁/.exec(text || "");
        return { i, name: (st.names || [])[i] || "", age: m ? Number(m[1]) : 0, text, cid: sha1(text) };
      });
      if (cards.length === 0) log("PROBE_EMPTY " + JSON.stringify({ label: st.label || "", href: st.href || "", diag: st.diag || null }));
      return { ok: st.cards >= 0, label: st.label || "", href: st.href || "", loggedIn, cards, diag: st.diag || null };
    },
    async sources() {
      const jobs = await listJobs();
      return jobs.map((j) => ({ key: String(j.i), label: j.text, text: j.text }));
    },
    async selectSource(src) {
      const st = await pickJob(Number(src.key));
      if (!st || (st.cards || 0) <= 0) {
        // 空列表不等于「这个岗位没人」：先重载一次再判，并留下诊断
        log("SOURCE_EMPTY " + JSON.stringify({ label: (st && st.label) || "", cards: (st && st.cards) ?? -1, diag: (st && st.diag) || null }));
        log("SOURCE_RELOAD → 重新打开推荐页再读一次");
        await page.goto("https://www.zhipin.com/web/chat/recommend", { timeout: 30000 }).catch((e) => log("reload failed:", String(e).slice(0, 120)));
        await page.waitForTimeout(3000);
        const again = await waitCards(page);
        log("SOURCE_RELOAD_RESULT " + JSON.stringify({ label: (again && again.label) || "", cards: (again && again.cards) ?? -1 }));
        return { label: (again && again.label) || (st && st.label) || "" };
      }
      return { label: (st && st.label) || "" };
    },
    async openCard(c) {
      const cur = await inRecommend(page, PROBE);
      const idx = (cur.texts || []).findIndex((x) => (x || "").trim() === (c.text || "").trim());
      const ov = await openDetail(page, idx >= 0 ? idx : c.i);
      return { open: !!ov.open, hasFav: !!ov.hasFav, favText: ov.favText || "", dialogText: ov.text || "" };
    },
    async fav() {
      await page.click(".like-icon-and-text", { timeout: 6000 }).catch((e) => log("click fav failed:", String(e).slice(0, 120)));
      let now = "";
      for (let t = 0; t < 12; t++) {
        await page.waitForTimeout(400);
        const o2 = await inRecommend(page, OVERLAY);
        now = o2.favText || "";
        if (/已收藏|取消收藏/.test(now)) break;
      }
      const ok = /已收藏|取消收藏/.test(now);
      log("fav state:", now || "(空)", ok ? "OK" : "UNCONFIRMED");
      return { ok, favText: now };
    },
    async close() { await closeDetail(page); },
    async scroll() {
      await inRecommend(page, SCROLL_DOWN);
      await page.waitForTimeout(2200);
      const st = await inRecommend(page, PROBE);
      return { cards: st.cards > 0 ? st.cards : 0 };
    },
    async wait(ms) { await page.waitForTimeout(ms); },
  };

  const io = {
    log,
    judge: (texts) => runJudge(texts),
    softAsk: async (c, ov) => softAsk(c, ov),
    state,
    saveState,
    isKnown: (c) => !!known[c.cid],
    onFav: (c, brief) => {
      known[c.cid] = c.name + "|" + c.age; writeJson("known_fav.json", known);
      realNames[c.cid] = c.name; writeJson("real_names.json", realNames);
      append("passes.jsonl", { ts: new Date().toISOString(), card_id: c.cid, name: c.name, real_name: c.name, age: c.age, verdict: (brief && brief.verdict) || "PASS" });
    },
    onDecision: (rec) => append("decisions.jsonl", { ts: new Date().toISOString(), ...rec }),
    writeSummary: (s) => { log("saved:", writeJson("round-summary.json", s)); },
  };

  const r = await runFlow({
    t: transport,
    io,
    cfg: {
      target: TARGET, scanPerJob: SCAN_PER_JOB, maxJobs: MAX_JOBS, jobHint: JOB_HINT,
      softReview: SOFT, softTimeoutMs: SOFT_TIMEOUT_MS, dryRun: DRY,
      favCap: FAV_CAP, maxMinutes: MAX_MIN, pacedSpacing, pacedFavGap, dwell,
    },
  });
  if (r && r.exit) process.exitCode = r.exit;
} else {
  log("unknown cmd:", CMD, "| use state|cards|open <i>|fav <i>|close|decide <json>|review --ids|apply|round");
  process.exitCode = 2;
}
