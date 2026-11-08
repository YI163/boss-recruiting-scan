import { runFlow } from "./flow.mjs";
const mk = (k, n) => Array.from({ length: n }, (_, i) => ({ i, name: k + "-" + i, age: 25, text: k + "-" + i + " 25岁 cid-" + k + "-" + i, cid: "cid-" + k + "-" + i }));
const jobs = [{ key: "J1", label: "A", text: "J1" }, { key: "J2", label: "B", text: "J2" }];
const data = new Map(jobs.map(j => [j.key, mk(j.key, 130)]));
let cur = null, shown = 15;
const t = {
  async probe() { if (!cur) return { ok: false, loggedIn: false, cards: [], href: "x" }; return { ok: true, label: cur, href: "y", loggedIn: true, cards: data.get(cur).slice(0, shown) }; },
  async sources() { return jobs; },
  async selectSource(s) { cur = s.key; shown = 15; return { label: cur }; },
  async openCard(c) { return { open: true, hasFav: true }; },
  async fav() { return { ok: true }; },
  async close() {},
  async scroll() { shown = Math.min(130, shown + 15); return { cards: shown }; },
  async wait() {},
};
const io = {
  log: (...a) => console.log("[flow]", ...a),
  judge: (texts) => texts.map((t, i) => ({ card_id: "cid-" + /cid-([\w-]+)/.exec(t)[1] })),
  state: { favorites: 0, cycles: 0 }, saveState: () => {}, isKnown: () => false,
  onFav: () => {}, onDecision: () => {}, writeSummary: () => {},
};
const r = await runFlow({ t, io, cfg: { target: 999, scanPerJob: 20, maxJobs: 5, dryRun: true, softReview: false, pacedSpacing: () => 1, pacedFavGap: () => 1, dwell: async () => {} } });
console.log("RESULT", JSON.stringify({ exit: r.exit, jobs: r.jobs, looked: r.looked }));
