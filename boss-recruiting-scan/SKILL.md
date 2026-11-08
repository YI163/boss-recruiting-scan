---
name: boss-recruiting-scan
description: 在 BOSS 直聘招聘端「推荐牛人」页按约定口径批量筛选候选人并点「收藏」，含 CDP 调试端口驱动、防封节奏与配额、可选「先审后点」（`--soft-review`：每张先交 agent 审、通过才收藏；默认纯脚本全自动）、每 N 人停轮送审的批量模式、被拒自动取消收藏、误点回滚与台账产出；判定口径可替换（JUDGE_PY / judge_template.py），换岗位或换条件无需改流程。当用户要求在 BOSS直聘 上批量筛人 / 点收藏 / 出候选人名单时加载。
---

# BOSS直聘 推荐流筛人（含收藏）

在 BOSS 直聘**招聘端**替雇主批量看人：按明确口径筛出候选人（只做「收藏」，零外联）。**默认纯脚本**：按规则判完就直接收藏、不做二次审核（用户没提软条件就是这样）；只有显式 `--soft-review` 才改成「先审后点」——每张卡在点收藏之前停下来交审，通过才收藏、不通过关详情看下一张。最后交台账。**流程与节奏固定，不可放宽**——它们是账号安全的边界。

## 何时用 / 不用

- 用：用户说「在推荐牛人里筛人」「点收藏」「按 XX 条件找人」「刷 N 个人」。
- 不用：批量发消息 / 自动打招呼 / 海投。本 skill 没有任何外联点击路径。

## 前置条件

**0. 拿到这套文件（三选一；`git clone` 后**不需要** npm/pip 安装任何依赖）**

```bash
git clone https://github.com/YI163/boss-recruiting-scan.git                                  # 官方
git clone https://gh-proxy.com/https://github.com/YI163/boss-recruiting-scan.git             # 国内镜像（git 可用，已实测）
curl -L -o skill.zip https://codeload.github.com/YI163/boss-recruiting-scan/zip/refs/heads/main   # 只取文件，不能 push
```

`gh-proxy.com` 不通时再试 `ghproxy.net`（时好时坏）、`ghfast.top`（只能取文件）或 zip 直下；要长期只读镜像可在 Gitee「从 GitHub 导入」。**目录位置决定能不能被自动发现**：放进 `~/.dsh/skills/` 才会被 skill 系统加载；clone 到任意目录也能直接 `node scripts/...` 跑。

1. Chrome **用调试端口另起实例**（不碰日常窗口）。macOS 细节见 `README.md`「1. 起一个带调试端口的 Chrome」：
   `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=$HOME/.boss-prof --remote-debugging-port=9333 https://www.zhipin.com/web/chat/index`
   Windows：
   `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:USERPROFILE\.boss-prof" --remote-debugging-port=9333 https://www.zhipin.com/web/chat/index`
   **受管终端（DSH、CI、Job Object 托管）必须「脱离启动」**，否则命令一结束 Chrome 就被连带杀掉、9333 随即消失：
   `powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\.dsh\tools\start-detached.ps1 -Path "C:\Program Files\Google\Chrome\Application\chrome.exe" -Arguments "--user-data-dir=C:\Users\<you>\.boss-prof --remote-debugging-port=9333 --no-first-run --new-window https://www.zhipin.com/web/chat/index"`
   没有该脚本时用 `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 等价启动。
   **Chrome 136+ 不允许默认 profile 开调试端口**（显式传默认 `--user-data-dir`、junction、subst 均无效），Windows 上也无法靠复制 cookie 搬登录态（v20 App-Bound Encryption 会把解不开的 cookie 删掉）——**只能在这个独立 profile 里登录一次**。
2. **登录必须选「我要招聘」**再扫码/输验证码；落到求职端首页是扫不出招聘端的。登录后侧栏应出现 职位管理 / 推荐牛人 / 沟通。
3. 首屏为推荐牛人页，职位与城市已选定、账号正确。
4. Node ≥ 22（可能不在 PATH，见 README）；Python 3；`make_ledger.py` 要 xlsx 需 openpyxl（系统 python3 没有时用 README 给的解释器路径，缺则只产 md）。
   **Windows**：`python3`/`python` 常是 Microsoft Store 空壳（能执行但 `exit 9009`、无任何输出），必须显式 `PYTHON_BIN`（`py` 启动器或真实 `python.exe`）；未设置时脚本会自动探测 `python3`→`python`→`py`。
5. **自检顺序**：先 `python3 scripts/judge.py --selftest`（12/12，不需要浏览器）→ 再起 Chrome → 再 `node scripts/cdp.mjs state`。`state` 的 `login` 由顶层 DOM、URL `/web/user/`、cookie `wt2=` 三处共同判定；`login:false` 时先看同一条输出里的 `loginDetail`，再决定要不要重新扫码（旧版按推荐帧里的「退出登录」文本判定，登录成功也会报 false，已修）。
6. **PowerShell 5.1 编码**：先 `chcp 65001`，并设 `$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8`；读写 UTF-8 JSON 用 `[IO.File]::ReadAllText/$p`（`Set-Content -Encoding utf8` 会带 BOM → 脚本 `JSON.parse` 失败、`daily_state` 被静默重置）。
7. 与用户确认：**口径卡**、**目标收藏数**、**是否允许收藏**。

## 两种运行方式（同一个流程，两个入口）

**流程只有一份代码**：`scripts/core/flow.mjs` 的 `runFlow({t, io, cfg})`。两个入口只负责"怎么读页面、怎么点"（transport）和"判定器/软审/账本怎么落"（io），流程本身（岗位轮转 → 每岗位看满 N 张 → 规则筛 → 先审后点 → 收藏校验 → 节奏/配额 → 汇总）全部由这一份实现，两边不允许再各写一份。

**共同流程**：`采集 → 硬条件（脚本判）→ 【可选：软条件（agent 判）】→ 点收藏 → 校验「已收藏」→ 关详情 → 台账`。

- **每岗位看满 N 张再换**：`SCAN_PER_JOB`（默认 100，env 可调）。注意是"看"不是"收藏"，也不是轮次。**两条路线的"岗位"都是推荐页岗位下拉里的岗位**（`.job-selecter-wrap .ui-dropmenu-label` / `.job-selecter-options .job-item`）；Chrome 线读不到岗位时才退回 tab（推荐/最新）。读到 `SCAN_PER_JOB` 张或连续 3 次没有新卡就换下一个岗位。**每次导航/刷新后岗位会跳回第一个**，必须重选并核对标签。
- **批量闸门挂在收藏回调上**：每收藏成功一人，就把 `pendingRecords` 追加进来；累计到 `REVIEW_EVERY`（默认 5）立刻写 `review_batch_N.json` 并 exit 42，等 `--accept-only` 接受。**这条只在批量模式（先收藏后审核，显式 `BATCH_REVIEW=1`）成立**；默认纯脚本与先审后点模式都不会产生 `review_batch_N.json`，被拒的人也没被收藏、不需要回滚。

- **软条件那一步是可选的开关**：
  - 用户**没提**软条件 → 不加 `--soft-review`，纯脚本跑完（判定器过了就收藏），**不需要 agent 二次检查**，也不会整批停轮（除非显式 `BATCH_REVIEW=1`）；
  - 用户**提了**软条件（“别要外包的”“看看经历是不是真的”“只挑能扛事的”）→ 加 `--soft-review`：每张卡在点收藏前停下来写 `soft_pack.json`（卡片全文 + 详情浮层文本），等 agent 写 `soft_ok.json`（`{"card_id":"…","approved":true/false,"reason":"…"}`）；`approved=false` 只关详情页、不收藏。**超时不等于同意**：`SOFT_TIMEOUT_MIN`（默认 15 分钟）内没结论就 exit 44，绝不擅自收藏。
- 硬条件永远由脚本判（`judge.py` / `JUDGE_PY`），两条路线用的是**同一套规则和同一份账本**。

| | **A. 独立调试实例 + 原生 CDP**（全自动批量） | **C. ego-cli 逐张**（在场，agent 审） |
|---|---|---|
| 用什么浏览器 | 另起一个 Chrome（`--user-data-dir` + `--remote-debugging-port=9333`）；这个 profile 是空的，**首次必须登一次** | 用户自己的 ego (lite) 窗口；**通常已经有登录态，不用再登**；不开调试端口 |
| 谁在操作 | `node scripts/scan-favorite.mjs [--soft-review] <收藏数>`（第 3 个参数是收藏目标；旧的"轮次上限"已废弃） | `node scripts/ego/ego-driver.mjs` 的 `round`（一次调用跑完整个循环，参数写 `%TEMP%\boss-ego-cmd.json`）或 `cards`/`open`/`fav`/`close` 单步命令 |
| 能力 | 采集 → 判定 → 收藏 → 闸门 → 台账 → 回滚，全自动 | 采集 → 判定 → **我逐张审** → 收藏/关掉 → 台账 |
| 能否无人值守 | **能**，挂机跑完（受防封节流：收藏间隔 12.5 s、轮间隔 18 s 起） | **能**：`round` 把整轮循环装进一次 `ego-browser nodejs` 调用；加软条件时两条路都一样，每张要等模型判断 |
| 失败处理 | 脚本内建重试/回滚/`rollback_queue.json` | agent 现场看结果再决定，最灵活 |
| 主要代价 | 要开调试端口；页面一改要改选择器；要单独摆一个浏览器并登录 | 不能挂机；每张卡多几次进程往返（实测单次 168–291 ms，可忽略）；长批次累计 token |
| 适合 | 一次筛几十上百人、跑完看台账 | 少量精筛、想每张都过一遍眼、不想开端口 |

**「登录一次」不是每次都要登**：登录态存在浏览器自己的 profile 目录里（cookie 持久化），做一次就一直有效。只有三种情况要重登：cookie 过期、同一账号在别处登录把你顶掉、或者换了 profile 目录。A 之所以必须登一次，是因为 Chrome 136+ 不允许在默认 profile 上开调试端口、Windows 又搬不了 cookie（v20 App-Bound Encryption），只能用一个全新的独立 profile 从零登一次；C 用的是你自己的 ego profile，本来就有登录态，只有 ego 自己弹「登录信息失效」时才需要补登。

**速度其实一样**：A 的"慢"来自它自己的防封节流（每收藏 12.5 s、每轮 18 s 起），不是技术慢；C 单次命令往返实测 168–291 ms，逐张的总墙钟时间与 A 同量级——真正的差别是「能不能挂机」和「开不开端口」。

> 另有一种**只读**变体（Chrome 扩展桥）：只有 15 个工具级动作（snapshot/get_text/click/scroll…），点击仅支持 snapshot 序号或 CSS selector，**没有视口坐标、没有任意 JS 求值**；而卡片与「收藏」既不是 `<button>` 也不是 `<a[href]>`，snapshot 里只编号出「打招呼」→ 去点收藏就会点到打招呼。所以它只能「筛人、出名单」，不能收藏。证据见 `references/troubleshooting.md` 第五、六节。



### C 方案怎么用（ego-cli 逐张）

`ego-browser` 自带语义快照、**跨 iframe 的选择器点击**（`>> nth=` 可用）和 `page.cdp()` 兜底，不需要 9333 调试端口，也不用自己算 iframe 偏移与视口坐标——「点歪 / 帧偏移 / 坐标兜底」整类问题从根上消失。前提是**在 ego 的窗口里登录一次**。

驱动器 `scripts/ego/ego-driver.mjs`（跑法和命令见下表 + 下文「命令必须走文件」）：

> **可选变体**：ego 本身就是 Chromium，给它 `--remote-debugging-port=9444` 就能拿到标准 CDP（实测 `Chrome/156.0.8078.74`、`Protocol-Version: 1.3`），设 `CDP_URL=http://127.0.0.1:9444` 后等于「把 A 方案跑在你的 ego 上」，`scan-favorite.mjs` 一行不改。默认菜单仍只保留 A / C 两种，这个变体只在你想复用 ego 登录态又想挂机时用；细节见 `references/ego-integration.md`。

