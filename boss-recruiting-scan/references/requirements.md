# 需求台账（对话里提过的要求 → 现在落到哪）

状态口径：
- ✅ **落地**：文档 + 代码都有，且实测过。
- 📄 **只有文档**：文档写了，代码靠脚本约定，或尚未实测。
- 🔧 **只有代码**：代码做了，文档没写清楚。
- ❌ **未落地**：提过，但文档和代码都没有。
- 🗄 **已被取代**：早期要求，后来被你改掉了（保留记录，避免又被翻出来）。

---

## A. 安全与边界（永不放宽）

| 状态 | 要求 | 出处 | 落在哪 |
|---|---|---|---|
| ✅ | 只做招聘端「推荐牛人」筛人 + 收藏；**零外联**：不打招呼、不联系 Ta、不开聊、不点「搜索畅聊卡」 | 全程反复 | 铁律 1；代码 allowlist 拦「打招呼/联系Ta/聊卡」 |
| ✅ | 节奏下限 轮 ≥15s（默认 18s）、收藏 ≥12s（默认 12.5s），env/config 只能更严 | 早期设定 | 铁律 2；`HARD.spacingMin/favGapMin` 用 `Math.max` 夹 |
| ✅ | 节奏抖动 `JITTER_PCT` 默认 0.25，抖动后仍不低于下限 | m02353 | 铁律 2；`pacedSpacing()/pacedFavGap()`；`--pacing-selftest` |
| ✅ | 配额：日收藏 ≤60、日轮次 ≤200、连跑 ≤180 分钟；日切按 Asia/Shanghai | 早期设定 | 铁律 3；`daily_state.json` |
| ✅ | 风险即停：登录页 / 安全验证 / 操作频繁 / 收藏失败率 >50% → 截图 + `STOP_TODAY` | 早期设定 | 铁律 4 |
| ✅ | 隐私：不导出手机号/微信/邮箱；卡片原文只在判定时临时落盘 | 早期设定 | 铁律 5；隐私说明 |
| ✅ | 不碰付费动作（搜索畅聊卡等） | 早期设定 | 铁律 6 |
| ✅ | **不做「随机点击 / 轨迹伪装」当防封** | m02353 | 铁律 10⑤；已知坑；troubleshooting 第九节 |
| ✅ | 风险自担声明（封号风险、别用主账号、无风控绕过） | m02197 | 铁律 10；根 README 免责声明；仓库简介 |

## B. 运行流程（当前模型）

| 状态 | 要求 | 出处 | 落在哪 |
|---|---|---|---|
| ✅ | 流程固定：采集 → 硬条件 → 【软条件】→ 收藏 → 校验 → 关详情 → 台账 | m03147 | 两模式节「共同流程」 |
| ✅ | **硬条件由脚本判**（0 token、毫秒级） | m02871 | 铁律 7；`judge.py` |
| ✅ | **软条件由 agent 判**（不是用户） | m02864 | 铁律 7；`references/soft-review-checklist.md` |
| ✅ | 用户**没提**软条件 → 纯脚本跑完，**不需要二次检查** | m03147 | 两模式节；`--soft-review` 默认关 |
| ✅ | 三种状态互斥：**默认纯脚本**（不审）；提了软条件 → `--soft-review` 先审后点（通过才收藏，不通过关详情看下一张）；要「先收藏回头再挑」→ `BATCH_REVIEW=1` 批量模式 | m02822 / m02871 / m03147 | 铁律 7、Step 7a/7b、README「审核的三种状态」表；代码 `SOFT_REVIEW` 与 `BATCH_REVIEW` 互斥（补丁 9 修复 F1） |
| ✅ | 软条件超时不等于同意（`SOFT_TIMEOUT_MIN` 默认 15 分钟，超时 exit 44） | m03147 | 两模式节；`softAsk()` |
| 🗄 | 「每收藏 N 个停轮送审 → 写 review_batch_N → exit 42」 | m02421 之前 | 批量模式仍保留（`REVIEW_EVERY`，默认 5、可设 1），但**已不是默认流程** |
| 🗄 | 「被拒 → 自动取消收藏（AUTO_ROLLBACK_REJECTED）」 | m02421 | 同上，仅当走了「先收藏后审核」的批量模式才需要；先审后点时被拒者根本没被收藏 |

## C. 判定与审核

