# 故障排查：白屏、卡住、点空（实战记录）

这份文档记录的是**真实踩过的坑**和对应的修法，不是推测。数字都是本机实测值（Chrome 156 / 窗口 CSS 1037×799 / dpr 2 / 推荐 iframe 偏移 (168,40)）。

排查顺序建议：先看 `node scripts/cdp.mjs state` 的帧树，再看页面 `readyState`，最后才怀疑点击逻辑。

---

## 一、白屏（页面一片空白）

三种完全不同的原因，处理方式也不同。

### 1. 调试器 attach 触发了反爬 → 文档反复重建

**现象**：页面长时间白屏或停在「加载中，请稍候」，`#app` 为空、`readyState` 长期 `loading`；`frames` 里反复出现新的 recommend 帧。

**证据**：两个反爬 SDK 脚本长期 `pending`：

```
https://static.zhipin.com/assets/sdk/warlock/warlockdata.min.2.2.15.js
https://static.zhipin.com/assets/sdk/apm/patas-compat.2.1.0.min.js
```

而直接 `Invoke-WebRequest` 取这两个 URL 都是 200（332ms / 489ms），系统也没有代理 → 不是网络问题，是页面主动不放行。

**结论**：这是「用 chrome.debugger 长时间驱动同一个标签」引起的。同一页面改用**内容脚本**（扩展桥）读取，立刻就正常了。所以：

- 原生 CDP 模式（本 skill 的主路径）跑长轮次时，页面被反复重建属于**已知风险**，出现即按风险信号停（见 SKILL.md 铁律 4）。
- 不要用「再刷一次试试」来对抗它，越刷越像机器。

### 2. `Page.navigate` 之后 SPA 重挂（正常的白屏，等就行）

**现象**：换批导航后十几二十秒里，`body.innerText` 只有 36~98 个字符、`#app` 空、`readyState:loading`；帧树里**已经有** recommend 帧，但顶层 `document.querySelectorAll('iframe')` 取不到。

**证据**：连续 20+ 秒轮询都是这个状态，之后自行恢复。

**处理**：脚本已改成**就绪轮询**——不固定 sleep 9s，而是循环取 `rf`/`off` 并读卡片数，要求**卡片数连续两次相同**才继续（`scan-favorite.mjs` 主循环 `stableN/stableHits`）。人工排查时只要 `readyState === 'loading'` 就是还没渲染完，别急着判定失败。

**注意**：如果连续 3 次拿不到偏移，脚本记 `noOffsetStreak` 并最终写 `REST_UNTIL`（停 30 分钟），这是防封的一部分，不要绕过。

### 3. 点歪落到侧栏 / 弹层盖屏（我们自己的误操作）

**现象**：窗口突然变成「沟通」页，上面还盖着「BOSS直聘 Windows 客户端」的推广弹层，看起来就是白屏卡住。

**原因**：旧实现的关闭按钮用魔法坐标 `(clientWidth-126, 57)`，实测真实位置约 `(1010, 46)`，偏约 100px；点空落到左侧菜单上。

**处理**：关闭按钮改建元素点击 + `.close-btn` 真实位置回退（见下文「三」）。日常判断：`cdp.mjs state` 的顶层 URL 变成 `/web/chat/xxx` 就是跑偏了，直接导航回 `/web/chat/recommend` 即可。

---

## 二、长时间"在跑但没进展"

### 1. 浮层判据错误 → 每个候选都被跳过

**现象**：日志连续 `stale overlay, skip <card_id>`，脚本空转。

**根因**：旧判据 `frames().some(f => /c-resume/.test(f.url))`。`c-resume` 是**画布帧**，浮层关掉后它仍常驻（预加载），于是「浮层是否打开」永远为真。

**修法**：改判「推荐帧里是否有**非离场状态**的 `.boss-popup__wrapper`」，见 SKILL.md「坐标与常量」。

### 2. 浮层关不掉 → 后续开卡全失败

**现象**：`overlay not opened <card_id>` 连续出现，只能成功第一个人。

**根因**：点关闭后 Vue 卡在离场过渡里，节点仍是可见的：

```json
{"cls":"... boss-popup__wrapper ... v-leave v-leave-active","op":"1","pe":"auto","disp":"block"}
```

`opacity` 还是 1、`pointerEvents` 还是 auto，而且这个 wrapper 覆盖整个 iframe（868×759）——它把后面的卡片全挡住了。

**更坑的是**：页面会**累积多个** `.boss-popup__wrapper`（一次开卡一个，长时间运行实测累积到 22 个 `c-resume` 帧），而 `querySelector` 只返回第一个——如果第一个是卡死的，就永远判成"浮层还开着"。