| 命令 | 作用 |
|---|---|
| `state` | 打印当前岗位标签、卡片数、登录态 |
| `cards [--job=关键词]` | 选岗位 → 等卡片稳定 → 写 `cards.json`（含全文，供判定器） |
| `open <i>` | 打开第 i 张卡详情，写 `last-open.json` + 截图 `card-<i>.png` |
| `fav <i>` | 点「收藏」并**校验文案变「已收藏」**；没有收藏控件（岗位仍是「待」）时报 `NO_FAV_CONTROL` 并退出码 3，绝不乱点 |
| `close` | 关详情浮层（处理 `v-leave` 卡死） |
| `decide '<json>'` | 追加一条审核决策到 `decisions.jsonl` |

三个硬约束（都是实测踩出来的）：

1. **命令必须走文件**：ego 的 `nodejs -e` 既不传 `process.argv`（只有 `ego.exe` 一项），也不传自定义环境变量（`EGO_WORK` 读出来是 `undefined`）。所以命令写成固定路径的 JSON：Windows `<TEMP>\boss-ego-cmd.json`，macOS/Linux `/tmp/boss-ego-cmd.json`；驱动器读完即删，同一个文件不会被执行两次。
2. **脚本必须是 `.mjs` 文件**再用 `await import('file:///...')` 引入：PowerShell 5.1 会把 `-e` 里的双引号吃掉，非 ASCII 内容（中文岗位名）也只能放在文件里。
3. **姿态**：驱动器本身是纯 Node（`os.tmpdir()` 取临时目录、`path.join` 拼路径），macOS / Linux 不需要改一行代码。
4. **profileId 必须显式指定**：`taskSpace(name)` 不传 `profileId` 会落在 `Profile 1`（从 Chrome 导入那份，v20 解不开、永远登录失效）；要用「您的 ego」必须写 `{ profileId: "Profile" }`。
5. **控制权不能被抢**：ego 在需要人时主动交还控制权，此时所有浏览器命令都会被拒；必须停下等人回来，**不得自行夺回**（用户明确要求后才 `takeOverTaskSpace`）。

#### 一次调用跑完整轮（`round`，多岗位轮转）

命令写在 `<TEMP>\boss-ego-cmd.json`（macOS / Linux 为 `/tmp/boss-ego-cmd.json`），然后一条命令跑完，不用逐条发：

```json
{"cmd":"round","spaceId":2,"work":"C:\\boss-work\\live","target":2,"scanPerJob":100,"maxJobs":20,"softReview":true,"dryRun":false}
```

| 参数 | 默认 | 含义 |
|---|---|---|
| `target` | 2 | 本次要**收藏**几人（到数就停） |
| `scanPerJob` | **100** | 每个岗位**看**多少张卡（去重后计数）就换下一个岗位——**看 ≠ 收藏** |
| `maxJobs` | 20 | 最多轮几个岗位（默认 20，不是「两个岗位」——有几个就轮几个） |
| `job` | 空 | 只跑名字含该关键词的岗位；空 = 所有岗位轮转 |
| `softReview` | false | 开 = 每张通过规则筛的卡先写 `soft_pack.json` 等 agent 批；关 = 纯脚本 |
| `softTimeoutMin` | 15 | 等审批超时（超时按未通过处理，exit 44） |
| `dryRun` | false | true = 只判不收藏 |
| `spacing` / `favGap` / `jitter` / `favCap` / `maxMinutes` | 18000 / 12500 / 0.25 / 60 / 180 | 与 A 同名的防封参数，硬下限不会被放宽 |

行为：读岗位下拉 → 逐岗位跑满 `scanPerJob` 张（卡不够就滚动加载；连续 3 次没有新卡视为到底，换下一个岗位）→ 每个岗位内先等卡片稳定、跑 `judge.py` 规则筛、逐张开详情**先看有没有收藏控件**（岗位「待」时没有 → 记 `NO_FAV_CONTROL` 跳过，绝不点「打开职位」）→ 有控件才按软审 + 收藏 + 文案校验 → 收藏达 `target` 或触顶即停。

产物：`soft_pack.json`（等你批）、`decisions.jsonl`、`passes.jsonl`、`known_fav.json`、`real_names.json`、`daily_state.json`、`round-summary.json`（含每个岗位看了多少、收藏几个）。退出码：0 正常 / 2 致命 / 3 无收藏控件 / 4 收藏未确认 / 5 触顶 / 44 软审超时。

```powershell
# Windows
$cmd = '{"cmd":"cards","spaceId":2,"job":"测试工程师","work":"C:\\work\\ego"}'
[IO.File]::WriteAllText((Join-Path $env:TEMP "boss-ego-cmd.json"), $cmd, (New-Object System.Text.UTF8Encoding($false)))
cmd /c "\"C:\Program Files\Citro Labs\ego lite\Application\<ver>\ego-browser.exe\" nodejs -e \"await import('file:///C:/Users/<you>/.dsh/skills/boss-recruiting-scan/scripts/ego/ego-driver.mjs')\""
```

```bash
# macOS / Linux（ego lite 装好后 ego-browser 在 PATH 上，通常 ~/.local/bin）
printf '%s' '{"cmd":"cards","spaceId":2,"job":"测试工程师"}' > /tmp/boss-ego-cmd.json
ego-browser nodejs -e "await import('file:///Users/<you>/.dsh/skills/boss-recruiting-scan/scripts/ego/ego-driver.mjs')"
```

> ego lite 有 macOS 版（DMG，arm64/x64，装到 `/Applications`，首次引导把 `ego-browser` 放到 `~/.local/bin`）。命令文件路径按平台自动切换，无需改脚本。

### 事前审核模式（推荐）：规则筛硬条件，agent 审软条件

| 阶段 | 谁做 | 成本 | 判什么 |
|---|---|---|---|
| 硬条件 | `judge.py` / 自定义判定器 | 0 token、毫秒级 | 方向词、证据条数、学历、年限、城市、排除项（外包/培训/纯手工） |
| 软条件 | **agent 逐条读**（`references/soft-review-checklist.md`） | ≈200–400 token/张、2–5 秒 | 证据强度、经历连续性、公司类型、城市通勤、薪资匹配、红旗、亮点 |

