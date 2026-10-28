# boss-recruiting-scan（v1.8.2 + 本地补丁 3）

> 已知边界：候选人姓名在 BOSS 端是掩码（`张**`），**同姓+同年龄**的两个人可能互相误伤（回滚会清同名键、拒绝会跳过同名同岁）。遇到这种情况请用真实姓名回滚并在台账里人工核对；判定器已改为按卡片文本去重（不再按 姓名/年龄/期望 合并）。
 — 5 分钟上手

在 BOSS 直聘**招聘端**「推荐牛人」页按你的口径批量筛人，只点「收藏」、零外联，每 5 人停轮交审，最后出 xlsx 台账。流程与节奏是固定的（防封），**不要改**。

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
| Python 3 | 台账要 xlsx 时需要 openpyxl；系统 `python3` 没有就用 `/Users/wangjie/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3` |
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
FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 2 5

# ④ 正式跑：≤150 轮，收藏满 5 人自动停轮交审（exit 42）
node scripts/scan-favorite.mjs 150 5

# ⑤ 审核：脚本输出 review_batch_1.json；审核后写 review_ok_1.json（见下）
#    被拒的人先回滚：node scripts/scan-favorite.mjs --rollback "真实姓名"
#    只想接受审批（不再收藏人、不连浏览器）：node scripts/scan-favorite.mjs --accept-only

# ⑥ 出台账（用带 openpyxl 的解释器；不传 --out 就写到 $BOSS_WORK）
export PY=/Users/wangjie/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
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
| `node scripts/scan-favorite.mjs 150 5` | 主流程（轮数 / 收藏目标） |
| `node scripts/scan-favorite.mjs --batch` | 不足 5 人时手动结批（写 review_batch，exit 42） |
| `node scripts/scan-favorite.mjs --accept-only` | 只接受 `review_ok_N.json`（不连浏览器、不再收藏任何人） |
| `node scripts/scan-favorite.mjs --rollback "真实姓名"` | 取消收藏 + 清理 known_fav + 回退账本（拒绝 card_id；全未命中时按 §4.1 用 known-cleanup） |
| `node scripts/known-cleanup.mjs "$BOSS_WORK" "张**\|32" "张伟 32岁"` | 手工取消收藏后清理 known 残留 |
| `node scripts/scan-favorite.mjs --judge-run cards.jsonl` | 只跑判定（不连浏览器，会覆盖 BOSS_WORK 的判定输出） |
| `node scripts/scan-favorite.mjs --selfcheck-judge` | 判定器契约回归 6/6（**不要**改成 `reviewEvery` 去调闸门频率，铁律固定每 5 人） |
| `FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 2 1` | 联调：只判定不收藏 |
| `node scripts/favcapture.mjs` | 抓收藏列表，区分 `this_round`（本轮）与 `historical_count`（历史） |
| `python3 scripts/make_ledger.py --work $BOSS_WORK` | 台账 xlsx + md（`--out` 默认就是 `$BOSS_WORK`） |

## 4. 退出码

| 码 | 含义 |
|---|---|
| 0 | 正常结束（达标/空跑） |
| 2 | 前置条件/契约错误（CDP 连不上、judge 失败或输出不合 schema、配额/TARGET 非法等）——看 stdout 的 `FATAL` 行 |
| 1 | 用法错误 / dry-run 拒绝执行某动作（如 `FAV_DRY_RUN=1 --rollback`）、`--judge-run` 文件不存在（v1.8.1 起改为 exit 2） |
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

## 5. 数据与隐私

- 姓名只落掩码（`张**`）；不采集手机号/微信/邮箱；不落完整卡片原文。
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
