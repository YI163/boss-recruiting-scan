# boss-recruiting-scan（v1.8.2 + 本地补丁 9）

## 一句话用法（零基础，但要求必须说）

把仓库地址丢给 AI 助手（DSH / Claude Code / Cursor 等），一句话里带**要什么人**：

> 把 https://github.com/YI163/boss-recruiting-scan 装成 skill，帮我筛人：深圳、兼职、Java 后端，本科计算机相关，一年以上经验。先跑两轮。

**要求不能省**：本 skill 按你给的口径判人，不说要求就只能用默认口径，而默认口径是模板示例，真实卡片上常常 0 PASS。要求请覆盖：岗位方向、城市（只要/优先）、全职或兼职与薪资、经验年限与学历专业、硬性加分项。说漏的 AI 会反问，并先给你「口径卡 + 判定器 diff」确认后再跑。

之后你只需：① 在它打开的 Chrome 里登录招聘端（选「我要招聘」）；② 每张卡点收藏**之前**由 AI 先看一遍（只有你说了软条件并加 `--soft-review` 才这样；默认是纯脚本、收藏前不停）；③ 看台账。

> 已知边界：推荐流卡片上是**真实姓名**（`.name`），判定器输出的是掩码（`张**`）；身份以「真实姓名 + card_id」为准，收藏成功会把真实姓名写进 `$BOSS_WORK/real_names.json`。**同名同年龄**的两个人仍可能互相误伤（回滚会清同名键、拒绝会跳过同名同岁），遇到请按 card_id 逐个核对。

## 5 分钟上手

1. 起一个带调试端口的 Chrome（§1），在里面登录招聘端、选「我要招聘」；
2. 换成你的口径（§2 的 `JUDGE_PY`），先 `FAV_DRY_RUN=1` 干跑看判定是否符合预期；
3. 正式跑 `node scripts/scan-favorite.mjs 5`（5 = 今天打算收藏几个人），跑完出台账（§2 第 ⑥ 步）。

## 审核的三种状态（默认什么都不做，两种可选模式互斥）

| 方式 | 何时用 | 怎么开 | 审核发生在 | 被拒怎么处理 |
|---|---|---|---|---|
| **纯脚本**（默认） | 用户没提软条件、也没说要「回头再挑」 | 不加任何开关 | 不审 | — |
| **先审后点**（显式开启） | 用户提了「软条件」、要求你逐张看 | `--soft-review`（`SOFT_TIMEOUT_MIN` 默认 15 分钟） | 点收藏**之前**，每张都停 | 不收藏，直接关详情看下一张；超时按不通过处理，`exit 44` |
| **批量模式**（显式开启） | 明确说「先收藏、回头再挑」 | `BATCH_REVIEW=1` + `REVIEW_EVERY=N`（默认 5） | 收藏之后，每累计 N 人停轮 | `AUTO_ROLLBACK_REJECTED=1`（默认）自动取消收藏并回退账本 |

**用户没提软条件 → 不要加 `--soft-review`**，默认就是纯脚本，不产生任何批次文件；想「先收藏、回头再挑」才加 `BATCH_REVIEW=1`。**切模式不会补送审**：`pendingRecords` 只在批量模式累计，之前纯脚本/先审后点收藏过的人不会被翻出来重审。

先审后点的软审文件（脚本写、agent 读）：

```json
// $BOSS_WORK/soft_pack.json  —— 脚本写：card_id / name / age / card_text / dialog_text / ask
// $BOSS_WORK/soft_ok.json    —— agent 写：{"card_id":"<同上>","approved":true,"reason":"..."}
```

`approved=false` 只关详情页、不收藏；**超时不等于同意**：`SOFT_TIMEOUT_MIN`（默认 15 分钟）内没结论就 `exit 44`，绝不擅自收藏。日志关键字：`SOFT_REVIEW_REQUIRED` / `SOFT_APPROVE` / `SOFT_REJECT` / `SOFT_TIMEOUT`。