链路：`cards` → 判定器 → **只把 PASS 的卡交给 agent** → `open <i>` 看详情 + 截图 → agent 判 `approve/reject` 并写一行理由 → `decide '{...}'` → 通过就 `fav <i>`（校验「已收藏」）、不通过就 `close` 换下一张。

好处：被拒的人**根本不会被收藏**，`AUTO_ROLLBACK_REJECTED` 那套账本回退只用来兜「人工点错」。抽查：每轮从规则判 NEAR/FAIL 的卡里抽 2 张复核，防规则误杀。

节奏与配额沿用 `## 铁律` 第 2、3 条（`HARD` 下限 + 默认间隔/配额），不另设阈值。


## 铁律（防封，任何情况下不改）

1. **零外联**：绝不发消息、不点「打招呼 / 联系Ta / 搜索畅聊卡」；只点「收藏」和关闭浮层。
2. **节奏**：轮间隔 ≥15s（默认 18s）、收藏间隔 ≥12s（默认 12.5s）；env/config 只能更严——脚本用 `Math.max`/`Math.min` 夹住，传 0/负数不会生效。每轮默认只读 2 个 tab（推荐 / 最新）。实际间隔在 [base×(1−JITTER), base×(1+JITTER)] 内随机（JITTER_PCT，默认 0.25），**任何情况下不低于上述下限**——抖动只是去掉「精确到毫秒的机械周期」，不是绕过风控。
3. **配额**：单日收藏 ≤60、轮次 ≤200、当日累计运行 ≤3h（`daily_state.json` 持久化，`startedAt` 为当日首次启动；启动与**每轮循环内**都复查，超限即退；跨日重置）。日切按 `Asia/Shanghai` 本地日（`Intl.DateTimeFormat en-CA`）。
4. **风险即停**：登录页 / 安全验证 / 操作频繁 / 收藏失败率 >50% → 截图、写 `STOP_TODAY`、非零退出；当天不再跑。
5. **隐私**：不导出手机号/微信/邮箱；**身份用推荐流卡片上的真实姓名**（`.name`，落在本机 `real_names.json`），判定器的掩码名只作兜底；卡片原文只在判定时用临时文件，判完即删。
6. **不碰付费动作**：用户说「搜索里的人要付费」时，全程只在推荐页操作。
7. **审核（默认纯脚本；两种可选审核互斥）**：不开任何开关 = 判定器过了就收藏，不逐张审、也不整批停；**先审后点** = 加 `--soft-review`，**每张卡都在点收藏之前**停下来等结论——通过才收藏、不通过关详情看下一张（详见 Step 7a），**被拒的人根本没被收藏，不需要回滚**。**批量模式** = 显式 `BATCH_REVIEW=1`（配 `REVIEW_EVERY`，默认 5），先收藏、每累计 N 个停轮送审，被拒者需回滚；只有这种模式才有下面的闸门：**每累计 `REVIEW_EVERY` 个收藏**（默认 5，可设 1–5；设 1 = 收一个就停轮送审；env `REVIEW_EVERY` 或 config `batch.reviewEvery`，超过 5 只 WARN 并按 5）（`state.sinceBatch`/`pendingRecords` 持久化，跨运行累计；启动时若已有满 5 条未结批会自动补结）自动停轮，产出 `review_batch_N.json` 并 `exit 42`；审核方写 `review_ok_N.json`，必须用 `approved_card_ids` + `rejected_card_ids` **覆盖全部候选**（不能用旧审批、不能只批一部分），被拒者用 `--rollback` 取消收藏后才算闭环（默认 `AUTO_ROLLBACK_REJECTED=1`：接受审批时对被拒者**自动**点「取消收藏」并回退账本；浏览器不在线时写 `rollback_queue.json`，下次启动先重试）（被拒 id 会写入 `rejected.json`，此后永久跳过、不会再收藏）（脚本会自动清理 `known_fav` 里的姓名键与对应 `card_id`；若手工在页面取消收藏，需同样清理，或直接 `--rollback` 走闭环）。未完成上一批审核不得开始下一批；不足 5 人时可 `--batch` 手动结批。（批量模式目前**只在 Chrome 线（`scan-favorite.mjs`）实现**；ego 线用 `--soft-review` 或纯脚本。）
8. **不在「精选」页收藏**：「精选」是另一套富集卡片，开聊要「搜索畅聊卡」（付费资源），卡片结构与推荐流不同，在那页点收藏等于把节奏和预算放到错的地方。脚本已做硬闸：`config.batch.tabs` 里写「精选」会被忽略（`WARN`），选来源时命中「精选」直接打 `SKIP_SOURCE 精选页` 跳过该来源（按 tab 采集时 `.tab-item.curr` 就是来源标签；两条路线现在都用岗位下拉，天然不含精选）。
9. **掩码姓名不收藏**：推荐流卡片上是**真实姓名**（`.name`，如「吴嫔」），判定器输出的是掩码（「吴**」）。身份以「真实姓名 + card_id」为准；卡片姓名若仍带 `*`（精选页就是这种「加密带星号」的名字）→ 直接 `SKIP 掩码姓名，不收藏`，因为收藏一个连姓名都核对不了的人，后面审核和回滚都没法对账。
10. **风险自担（开工前必须先跟用户说清）**：自动化操作真实账号**有被限流甚至封号的风险**——平台协议普遍限制自动化 / 批量 / 脚本化操作。必须由用户明确确认四件事：① 用的是**有权处置、丢了不心疼**的账号（不要主账号、不要公司主账号）；② 接受可能触发安全验证、推荐与沟通功能受限、临时封禁乃至永久封号；③ 明白本 skill **不带也不允许**任何风控绕过手段（代理池、指纹伪装、验证码识别、账号池、并发多开、模拟真人轨迹），节奏与配额下限**不允许为了跑快而放宽**；④ 候选人简历属个人信息，法律与内部合规由用户自行负责（不外传、不商用、不作非招聘用途）；⑤ 明白本 skill **不做「随机点击 / 轨迹伪装」**（随机坐标会点到「打招呼 / 联系Ta / 搜索畅聊卡」，既破坏零外联又可能产生真实费用，见 `references/troubleshooting.md` 第九节）。用户不接受任一条 → **不跑**，也不要帮忙绕过。

## 流程（按顺序，不跳步）

**Step 0 口径卡**：三段条件（见 `references/criteria.md`），每段写清「算/不算」。口径实现于 `scripts/judge.py`；换口径改判定器，不改流程。

> ⚠️ **默认判定器不是通用口径**：`judge.py` 内置「长沙优先 / 英语 A 级 / 教学或大厂职能经历月数」三条，**依赖卡片里的起止日期**。BOSS 推荐卡的正文多数没有起止日期，所以默认口径在真实卡上常常 **0 PASS**（实测 14 张真实卡 0 PASS，同一批换成自写口径后 8 PASS）。第一次用请把它当**骨架**，按 `scripts/judge_template.py` 改写口径再跑；`WARN 判定器本轮 0 条 PASS` 是口径不适配的信号，不是"这批人都不合适"。

**Step 1 环境**：`node scripts/cdp.mjs state` 确认存在 `/web/frame/recommend/` 帧、且 `login:true`；需要换页时用 `node scripts/cdp.mjs navigate <url>`（v1.8.2+ 新增，例如 `navigate "https://www.zhipin.com/web/chat/recommend"`）。窗口不能最小化（最小化时 CDP 点击无效、截图超时）。**每次导航/刷新后岗位选择会跳回第一个岗位**：拿卡片前先读岗位标签（推荐帧 `.ui-dropmenu.job-selecter-wrap` → `.ui-dropmenu-label`），不是目标岗位就点开下拉、按 `.job-selecter-options .job-item >> nth=<下标>` 重选；选不到目标岗位就停，**不要拿错岗位的卡片继续点收藏**。首次 `shot` 可能拍到全白（页面还没渲染完）→ 等 8 秒重拍，不要据此判断页面坏了。

**Step 2 筛选（可选）**：手动在页面点「筛选」→ 勾选目标条件（如院校「留学」）→「确定」，命中率可提高数倍。`Page.navigate` 会复位筛选；脚本默认 `APPLY_FILTER=1`，每轮回点「筛选 → 应用 → 确定」重放上次筛选，但**不会自动勾选条件**——首次需人工勾好；若页面没有「应用上次筛选」提示，则筛选不会被重放。

**Step 3 采集 + 判定**：脚本每轮导航 → **就绪轮询**（最多 25×1.2s：循环取推荐帧与 iframe 偏移，并读 `.candidate-card-wrap` 数量，要求连续两次相同才继续；不要用固定 `sleep(9000)`——这个页面导航后常要 20s 级才稳定）→ 依次点「推荐 / 最新」→ 读卡片文本 → 写临时文件（600，判完即删，**不持久化完整卡片**）→ `judge.py` 判定 → 拿 PASS 列表（含 `card_id`）；**运行时不做 tab 检测**（来源是岗位下拉，天然不含精选；真按 tab 采集时在选来源阶段就会 `SKIP_SOURCE`）→ **收藏成功**的 PASS 才追加到 `passes.jsonl`（审核包由 `state.pendingRecords` 生成）。judge 失败或缺输出文件时脚本 `exit 2`（不吞错）。

