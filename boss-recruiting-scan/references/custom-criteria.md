# 换口径指南 —— 不是「留学 + 英语 + 名企职能」这三点时怎么做

本 skill 只有**判定层**和具体口径绑定；扫描、开浮层、点收藏、审核闸门、台账、防封配额都与口径无关。所以换条件 ≠ 重写流程。

## 先分清三层

| 层 | 文件 | 换口径时 |
|---|---|---|
| 流程层（CDP/收藏/闸门/台账/配额） | `scripts/scan-favorite.mjs`、`cdp.mjs`、`known-cleanup.mjs`、`make_ledger.py` | **不动** |
| 判定层（谁达标） | `scripts/judge.py`（默认实现）或你自己的判定器 | **只改这里** |
| 口径文档 | `references/criteria.md` | 同步写清楚「算/不算」 |

## 三条路，按改动量从小到大

### A. 只换规则参数（最常见，10 分钟）

复制模板，改 `CONFIG` 和 `judge_card()`：

```bash
cp scripts/judge_template.py my_judge.py
# 编辑 my_judge.py：CONFIG 里的关键词/排除词/门槛月数/城市偏好；
#                  judge_card() 里的判定组合（任意条件的与/或/权重）
JUDGE_PY=$PWD/my_judge.py node scripts/scan-favorite.mjs 150 5
```

`judge_template.py` 开箱能跑（自检 `python3 scripts/judge_template.py --selftest` → **5/5**，覆盖「年龄在首 token」「缺年龄」两种边界），它做了这些事：
- 解析卡片：姓名/年龄/城市/期望岗位（`parse_basic`）、工作段落与起止年月（`parse_jobs`）、月数（`months_between`，支持「至今」）
- 样例口径：c1 目标职能经历 ≥24 月、c2 硬证据（**仅 A 级算通过，B 级只作证据展示**）、c3 名企职能 ≥24 月、城市默认只排序（`rank_only=true`；改 `false` 后非 `prefer` 城市直接判失败，已在模板实现）
- 输出契约要求的 4 个 JSON，姓名掩码，产物 600 权限

改口径常见动作：
- **换岗位**：改 `CONFIG['c1']['role_kw']` 与 `['c3']['role_kw']`（如 `后端|Java|服务端`）
- **换门槛**：`min_months`（18/24/36），同时更新 `references/criteria.md`
- **换证书**：`CONFIG['c2']['a_kw']`（如 `PMP|软考|CFA|CPA`）
- **换名企范围**：`CONFIG['c3']['company_kw']`；若要「行业」而非「公司名单」，写行业词（如 `银行|证券|保险`）
- **加条件**：在 `judge_card()` 里加判断；记录到 `flags` 便于台账解释
- **城市策略**：`city.prefer`；`rank_only=true` 只影响排序并写 `flags: city_not_preferred`；`rank_only=false` 时非 `prefer` 城市**直接判失败**（已实现）

### B. 完全自定义判定逻辑

任何语言都行，只要你能让命令行跑它，并遵守契约：

```bash
JUDGE_PY=/path/my_judge.py          # 默认用 python3 执行
node scripts/scan-favorite.mjs 150 5

# 非 Python 判定器：必须显式指定解释器（否则 .js/.sh 会被 python3 解析而报 SyntaxError）
PYTHON_BIN=node JUDGE_PY=$PWD/my_judge.js node scripts/scan-favorite.mjs 150 5
PYTHON_BIN=bash JUDGE_PY=$PWD/my_judge.sh node scripts/scan-favorite.mjs 150 5
```

**输入**：`argv[1]` 指向一个 JSONL 临时文件，每行：

```json
{"card": "20-30K 张** 本周活跃 32岁 8年 硕士 期望 长沙 项目经理 …"}
```

**输出**：写到 `$BOSS_WORK/`（默认 `/tmp/boss`）：

| 文件 | 必需 | 说明 |
|---|---|---|
| `strict3v2_ok.json` | ✅ | 达标者数组；**缺此文件 scan 直接 FATAL exit 2** |
| `strict3v2_near.json` | 可选 | 差一点的（人工复核用） |
| `strict3v2_all.json` | 可选 | 全部卡片的判定摘要 |
| `strict3v2_summary.json` | 可选 | 统计 |

`strict3v2_ok.json` 每条至少含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `card_id` | str(16hex) | `sha1(card)[:16]`，用于去重/回滚对账 |
| `name` | str | **必须是「前缀+`**`」的掩码**（如 `张**`；`张*`/`**` 会 FATAL），否则 schema FATAL；卡片解析不出姓名时请直接跳过该卡（模板即如此） |
| `age` | int | 必填；卡片缺年龄时判定器应**跳过该卡**（不产出 PASS），否则 scan 的 schema 校验会 FATAL |
| `city` | str | 期望城市 |
| `want` | str | 期望岗位 |
| `verdict` | str | `PASS` |
| `c1_months` | int | 条件 1 的累计月数（整数月开始，台账/审核依赖） |
| `c2_level` | str | `A` / `B` / `none` |
| `c2_evidence` | list | `[{"level":"A","text":"…"}]`，最多 8 条 |
| `c3_months` | int | 条件 3 的累计月数 |
| `c3_segments` | list | 必填（可为 `[]`）：`[{"start":"2020.03","end":"至今","months":67,"text":"…"}]`；`c1_segments` 同构（模板已自动填） |