| 状态 | 要求 | 出处 | 落在哪 |
|---|---|---|---|
| ✅ | 口径三段（方向 / 硬证据 / 学历年限），每段写清「算/不算」 | 早期 | Step 0；`references/criteria.md` |
| ✅ | 默认判定器不是通用口径，真实卡常 0 PASS，第一次用要当骨架改写 | 外测 D4 | Step 0 警告 |
| ✅ | 判定器契约（`strict3v2_ok.json` 字段 + 姓名前缀+`**`） | 早期 | 「换口径」节 |
| ✅ | 台账 xlsx + md；`--out` 默认 `$BOSS_WORK`；时间转本地时区 | 外测 D21–D23 | Step 9 |
| ✅ | 姓名口径：卡片真实姓名 + card_id，落本机 `real_names.json` | m01817 | 铁律 5、9；Step 5 |
| ✅ | 掩码姓名（带 `*`）不收藏、不作身份 | m01817 | 铁律 9 |

## D. 平台 / 环境适配

| 状态 | 要求 | 出处 | 落在哪 |
|---|---|---|---|
| ✅ | 不在「精选」页收藏（要畅聊卡、姓名是掩码） | m01817 | 铁律 8 |
| ✅ | **每次刷新/换页后岗位会跳回第一个，必须重新选** | m02819 | `listJobsA()`/`pickJobA()` + 开卡前核对岗位标签；SKILL Step 1 与「已知坑」 |
| ✅ | 岗位「待」时详情页没有收藏按钮，要显式报错、不许乱点 | 实测 | 统一在 `core/flow.mjs`：开卡后 `hasFav=false` → `NO_FAV_CONTROL` 跳过（ego exit 3 保留） |
| ✅ | 未开放岗位的「打开职位」按钮不点（会真的开职位/消耗资源） | 推断 | 代码从不点它；SKILL/README/troubleshooting 三处写明 |
| ✅ | Chrome 136+ 禁止在默认 profile 开调试端口；Windows v20 加密导致 cookie 搬不动 | 实测 | 前置条件 1 |
| ✅ | 受管终端（DSH/Job Object）必须「脱离启动」Chrome，否则端口随命令消失 | 外测 D1 | 前置条件 1 |
| ✅ | `python3` 可能是 Store 空壳，要显式 `PYTHON_BIN` | 实测 | 前置条件 4 |
| ✅ | 取仓库三路径（官方 / gh-proxy.com 镜像 / codeload zip） | m01473 | 前置条件 0 |
| ✅ | 登录必须选「我要招聘」 | 外测 D5 | 前置条件 2 |
| ✅ | PowerShell 5.1 编码坑（`chcp 65001`、BOM 会让 JSON.parse 失败） | 实测 | 前置条件 6 |

## E. ego 路线（C 方案）

| 状态 | 要求 | 出处 | 落在哪 |
|---|---|---|---|
| ✅ | ego 可作为第二种运行方式；语义快照 + 跨 iframe 选择器点击（`>> nth=`） | m02999 | 「C 方案怎么用」 |
| ✅ | ego 加 `--remote-debugging-port=9444` = 标准 CDP，可复用 A 的全流程 | m02999 | 两模式节的可选变体；`references/ego-integration.md` |
| ✅ | ego 的 `nodejs -e` 不传 argv / 环境变量 → 命令必须走固定 JSON 文件 | 实测 | C 方案三硬约束 |
| ✅ | ego 需要人时会把控制权交还，**agent 不得自行夺回**（要等用户明确要求再 `takeOverTaskSpace`） | 实测 | `SKILL.md` C 方案硬约束 / `references/ego-integration.md` |
| ✅ | ego 默认任务空间建在 `Profile 1`（从 Chrome 导入、v20 解不开，永远是登录失效）→ 必须显式 `profileId:"Profile"`（「您的 ego」） | 实测 | `SKILL.md` C 方案硬约束 / `references/ego-integration.md` |
| ✅ | ego 里登录一次即长期有效；别指望它跟 Chrome 共享登录态 | 实测 | `SKILL.md` C 方案硬约束 / `references/ego-integration.md` |

## F. 交付与文档

| 状态 | 要求 | 出处 | 落在哪 |
|---|---|---|---|
| ✅ | README 一句话上手，且**必须让用户说出筛选要求**（不说就只用默认口径 → 常 0 PASS） | m02273 / m02328 | 根 README「最短用法」 |
| ✅ | 仓库公开 + 简介 + 免责声明 + topics | m01280 / m02197 | GitHub `YI163/boss-recruiting-scan` |
| ✅ | 24 条外部审计缺口全修（2 Blocker + 13 Major + 9 Minor） | m01473 | 补丁 3；`references/troubleshooting.md` |
| ✅ | 白屏/卡住/点空的成因与修法写进 skill | m01194 | troubleshooting 全篇 |
| 📄 | 本文档：需求台账（对话里说过的要求逐条对照） | m03281 | 本文件 |

---

## 本次要改的口径（已于补丁 9 全量落地）