**Step 4 开浮层**：命中的卡优先用**元素点击**（`.row.name-wrap` 的 JS `click()`，返回 `el-click`），失败才回退到卡片坐标 `Input.dispatchMouseEvent`。成功标志：推荐帧内出现**非 `v-leave`** 的 `.boss-popup__wrapper` 且可见（浮层内容其实渲染在推荐帧里，`c-resume` 画布帧不可点）。开卡前若已有残留浮层，先 `closeOverlay()`；仍关不掉就跳过此人（日志 `stale overlay, skip <card_id>`）。点击前做 allowlist：目标文本含「打招呼 / 联系Ta / 聊卡」立即放弃。

**Step 5 收藏 + 校验**：点该 wrapper 内 `DIV.like-icon-and-text`（轮询最多 20×500ms，等工具条挂载）→ 读同一控件的文案变化：`收藏`→`已收藏` 即成功，反过来即被取消（此前已收藏过 → 再点一次恢复）。toast（`收藏成功`/`取消收藏成功`）只作补充证据，不作为唯一判据——历史 bug 里 toast 有假阴性也有假阳性。收藏成功时把推荐流卡片上的**真实姓名**写进 `real_names.json`（`card_id → 姓名`），审核包 `review_batch_N.json` 的候选带 `name_real`，台账「姓名」列优先用它；卡片姓名为空或带 `*` 的候选在开卡前就被跳过。

**Step 6 收尾**：点该 wrapper 的 `.close-btn` → 轮询 8×300ms；关不掉的把仍处于 `v-leave` 的节点直接 `remove()`（日志 `overlay cleanup: removed N stuck node(s)`）→ 仍失败再在推荐帧 document 内派发 Escape → 最后才按真实 rect 兜底点击；然后 `sleep` 到收藏间隔（默认 12.5s）再下一位。

**Step 7a 事前审核（默认，配合 `--soft-review`）**：硬条件判过的卡，在**点收藏之前**停下来：写 `soft_pack.json`（`card_id`/`name`/`age`/`card_text`/`dialog_text`/`ask`）→ 等 agent 写 `soft_ok.json`（`{"card_id":"…","approved":true|false,"reason":"…"}`，可 `all:true`）→ **通过才点收藏**，不通过只关详情页、看下一张。超时（`SOFT_TIMEOUT_MIN`，默认 15 分钟）按未通过处理并 `exit 44`，**绝不擅自收藏**。日志关键字：`SOFT_REVIEW_REQUIRED` / `SOFT_APPROVE` / `SOFT_REJECT` / `SOFT_TIMEOUT`。
   这条路下**没有「先收藏再被你拒」的人**，所以不需要回滚，也不需要 `review_batch_N.json`——审核发生在收藏之前。

**Step 7b 批量模式：先收藏后闸门（可选，`REVIEW_EVERY`）**：每累计
 `REVIEW_EVERY` 个收藏（默认 5，可设 1），脚本写 `review_batch_N.json`（只含证据字段：card_id/掩码姓名/年龄/城市/期望/c1 月数与 segments/c2 等级与 evidence/c3 月数与 segments，**不含完整卡片**）+ `digest`，并 `exit 42`。审核方逐人核 c1/c2/c3，写 `review_ok_N.json`：`{"batch":N,"digest":"<与 batch 一致>","approved_card_ids":[...],"rejected_card_ids":[...]}`。脚本启动校验：batch 序号、digest、**ap∪rj 覆盖全部候选且不重叠**；被拒者须已取消收藏——`AUTO_ROLLBACK_REJECTED=1`（默认）时**接受审批即自动取消**，连不上浏览器则记 `rollback_queue.json` 并 `exit 42`，下次运行先重试；设 0 才要求手工 `--rollback`。**接受审批不必再跑采集**：`node scan-favorite.mjs --accept-only`（无浏览器、不产生新收藏）。`batchSeq`/`sinceBatch`/`pendingRecords` 持久化，旧审批不能复用。手动结批：`node scan-favorite.mjs --batch`。

> **接受审核是一个独立动作**：`node scripts/scan-favorite.mjs --accept-only` 只校验并消费 `review_ok_N.json`，**不需要浏览器、也不会再收藏人**。不带它时，下一次正式启动会先自动接受，但**接受发生在配额/停线检查之前**（所以「今天收藏到顶了但最后一批还没结」不会再卡死）；`FAV_DRY_RUN=1` 时不消费审批（联调不动账本）。

**Step 8 回滚**：审核不通过 / 误收藏 → `node scripts/scan-favorite.mjs --rollback "真实姓名,..."`。**优先真实姓名**；也接受 `card_id`（先经 `real_names.json` 换成真实姓名，换不到才 `exit 2`）与掩码名 `唐**|27`（best-effort，按首字通配+年龄匹配）；在收藏牛人页按姓名匹配 → **元素点击 `.row.name-wrap` 开浮层**（轮询 12s 等浮层；el-click 没送达才用坐标兜底，兜底等 8s——实测坐标点击会落空，且同一位置重复点没有收益）→ 点收藏（= 取消）→ 校验控件文案回「收藏」；成功后经 `known-cleanup.mjs` 按「姓名|年龄 / 掩码名|年龄 / 同年龄+同首字」清理 `known_fav.json`，**并删除对应 16hex card_id**（`known_fav_map.json` 映射、`review_batch_*.json` 反查）；同时**回退账本**：`state.favorites`/`state.sinceBatch` 各减 1，`state.pendingRecords` 与 `passes.jsonl` 里该人的记录一并删除——否则下次 `--batch` 会把已回滚的人重新送审。收藏牛人页有就绪轮询（25×1.2s），冷启动第一次就等它加载完，否则会误报「全部未命中」。全部未命中时 `exit 2`（不假成功）；`FAV_DRY_RUN=1` 时拒绝回滚。

**Step 9 台账**：`python3 scripts/make_ledger.py --work $BOSS_WORK --out <交付目录> --title 招聘筛人台账-YYYYMMDD` → xlsx + md（通过名单 / 收藏记录 / 审核批次 / 说明）。`--out` 不传时默认写到 `$BOSS_WORK`（不再写当前目录）；出 xlsx 必须用带 openpyxl 的解释器（缺库会提示，只产 md）；台账里时间统一转本地时区并把时区写进表头。

**Step 10 停止**：达标、用户喊停、或任一风险信号 → 立即停、截图、汇报；写 `STOP_TODAY`。

## 定位方式与常量（CSS 像素，随窗口自适应）

**优先按元素点，坐标只作兜底。** 减法魔法坐标是历史 bug 的根源（收藏横偏 44px、关闭钮偏约 99px），见 `references/troubleshooting.md`「三、点空」。

| 元素 | 定位方式 |
|---|---|
| recommend iframe 偏移 | iframe `getBoundingClientRect()` 实时取，每次导航重取 |
| 岗位选择器 | 推荐帧 `.ui-dropmenu.job-selecter-wrap` 里的 `.ui-dropmenu-label`（当前岗位）与 `.job-selecter-options .job-item`（可选项，`curr` 为当前） |
| tab 相对坐标 | 推荐 (+56, +30) / 精选 (+116, +30) / 最新 (+176, +30)；默认点 推荐 + 最新（精选 常空，可在 config `batch.tabs` 改） |
| 开卡 | 推荐帧内 `.row.name-wrap` 的 **JS `click()`**（不需要 isTrusted）；返回 `el-click` 才算成功，否则回退卡片坐标 |
| 收藏控件 | **推荐帧**内 `DIV.like-icon-and-text`（子元素 `.btn-text` 文案「收藏」/「已收藏」）；点它，再用控件文案自证，不靠 toast |
| 浮层是否打开 | 推荐帧内**最后一个**不含 `v-leave` 的 `.boss-popup__wrapper`，且 `getBoundingClientRect()` 宽高 > 0 |
| 浮层关闭 | 该 wrapper 内 `.close-btn` → 删除仍卡在 `v-leave` 的节点 → 推荐帧 document 内派发 Escape → 最后才按「帧内 rect + iframe 偏移」点真实坐标 |
| 收藏牛人页 | `/web/chat/interaction?status=9`（抓取/回滚/核对用） |
| 旧坐标（已废弃） | 收藏 `(clientWidth-360, 95)`、关闭 `(clientWidth-126, 57)`；保留仅为兜底与识别老日志，**不要作为首选** |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CDP_URL` | `http://127.0.0.1:9333` | 调试端口 |
| `BOSS_WORK` | `/tmp/boss`（Windows：`%TEMP%\boss`） | 卡片池、日志、状态、判定输出目录 |
| `PYTHON_BIN` | `python3`（未设置时自动探测 `python3`→`python`→`py`） | 跑 judge.py 的解释器 |
| `JUDGE_PY` | `scripts/judge.py` | 判定器路径 |
| `SKILL_CONFIG` | `<skill>/config.json` | 节奏/配额配置（`pacing.*`、`batch.tabs` 会被消费；配额只能调小） |
| `SPACING` | 18000 | 轮间隔 ms（下限 15000） |
| `FAV_GAP` | 12500 | 收藏间隔 ms（下限 12000） |
| `FAV_DRY_RUN` | 0 | 设 1 只判定不点收藏（联调） |
| `APPLY_FILTER` | 1 | 每轮重放「筛选→应用→确定」；设 0 关闭 |
| `FAV_OUT` | `<BOSS_WORK>/fav_capture.json` | 收藏列表抓取输出 |
| `BATCH_REVIEW` | 0 | **批量模式总开关**：设 1 才启用「先收藏、每 N 人停轮送审」；`--soft-review` 开着时强制关闭 |
| `REVIEW_EVERY` | 5 | **仅批量模式用**：先收藏、每 N 人停轮送审（1–5；设 1 = 收一个就停；>5 只 WARN 并按 5）。纯脚本 / 先审后点模式都不用它 |
| `AUTO_ROLLBACK_REJECTED` | 1 | **仅批量模式用**：接受审批时对被拒者自动取消收藏并回退账本；先审后点模式下被拒者没被收藏，用不到 |
| `JITTER_PCT` | 0.25 | 节奏抖动幅度（0=固定周期，上限 0.5；抖动后仍被硬下限夹紧） |