**退出码**：0 成功；非 0 → scan 会 `FATAL judge failed` 并停。判定器崩溃 **不要**静默返回空数组（会被当成「今天没人合格」）。

**底线**：判定器只读卡片文本，不联网、不导出联系方式、不写非掩码姓名；空输入必须非 0 退出（不能静默写空数组）。

**自检**：`node scripts/scan-favorite.mjs --selfcheck-judge` 会验证6 条契约（c3 门槛由判定器决定、缺输出即停、stale 输出被清理、schema 校验生效），无需浏览器。

### C. 不是「筛人」而是别的任务

流程骨架仍可复用：`cdp.mjs`（连调试端口、找帧、点击、截图）、`scan-favorite.mjs` 的闸门/配额、`make_ledger.py` 的台账。但**不要**套本 skill 的铁律去干别的事（那些规则是围绕「只收藏、零外联」的账号安全边界）。新任务另建 skill，复用脚本即可。

## 两个示例

### 例 1：换「Java 后端 + 大厂 + 985」

```python
CONFIG = {
    'c1': {'label': '后端开发经历', 'role_kw': r'后端|Java|服务端|研发',
           'exclude_kw': r'实习|外包|派遣', 'min_months': 24},
    # a_kw 只放「能证明英语/学历硬门槛」的词，别把「本科」当 985 证据
    'c2': {'label': '学历/证书硬证据', 'a_kw': r'985|211|软考|PMP|英语六级|雅思', 'b_kw': r'熟练|精通'},
    'c3': {'label': '大厂经历', 'company_kw': r'阿里|腾讯|字节|美团|华为|百度',
           'role_kw': r'工程师|开发|架构师', 'exclude_kw': r'实习|外包', 'min_months': 24},
    'city': {'prefer': ['长沙', '深圳'], 'rank_only': False},
}

def judge_card(card):
    """985 是硬条件：先套模板的解析/月数，再单独校验 985。"""
    name, age, city, want = parse_basic(card)           # 模板自带
    if age is None or not re.search(r'985', card):
        return None
    c1, c1_segs = matched(card, CONFIG['c1'])           # 模板自带
    c3, c3_segs = matched(card, CONFIG['c3'])
    if c1 < 24 or c3 < 24 or not re.search(CONFIG['c2']['a_kw'], card):
        return None
    return {'card_id': card_id(card), 'name': mask_name(name), 'age': age, 'city': city, 'want': want,
            'verdict': 'PASS', 'c1_months': c1, 'c1_segments': c1_segs,
            'c2_level': 'A', 'c2_evidence': [{'level': 'A', 'text': '985'}],
            'c3_months': c3, 'c3_segments': c3_segs, 'flags': []}
```

### 例 2：两条件或五条件（伪代码示意，仅说明组合方式）

条件数量不固定——在 `judge_card()` 里把各条件算成布尔/月数后自行组合：

```python
def judge_card(card):
    name, age, city, want = parse_basic(card)          # 模板函数
    c1, _ = matched(card, CONFIG['c1'])                # 月数
    c3, _ = matched(card, CONFIG['c3'])
    eng = bool(re.search(CONFIG['c2']['a_kw'], card))
    if c1 >= 24 and eng:                               # 两条件
        return {..., 'c1_months': c1, 'c3_months': 0, 'c3_segments': []}
    # 五条件同理：全部 and 起来，或按权重打分 ≥ 阈值；返回字段必须齐全
```

## 换完口径后必做

1. `python3 my_judge.py --selftest`（若沿用模板自检）
2. `FAV_DRY_RUN=1 node scripts/scan-favorite.mjs 2 1` 跑 1 轮，确认输出里有 `DRY would favorite 张** 32 card_id …`
3. 人工抽 3–5 张卡对账（判对/判错各记一条，写回 `references/criteria.md`）
4. 再正式跑；台账里的「通过名单」以判定器输出为准，出现分歧先修判定器再收藏

### 城市优先（v1.8.2）

- `CONFIG['city'] = {'prefer': ['长沙'], 'acceptable': ['不限'], 'rank_only': True}`
- 判定器可在每条 PASS 记录里输出 **`city_rank`**：`0`=prefer、`1`=acceptable/空/不限、`2`=其它城市。
- `rank_only=True` 时 city_rank 只影响**排序**（不淘汰）；`rank_only=False` 时非 prefer 直接判失败。
- 排序规则（流程层实现）：收藏顺序与台账均按 `city_rank` 升序 → `c3_months` 降序。
- 若判定器不输出 `city_rank`，流程层按「未知」排在最后（9），不报错。

### 布尔型条件（v1.8.2）

有些条件不是「月数」而是「有没有」——例如「至少 1 项平台工具」：

```python
CONFIG['c3'] = {'mode': 'evidence', 'evidence_kw': r'Amazon|Shopee|TikTok\s*Shop|Shopify|Google\s*Ads|Meta\s*Ads|eBay|AliExpress'}
```

`mode='evidence'` 时：命中即算满足，`c3_months` 输出命中分段的月数合计（无命中为 0），证据片段写入 `c3_segments`。
