---
name: boss-recruiting-scan
description: 在 BOSS 直聘招聘端「推荐牛人」页按约定口径批量筛选候选人并点「收藏」，含 CDP 调试端口驱动、防封节奏与配额、每 5 人一道审核闸门、误点回滚与台账产出；判定口径可替换（JUDGE_PY / judge_template.py），换岗位或换条件无需改流程。当用户要求在 BOSS直聘 上批量筛人 / 点收藏 / 出候选人名单时加载。
---

# BOSS直聘 推荐流筛人（含收藏）

在 BOSS 直聘**招聘端**替雇主批量看人：按明确口径筛出候选人（只做「收藏」，零外联），每收藏 5 人停轮交审、审不过回滚，最后交台账。**流程与节奏固定，不可放宽**——它们是账号安全的边界。

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

## 两种连接方式（二选一）

| | **A. 独立调试实例**（默认，全自动） | **B. 扩展桥**（只读筛人） |
|---|---|---|
| 前提 | 新建 `--user-data-dir` + `--remote-debugging-port=9333`，**并在该实例里登录一次**（Windows 必须如此：Chrome 136+ 不允许默认 profile 开调试端口，且 cookie 是 v20 App-Bound Encryption、复制过去会被删） | 用户已登录的日常 Chrome + 已装扩展（本机 `~/.dsh/browser-extension` 工具级桥，或 BrowserSkill/bsk 那套） |
| 能力 | 采集 → 判定 → **收藏** → 每 5 人闸门 → 台账（全流程） | 采集 → 判定 → 名单/台账；**不能点收藏** |
| 原因 | 原生 CDP：可 `Runtime.evaluate`、可派发真实鼠标事件、可算元素 rect 与 iframe 偏移 | 工具级桥只有 15 个动作（snapshot/get_text/click/scroll/…）：点击仅支持 snapshot 序号或 CSS selector，**没有视口坐标、没有任意 JS 求值**；而卡片与「收藏」既不是 `<button>` 也不是 `<a[href]>`，snapshot 里只编号出「打招呼」→ 去点收藏就会点到打招呼 |
| 驱动方式 | `node scripts/scan-favorite.mjs <轮次> <收藏数>` | 助手 agent 用 `browser_snapshot`/`browser_get_text` 读候选人 → 写成 `cards.jsonl`（每行 `{"card":"<卡片全文>"}`）→ `node scripts/scan-favorite.mjs --judge-run cards.jsonl`（只判定、不点收藏，产物在 `$BOSS_WORK`）→ `make_ledger.py` 出台账 |

结论：**自动收藏只有 A 一条路**；B 适合「只筛人、不出手」。细节与踩坑证据见 `references/troubleshooting.md` 第五、六节。

## 铁律（防封，任何情况下不改）

1. **零外联**：绝不发消息、不点「打招呼 / 联系Ta / 搜索畅聊卡」；只点「收藏」和关闭浮层。
2. **节奏**：轮间隔 ≥15s（默认 18s）、收藏间隔 ≥12s（默认 12.5s）；env/config 只能更严——脚本用 `Math.max`/`Math.min` 夹住，传 0/负数不会生效。每轮默认只读 2 个 tab（推荐 / 最新）。
3. **配额**：单日收藏 ≤60、轮次 ≤200、当日累计运行 ≤3h（`daily_state.json` 持久化，`startedAt` 为当日首次启动；启动与**每轮循环内**都复查，超限即退；跨日重置）。日切按 `Asia/Shanghai` 本地日（`Intl.DateTimeFormat en-CA`）。
4. **风险即停**：登录页 / 安全验证 / 操作频繁 / 收藏失败率 >50% → 截图、写 `STOP_TODAY`、非零退出；当天不再跑。
5. **隐私**：不导出手机号/微信/邮箱；**身份用推荐流卡片上的真实姓名**（`.name`，落在本机 `real_names.json`），判定器的掩码名只作兜底；卡片原文只在判定时用临时文件，判完即删。
6. **不碰付费动作**：用户说「搜索里的人要付费」时，全程只在推荐页操作。
7. **审核闸门**：**每累计 5 个收藏**（`state.sinceBatch`/`pendingRecords` 持久化，跨运行累计；启动时若已有满 5 条未结批会自动补结）自动停轮，产出 `review_batch_N.json` 并 `exit 42`；审核方写 `review_ok_N.json`，必须用 `approved_card_ids` + `rejected_card_ids` **覆盖全部候选**（不能用旧审批、不能只批一部分），被拒者用 `--rollback` 取消收藏后才算闭环（被拒 id 会写入 `rejected.json`，此后永久跳过、不会再收藏）（脚本会自动清理 `known_fav` 里的姓名键与对应 `card_id`；若手工在页面取消收藏，需同样清理，或直接 `--rollback` 走闭环）。未完成上一批审核不得开始下一批；不足 5 人时可 `--batch` 手动结批。
8. **不在「精选」页收藏**：「精选」是另一套富集卡片，开聊要「搜索畅聊卡」（付费资源），卡片结构与推荐流不同，在那页点收藏等于把节奏和预算放到错的地方。脚本已做硬闸：`config.batch.tabs` 里写「精选」会被忽略（`WARN`），运行中检测到当前 tab 是「精选」（`.tab-item.curr` 文案 / 「精选优质牛人」提示）→ 整轮 `SKIP 精选页`。
9. **掩码姓名不收藏**：推荐流卡片上是**真实姓名**（`.name`，如「吴嫔」），判定器输出的是掩码（「吴**」）。身份以「真实姓名 + card_id」为准；卡片姓名若仍带 `*`（精选页就是这种「加密带星号」的名字）→ 直接 `SKIP 掩码姓名，不收藏`，因为收藏一个连姓名都核对不了的人，后面审核和回滚都没法对账。

