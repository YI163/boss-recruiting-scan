# boss-recruiting-scan

BOSS 直聘招聘端「推荐牛人」的**批量筛人 + 收藏** skill：CDP 驱动、防封节奏与配额、每 5 人一道人工审核闸门、判定口径可替换，附带 Windows 补丁与一份踩坑排查手册。

> A Claude/DSH-style skill for screening and bookmarking candidates on the BOSS Zhipin recruiter recommendation feed. CDP-driven, rate-limited, with a mandatory human-review gate every 5 bookmarks. Zero outreach by design.

## 它做什么

1. 连上你**自己已登录**的招聘端 Chrome（独立调试实例，不碰主窗口）
2. 每轮读「推荐牛人」流的候选人卡片 → 交给判定器（默认 `scripts/judge.py`，可换 `judge_template.py`）
3. 对 PASS 的人点「收藏」，每 5 人**强制停轮**，产出 `review_batch_N.json` 交你审核
4. 审核不通过的人回滚（取消收藏）→ 最后出 xlsx + md 台账

## 它不做什么（硬性边界，写进代码）

- **零外联**：不打招呼、不发消息、不点「联系Ta / 搜索畅聊卡」；只有「收藏」和「关闭浮层」两个写操作，且点击前有 allowlist。
- 不绕过平台限制：节奏有下限（轮间隔 ≥15s、收藏间隔 ≥12s），配额有上限（单日收藏 ≤60、轮次 ≤200、连跑 ≤180 分钟），登录页/安全验证/操作频繁即停。
- 不导出隐私：姓名只落掩码（`张**`），不采集手机号/微信/邮箱，卡片原文只用临时文件、判完即删。

## 安装

把 `boss-recruiting-scan/` 整个目录放进你的 skill 目录即可（目录名就是 skill 名）：

```bash
# DSH
cp -r boss-recruiting-scan ~/.dsh/skills/
# Claude Code（用户级 / 项目级）
cp -r boss-recruiting-scan ~/.claude/skills/      # 或 <project>/.claude/skills/
```

Windows：

```powershell
Copy-Item .\boss-recruiting-scan "$env:USERPROFILE\.dsh\skills\" -Recurse -Force
```

## 快速开始

```bash
# 1) 起一个带调试端口的独立 Chrome，并在里面登录一次招聘账号
#    macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir=$HOME/.boss-prof --remote-debugging-port=9333 \
  https://www.zhipin.com/web/chat/recommend
#    Windows
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$env:USERPROFILE\.boss-prof" --remote-debugging-port=9333 `
  https://www.zhipin.com/web/chat/recommend

# 2) 确认连上了
node scripts/cdp.mjs state

# 3) 离线自检（无需浏览器）
python scripts/judge.py --selftest                   # 默认判定器 12/12
node scripts/scan-favorite.mjs --selfcheck-judge     # 判定器契约回归 6/6

# 4) 联调：只判定不点收藏
FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 1 1

# 5) 正式：≤150 轮，收藏满 5 人自动停轮交审（exit 42）
node scripts/scan-favorite.mjs 150 5

# 6) 审核后写 review_ok_1.json 再继续；出台账
python scripts/make_ledger.py --work "$BOSS_WORK" --out . --title 招聘筛人台账
```

Windows 上的解释器、路径与冒烟验收见 [`boss-recruiting-scan/README-windows.md`](boss-recruiting-scan/README-windows.md)；
完整安装说明见 [`boss-recruiting-scan/README.md`](boss-recruiting-scan/README.md)。

## 换岗位 / 换条件

流程与口径解耦：`cp scripts/judge_template.py my_judge.py`，改 `CONFIG`（c1/c2/c3 关键词、排除词、月数门槛、城市优先级）即可，然后
`JUDGE_PY=$PWD/my_judge.py node scripts/scan-favorite.mjs 150 5`。
判定器契约、字段表与两个可运行示例见 [`references/custom-criteria.md`](boss-recruiting-scan/references/custom-criteria.md)。

## 两种连接方式

| | A. 独立调试实例（默认） | B. 浏览器扩展桥 |
|---|---|---|
| 能力 | 采集 → 判定 → **收藏** → 闸门 → 台账 | 采集 → 判定（只读筛人） |
| 原因 | 原生 CDP：可 `Runtime.evaluate`、可派发真实鼠标事件 | 工具级桥只给 snapshot 序号/CSS selector 点击，没有坐标也没有任意 JS；而卡片的「收藏」不是 button/a |

自动收藏只有 A 一条路。细节见 `SKILL.md`「两种连接方式（二选一）」。

## 排障

三份文档，按遇到问题的类型看：

- [`references/troubleshooting.md`](boss-recruiting-scan/references/troubleshooting.md) —— 白屏三因、卡住四因、点空三层（含实测像素偏差）、闸门卡住、为什么扩展桥不能收藏、Windows 专属结论。
- [`README-windows.md`](boss-recruiting-scan/README-windows.md) —— Windows 上 Chrome 136+ 禁默认 profile 调试、App-Bound Encryption 让登录态搬不动等硬约束。
- [`HANDOVER.md`](boss-recruiting-scan/HANDOVER.md) —— 交接说明与目录约定。

## 目录结构

```
boss-recruiting-scan/       skill 本体（可直接安装）
├── SKILL.md                主文档：流程、铁律、两条路线、已知坑
├── README.md               5 分钟快速上手
├── README-windows.md       Windows 补丁与环境
├── HANDOVER.md             交接
├── config.example.json     节奏/配额配置（只能更严）
├── scripts/                cdp.mjs / scan-favorite.mjs / judge*.py / make_ledger.py …
└── references/             criteria.md / custom-criteria.md / troubleshooting.md
dev/                        排查用的探针脚本（我的原始调试 harness，路径需自行改）
```

`dev/` 里是定位上述 bug 时写的一次性探针：`probe-*.mjs`（DOM/浮层/点击命中/帧树取证）、`fav-*.mjs`（单步收藏流程）、`check-favs.mjs`（核对收藏列表）、`judge-pt-java.py`（一个改好的自定义判定器示例）。它们依赖 `cdp.mjs` 的连接方式，硬编码路径已脱敏，运行前按需改。

## 免责声明

本项目只用于**你自己有权限的招聘账号**，且请遵守 BOSS 直聘的用户协议。内置的节奏下限、配额上限与每 5 人审核闸门，就是为了让批量操作不至于伤到账号、也不会在无人复核的情况下误收藏候选人。使用前请确认你所在司法辖区与平台规则允许这类自动化操作。

## License

MIT，见 [LICENSE](LICENSE)。