## 口径不是这三条怎么办（换岗位 / 换条件）

本 skill 只有**判定层**与具体口径绑定；扫描、收藏、闸门、台账、防封配额都与口径无关。换条件时**不改流程**：

1. **只换规则参数（最常见）**：`cp scripts/judge_template.py my_judge.py`，改 `CONFIG`（c1/c2/c3 关键词、排除词、`min_months`、`city.prefer/rank_only`）与 `judge_card()`，然后
   `JUDGE_PY=$PWD/my_judge.py node scripts/scan-favorite.mjs 5`
   （模板开箱可跑：`python3 scripts/judge_template.py --selftest` → 5/5；自带卡片解析、日期月数、掩码、4 个输出，c1/c2/c3 证据齐全。）
2. **完全自定义逻辑**：任何语言都行，只要遵守契约——输入 `argv[1]` JSONL `{"card":"<innerText>"}`；输出 `$BOSS_WORK/strict3v2_ok.json`（必填）及可选 near/all/summary；必填字段 `card_id/name/age/city/want/verdict/c1_months/c1_segments/c2_level/c2_evidence/c3_months/c3_segments`（schema 要求 `name` 为「前缀+`**`」（如 `张**`）、两 segments 为数组、两月数为整数）；空输入/失败必须非 0 退出（判定器崩溃**不要**静默返回空数组）；非 Python 判定器需设 `PYTHON_BIN=node|bash`（默认用 `python3` 执行 `JUDGE_PY`）。scan 会先删旧输出再跑判定器，并对输出做 schema 校验，不满足即 `FATAL exit 2`。
3. **不是筛人任务**：骨架（`cdp.mjs` 连帧/点击/截图、闸门、台账）可复用，但另建 skill，别套本 skill 的防封铁律。

细节、字段表与两个示例（例 1 可运行的 Java 后端 + 大厂 + 985；例 2 两条件/五条件为伪代码示意）见 `references/custom-criteria.md`。契约回归：`node scripts/scan-favorite.mjs --selfcheck-judge`（无需浏览器，6/6）。

## 隐私说明

- 代码内不导出手机号/微信/邮箱；卡片原文只在判定时写临时文件（600，判完即删）。
- `review_batch`/`passes`/`fav15`/`known_fav`/`security_*.jpg`/judge 与 ledger 产物均 600。
- `cdp.mjs dump` 会写**完整卡片**（600，`BOSS_WORK/dump-*.json`）——仅供本机调试，用完删除，不要拷贝/上传。
- `favcapture.mjs` 输出姓名已掩码（首字+**）。

## 已知坑

> 完整排查手册（含实测数字与判断方法）：`references/troubleshooting.md`。

- **窗口最小化**：点击无效、截图 20s 超时 → 脚本每轮自动 `setWindowBounds(normal)` + `bringToFront`；仍失败时 macOS 用 `osascript -e 'tell application "Google Chrome" to activate'`，Windows 无 osascript（该步跳过），用手动还原窗口或 `SetForegroundWindow` 等价操作。
- **筛选复位**：导航后 iframe 变 `jobid=null&filterParams=`，需手动或 `APPLY_FILTER=1` 重放。
- **收藏控件不在 shadow DOM**（旧文档此处写错过）：收藏/关闭都在**推荐 iframe** 里（`.like-icon-and-text`、`.close-btn`），可读可点；`web/frame/c-resume/` 只是 `<canvas>` 容器，点它什么也点不到。
- **浮层卡在离场状态**：点关闭后 Vue 可能停在 `v-leave v-leave-active`（`opacity:1`、`pointerEvents:auto`），盖住整个 iframe，导致后续全 `overlay not opened`。判据只认最后一个非 `v-leave` 的 `.boss-popup__wrapper`；关不掉时删掉卡死节点（`overlay cleanup`）。
- **浮层节点会累积**：每个候选开一次卡就多一个 `boss-popup__wrapper`（实测跑到 22 个 `c-resume` 帧），`querySelector` 只取第一个是错的——必须取最后一个 live wrapper。
- **白屏有三种**：①调试器 attach 触发反爬（`warlockdata`/`patas` SDK 长期 pending，文档反复重建）→ 按风险信号停；②`Page.navigate` 后 SPA 重挂（`readyState:loading`、正文 36~98 字、帧树已有帧但顶层取不到 iframe）→ 就绪轮询，等；③点歪落到侧栏/推广弹层 → 导航回推荐页。判据见 troubleshooting 第一节。
- **假记录**：旧坐标实现曾写出「日志报 fav、收藏列表里没有」的记录；核对以 `/web/chat/interaction?status=9` 为准，发现假记录时同步清理 `known_fav.json`/`known_fav_map.json` 并在台账注明。
- **核对收藏别数总条数**：收藏牛人页**懒加载**（首屏 10 条，滚动才到 18）且**混着账号历史**（实测 18 条里 13 条是以前收的）。用 `node scripts/favcapture.mjs`（自带就绪轮询）：输出 `this_round` / `historical_count` 才是本轮成绩；把「18 条」当战果会虚报。
- **卡片「期望城市」不可信**：同一人推荐卡显示深圳、进收藏页变珠海/济南（实测两例）。城市只用于排序与提示，台账城市列以收藏页为准，别拿它做硬淘汰。
- **默认口径在真实卡上常 0 PASS**：`judge.py` 内置的三条口径依赖起止日期，而推荐卡多数没有日期 → 先按 Step 0 的警告改写口径，别把 `0 PASS` 当结论。
- **重复收藏 toggle**：已收藏的人再点会取消 → `known_fav.json` 同时存 `card_id` 与 `姓名|年龄`（兼容旧数据/掩码姓名），卡片含「已收藏」也跳过；收藏成功即原子写入。
- **姓名/日期解析**：姓名前常有活跃标签；年龄取 `N岁`；日期成对配对；教育条目跳过；PASS 用 `card_id` 对齐而不是姓名。
- **别加「随机点击」当防封**：这个页面随机坐标很容易落在「打招呼 / 联系Ta / 搜索畅聊卡」（付费）上——违反零外联、可能真发消息或花钱；而且无意义的点击轨迹对行为模型来说并不比规律节奏更像人。要降低机械感只有两条：节奏抖动（`JITTER_PCT`）+ 停顿（`dwell`），以及**少跑**。
- **「收一个就审」怎么开**：`BATCH_REVIEW=1` + `REVIEW_EVERY=1`（或 config `batch.batchReview:1` + `batch.reviewEvery:1`；**只设 `REVIEW_EVERY` 不会开批量模式**）。审核没过的取消收藏是**自动**的（`AUTO_ROLLBACK_REJECTED=1` 默认）：`--accept-only` 或脚本启动接受审批时，会先对被拒者点「取消收藏」再回退账本（`state.favorites`/`sinceBatch` −1、清 `pendingRecords`/`passes.jsonl`）。**连不上浏览器时不会硬失败**：写 `rollback_queue.json` 并 `exit 42`，下次启动 `main()` 里先 `flushRollbackQueue()` 重试。注意 `connect()` 连不上会直接 `exit(2)`，所以自动回滚前用 `cdpReachable()` 探端口，别指望 try/catch 兜住。
- **岗位会跳回第一个**：每次 `Page.navigate` / 刷新后，职位选择恢复到列表第一项（实测）。所有「读卡片/开详情/收藏」的动作前都要核对岗位标签，否则就是拿错岗位的人在点收藏。
- **岗位「待」时没有收藏按钮**：`jobid=null` → 详情页只有「打开职位」和经历概览，没有 `.like-icon-and-text`。这是「不可收藏」而不是失败：记录原因、跳过此人，**不要点「打开职位」**（那是真的开放岗位动作），也不要反复重试。ego 侧报 `NO_FAV_CONTROL`（exit 3），A 侧在开卡后立即记 `NO_FAV_CONTROL` 并跳过。
- **ego 控制权会被交还**：ego 认为需要人时会把控制权交给用户（日志会明说 "Control of this task space is with the user"）。此时**任何浏览器命令都会被拒**，必须停下等人回来，**不允许自行 `takeOverTaskSpace` 夺回**（用户明确要求后才可）。
- **ego 必须指定自己的 profile**：`taskSpace(name)` 默认建在 `Profile 1`（从 Chrome 导入的那份，cookie 是 v20、ego 解不开 → 永远「登录状态已失效」）。要用它自己的登录态必须显式 `taskSpace(name, { profileId: "Profile" })`（名字「您的 ego」）；ego 也不会跟 Chrome 共享登录态，两边同时登同一账号会互相顶掉。
- **限流征兆**：连续空 feed / 无 iframe 偏移 / 异常 → 连续 3 次写 `REST_UNTIL` 停 30 分钟（**下次启动会读取并拒绝运行**）；收藏失败率 >50% 直接 `stopRisk('favorite-failure')`（截图 + STOP_TODAY）。
- **后台任务会搬家**：单条命令跑超 600s 会被移到后台继续跑，看着像卡住；用 `job_list` 查、必要时 `job_kill` 后重启。

