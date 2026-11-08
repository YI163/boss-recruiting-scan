# boss-recruiting-scan 交接说明（v1.8.2 + 本地补丁 8）

在 BOSS 直聘**招聘端**「推荐牛人」页按约定口径筛候选人并点「收藏」的通用 skill。
零外联：不发消息、不点「打招呼/联系Ta/搜索畅聊卡」，只有「收藏」一个动作。

> 数据说明：本包只含代码与文档，**不含任何真实候选人数据**。回归用例 `scripts/strict3_fixtures.json`
> 全部为合成用例（虚构姓名、虚构年龄/日期组合），仅用于 `judge.py --selftest` 校验规则。

## 1. 安装（二选一）
- 全局：`cp -R boss-recruiting-scan ~/.dsh/skills/`
- 项目内：`cp -R boss-recruiting-scan <你的工作目录>/.dsh/skills/`
装好后新开会话，技能列表里出现 `boss-recruiting-scan` 即成功（也可以直接说「用 boss-recruiting-scan 刷人」）。

## 2. 依赖
- Node ≥ 22（脚本用全局 WebSocket）
- Python 3（`judge.py` 判定；`make_ledger.py` 需要 openpyxl，没有则只出 md）
- Chrome（用**复制出来的 profile** 另起实例，不动主窗口）

## 3. 首次准备
**统一以 `README.md` 的「起 Chrome」为准**（先退出 Chrome → 复制 `Default` + `Local State` 到 `~/.boss-prof` → 带 `--remote-debugging-port=9333` 启动）。不要 rsync 整个 Chrome 目录（会把 `SingletonLock`/其它 profile 一起带进去，副本实例可能被判定为 profile 被占用）。重跑前先 `rm -rf ~/.boss-prof/Default` 再复制，否则 macOS `cp -R` 会嵌套成 `Default/Default`、登录态不刷新。
- 登录自己的 BOSS 账号，选好职位与城市
- **人工点一次「筛选」勾好条件**（如院校「留学」）→「确定」；脚本之后每轮自动重放，但不会替你勾
- 自检：`python3 scripts/judge.py --selftest` → 应为 `12/12 passed`
- 审核提交格式以 `README.md` 为准（`{batch,digest,approved_card_ids,rejected_card_ids}`）；`references/criteria.md` 只描述判断口径，不是提交文件格式

## 4. 跑起来
```bash
cd boss-recruiting-scan
export CDP_URL=http://127.0.0.1:9333 BOSS_WORK=/tmp/boss-<你的名字>   # 数据目录各自独立！

# 空转一轮（不点收藏，先确认判定正确）
FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 1

# 正式（默认先审后点：提了软条件要加 --soft-review；收藏目标 5 人）
node scripts/scan-favorite.mjs 5
```

**审核有三种状态，别混用**：默认是**纯脚本**（不逐张审、也不整批停，判定器过了就收藏）；提了软条件就加 `--soft-review`（先审后点）——脚本每张卡写 `soft_pack.json`、等 agent 写 `soft_ok.json`，通过才收藏，被拒**根本没收藏**、不需要回滚。
只有**批量模式**（`BATCH_REVIEW=1` + `REVIEW_EVERY`，默认 5）才是「先收藏、每 N 人停轮送审」：脚本写 `review_batch_N.json` 并 `exit 42`，审核方逐人核三条件写 `review_ok_N.json`（`approved_card_ids` + `rejected_card_ids` 必须覆盖该批全部候选，digest 与 batch 一致），被拒的人先撤回：`node scripts/scan-favorite.mjs --rollback "真实姓名"`（`AUTO_ROLLBACK_REJECTED=1` 默认会自动取消）。
不足 N 人想结批：`node scripts/scan-favorite.mjs --batch`；只接受审批不采集：`--accept-only`。

## 5. 台账
```bash
python3 scripts/make_ledger.py --work $BOSS_WORK --out . --title 招聘筛人台账-$(date +%Y%m%d)
```

