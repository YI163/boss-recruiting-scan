# boss-recruiting-scan

BOSS 直聘招聘端「推荐牛人」的**批量筛人 + 收藏** skill：CDP 驱动、防封节奏与配额、每 5 人一道人工审核闸门、判定口径可替换，附带 Windows 补丁与一份踩坑排查手册。

> A Claude/DSH-style skill for screening and bookmarking candidates on the BOSS Zhipin recruiter recommendation feed. CDP-driven, rate-limited, with a mandatory human-review gate every 5 bookmarks. Zero outreach by design.

## 最短用法（零基础，一句话 + 一句要求）

**把这个仓库地址丢给你正在用的 AI 助手（DSH / Claude Code / Cursor / ChatGPT 等），一句话里把「要什么人」说清楚：**

> 把 https://github.com/YI163/boss-recruiting-scan 装成 skill，帮我筛人：**深圳、兼职、Java 后端，本科计算机相关专业，一年以上后端经验（应届要有完整项目）**。先跑两轮，每 5 个给我审一次。

**「要什么人」这句不能省。** 这个 skill 不是一键全自动的筛人机器，它按你给的要求判。你不说要求，它就只能用仓库里的默认口径——那是给模板看的示例，**在真实候选人卡片上常常一个人都不 PASS**（真实卡片没有起止日期，默认口径算不出年限）。

要求里最好说清这 5 件事，说漏的 AI 会反问你：

1. **岗位方向**：Java 后端 / 前端 / 测试 / 运营 / 销售…
2. **城市**：只要深圳，还是深圳优先、周边（东莞/惠州/广州）也行
3. **全职还是兼职**、能接受的薪资范围
4. **经验与学历**：几年以上、本科还是大专、专业是否要计算机相关、应届要不要
5. **硬性加分项**：例如 Spring Boot / 微服务 / Redis；英语 A 级；教学或大厂经历

不知道怎么写也不要紧：AI 会按这 5 项问你要答案，然后先给你一张「口径卡」和判定器改动让你确认，确认后才开始跑。

装好之后它自己会 clone、放进 skill 目录、起一个独立的调试 Chrome。你只需要做三件事：

1. 在它打开的 Chrome 窗口里登录招聘端（**选「我要招聘」**，不是「我要找工作」）
2. 每 5 个人它会停下来给你一份名单，你回「这批都行」或点名去掉谁
3. 跑完看它出的台账（xlsx + md），自己再核一遍

一句记不住就记这句：**「把这个仓库装成 skill，我要招<岗位+城市+年限+学历>，带我跑一轮。」**

---

## ⚠️ 风险与免责声明（先读这一段，再决定要不要跑）

**这个工具会操作真实账号，可能让你被限流甚至封号。**

- **封号 / 限流风险（最需要权衡的一条）**：BOSS 直聘及同类招聘平台的用户协议普遍限制「自动化 / 批量 / 脚本化操作」。本 skill 通过浏览器调试协议真实点击页面，动作与人工相似，但**仍然可能被风控识别**。可能的后果包括但不限于：频繁安全验证、推荐与沟通功能受限、临时封禁、**永久封号**、企业账号与关联账号连带受限。**不要拿你的主账号 / 公司主账号来试**，用你有权处置、且丢了不心疼的账号。
- **不承诺可用性**：平台前端一改版（DOM、类名、iframe 结构变化）或风控策略一调整，脚本就可能失效、点空、误判。作者不承诺持续维护，也不承诺任何筛选效果、面试量或录用结果。
- **不提供任何风控绕过**：本项目不含也不会加入代理池、指纹伪装、验证码识别、账号池、并发多开、模拟真人轨迹等手段。节奏（轮 ≥15s / 收藏 ≥12s）与配额（日收藏 ≤60、轮次 ≤200、连跑 ≤180 分钟）是**硬编码下限**，为绕过而放宽等于自担更大概率封号。
- **个人信息与合规**：候选人简历属于个人信息。请自行确认你所在司法辖区的法律（例如《个人信息保护法》）、平台协议与公司内部规定是否允许你以这种方式处理这些数据；台账、截图、审核包应存放在受控位置，**不得外传、不得商用、不得用于与招聘无关的用途**。你无权处理这些数据时，请不要运行。
- **非官方**：本项目与 BOSS 直聘无任何关联，未获其授权、认可或背书；平台名称与页面元素仅用于说明用途。
- **责任自负**：因使用本工具产生的任何后果——账号受限/封禁、数据丢失、误收藏/漏收藏、错筛人选、法律纠纷、业务损失——均由使用者自行承担；作者与贡献者不承担任何责任，也不提供任何形式的担保（详见 `LICENSE`）。
- **先人工后动作**：脚本只负责「采集 + 判定 + 收藏」，**录用、沟通、Offer 等一切对外动作必须由人来做**；被拒绝的人要用 `--rollback` 清掉，跑完自己核对一遍台账。
- **不认同就别用**：如果你不接受以上任何一条，请不要克隆、不要运行、不要用于任何生产/商业场景。

---

## 它做什么

1. 连上你**自己已登录**的招聘端 Chrome（独立调试实例，不碰主窗口）
2. 每轮读「推荐牛人」流的候选人卡片 → 交给判定器（默认 `scripts/judge.py`，可换 `judge_template.py`）
3. 对 PASS 的人点「收藏」，每 5 人**强制停轮**，产出 `review_batch_N.json` 交你审核
4. 审核不通过的人回滚（取消收藏）→ 最后出 xlsx + md 台账