批量模式（仅此模式用 `BATCH_REVIEW` / `REVIEW_EVERY` / `AUTO_ROLLBACK_REJECTED`；与 `--soft-review` 互斥）：

```bash
BATCH_REVIEW=1 REVIEW_EVERY=1 node scripts/scan-favorite.mjs 5    # 收一个就停轮送审
node scripts/scan-favorite.mjs --batch             # 不足 N 人手动结批
node scripts/scan-favorite.mjs --accept-only       # 只接受 review_ok_N.json：无浏览器、不产生新收藏
```

**被拒的会自动取消收藏**（`AUTO_ROLLBACK_REJECTED=1` 默认开）：接受审批时对被拒者点「取消收藏」，并回退 `state.favorites`/`sinceBatch`/`pendingRecords`/`passes.jsonl`/`known_fav`。浏览器不在线不会硬失败——写 `rollback_queue.json` 并 `exit 42`，下次启动先重试。设 `AUTO_ROLLBACK_REJECTED=0` 则恢复手工 `--rollback`。

## 岗位轮转与「每岗看多少张」（SCAN_PER_JOB）

`SCAN_PER_JOB`（默认 **100**，小于 5 会被夹到 5）是**看**的张数，不是收藏数，也不是轮次。达到就换下一个来源：

- **Chrome 线**：来源 = 岗位下拉里的每个岗位（`.job-selecter-wrap`）；读不到岗位才退回 tab（推荐/最新）。
- **ego 线**：同样是岗位下拉，跑完岗位下拉里所有可见岗位即结束（`maxJobs` 默认 20，是上限、不代表只有两个岗位）。
- 岗位「待」/未发布时推荐流 `jobid=null`，详情页只有「打开职位」、**没有收藏按钮**：脚本记 `NO_FAV_CONTROL` 跳过，**不会去点「打开职位」**（那会真的把岗位发出去）。
- 每次导航/刷新后岗位会跳回第一个，脚本在开卡前会核对岗位标签；跨岗位时重选。

```bash
SCAN_PER_JOB=30 node scripts/scan-favorite.mjs 5    # 每个岗位看 30 张
```

在 BOSS 直聘**招聘端**「推荐牛人」页按你的口径批量筛人，只点「收藏」、零外联，按 `SCAN_PER_JOB` 轮岗位、按上面的审核方式交审，最后出 xlsx 台账。流程与节奏是固定的（防封），**不要改**。

> ⚠️ **封号风险，先看这条**：本 skill 用真实浏览器操作真实账号，平台协议普遍限制自动化 / 批量 / 脚本化操作，**可能被限流、功能受限甚至封号**。请用**有权处置、丢了不心疼**的账号（不要主账号、不要公司主账号）；本项目**不提供也不允许**任何风控绕过手段（代理池、指纹伪装、验证码识别、账号池、并发多开），节奏与配额的下限是为降低风险写的，**不能为了跑快而放宽**。本项目也**不做「随机点击 / 轨迹伪装」**：随机坐标会点到「打招呼」「联系Ta」「搜索畅聊卡（付费）」，既破坏零外联又可能产生真实费用；降低机械感靠节奏抖动（`JITTER_PCT`，默认 ±25%，永不低于下限），不是乱点。候选人数据属个人信息，合规由使用者自行负责。完整免责声明见仓库根 `README.md` 的「风险与免责声明」。

> 详细规则看 `SKILL.md`；换岗位/换条件看 `references/custom-criteria.md`；白屏/卡住/点空的成因看 `references/troubleshooting.md`；Windows 环境看 `README-windows.md`；交接给同事看 `HANDOVER.md`。

## 拿到代码（国内网络三选一）