**修法**（已进代码）：
1. 只认**最后一个**不在 `v-leave` 里的 wrapper（`LIVE_DLG`）。
2. `closeOverlay()` 点完 `.close-btn` 后，把仍处于 `v-leave` 的节点 `remove()` 掉，日志会打 `overlay cleanup: removed N stuck node(s)`。
3. Escape 兜底改成**在推荐帧自己的 document 里派发**——顶层 `Input.dispatchKeyEvent` 的 Escape 到不了这个 iframe。

### 3. 固定等待不够

旧代码 `sleep(9000)` 后一次性取帧和偏移，赶不上这个页面 20 秒级的重挂节奏 → 见上文「一.2」的就绪轮询。

### 4. 后台任务超时被搬家

跑太久的命令会被移到后台继续跑（600s 后），看起来像"卡住"。处置：`job_list` 看有没有还在跑的 job，需要的话 `job_kill`，再重启任务。

---

## 三、点空（"模拟点击总是点歪"）

这是本项目花时间最多的问题，根因有三层：

### 1. 坐标是猜的，而且猜错了

| 元素 | 旧坐标 | 实测真实位置 | 偏差 |
|---|---|---|---|
| 收藏按钮 | `(clientWidth-360, 95)` = (677,95) → 帧内 (509,55) | 帧内 `(553,30)` + iframe 偏移 (168,40) → 约 `x721..792, y70..126` | 横向偏左 44px（落到工具条左侧空白，纵向虽在工具条高度内但不在按钮上） |
| 浮层关闭 X | `(clientWidth-126, 57)` = (911,57) → 帧内 (743,17) | 帧内 `(842,6)` + 偏移 → 约 `(1010,46)` | 横向偏约 99px、纵向偏 11px |

窗口宽度一变，偏差还会变。**结论：不要用减固定像素的魔法坐标。**

### 2. 控件不在以为的地方

- 浮层 `web/frame/c-resume/` 只是画布容器：`<div id="resume"><canvas id="resume"></canvas></div>`，`innerText` 为空，**点它的 shadow DOM 什么也点不到**（旧文档说"在闭合 shadow DOM 里只能坐标点击"是错的）。
- 真正可点的控件都在**推荐 iframe**（`https://www.zhipin.com/web/frame/recommend/?...`）里：
  - 收藏：`div.like-icon-and-text`（内层 `div.btn-text` 文案「收藏」/「已收藏」）
  - 关闭：`div.close-btn`
  - 工具条容器：`.communication.icon-coop-forward.shareReport` / `.btns`（收藏/转发/举报/不合适），其下还有「打招呼」按钮 —— **必须有 allowlist，绝不点它**。

### 3. 合成点击的可信度

- `element.click()`（JS 派发）足以打开卡片浮层、足以触发收藏，**不需要 isTrusted**。本机实测：`document.querySelector('.row.name-wrap').click()` 稳定开卡；同一时刻按坐标点 `(362,138)` 反而打不开。
- 需要真实鼠标事件时才用 `Input.dispatchMouseEvent`，并且坐标必须是「帧内 `getBoundingClientRect()` + 顶层 iframe 偏移」算出来的，不是猜的。
- 校验以**控件文本变化**为准（`收藏` → `已收藏`），toast 只作补充——toast 有假阴性/假阳性（旧实现就出现过"报了 fav 实际没进去"和"没报但进去了"两种情况）。

---

## 四、审核闸门卡住

- `exit 42` = 有未结批的 batch。必须先写 `review_ok_N.json`（`digest` 必须与 `review_batch_N.json` 一致，`approved_card_ids ∪ rejected_card_ids` 覆盖全部候选且不重叠），否则下次启动直接拒绝。
- 被拒的候选如果还记在 `known_fav.json` 里，会报 `REJECTED_STILL_FAVORITED` —— 要么 `--rollback "真实姓名"` 走闭环，要么确认它其实从未收藏成功（历史 bug 的假记录）后手工纠正记账。
- 历史教训：旧版坐标点击写出过两条**假收藏记录**（日志报 `fav`，收藏列表里没有）。修好元素点击后不会再有；发现历史假记录时按上面第二条纠正，并在台账里注明。

---

## 五、为什么不用扩展桥做收藏

排查过两条桥，都不能替代原生 CDP 完成"收藏"这一步：