## 流程（按顺序，不跳步）

**Step 0 口径卡**：三段条件（见 `references/criteria.md`），每段写清「算/不算」。口径实现于 `scripts/judge.py`；换口径改判定器，不改流程。

> ⚠️ **默认判定器不是通用口径**：`judge.py` 内置「长沙优先 / 英语 A 级 / 教学或大厂职能经历月数」三条，**依赖卡片里的起止日期**。BOSS 推荐卡的正文多数没有起止日期，所以默认口径在真实卡上常常 **0 PASS**（实测 14 张真实卡 0 PASS，同一批换成自写口径后 8 PASS）。第一次用请把它当**骨架**，按 `scripts/judge_template.py` 改写口径再跑；`WARN 判定器本轮 0 条 PASS` 是口径不适配的信号，不是"这批人都不合适"。

**Step 1 环境**：`node scripts/cdp.mjs state` 确认存在 `/web/frame/recommend/` 帧、且 `login:true`；需要换页时用 `node scripts/cdp.mjs navigate <url>`（v1.8.2+ 新增，例如 `navigate "https://www.zhipin.com/web/chat/recommend"`）。窗口不能最小化（最小化时 CDP 点击无效、截图超时）。首次 `shot` 可能拍到全白（页面还没渲染完）→ 等 8 秒重拍，不要据此判断页面坏了。

**Step 2 筛选（可选）**：手动在页面点「筛选」→ 勾选目标条件（如院校「留学」）→「确定」，命中率可提高数倍。`Page.navigate` 会复位筛选；脚本默认 `APPLY_FILTER=1`，每轮回点「筛选 → 应用 → 确定」重放上次筛选，但**不会自动勾选条件**——首次需人工勾好；若页面没有「应用上次筛选」提示，则筛选不会被重放。

**Step 3 采集 + 判定**：脚本每轮导航 → **就绪轮询**（最多 25×1.2s：循环取推荐帧与 iframe 偏移，并读 `.candidate-card-wrap` 数量，要求连续两次相同才继续；不要用固定 `sleep(9000)`——这个页面导航后常要 20s 级才稳定）→ 依次点「推荐 / 最新」→ 读卡片文本 → 写临时文件（600，判完即删，**不持久化完整卡片**）→ `judge.py` 判定 → 拿 PASS 列表（含 `card_id`）；每轮还会检查当前 tab，落在「精选」页则整轮 `SKIP 精选页`（该页开聊要畅聊卡、姓名是掩码）→ **收藏成功**的 PASS 才追加到 `passes.jsonl`（审核包由 `state.pendingRecords` 生成）。judge 失败或缺输出文件时脚本 `exit 2`（不吞错）。

**Step 4 开浮层**：命中的卡优先用**元素点击**（`.row.name-wrap` 的 JS `click()`，返回 `el-click`），失败才回退到卡片坐标 `Input.dispatchMouseEvent`。成功标志：推荐帧内出现**非 `v-leave`** 的 `.boss-popup__wrapper` 且可见（浮层内容其实渲染在推荐帧里，`c-resume` 画布帧不可点）。开卡前若已有残留浮层，先 `closeOverlay()`；仍关不掉就跳过此人（日志 `stale overlay, skip <card_id>`）。点击前做 allowlist：目标文本含「打招呼 / 联系Ta / 聊卡」立即放弃。

**Step 5 收藏 + 校验**：点该 wrapper 内 `DIV.like-icon-and-text`（轮询最多 20×500ms，等工具条挂载）→ 读同一控件的文案变化：`收藏`→`已收藏` 即成功，反过来即被取消（此前已收藏过 → 再点一次恢复）。toast（`收藏成功`/`取消收藏成功`）只作补充证据，不作为唯一判据——历史 bug 里 toast 有假阴性也有假阳性。收藏成功时把推荐流卡片上的**真实姓名**写进 `real_names.json`（`card_id → 姓名`），审核包 `review_batch_N.json` 的候选带 `name_real`，台账「姓名」列优先用它；卡片姓名为空或带 `*` 的候选在开卡前就被跳过。

**Step 6 收尾**：点该 wrapper 的 `.close-btn` → 轮询 8×300ms；关不掉的把仍处于 `v-leave` 的节点直接 `remove()`（日志 `overlay cleanup: removed N stuck node(s)`）→ 仍失败再在推荐帧 document 内派发 Escape → 最后才按真实 rect 兜底点击；然后 `sleep` 到收藏间隔（默认 12.5s）再下一位。