## 误点处理

- 误点「收藏」：再点一次取消（或 `--rollback`），核对 toast「取消收藏成功」；手工取消后务必清理 `known_fav.json`/`known_fav_map.json` 中该人，否则闸门会认为仍在收藏（`--rollback` 会自动清理）。
- 误点「打招呼 / 联系Ta / 搜索畅聊卡」：**无法撤回**，立即停止、截图、告知用户，不要继续操作。
- 任何不确定状态：先 `FAV_DRY_RUN=1` 跑一轮观察，再逐步放开。

## 产物与目录

```
.dsh/skills/boss-recruiting-scan/
├── SKILL.md
├── README.md                # 5 分钟快速上手（环境/命令/退出码）
├── HANDOVER.md              # 交接说明
├── config.example.json      # 复制为 config.json 后可调节奏/配额
├── scripts/
│   ├── cdp.mjs              # 只读诊断（state/cards/shot/ax/reload/eval/scroll/more/pmore/wheel/dump）
│   ├── scan-favorite.mjs    # 主流程 + --rollback / --batch / --accept-only
│   ├── judge.py             # 口径判定器（--selftest 12/12，合成用例）
│   ├── judge_template.py    # 换口径模板（改 CONFIG/judge_card 即可，--selftest 5/5）
│   ├── strict2.py           # 判定器依赖的解析层
│   ├── strict3_fixtures.json
│   ├── favcapture.mjs       # 抓收藏牛人列表（报 total / this_round / historical）
│   ├── known-cleanup.mjs    # 回滚清理 known_fav（姓名键 + card_id 映射，含自测入口）
│   └── make_ledger.py       # xlsx + md 台账
└── references/
    ├── criteria.md          # 口径卡模板 + 假阳性示例
    ├── custom-criteria.md   # 换口径指南（判定器契约 + 示例）
    ├── troubleshooting.md   # 白屏/卡住/点空的成因与修法（实测记录）
    ├── requirements.md      # 需求台账：对话里提过的要求 → 落地状态（✅/📄/🔧/❌/🗄）
    └── ego-integration.md   # ego 三条集成路线对比
```

`$BOSS_WORK` 里运行期产物（不进仓库）：

```
daily_state.json         # 日收藏数/轮次/startedAt/batchSeq
known_fav.json           # card_id 与「真实姓名|年龄」键（防重复收藏）
known_fav_map.json       # card_id → 姓名|年龄
real_names.json          # card_id → 推荐流卡片上的真实姓名（台账/审核优先用它）
passes.jsonl / fav15.jsonl / review_batch_N.json / review_ok_N.json / rejected.json
strict3v2_{ok,all,near,summary}.json
```

```bash
export CDP_URL=http://127.0.0.1:9333 BOSS_WORK=/tmp/boss
node scripts/cdp.mjs state                            # 看 url/frames/login/loginDetail
node scripts/cdp.mjs navigate "https://www.zhipin.com/web/chat/recommend"   # 换页（v1.8.2+）
FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 1      # 联调：只看不收藏
node scripts/scan-favorite.mjs 5                  # 正式：收藏目标 5 人
python3 scripts/judge.py --selftest                   # 默认口径判定器，12/12
python3 scripts/judge_template.py --selftest          # 换口径模板，5/5
node scripts/scan-favorite.mjs --selfcheck-judge      # 判定器契约回归（无浏览器），6/6
node scripts/scan-favorite.mjs --batch                # 不足 5 人时手动结批（exit 42）
node scripts/scan-favorite.mjs --accept-only          # 只接受 review_ok_N（无浏览器、不再收藏）
node scripts/scan-favorite.mjs --rollback "真实姓名"   # 取消收藏 + 清理 known + 回退账本
node scripts/favcapture.mjs                           # 本轮 vs 历史收藏（this_round / historical_count）
python3 scripts/make_ledger.py --work $BOSS_WORK --title 招聘筛人台账-$(date +%Y%m%d)   # 默认输出到 $BOSS_WORK
```

## 交付前自检

- [ ] 轮次/收藏在配额内，无 `STOP_TODAY` / `REST_UNTIL`
- [ ] 每个 PASS 都有 `card_id` + 证据；收藏以控件文案「已收藏」自证（toast 仅补充）
- [ ] **若开了 `--soft-review`（先审后点）**：每张卡的 `SOFT_APPROVE/SOFT_REJECT` 都在 `decisions.jsonl` 或日志里留痕；被拒者**没有**被收藏，也不需要回滚
- [ ] **岗位核对**：每一轮开卡前确认岗位标签仍是目标岗位（刷新后会跳回第一个）；岗位为「待」时已按不可收藏跳过，而不是反复重试
- [ ] **若开了 `BATCH_REVIEW=1`（批量模式）**：`review_batch_N.json` 都有对应 `review_ok_N.json`；未通过者已 `--rollback`；纯脚本模式不产生批次文件
- [ ] 台账 xlsx + md 已生成（xlsx 需 openpyxl 解释器）；用 `node scripts/favcapture.mjs` 核对，**只认 `this_round`**，别拿收藏页总条数（含历史、且懒加载）当成绩
- [ ] 若开了 `BATCH_REVIEW=1 REVIEW_EVERY=1`：每次收藏后都停轮送审，且被拒者已自动取消（看 `auto-rollback:` 日志；没取消干净时 `rollback_queue.json` 会被清空）
- [ ] 每批 `review_ok_N.json` 都有对应 `--accept-only`／启动自动接受的日志；被拒者已 `--rollback`（账本 `state.favorites` 同步减掉）
- [ ] 若换过口径：`judge_template.py --selftest` 与 `scan-favorite.mjs --selfcheck-judge` 均通过

## 版本