| 方案 | 能做什么 | 卡在哪 |
|---|---|---|
| BrowserSkill 0.3.3（bsk daemon，`ws://127.0.0.1:52800`） | `evaluate` 可读页面、可截图 | 用 `chrome.debugger` 长驱动 → 触发上面的反爬白屏；且要先 `bsk tab borrow` 才能碰用户标签 |
| DSH 浏览器助手（`~/.dsh/browser-extension`，工具级 15 个 `browser_*`） | `snapshot`/`get_text`/`scroll` 读整页候选人文本（实测一次读 12 人） | 点击只有 snapshot 序号或 CSS selector，**没有视口坐标、没有任意 JS 求值**；而卡片和「收藏」既不是 `<button>` 也不是 `<a[href]>`，snapshot 里只编号出「打招呼」按钮 → 想点收藏就会点到打招呼 |

所以：**收藏必须走独立调试实例 + 原生 CDP**；扩展桥只适合「只读筛人」（读候选人 → 判定 → 出名单，不点收藏）。

---

## 六、Windows 平台专属结论

1. **Chrome 136+ 不允许在默认 user-data-dir 上开调试端口**。实测三条路都不通：直接指定默认目录、目录 junction、`subst` 盘符映射——Chrome 会把路径解析回默认目录，端口不监听。必须用全新的 `--user-data-dir`（本机 `C:\Users\<you>\.boss-prof`），**并且在这个实例里登录一次**。
2. **Cookie 搬不过去**：源 profile 的 zhipin cookie 全部是 `v20` 前缀（App-Bound Encryption）。复制 `Local State` + `Cookies` + `Preferences` 到新 profile 启动后，实测 10 条 cookie **全被 Chrome 删掉**（解不开的 v20 会被清除）。macOS 的 cookie 密钥在钥匙串、同用户可复用，所以上游 README 里"复制 Default 目录"的流程在 macOS 成立、在 Windows 不成立。
3. 非管理员账号改不了 `HKLM\SOFTWARE\Policies\Google\Chrome`（`HKCU` 那个键访问被拒），所以没法用企业策略放开默认 profile 调试。

---

## 七、新人外测暴露的"跑起来但不是要做的事"（v1.8.2 本地补丁 3）

一个只读公开仓库、在干净沙盒里从零跑的 agent 交了 24 条缺口（2 Blocker + 13 Major + 9 Minor）。执行层是结实的——它真实收藏了 7 人、回滚 2 次、过了 2 批审核、出了 xlsx；问题全在**入门层**，补丁 3 已修，留档备查：

| 症状 | 真实原因 | 现在的做法 |
|---|---|---|
| 文档照做但走不到第一张卡 | ①`github.com:443` 时通时不通（实测同一台机器 40 分钟内两种结果）；②受管终端里 `& chrome.exe` 起的实例，命令一结束就被 Job Object 带走，9333 随即消失；③默认 `judge.py` 在真实卡上 `0 PASS` | 文档给「官方 / `gh-proxy.com` / codeload zip」三路径；给 `start-detached.ps1` 脱离启动命令；Step 0 明确写「默认口径依赖起止日期，真实卡多数没有日期，请改写口径」 |
| `cdp.mjs state` 登录成功仍报 `login:false` | 旧判据在**推荐帧**里找「退出登录」文本，而该文本不在那里 | 改按「顶层 DOM + URL `/web/user/` + cookie `wt2=`」判定，并打印 `loginDetail` |
| 想换页发现没有命令 | `cdp.mjs` 只有 state/cards/shot/eval/…，没有 navigate，而文档写「打开推荐页」 | 新增 `node scripts/cdp.mjs navigate <url>` |
| 当天收藏到顶后最后一批永远结不清 | 接受审批被排在配额/停线检查**之后**，且必须再跑一次会收藏的采集才能接受 | 新增 `--accept-only`（不连浏览器、不再收藏）；不带它时启动先接受再检查配额 |
| 接受审批时"顺手"又收藏了一个人 | 接受只能靠下一次采集触发 | 同上：`--accept-only` 是唯一不产生新收藏的接受路径 |
| 回滚冷启动第一次必失败 | 收藏牛人页有懒加载/就绪延迟，旧实现找帧后立刻匹配 | 回滚前 25×1.2s 就绪轮询，未命中改为最后汇总打印 |
| 回滚后账本还记着、下次又被送审 | 回滚只清 `known_fav`，没有回退 `state.favorites`、没清 `pendingRecords`/`passes.jsonl` | 回滚成功同步回退计数并删除对应记录，台账不再虚报收藏事件 |
| 核对收藏数总是对不上 | 收藏牛人页懒加载（10→18）且混着账号历史（18 条里 13 条是历史） | `favcapture.mjs` 输出 `this_round` / `historical_count`，文档明确「别拿总条数当成绩」 |
| 台账跑完落在奇怪的地方 / 没有 xlsx | `--out` 默认是 cwd；xlsx 需要 openpyxl | `--out` 默认 `$BOSS_WORK`；缺库时打印明确修法；时间统一转本地并标注时区 |
| 声称"收藏顺序按判定排序"但实际按页面顺序 | changelog 已写、代码仍 `for (i...)` 按 DOM 顺序 | 主循环改 `domIndex` → `queue`，排序真的生效 |
## 八、"别在精选页收藏 / 别用带星号的名字"（v1.8.2 本地补丁 4）