1. **默认是纯脚本**（规则判完直接收藏、不二次审）；**先审后点**要显式 `--soft-review`（审核在收藏之前，被拒者不收藏、不需要回滚）；**批量模式**（先收藏后闸门 + 自动回滚）要显式 `BATCH_REVIEW=1`，且与 `--soft-review` 互斥。
2. **岗位重选**：每次 `Page.navigate` / 刷新后，先确认岗位标签，不是目标岗位就重选；没选到就停，不要拿错岗位的卡片乱点。
3. **岗位未开放**：详情页没有收藏控件时按「不可收藏」处理并记录原因，不重试、不乱点；「打开职位」按钮一律不点。
4. **ego 三条**：控制权交还后不自行夺回、`profileId:"Profile"`、登录态不跨浏览器同步。

## 2026-11-08 追加：流程统一（✅ 已落地）

- 流程只有一份实现：`scripts/core/flow.mjs` 的 `runFlow({t, io, cfg})`；A（`scan-favorite.mjs`）与 C（`ego/ego-driver.mjs` 的 `round`）都只是 transport + io。
- A 的主循环（原 170 行）已整段删除，改为 transport/io；tab（推荐/最新）映射成引擎的 source，`SCAN_PER_JOB`（默认 100）控制"每岗位看满多少张"。
- 批量闸门挂在 `onFav`（**仅 `BATCH_REVIEW=1`**）：每收藏一人写入 `pendingRecords`，累计到 `REVIEW_EVERY` 立即结批并 exit 42；纯脚本与先审后点不入队。
- 回归：`--pacing-selftest` → PACING_OK；`--judge-run` 15 张 → JUDGE_OK；`--accept-only` fixture → accepted exit 0；真实 CDP 连接 + 安全闸门（未登录 → SECURITY STOP exit 2）通过。
- 仍待验证：登录态下 A 的完整循环跑一轮（需要 9333 实例里重新登录）。
## 2026-11-08 追加：补丁 9.2（✅ 复核遗留全清）

| 状态 | 项 | 落在哪 |
|---|---|---|
| ✅ | 默认口径写对（纯脚本，先审后点要显式开关） | SKILL/README/README-windows/HANDOVER/troubleshooting |
| ✅ | 预览时 `REVIEW_EVERY` 必须配 `BATCH_REVIEW=1` | SKILL 已知坑、README-windows PowerShell 块 |
| ✅ | 退出码表与代码一致（1/2/42/44） | `README.md` §4 |
| ✅ | `pendingRecords` 只在批量模式累计（防跨模式串联） | `scan-favorite.mjs` `onFav` |
| ✅ | 精选匹配精确化 + selftest 覆盖精选/掩码两场景 | `core/flow.mjs`、`core/selftest-flow.mjs` |
| ✅ | requirements 台账过时 ❌ 与旧表名 | 本文件 |
| ✅ | 第四轮 Minor（N9–N14）：表头/交叉引用/标题限定、selftest 断言可失败、旧状态迁移 | troubleshooting、README、criteria、selftest、`scan-favorite.mjs` `schemaVersion` |

## 2026-11-08 追加：补丁 8（✅ 已落地，文档 + A 路线代码）

| 要求 | 状态 | 证据 |
|---|---|---|
| 岗位轮转写进文档（来源=岗位下拉，不是 tab） | ✅ | SKILL.md 第 45 行段、README.md「岗位轮转与 SCAN_PER_JOB」、README-windows.md 补丁 8 节 |
| SCAN_PER_JOB 语义（看≠收藏，默认 100，连续 3 次无新卡换岗） | ✅ | 同上；代码 const SCAN_PER_JOB = Math.max(5, num(process.env.SCAN_PER_JOB, 100)) |
| --soft-review 先审后点写进文档 | ✅ | README.md「审核的三种状态」表 + soft_pack.json/soft_ok.json 示例；README-windows.md；troubleshooting.md 第十一节 |
| 消除「收藏前自动检查 vs 每 5 人自动审核」歧义 | ✅ | README.md/README-windows.md/troubleshooting.md 三处对照表，均写明两模式互斥、review_batch_N.json 只在批量模式产生 |
| A 路线岗位读取/切换（listJobsA()/pickJobA()） | ✅ | scan-favorite.mjs transport；dry-run 实测两岗位各 15 张 |
| A 路线登录闸门误判（/web/chat/index 被当成未登录） | ✅ | scripts/core/flow.mjs 改为只在 loggedIn===false 时 NOT_LOGGED_IN，否则 PROBE_NOT_READY |
| A 路线滚动加载（原来滚窗口无效） | ✅ | transport.scroll() 改为按 overflowY:auto/scroll 容器滚动，日志带 before/after/sh/ch |
| 真收藏闭环（岗位在招） | ❌ 未验证 | 当前两个岗位都是「待」→ NO_FAV_CONTROL；需先发布岗位 |