**Step 7 审核闸门**：每累计 5 个收藏，脚本写 `review_batch_N.json`（只含证据字段：card_id/掩码姓名/年龄/城市/期望/c1 月数与 segments/c2 等级与 evidence/c3 月数与 segments，**不含完整卡片**）+ `digest`，并 `exit 42`。审核方逐人核 c1/c2/c3，写 `review_ok_N.json`：`{"batch":N,"digest":"<与 batch 一致>","approved_card_ids":[...],"rejected_card_ids":[...]}`。脚本启动校验：batch 序号、digest、**ap∪rj 覆盖全部候选且不重叠**；被拒者须已 `--rollback`。`batchSeq`/`sinceBatch`/`pendingRecords` 持久化，旧审批不能复用。手动结批：`node scan-favorite.mjs --batch`。

> **接受审核是一个独立动作**：`node scripts/scan-favorite.mjs --accept-only` 只校验并消费 `review_ok_N.json`，**不需要浏览器、也不会再收藏人**。不带它时，下一次正式启动会先自动接受，但**接受发生在配额/停线检查之前**（所以「今天收藏到顶了但最后一批还没结」不会再卡死）；`FAV_DRY_RUN=1` 时不消费审批（联调不动账本）。

**Step 8 回滚**：审核不通过 / 误收藏 → `node scripts/scan-favorite.mjs --rollback "真实姓名,..."`。**优先真实姓名**；也接受 `card_id`（先经 `real_names.json` 换成真实姓名，换不到才 `exit 2`）与掩码名 `唐**|27`（best-effort，按首字通配+年龄匹配）；在收藏牛人页按姓名匹配 → **元素点击 `.row.name-wrap` 开浮层**（坐标仅兜底，实测坐标点击会落空）→ 点收藏（= 取消）→ 校验控件文案回「收藏」；成功后经 `known-cleanup.mjs` 按「姓名|年龄 / 掩码名|年龄 / 同年龄+同首字」清理 `known_fav.json`，**并删除对应 16hex card_id**（`known_fav_map.json` 映射、`review_batch_*.json` 反查）；同时**回退账本**：`state.favorites`/`state.sinceBatch` 各减 1，`state.pendingRecords` 与 `passes.jsonl` 里该人的记录一并删除——否则下次 `--batch` 会把已回滚的人重新送审。收藏牛人页有就绪轮询（25×1.2s），冷启动第一次就等它加载完，否则会误报「全部未命中」。全部未命中时 `exit 2`（不假成功）；`FAV_DRY_RUN=1` 时拒绝回滚。

**Step 9 台账**：`python3 scripts/make_ledger.py --work $BOSS_WORK --out <交付目录> --title 招聘筛人台账-YYYYMMDD` → xlsx + md（通过名单 / 收藏记录 / 审核批次 / 说明）。`--out` 不传时默认写到 `$BOSS_WORK`（不再写当前目录）；出 xlsx 必须用带 openpyxl 的解释器（缺库会提示，只产 md）；台账里时间统一转本地时区并把时区写进表头。

**Step 10 停止**：达标、用户喊停、或任一风险信号 → 立即停、截图、汇报；写 `STOP_TODAY`。

## 定位方式与常量（CSS 像素，随窗口自适应）

**优先按元素点，坐标只作兜底。** 减法魔法坐标是历史 bug 的根源（收藏横偏 44px、关闭钮偏约 99px），见 `references/troubleshooting.md`「三、点空」。

| 元素 | 定位方式 |
|---|---|
| recommend iframe 偏移 | iframe `getBoundingClientRect()` 实时取，每次导航重取 |
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

## 口径不是这三条怎么办（换岗位 / 换条件）

本 skill 只有**判定层**与具体口径绑定；扫描、收藏、闸门、台账、防封配额都与口径无关。换条件时**不改流程**：

1. **只换规则参数（最常见）**：`cp scripts/judge_template.py my_judge.py`，改 `CONFIG`（c1/c2/c3 关键词、排除词、`min_months`、`city.prefer/rank_only`）与 `judge_card()`，然后
   `JUDGE_PY=$PWD/my_judge.py node scripts/scan-favorite.mjs 150 5`
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
    └── troubleshooting.md   # 白屏/卡住/点空的成因与修法（实测记录）
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
FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 2 1      # 联调：1 轮不点收藏
node scripts/scan-favorite.mjs 150 5                  # 正式：≤150 轮，收藏 5 人后停轮交审
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
- [ ] `review_batch_N.json` 都有对应 `review_ok_N.json`；未通过者已 `--rollback`
- [ ] 台账 xlsx + md 已生成（xlsx 需 openpyxl 解释器）；用 `node scripts/favcapture.mjs` 核对，**只认 `this_round`**，别拿收藏页总条数（含历史、且懒加载）当成绩
- [ ] 每批 `review_ok_N.json` 都有对应 `--accept-only`／启动自动接受的日志；被拒者已 `--rollback`（账本 `state.favorites` 同步减掉）
- [ ] 若换过口径：`judge_template.py --selftest` 与 `scan-favorite.mjs --selfcheck-judge` 均通过

## 版本

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