| 现象 | 真实原因 | 现在的做法 |
|---|---|---|
| 「精选」页也能读到卡片，但一开聊就提示要用「搜索畅聊卡」 | 精选是另一套富集卡片，开聊动作是付费资源（畅聊卡），和推荐流的「收藏」不是一回事 | config.batch.tabs 里的「精选」被忽略并 WARN；运行中 .tab-item.curr 是「精选」或页面出现「精选优质牛人」提示 → 整轮 SKIP 精选页（实测精选页 .candidate-card-wrap = 0，卡在选卡阶段空转） |
| 收藏/审核记录里全是「李**／杨**／姚**」这种加密带星号的名字 | ① 精选页的卡片名就是掩码；② 判定器 judge.py 按隐私规则把姓名统一打码，跟页面无关 | 推荐流卡片本来就有真实姓名（div.name，实测「吴嫔／谭荣康／钟嘉保」）；收藏成功写 `real_names.json`（card_id → 真实姓名），审核包带 `name_real`，台账「姓名」列优先真实姓名，--rollback 也支持传 card_id 自动换名。卡片姓名仍带 * 的候选 → 开卡前 SKIP 掩码姓名，不收藏（连姓名都核对不了的人，审核和回滚都对不上账） |

要点：**「带星号」不是页面在加密，是判定器在打码**；但精选页确实两种都有（掩码 + 付费开聊），所以两处都要挡。
## 九、为什么不做「随机点击」防封（v1.8.2 本地补丁 5）

| 想法 / 现象 | 真实情况 | 现在的做法 |
|---|---|---|
| 「加点随机点击，就不像机器人了」 | 这个页面随机落点可能正好是「打招呼」「联系Ta」「搜索畅聊卡（付费开聊）」——点中就是对外发消息或扣付费资源，比被封号更先出问题；而且无意义的点击在行为模型里是噪声，不是人 | 不做随机点击；只做节奏抖动 + 停顿 |
| 「改改节奏/鼠标轨迹就能绕过风控」 | 反爬检测的是 **CDP 通道本身**（`Runtime.enable` 的副作用），在 JS 层之上；`navigator.webdriver`、插件列表这类 JS 伪装对 CDP 检测无效（公开研究：scraping-wiki 的 cdp-detection；Patchright / undetected-playwright / nodriver / Camoufox 都是去改控制层而不是改页面） | 承认 CDP 可被识别；靠**慢**和**少**降低触发概率，不承诺不被识别 |
| 抖动会不会把节奏拖到跑不完 | 抖动只在 `[base×(1−JITTER), base×(1+JITTER)]`，结果再被硬下限夹紧；`--pacing-selftest` 可核对 | `JITTER_PCT=0.25`（默认）；要固定周期设 0 |

要点：**节奏抖动是「别让机器周期精确到毫秒」，不是「骗过风控」**。真正的降险手段是少跑、人工抽检、用不心疼的账号。
## 十、批量模式：「收一个就审」与自动取消收藏（**仅批量模式**）

> 这一节整节只适用于「先收藏、后审核」的批量模式（`REVIEW_EVERY`）。**默认流程是先审后点**，被拒的人根本没被收藏，不需要回滚——别把两套机制串成一个。