- 2026-11-08 **本地补丁 9：两种审核机制真正互斥 + 外部审计 F1–F15 全修（非上游版本）**：① 新增 `BATCH_REVIEW` 总开关（`scripts/scan-favorite.mjs:92`，`!SOFT_REVIEW && …`），启动补结与 `onFav` 两处闸门都挂它——什么都不加=纯脚本、`--soft-review`=先审后点、`BATCH_REVIEW=1`=批量模式，任意两者不再叠加；② 收藏目标改为按「非 flag 位置参数」解析（`TARGET_FAV`），`scan-favorite.mjs 10` 真为 10，非数字直接 `FATAL` exit 2；③ 铁律 8/9 落到代码：`core/flow.mjs` 来源命中精确「精选」→ `SKIP_SOURCE`，卡片姓名含 `*` → `SKIP 掩码姓名`（不再误杀标题含「精选」的岗位）；④ 全仓库过期示例清零（`150 5` / `2 1`），文档统一三态写法；⑤ 退出码表按代码实际改写（1=致命/用法错误，2=前置条件，42=批量闸门，44=软审超时）；⑥ `config.example.json` 补 `batch.batchReview` / `batch.autoRollbackRejected`。⑦ `pendingRecords` / `sinceBatch` 只在批量模式累计，纯脚本或先审后点收藏过的人**不会**在之后开批量模式时被补送审；⑧ 精选匹配修正为单反斜杠正则、`selftest-flow.mjs` 新增「精选来源跳过」「掩码姓名跳过」两个场景（9 场景全过，其中精选场景用 `t.selected` 断言，删掉闸门会真 FAIL）；⑨ 旧 `daily_state.json` 加 `schemaVersion: 2` 迁移：非批量模式下清掉 9.1 遗留的 `pendingRecords`（并把 `sinceBatch` 归零）并打印 `MIGRATE clear legacy pendingRecords N`，批量模式下保留。回归：`node --check`×4、`selftest-flow.mjs` SELFTEST OK（9 场景）、`--pacing-selftest` PACING_OK、`--selfcheck-judge` 6/6、`judge.py --selftest` 12/12。
- 2026-11-08 **本地补丁 8：文档补齐「岗位轮转 / SCAN_PER_JOB / --soft-review」+ 消除审核口径歧义（非上游版本）**：① 明确**两条路线的来源都是岗位下拉**（Chrome 线仅在读不到岗位时退回 tab），`SCAN_PER_JOB` 是"看"的张数（默认 100），达到或连续 3 次没有新卡就换下一个岗位；② 明确**两种审核方式互斥**：「先审后点」（`--soft-review`，审核在收藏之前，被拒不需要回滚）与当时的可选「批量模式」（`REVIEW_EVERY`，收藏之后停轮，被拒需回滚；`BATCH_REVIEW` 总开关是补丁 9 才加的）——`review_batch_N.json` 只在批量模式产生，先审后点看的是 `soft_pack.json`/`soft_ok.json`；③ `README.md` 新增「审核的两种方式」「岗位轮转与 SCAN_PER_JOB」两节，并修掉旧示例（原 `scan-favorite.mjs 150 5` 是"轮次上限+收藏目标"两个位置参数，现在只剩一个位置参数=收藏目标）；④ `README-windows.md` 追加上表 + PowerShell 命令；⑤ `references/troubleshooting.md` 新增第十一节「先审后点 vs 批量模式」对照表与误用后果，第十节标注「仅批量模式」；⑥ **代码同步**：Chrome 线新增岗位读取/切换（`listJobsA()`/`pickJobA()`）、登录闸门改为只在真正跳登录页时报 `NOT_LOGGED_IN`（`PROBE_NOT_READY` 只记录不退出）、列表滚动改为按溢出容器滚动（`before/after/sh/ch` 日志）。回归：`--pacing-selftest` PACING_OK、`selftest-flow.mjs` SELFTEST OK、真实 Chrome dry-run 两岗位各 15 张、测试工程师规则 PASS 4（甲某/丁某/乙某/丙某）全部 `NO_FAV_CONTROL`（岗位仍「待」）、兼职·Java PASS 0、exit 0。
- 2026-11-08 **本地补丁 7：文档对齐「先审后点」+ 需求台账（非上游版本）**：① 默认流程改写为「先审后点」——软条件开启时，**审核发生在点收藏之前**，通过才收藏、不通过关详情看下一张（Step 7a）；被拒者根本没被收藏，故不需要回滚；② 原「每 N 人停轮送审 + 被拒自动取消收藏」降级为**可选批量模式**（Step 7b，`REVIEW_EVERY`/`AUTO_ROLLBACK_REJECTED` 只在批量模式生效）；③ 补上**岗位跳回**（每次 `Page.navigate`/刷新后职位选择恢复第一项 → 开卡前必须核对岗位标签，`.ui-dropmenu.job-selecter-wrap` / `.job-selecter-options .job-item`）；④ 补上**岗位「待」= 无收藏控件**的处置（跳过并记录，不点「打开职位」，不重试；ego 侧 `NO_FAV_CONTROL` exit 3）；⑤ 补上 ego 两条硬约束（必须 `profileId:"Profile"`；控制权交还后不得自行夺回）；⑥ 新增 `references/requirements.md` 需求台账（对话里所有要求 → ✅/📄/🔧/❌/🗄 状态）。**未落地项**见 `references/requirements.md` 的 ❌ 行与「本次要改的口径」：A 路线的岗位重选与 `NO_FAV_CONTROL` 显式报错仍是代码缺口。
- 2026-11-02 **本地补丁 6：审核粒度可配（`REVIEW_EVERY`）+ 被拒自动取消收藏（非上游版本）**：① 闸门从「硬编码每 5 人」改为 `REVIEW_EVERY`（env 或 config `batch.reviewEvery`，1–5，默认 5，`>5` 只 WARN 并按 5）——设 1 即「收藏一个就停轮送审」；② `AUTO_ROLLBACK_REJECTED`（默认 1）：接受审批时对被拒者**自动回滚**（元素点击 `.row.name-wrap` 取消收藏 + 回退 `state.favorites`/`sinceBatch`/`pendingRecords`/`passes.jsonl`/`known_fav`）；③ 自动回滚前用 `cdpReachable()` 探端口，连不上就写 `rollback_queue.json` + `exit 42`，下次启动 `flushRollbackQueue()` 先重试；④ `--accept-only` 无浏览器接受审批；⑤ `rollback(keys, {exit:false})` 软模式。回归实测（`REVIEW_EVERY=1`）：`NOTE: reviewEvery=1` → `REVIEW_REQUIRED batch=1 (1 人)` exit 42；全 approved + `--accept-only` → accepted exit 0；一人被拒 + 无 CDP → `auto-rollback: 现在连不上 Chrome…` + `AUTO_ROLLBACK 未完成` exit 42 + 队列 1 条；`AUTO_ROLLBACK_REJECTED=0` → `REJECTED_STILL_FAVORITED` exit 42。
- 2026-11-02 **本地补丁 5：节奏抖动（`JITTER_PCT`）+ 明确不做「随机点击」（非上游版本）**：① 轮间隔/收藏间隔改为在 `[base×(1−JITTER), base×(1+JITTER)]` 内随机（`JITTER_PCT` 默认 0.25，0=固定周期，上限 0.5），随机结果仍被 `HARD.spacingMin` / `HARD.favGapMin` 夹紧，**任何情况下不低于 15s / 12s**；② 开卡前 0.4–1.2s、点收藏前 0.25–0.9s 的随机停顿（只延后下一次真实动作，不点任何额外元素）；③ 新增 `--pacing-selftest`（抽样 12 次、打印最小/最大与硬下限，不连 CDP、不读写状态）；④ **不做「随机点击 / 轨迹伪装」**：随机坐标会命中「打招呼 / 联系Ta / 搜索畅聊卡（付费）」，破坏零外联且可能产生真实费用，见 `references/troubleshooting.md` 第九节；⑤ 参考公开研究：反爬检测的是 CDP 通道本身（`Runtime.enable` 的副作用），在 JS 层之上，点击节奏改变不了这个事实。
- 2026-10-28 **本地补丁 4：精选页禁收藏 + 姓名口径改用真实姓名（非上游版本）**：①「精选」页硬闸（`config.batch.tabs` 里的「精选」被忽略并 WARN；运行中 `.tab-item.curr` 为「精选」或出现「精选优质牛人」提示 → 整轮 `SKIP 精选页`）——该页开聊要搜索畅聊卡、卡片姓名是加密掩码；②身份改用推荐流卡片上的真实姓名（`.name`），收藏成功写 `real_names.json`，审核包与台账优先用真实姓名；卡片姓名带 `*` 的候选开卡前直接跳过（`SKIP 掩码姓名`）；③`--rollback` 支持传 card_id（经 `real_names.json` 换成真实姓名）；④`--rollback` 开浮层改**元素点击优先**（`.row.name-wrap` 的 JS `click()`，坐标仅兜底）——收藏牛人页按坐标点击实测落空（`rollback: overlay not opened`）。回归实测：真跑收藏 2 人（陈琳/冯婷）→ 回滚 1 人后 `state.favorites` 2→1、`pendingRecords`/`passes.jsonl` 各减 1 条、`known_fav.json` 清掉 3 个键、站点收藏 20→19 条且 `this_round=1`（D14/D17/D18/D19 四项浏览器验证同时通过）。
- 2026-10-28 **本地补丁 3：按「拿不到本地补丁的新人」外测报告修 24 条（非上游版本）**。报告：一个 agent 只读 GitHub 仓库、在干净沙盒里从头跑两轮，产出 `TEST-REPORT.md`（2 Blocker + 13 Major + 9 Minor）。本补丁修完：**A. 文档**（取仓库三路径：官方/gh-proxy.com 镜像/codeload zip；受管终端必须脱离启动 Chrome；登录必须选「我要招聘」；自检顺序与 PowerShell 编码；默认口径在真实卡上常 0 PASS 的警告；核对收藏只认 `this_round`；卡片城市不可信）。**B. 代码**：①`cdp.mjs` 的 `login` 改按顶层 DOM+URL+`wt2=` 判定（旧实现找推荐帧里的「退出登录」，登录成功也报 false）；②新增 `cdp.mjs navigate <url>`（文档说要打开推荐页，但此前没有该子命令）；③`cdp.mjs cards` 在收藏页回退读 `.card-item`（此前恒 `total 0`）、`shot` 改 `fromSurface:false`（默认值会挂住）；④收藏顺序真的按判定器排序（`domIndex` → `queue`），此前 changelog 声称已实现、代码仍按 DOM 顺序；⑤新增 `--accept-only`，并把「接受审批」提到配额/停线检查之前（否则当天到顶时最后一批永远结不清）；⑥`--batch` 批号取 `batchSeq`/`pendingBatch` 最大值（并发时不再重号）；⑦`--rollback` 加收藏页就绪轮询（冷启动首跑不再误报「全部未命中」），且成功回退 `state.favorites`/`sinceBatch`、清 `pendingRecords`/`passes.jsonl`（此前回滚后账本仍记着、下次还会把已回滚者送审）；⑧`make_ledger.py --out` 默认 `$BOSS_WORK`、时间转本地、缺 openpyxl 时给明确修法；⑨`favcapture.mjs` 加就绪轮询并区分 `this_round`/`historical_count`。
- 2026-10-28 **本地补丁 2：把「点收藏」从坐标点击改成元素点击 + 浮层判据修复（非上游版本）**。实测两轮跑通（第 2 批审核 + 台账）。①`scan-favorite.mjs` 开卡改元素优先（`.row.name-wrap` 的 JS `click()` 返回 `el-click`），坐标仅兜底；②收藏改点推荐帧内 `.like-icon-and-text`，用控件文案「收藏→已收藏」自证，toast 降为辅助（旧实现靠 toast 产生过假阳性/假阴性）；③浮层判据由「帧树里有 c-resume 帧」改为「推荐帧里最后一个非 `v-leave` 的 `.boss-popup__wrapper` 且可见」——c-resume 画布帧关掉后仍常驻，是 `stale overlay` 空转的根因；④`closeOverlay` 改为点 live wrapper 的 `.close-btn` + 清除卡在 `v-leave` 的残留节点（`overlay cleanup: removed N stuck node(s)`）+ 推荐帧内派发 Escape，最后才用真实 rect 兜底；⑤主循环固定 `sleep(9000)` 改成就绪轮询（卡片数连续两次相同）；⑥新增 `references/troubleshooting.md`（白屏三因、卡住四因、点空三层、闸门卡住、为何扩展桥不能收藏、Windows 专属结论）；⑦SKILL.md 修正「收藏按钮在 shadow DOM、只能坐标点击」的错误说法，坐标表改为元素选择器，新增「两种连接方式」章节（A 独立调试实例=全自动，B 扩展桥=只读筛人）。
- 2026-10-28 **本地 Windows 补丁（非上游版本，v1.8.2 之上）**：仅修 POSIX 路径/解释器假设，不改流程、节奏、配额、闸门与口径——①`scan-favorite.mjs` 自检临时目录改用 `os.tmpdir()`（原先写死 `/tmp/…`，Windows 上 `mkdtemp` 直接 ENOENT）；②新增解释器探测（`PYTHON_BIN` 优先，未设置时按平台探测，Windows 附加 `py` 启动器），`PYTHON_BIN` 为商店空壳时 `FATAL` 明确提示；③`scan-favorite.mjs`/`cdp.mjs`/`favcapture.mjs`/`judge.py`/`judge_template.py`/`make_ledger.py`/`strict2.py` 的默认工作目录在 Windows 改为 `%TEMP%\boss`（POSIX 仍是 `/tmp/boss`）；④新增 `README-windows.md`（环境、冒烟验收、与 macOS 的差异、补丁回滚）。验收：`judge.py --selftest 12/12`、`judge_template.py --selftest 5/5`、`scan-favorite.mjs --selfcheck-judge 6/6`。
- 2026-10-28 v1.8.2：按「换口径」实测修复——判定器可选输出 `city_rank`（0/1/2），收藏顺序与台账排序**真实生效**（city_rank 升序 → 条件3月数降序）；`judge_template.py` 支持 `city.acceptable`、`c3.mode='evidence'`（布尔型条件）与完整 `want` 解析；`scan-favorite.mjs` 校验 `city_rank`/负月数，判定器 0 条 PASS 时 WARN（ok/near/all 全空才 FATAL）；`--rollback` 成功写 `rollbacks.jsonl`，台账新增「城市优先级」列与「已回滚」状态，说明不再硬编码默认口径；`ledger_config.json` 支持 `note` 自定义口径说明。
- 2026-10-28 v1.8.0：按「新人从零使用」实测报告修复——①回滚崩溃（`scan-favorite.mjs` 缺 `cleanupKnown` 导入，Blocker）；②新增持久化 `rejected.json`（被拒者永久跳过，不再复活）；③台账重写：读 `known_fav/rejected/review_ok`，标注「已收藏/已回滚/已拒绝/审核结果」，列名可经 `ledger_config.json` 覆盖（换口径不贴错标签）；④新增 `README.md` 快速上手 + macOS 前置条件具体化；⑤CDP 连不上时友好报错；⑥`strict2.py` 不再静默读 `/tmp/boss` fixture（改 `STRICT2_FIXTURES`）；⑦`config.json` 缺失提示、TARGET 超额度自动夹取、digest/覆盖错误分开提示；⑧`HANDOVER.md` 随 skill 目录分发。
- 2026-10-27 v1.7.3：审计 minor 收尾——`runJudge` 入口过滤空卡并 FATAL；生产抽取路径先过滤空串；文档把姓名契约写实为「前缀+`**`」、HANDOVER 必填字段补 `c1_segments`、补 `strict2` 真实回归用例不随包说明、`--judge-run` 覆盖提示。
- 2026-10-27 v1.7.2：姓名 schema 收紧为「前缀+**」（`^[\u4e00-\u9fffA-Za-z]{1,6}\*\*$`，拒绝 `张*`/`**`/`AB12**`）；`judge.py` 与 `scan --judge-run` 对空 card/空白 card/无 card 字段统一 exit 2；`strict2_fixtures.json`（真实回归用例）不随包，包内 `strict2.py --selftest` 打印 SKIP 并 exit 0；`scan-favorite.mjs` 删除死代码 `maskName`；`--selfcheck-judge` 6/6；文档计数与隐私声明同步。
- 2026-10-27 v1.7.1：包内 `judge.py` 同步修复（空输入/全空 card → exit 2；无姓名/无年龄的卡不进 PASS）；scan schema 收紧（`name` 必须含 `*`、`c1_segments`/`c3_segments` 必填数组、`c1_months`/`c3_months` 必须整数）并新增 2 条契约自检（未掩码姓名、浮点月数）共 6/6；`judge_template.py` 不再猜姓名（解析不到姓名直接跳过，`--selftest` 5/5）；文档同步（契约字段、无占位姓名、HANDOVER v1.7.1）。
- 2026-10-27 v1.7：修复审核发现的 2 blocker + 5 major——流程层删除 `c3_months<24` 硬编码（门槛完全交给判定器）并新增判定输出 schema 校验 + 跑前清理旧输出（防 stale 记录绕过「缺输出即停」）；`judge_template.py` 重写（年龄在首 token/缺年龄边界、空姓名用 card_id 占位、空输入 exit 2、`rank_only=false` 城市硬过滤、c1/c3 segments、产物 600、--selftest 5/5）；新增 `scan-favorite.mjs --selfcheck-judge` 契约回归 4/4；文档同步（c2 仅 A 级、PYTHON_BIN 非 Python 判定器、示例 1 真强制 985、示例 2 标注伪代码、HANDOVER 版本）。
- 2026-10-27 v1.6：新增「换口径」能力——`scripts/judge_template.py`（可复制改 CONFIG/judge_card，`--selftest 2/2`，输出符合契约的 4 个 JSON）+ `references/custom-criteria.md`（三层换口径路径、判定器契约字段表、Java/两条件示例）；默认判定器 `judge.py` 不变，通过 `JUDGE_PY` 切换；另修复 `scripts/strict2.py` docstring 里的真实姓名示例为掩码（v1.6 审核补记）。
- 2026-10-27 v1.5：`--rollback`/`--batch` 不受 STOP_TODAY/配额/RUN_LIMIT **以及未审闸门** 限制（纠正模式真正解锁，消除「被拒→回滚被 42 拦住」死锁）；回滚成功经 `known-cleanup.mjs` 同步清理姓名键 **与 card_id**（`known_fav_map.json`），闸门 X2 同时按 card_id 与 `姓名|年龄` 判定；favcapture 掩码容忍多个活动标签。
- 2026-10-27 v1.4：`--rollback`/`--batch` 不受 STOP_TODAY/配额/RUN_LIMIT 限制（纠正模式；闸门限制见 v1.5 修复）；闸门改为收藏成功后立即触发（closeOverlay 抛错/中断不漏审），启动时满 5 条未结批自动补结；`writeReviewBatch` 只消费已写记录（不丢第 6 条）；`review_ok` 的 rejected 必须不在 `known_fav`（否则 42，要求先回滚）；掩码回滚正则容忍中间活动标签。
- 2026-10-27 v1.3：闸门计数持久化（sinceBatch/pendingRecords，跨运行累计，`--batch` 手动结批）；review_ok 必须覆盖全部候选（approved+rejected）；回滚优先真实姓名（掩码名 best-effort）、全未命中 exit 2、自动清理 known_fav；judge `_brief` 补 c1_segments/c2_evidence（review_batch 证据不再为空）；fixtures 全部姓名掩码；favcapture 掩码覆盖「姓名+活跃标签+N岁」布局；cdp dump 改 600 + 警告；REST_UNTIL 启动即读；reviewEvery 读 config。
- 2026-10-27 v1.2：硬夹紧节奏/配额（env、config 无法放宽）；Asia/Shanghai 本地日；审核闸门加 digest + approved ids + batchSeq 持久化；review_batch 只存证据字段（无完整卡片）；安全停线覆盖各 iframe 正文/登录/失败率；tab 改 推荐+最新；回滚用真实姓名（掩码名 best-effort）并回写 known_fav；judge 默认输出 `/tmp/boss`、产物 600、fixtures 姓名匿名化、修 SyntaxWarning；favcapture 掩码只掩姓名 + 登录检查；ledger 产物 600。
- 2026-10-27 v1.1：防封配额/节奏落地；审核闸门（每 5 人停轮）；安全停线覆盖 iframe/正文/登录/限流；隐私掩码 + card_id；judge 输出到 BOSS_WORK、动态月份；新增 `--rollback`、`make_ledger.py`、`FAV_DRY_RUN`。
- 2026-10-27 v1.0：初版（流程固化）。