```bash
git clone https://github.com/YI163/boss-recruiting-scan.git                        # 官方（能连就用这个）
git clone https://gh-proxy.com/https://github.com/YI163/boss-recruiting-scan.git   # 镜像，git 可用（实测 3.4s）
curl -L -o skill.zip https://codeload.github.com/YI163/boss-recruiting-scan/zip/refs/heads/main   # 只取文件
```

镜像挂了换 `ghproxy.net`；长期只读镜像可在 Gitee「从 GitHub 导入」。clone 到任意目录都能直接 `node scripts/...` 跑；想被 skill 系统自动发现则放进 `~/.dsh/skills/`。**不需要 npm/pip 安装任何依赖。**

## 0. 环境（macOS，实测路径）

| 依赖 | 说明 |
|---|---|
| Node ≥ 22 | 可能不在 PATH：`/usr/bin/env node` 找不到时用 `$HOME/.dsh/node/bin/node`（先 `export PATH="$HOME/.dsh/node/bin:$PATH"`） |
| Python 3 | 台账要 xlsx 时需要 openpyxl；系统 `python3` 没有就换一个装了 openpyxl 的解释器（`pip install openpyxl`，或直接用你本机 DSH 自带的 python） |
| Chrome | 用**调试端口的副本实例**，不要动你正在用的窗口 |

> **默认判定器不是通用口径**：`judge.py` 内置「长沙优先 / 英语 A 级 / 教学或大厂经历月数」，依赖卡片里的起止日期；BOSS 推荐卡多数没有日期，真实卡上常 **0 PASS**（实测 14 张真卡 0 PASS）。第一次用请按 `scripts/judge_template.py` 改写口径，详见 `SKILL.md` 的 Step 0。

## 1. 起一个带调试端口的 Chrome（不碰主窗口）

```bash
# 0) 先看端口是否被占（被占就换 9334，并同步改 CDP_URL）
lsof -nP -iTCP:9333 -sTCP:LISTEN || true

# 1) 复制一份登录态（先退出 Chrome，避免锁文件）
mkdir -p ~/.boss-prof
# 重跑/刷新登录态时：先删旧副本，否则 macOS cp -R 会嵌套成 Default/Default
rm -rf ~/.boss-prof/Default
cp -R "$HOME/Library/Application Support/Google/Chrome/Default" ~/.boss-prof/Default
cp "$HOME/Library/Application Support/Google/Chrome/Local State" ~/.boss-prof/ 2>/dev/null || true

# 2) 用副本起 Chrome（macOS 绝对路径）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.boss-prof" \
  --remote-debugging-port=9333 \
  --no-first-run --no-default-browser-check \
  "https://www.zhipin.com/web/chat/recommend"
```

验证（必须看到 `"url": ".../web/chat/recommend"`）：

```bash
curl -s http://127.0.0.1:9333/json/list | head -20
node scripts/cdp.mjs state        # 应包含 /web/frame/recommend/ 帧
```

## 2. 首次运行（6 步）

```bash
export CDP_URL=http://127.0.0.1:9333
export BOSS_WORK=/tmp/boss          # 状态/名单/审核/台账都写这里
export PATH="$HOME/.dsh/node/bin:$PATH"

# ① 离线自检（不用浏览器）
node scripts/scan-favorite.mjs --selfcheck-judge      # 6/6
python3 scripts/judge.py --selftest                   # 12/12

# ② 页面里人工勾一次筛选（可选但强烈建议：命中率可翻数倍）
#    推荐页右上「筛选」→ 院校「留学」等 →「确定」；脚本每轮会自动重放上次筛选

# ③ dry-run：只判定、不点收藏
FAV_DRY_RUN=1 SCAN_PER_JOB=30 node scripts/scan-favorite.mjs 5

# ④ 正式跑：收藏目标 5 人；提了软条件就加 --soft-review（先审后点）
node scripts/scan-favorite.mjs 5

# ⑤ 审核：这一条只对批量模式（BATCH_REVIEW=1）成立——脚本输出 review_batch_1.json，审核后写 review_ok_1.json；纯脚本/先审后点模式没有这一步
#    批量模式下被拒的人需要回滚：node scripts/scan-favorite.mjs --rollback "真实姓名"
#    只想接受审批（不再收藏人、不连浏览器）：node scripts/scan-favorite.mjs --accept-only

# ⑥ 出台账（用带 openpyxl 的解释器；不传 --out 就写到 $BOSS_WORK）
export PY=/path/to/python-with-openpyxl    # 例：~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
"$PY" scripts/make_ledger.py --work "$BOSS_WORK" --title 招聘筛人台账-$(date +%Y%m%d)
```