| 现象 | 真因 | 处理 |
|---|---|---|
| 设了 `REVIEW_EVERY=1` 还是 5 人一批 | 只设了 env 没生效 / 写成了别的名字 | `REVIEW_EVERY`（env）或 config `batch.reviewEvery`；启动日志会打 `reviewEvery 1` 与 `NOTE: reviewEvery=1 —— 每收藏 1 人就停轮送审`；>5 只 WARN 并按 5 |
| 接受审批后日志报 `FATAL 无法连接 Chrome…` exit 2 | 旧实现的自动回滚直接调 `connect()`，它自己会 `process.exit(2)`，`try/catch` 抓不到 | 已修：回滚前先 `cdpReachable()` 探端口；连不上就写 `rollback_queue.json` + `exit 42`，下次启动 `flushRollbackQueue()` 重试 |
| 审批 accepted 了，但被拒的人还留在收藏里 | `AUTO_ROLLBACK_REJECTED=0`，或浏览器不在线导致被推迟 | 看日志 `auto-rollback:` 与 `rollback_queue.json`；手工补 `node scripts/scan-favorite.mjs --rollback "真实姓名"` |
| 同一批反复要求审批 | `review_ok_N.json` 的 `digest` 与 `review_batch_N.json` 不一致，或 ap∪rj 没覆盖全部候选 | 用 `--batch` 生成的 digest 原样填；ap 与 rj 必须恰好覆盖全部候选、不重叠 |
| 想只接受不采集 | 旧版接受夹在采集主流程里 | `--accept-only`：无浏览器、不产生新收藏；`FAV_DRY_RUN=1` 时不会消费审批 |

## 十一、「先审后点」还是「批量模式」——最容易被搞混的一对（本地补丁 8）

这两件事**同一时间只会发生一件**，混用就会出现「我让他收藏前自动检查，skill 里却在每 5 个人自动审核」这种前后矛盾。对照表：

| | 先审后点（默认） | 批量模式（可选） |
|---|---|---|
| 谁决定 | agent 逐张判 | 人/agent 按批审 `review_batch_N.json` |
| 触发开关 | `--soft-review` 或 `SOFT_REVIEW=1` | `REVIEW_EVERY=N`（仅此模式生效） |
| 审核时机 | **点收藏之前** | 收藏之后 |
| 交接文件 | 脚本写 `soft_pack.json` → agent 写 `soft_ok.json` | 脚本写 `review_batch_N.json` → 人写 `review_ok_N.json` |
| 被拒结果 | 没收藏，关详情页看下一张；**不需要回滚** | 已收藏，需 `--rollback`（或 `AUTO_ROLLBACK_REJECTED=1` 自动取消） |
| 超时 | `SOFT_TIMEOUT_MIN`（默认 15 分钟）→ `exit 44`，绝不擅自收藏 | 无超时概念，等人写 `review_ok_N.json` |

常见误用与后果：

| 现象 | 真因 | 处理 |
|---|---|---|
| 加了 `--soft-review` 却还在等 `review_batch_N.json` | 两套审核机制串了：先审后点模式下**不会**产生批次文件 | 先审后点看 `soft_pack.json`/`soft_ok.json`；批量模式才看 `review_batch_*` |
| 用户只提了硬条件，脚本却停下来等软审 | 自己多加 `--soft-review` | 用户没提软条件 → 不加该参数，纯脚本跑完 |
| `SOFT_TIMEOUT … exit 44` 后收藏栏多了一个人 | 超时被当成「同意」 | 不会：超时按未通过处理并退出；若真多了人，是别的原因（查 `decisions.jsonl`） |
| 软审文件写了不生效 | `card_id` 与 `soft_pack.json` 不一致（脚本删除过一次后重写包） | `soft_ok.json` 的 `card_id` 必须与当前 `soft_pack.json` 完全一致；也可写 `all:true` 一次性放行 |

**岗位轮转与「每岗看多少张」**（`SCAN_PER_JOB`，默认 100，是**看**的张数不是收藏数）：

| 现象 | 真因 | 处理 |
|---|---|---|
| 只跑第一个岗位就结束 | 旧版本来源只有 tab | 现在来源是岗位下拉（`.job-selecter-wrap`）：每个岗位看到 `SCAN_PER_JOB` 张或连续 3 次没新卡就换下一个；Chrome 线 `maxJobs=20`，ego 线 `maxJobs` 由参数给 |
| 明明有卡片却一直 `NO_FAV_CONTROL` | 岗位状态是「待」（未发布）→ 推荐流 `jobid=null` → 详情页只有「打开职位」，没有收藏按钮 | 这是账号侧状态，不是脚本 bug；脚本记录跳过、**不点「打开职位」**（点了会真的发布岗位）。要收藏必须先把岗位发布/在招 |
| 每次刷新后岗位都变回第一个 | 页面自身行为：`Page.navigate`/重载后岗位选择恢复第一项 | 脚本每次 `selectSource` 都重新选岗位并在开卡前核对标签（`.ui-dropmenu-label`） |
| 两个岗位都跑完但没收藏到人 | `target` 已满足，或全都 `NO_FAV_CONTROL` | 看 `round-summary.json` 的 `jobs[].screened/faved` 与 `noFav`；岗位在招后才可能真收藏 |