## 6. 铁律（防封边界，不能放宽）
1. 零外联，只点「收藏」
2. 轮间隔 ≥15s、收藏间隔 ≥12s（env/config 只能更严）
3. 单日收藏 ≤60、轮次 ≤200、当日累计 ≤3h
4. 验证码/登录失效/操作频繁/失败率>50% → 立即停（写 STOP_TODAY，当天不再跑）
5. 不导出手机号/微信/邮箱；姓名落盘即掩码；产物 600
6. 窗口别最小化（最小化时点击无效、截图超时）

## 7. 常用环境变量
`CDP_URL`（默认 127.0.0.1:9333）、`BOSS_WORK`（默认 /tmp/boss）、`PYTHON_BIN`、`JUDGE_PY`、
`SKILL_CONFIG`（复制 config.example.json 为 config.json 后生效）、`SPACING`、`FAV_GAP`、
`FAV_DRY_RUN`、`APPLY_FILTER`（默认 1 重放筛选）、`FAV_OUT`、
`SCAN_PER_JOB`（默认 100，每个岗位看多少张，<5 夹到 5）、`SOFT_REVIEW`/`--soft-review`（先审后点）、`SOFT_TIMEOUT_MIN`（默认 15 分钟，超时 exit 44）、
`BATCH_REVIEW`（默认 0；批量模式总开关，与 `--soft-review` 互斥）、`REVIEW_EVERY`（默认 5，仅批量模式）、`AUTO_ROLLBACK_REJECTED`（默认 1，仅批量模式）、`JITTER_PCT`（默认 0.25）。


## 7.5 如果口径不是「留学 + 英语 + 名企职能」怎么办

流程层（扫描/开浮层/收藏/闸门/台账/配额）与口径无关，**只换判定层**：

1. **改参数**：`cp scripts/judge_template.py my_judge.py`，改里面的 `CONFIG`（每段条件的关键词、排除词、`min_months`、城市偏好）和 `judge_card()`，然后
   `JUDGE_PY=$PWD/my_judge.py node scripts/scan-favorite.mjs 5`
   模板自带卡片解析/日期月数/掩码/4 个输出，`python3 my_judge.py --selftest` → 5/5。
2. **自己写判定器**：任何语言（非 Python 需设 `PYTHON_BIN=node|bash`），遵守契约即可——输入 `argv[1]` 的 JSONL（每行 `{"card":"..."}`），输出 `$BOSS_WORK/strict3v2_ok.json`（必填，缺则 FATAL），必填字段 `card_id/name/age/city/want/verdict/c1_months/c1_segments/c2_level/c2_evidence（c2_level 非 `none` 时必填）/c3_months/c3_segments`；姓名必须掩码；空输入/崩溃要非 0 退出，**不要**静默返回空数组；scan 会做 schema 校验并清理旧输出。
3. 完整说明与示例见 `references/custom-criteria.md`。

换完口径先 `node scripts/scan-favorite.mjs --selfcheck-judge`（6/6）再 `FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 1` 试跑一轮，人工抽 3–5 张对账，再正式跑。

## 8. 排错
- `FATAL fetch failed` → Chrome 调试端口没起或 CDP_URL 错
- `overlay not opened` → 窗口最小化/页面未加载完；脚本会自动恢复窗口并重试
- 收藏点了没变 → 窗口不可见或坐标错；确认 `document.visibilityState==='visible'`
- 判定疑似漏人 → 改 `scripts/judge.py` 口径并跑 `--selftest`；不要改流程脚本

## 9. 已验证
- `judge.py --selftest` 12/12（合成用例）；4 个 .mjs `node --check` 通过
- 闸门：积压自动结批 / 部分批准拒绝 / 全覆盖接受；`--rollback` 不受停线锁定；回滚清理 card_id 后闸门闭环通过
- 5 轮独立只读审核（审核记录不随包分发）

## 10. 注意
自动化操作有平台风控风险，建议有人盯屏；账号、profile、BOSS_WORK 目录请按人隔离，不要共享。