审核文件格式（必须覆盖 **全部候选**，approved + rejected 不重叠）：

```json
{"batch":1,"digest":"<review_batch_1.json 里的 digest>","approved_card_ids":["..."],"rejected_card_ids":["..."]}
```

被拒者回滚**不会立刻**写名单：下一次 scan 接受审核时，才把这些 rejected 候选写进 `rejected.json`，之后永久跳过（不要按「回滚后立刻有 rejected.json」验收）。

## 3. 常用命令

| 命令 | 作用 |
|---|---|
| `node scripts/cdp.mjs state` / `cards` / `shot` | 诊断：帧结构 / 列表卡片 / 截图（`state` 里 `login`+`loginDetail` 才是登录判据） |
| `node scripts/cdp.mjs navigate "https://www.zhipin.com/web/chat/recommend"` | 换页（v1.8.2 本地补丁 3 新增） |
| `node scripts/scan-favorite.mjs 5` | 主流程（参数 = 收藏目标；提了软条件加 `--soft-review`；要批量模式加 `BATCH_REVIEW=1`） |
| `node scripts/scan-favorite.mjs --batch` | 不足 5 人时手动结批（写 review_batch，exit 42） |
| `node scripts/scan-favorite.mjs --accept-only` | 只接受 `review_ok_N.json`（不连浏览器、不再收藏任何人） |
| `node scripts/scan-favorite.mjs --rollback "真实姓名"` | 取消收藏 + 清理 known_fav + 回退账本（真实姓名或 card_id 都行；全未命中时按 §4.1 用 known-cleanup） |
| `node scripts/known-cleanup.mjs "$BOSS_WORK" "张**\|32" "张伟 32岁"` | 手工取消收藏后清理 known 残留 |
| `node scripts/scan-favorite.mjs --judge-run cards.jsonl` | 只跑判定（不连浏览器，会覆盖 BOSS_WORK 的判定输出） |
| `node scripts/scan-favorite.mjs --selfcheck-judge` | 判定器契约回归 6/6（只验判定器输出格式，与审核频率无关；审核方式看「审核的三种状态」一节） |
| `FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 1` | 联调：只判定不收藏 |
| `node scripts/favcapture.mjs` | 抓收藏列表，区分 `this_round`（本轮）与 `historical_count`（历史） |
| `python3 scripts/make_ledger.py --work $BOSS_WORK` | 台账 xlsx + md（`--out` 默认就是 `$BOSS_WORK`） |

## 4. 退出码

| 码 | 含义 |
|---|---|
| 0 | 正常结束（达标/空跑） |
| 1 | 未捕获异常兜底与用法错误：`main()`/`rollback()` 的 `.catch` 兜底、`--rollback` 没给参数、`FAV_DRY_RUN=1` 时拒绝回滚 |
| 2 | 脚本主动报错（多数带 `FATAL` 前缀）：config 解析失败、收藏目标不是正整数、未登录（`NOT_LOGGED_IN`）、CDP 连不上、judge/schema 失败、回滚全部未命中、`--judge-run` 文件不存在、配额触发 |
| 44 | 软审超时（`SOFT_TIMEOUT_MIN` 内没等到 `soft_ok.json`）——按「不通过」处理，绝不擅自收藏 |
| 42 | 到了审核闸门：先审 `review_batch_N.json`，写 `review_ok_N.json`，再继续 |