## 它不做什么（硬性边界，写进代码）

- **零外联**：不打招呼、不发消息、不点「联系Ta / 搜索畅聊卡」；只有「收藏」和「关闭浮层」两个写操作，且点击前有 allowlist。
- 不绕过平台限制：节奏有下限（轮间隔 ≥15s、收藏间隔 ≥12s），配额有上限（单日收藏 ≤60、轮次 ≤200、连跑 ≤180 分钟），登录页/安全验证/操作频繁即停。
- 不导出隐私：身份以推荐流的**真实姓名 + card_id** 为准（落在本机 `real_names.json`），判定器输出仍是掩码；不采集手机号/微信/邮箱，卡片原文只用临时文件、判完即删。--rollback 支持真实姓名与 card_id。

## 安装

```bash
git clone https://github.com/YI163/boss-recruiting-scan.git            # 官方
git clone https://gh-proxy.com/https://github.com/YI163/boss-recruiting-scan.git   # 国内镜像，git 可用（实测 3.4s）
# 只取文件：curl -L -o skill.zip https://codeload.github.com/YI163/boss-recruiting-scan/zip/refs/heads/main
```

`gh-proxy.com` 不通时换 `ghproxy.net`；长期只读镜像可在 Gitee「从 GitHub 导入」。clone 后**不需要** npm/pip 装任何依赖。

然后把 `boss-recruiting-scan/` 整个目录放进你的 skill 目录即可（目录名就是 skill 名；不放也能直接 `node scripts/...` 跑）：

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
# 1) 起一个带调试端口的独立 Chrome，并在里面登录一次招聘账号（登录时选「我要招聘」）
#    macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir=$HOME/.boss-prof --remote-debugging-port=9333 \
  https://www.zhipin.com/web/chat/index
#    Windows
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$env:USERPROFILE\.boss-prof" --remote-debugging-port=9333 `
  https://www.zhipin.com/web/chat/index
#    受管终端（DSH 等）用 start-detached.ps1 脱离启动，否则命令一结束 Chrome 就被带走、9333 消失

# 2) 确认连上了（看 url / frames / login / loginDetail）
node scripts/cdp.mjs state

# 3) 离线自检（无需浏览器）
python scripts/judge.py --selftest                   # 默认判定器 12/12
node scripts/scan-favorite.mjs --selfcheck-judge     # 判定器契约回归 6/6

# 4) 联调：只判定不点收藏
FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 1 1

# 5) 正式：≤150 轮，收藏满 5 人自动停轮交审（exit 42）
node scripts/scan-favorite.mjs 150 5

# 6) 审核后写 review_ok_1.json；只想接受审批用 --accept-only（不连浏览器、不再收藏人）
node scripts/scan-favorite.mjs --accept-only

# 7) 出台账（不传 --out 就写到 $BOSS_WORK）
python scripts/make_ledger.py --work "$BOSS_WORK" --title 招聘筛人台账
```

> **默认判定器不是通用口径**：`judge.py` 依赖卡片起止日期，BOSS 推荐卡多数没有日期 → 真实卡上常 `0 PASS`（实测 14 张真卡 0 PASS）。第一次用请按 `judge_template.py` 改写口径。

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

- [`references/troubleshooting.md`](boss-recruiting-scan/references/troubleshooting.md) —— 白屏三因、卡住四因、点空三层（含实测像素偏差）、闸门卡住、为什么扩展桥不能收藏、Windows 专属结论，以及第七节「新人外测暴露的入门层缺口」。
- [`README-windows.md`](boss-recruiting-scan/README-windows.md) —— Windows 上 Chrome 136+ 禁默认 profile 调试、App-Bound Encryption 让登录态搬不动等硬约束。
- [`HANDOVER.md`](boss-recruiting-scan/HANDOVER.md) —— 交接说明与目录约定。

## 最近修复：一次外部实测的 24 条缺口

有人只拿这个仓库、在干净沙盒里从零跑了两轮，交出 24 条缺口（2 Blocker + 13 Major + 9 Minor）。结论是**执行层结实、入门层漏三处**：取仓库（国内网络）、起常驻 Chrome（受管终端）、默认口径（真实卡 0 PASS）。已修：

- 文档：取仓库三路径（官方 / `gh-proxy.com` / zip）、脱离启动、**登录选「我要招聘」**、自检顺序、PowerShell 编码、默认口径警告、核对收藏只认 `this_round`、卡片「期望城市」不可信。
- 代码：`cdp.mjs` 的 `login` 判据（旧版登录成功也报 false）、新增 `navigate`、`cards` 在收藏页回退、`shot` 用 `fromSurface:false`；收藏顺序真的按判定器排序（此前 changelog 声称已实现、代码仍按 DOM 顺序）；新增 `--accept-only` 且接受早于配额检查；`--batch` 批号防重；`--rollback` 加就绪轮询并回退账本；`make_ledger.py` 默认输出目录与本地时区；`favcapture.mjs` 区分本轮与历史。

改动细节见 `boss-recruiting-scan/SKILL.md` 的「版本」段（**本地补丁 3**）。

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