## 4.1 排障（新人最常卡的三处）

1. **`--rollback "姓名"` 报「全部未命中」，但 `known_fav` 里还有残留**（常见于你已在页面上手工取消了收藏）：
   ```bash
   node scripts/known-cleanup.mjs "$BOSS_WORK" "张**|32" "张伟 32岁"
   ```
   然后再跑 `--rollback "张伟"`；清理命令会同时删掉姓名键、掩码键和对应 card_id。
2. **审核写对了却一直 42**：先看 `REVIEW_PENDING` 的原因——digest 不一致 / 覆盖不全 / 字段非法，三种提示不同；`digest` 必须原样抄 `review_batch_N.json`。
3. **只开一个 BOSS 标签页**：脚本取第一个含 `zhipin` 的 page；开多个 BOSS tab 可能连错页面。
4. **白屏 / 一直卡着不动 / 收藏点了没反应**：这三类是本 skill 踩得最深的坑（反爬重建、SPA 重挂、浮层卡在 `v-leave`、魔法坐标点空），成因、判断方法与修法全在 [`references/troubleshooting.md`](references/troubleshooting.md)。

## 4.2 两条硬规则（本地补丁 4）

1. **不在「精选」页收藏**：「精选」的开聊要「搜索畅聊卡」（付费），卡片姓名也是加密掩码（`李**`）。脚本已做硬闸：`config.batch.tabs` 写「精选」会被忽略；选来源时命中「精选」→ 打 `SKIP_SOURCE 精选页` 跳过该来源（按 tab 采集时 `.tab-item.curr` 就是来源标签；两条路线现在都用岗位下拉，天然不含精选）。
2. **掩码姓名不收藏**：推荐流卡片上是真实姓名（`.name`），判定器输出的 `name` 是掩码。身份以「真实姓名 + card_id」为准；卡片姓名仍带 `*` 的候选直接跳过（`SKIP 掩码姓名`），否则审核/回滚都无法对账。收藏成功会写 `$BOSS_WORK/real_names.json`，审核包带 `name_real`，台账「姓名」列优先真实姓名；`--rollback` 也支持传 card_id（自动换成真实姓名）。

## 5. 数据与隐私

- 姓名：推荐流真实姓名（`.name`）与判定器掩码名并存，只落本机 `real_names.json`/台账；不采集手机号/微信/邮箱；不落完整卡片原文。
- 产物全部 `600`；`dump`/截图可能含完整页面，勿外发、用完即删。
- `BOSS_WORK` 目录建议单独隔离（如 `/tmp/boss`），不要把真实候选人数据提交到任何仓库。

## 6. 出问题先看这三处

1. **`FATAL 无法连接 Chrome 调试端口 …`** → Chrome 没带 `--remote-debugging-port=9333`，或 `CDP_URL` 不一致。
2. **`窗口最小化`** → CDP 点击无效、截图超时；脚本会尝试恢复正常窗口，仍失败就 `osascript -e 'tell application "Google Chrome" to activate'`。
3. **`REVIEW_PENDING batch=N`** → 上一批没审完：写 `review_ok_N.json`（全量覆盖）或 `--rollback` 被拒者后再跑。


## 台账自定义（v1.8.2）

`ledger_config.json`（放在 `$BOSS_WORK`）可覆盖列名与口径说明：

```json
{"c1":"跨境运营(月)","c2":"英语证据","c3":"平台工具(月)","note":"条件：跨境运营≥24月 + 英语硬证据 + 至少1项平台工具；深圳/广州优先"}
```

「候选人总表」新增「城市优先级」列（来自判定器 `city_rank`：0=优先 / 1=不限 / 2=其它），排序规则 = city_rank 升序 → 条件3月数降序；收藏状态区分 `已收藏 / 已拒绝 / 已回滚 / 未收藏`（已回滚来自 `rollbacks.jsonl`）。
