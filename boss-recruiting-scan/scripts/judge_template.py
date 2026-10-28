#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""judge_template.py — 换口径判定器模板（可复制后改 CONFIG / judge_card）

三条硬条件只是默认实现。换岗位/换条件时**不改流程**，只换判定层：

    cp scripts/judge_template.py my_judge.py
    # 改 CONFIG 与 judge_card()
    JUDGE_PY=$PWD/my_judge.py node scripts/scan-favorite.mjs 150 5

契约（scan-favorite.mjs 会做 schema 校验，不满足即 FATAL exit 2）
    输入：argv[1] = JSONL，每行 {"card": "<卡片 innerText>"}
    输出到 $BOSS_WORK（默认 /tmp/boss）：
        strict3v2_ok.json       必需：达标者数组
        strict3v2_near.json     可选
        strict3v2_all.json      可选
        strict3v2_summary.json  可选
    每条记录必需字段：
        card_id(16hex) / name(掩码，禁止空) / age(int) / city(str) / want(str) /
        verdict('PASS') / c1_months(int) / c2_level('A'|'B'|'none') /
        c2_evidence(list) / c3_months(int) / c3_segments(list)
    退出码：0 成功；非 0 会被 scan 视为判定失败并停止。
    空输入 / 全部卡片解析失败 → stderr 报错 + exit 2（不能静默写空数组）。
    隐私：name 必须掩码；不写手机号/微信/邮箱；产物 600。

自检：python3 my_judge.py --selftest
"""
import hashlib
import json
import os
import re
import sys
import tempfile

# 默认输出目录：macOS/Linux 仍是 /tmp/boss；Windows 用 %TEMP%\boss（与 scan-favorite.mjs 一致）
DEFAULT_WORK = os.path.join(tempfile.gettempdir(), 'boss') if os.name == 'nt' else '/tmp/boss'
BASE = os.environ.get('BOSS_WORK') or DEFAULT_WORK
OUTS = ['strict3v2_ok.json', 'strict3v2_near.json', 'strict3v2_all.json', 'strict3v2_summary.json']

# =============================== 口径配置（改这里） ===============================
CONFIG = {
    'c1': {
        'label': '目标职能经历',
        'role_kw': r'行政|助理|总助|运营|HRBP|项目经理|咨询',
        'company_kw': r'',
        'exclude_kw': r'实习|兼职|外包|派遣',
        'min_months': 24,
    },
    # 本模板：c2 仅 A 级通过；B 级只作证据展示
    'c2': {
        'label': '硬证据',
        'a_kw': r'专八|雅思\s*[789](?:\.\d)?|托福\s*1[01]\d|CATTI|TESOL|硕士',
        'b_kw': r'英语流利|可作为工作语言|熟练使用',
    },
    'c3': {
        'label': '目标大厂/行业经历',
        # mode='months' 按月数门槛；mode='evidence' 只要命中 evidence_kw 即算（布尔型条件）
        'mode': 'months',
        'evidence_kw': r'',
        'company_kw': r'美团|百度|华为|中联重科|毕马威|字节|阿里',
        'role_kw': r'经理|主管|专员|顾问|分析师|工程师',
        'exclude_kw': r'实习|外包|驻场|派遣',
        'min_months': 24,
    },
    # 城市：rank_only=true 只影响排序；false 则非 prefer 城市直接判失败
    'city': {'prefer': ['长沙'], 'acceptable': [], 'rank_only': True},
}

ACT = set('热搜 刚刚活跃 今日活跃 3日内活跃 本周活跃 本月活跃 2周内活跃 在线 新牛人 面议 招聘中 高学历 牛人 猎头 离职 在职'.split())
DATE = re.compile(r'(?:19|20)\d\d(?:[.\-/]\d{1,2})?|至今')
CH_NAME = re.compile(r'[\u4e00-\u9fffA-Za-z·]{1,12}(?:\*\*)?')
# 姓名候选的严格规则：掩码名（王**）/英文名/2-4 个汉字；并用停用词挡住「硕士/期望/城市」等
NAME_MASKED = re.compile(r'^[\u4e00-\u9fff]{1,3}\*{1,2}$')
NAME_CN = re.compile(r'^[\u4e00-\u9fff]{2,4}$')
NAME_EN = re.compile(r"^[A-Za-z][A-Za-z.\-·']{1,20}$")
STOP = set('硕士 本科 博士 大专 高中 中专 期望 优势 工作 经验 现任 曾任 学历 年龄 招聘 在职 离职 面议 项目经理 管理 培训 运营 销售 技术 财务 行政 市场 产品 研发 设计 采购 客服 助理 专员 经理 主管 总监 兼职 全职 实习 城市'.split())
CITY_STOP = set('长沙 北京 上海 深圳 广州 杭州 武汉 成都 南京 西安 苏州 天津 重庆 郑州 合肥 福州 厦门 南昌 昆明 贵阳 南宁 海口 三亚 沈阳 大连 哈尔滨 长春 石家庄 太原 济南 青岛 乌鲁木齐 兰州 西宁 银川 拉萨 呼和浩特 香港 澳门 台北 深圳 东莞 佛山 珠海 无锡 宁波 温州 常州 徐州 烟台 潍坊 唐山 保定 洛阳 襄阳 宜昌 株洲 湘潭 衡阳 岳阳 常德 郴州'.split())


def _pick_name(tokens):
    for t in tokens:
        if not t or t in ACT or t in STOP or t in CITY_STOP:
            continue
        if re.search(r'\d', t):
            continue
        if NAME_MASKED.fullmatch(t) or NAME_EN.fullmatch(t) or NAME_CN.fullmatch(t):
            return t
    return ''


class JudgeError(Exception):
    pass


def now_month():
    ym = os.environ.get('JUDGE_NOW')          # YYYY-MM：回归测试用
    if ym and re.fullmatch(r'\d{4}-\d{2}', ym):
        return int(ym[:4]), int(ym[5:])
    import datetime
    t = datetime.date.today()
    return t.year, t.month


def months_between(start, end):
    y1, m1 = int(start[:4]), (int(start[5:7]) if len(start) >= 7 else 1)
    if end in (None, '', '至今'):
        y2, m2 = now_month()
    else:
        y2, m2 = int(end[:4]), (int(end[5:7]) if len(end) >= 7 else 12)
    return max(0, (y2 - y1) * 12 + (m2 - m1))


def card_id(card):
    return hashlib.sha1(card.encode('utf-8')).hexdigest()[:16]


def mask_name(name):
    name = (name or '').strip()
    if not name:
        return ''
    return name if '*' in name else name[0] + '**'


def parse_basic(card):
    """返回 (name, age, city, want)。name 解析不出来时返回 ''，由调用方跳过该卡。"""
    toks = card.split()
    age_idx, age = None, None
    for i, t in enumerate(toks):
        m = re.fullmatch(r'(\d{1,3})岁', t)
        if m:
            age_idx, age = i, int(m.group(1))
            break
    name = ''
    if age_idx is not None:
        name = _pick_name(reversed(toks[max(0, age_idx - 4):age_idx]))
        if not name:
            name = _pick_name(toks[age_idx + 1:age_idx + 4])
    # 注意：不要在前几个 token 里瞎猜姓名（「硕士」「期望」也会命中），解析不到就交给调用方跳过
    # 期望段：城市 + 最多 2 个岗位 token（遇到其它标签/日期就停）
    LABELS = {'职位', '院校', '最近关注', '近14天', '优势', '工作经历', '教育', '标签', '期望', '沟通'}
    city, want_toks = '', []
    for i, t in enumerate(toks):
        if t == '期望' and i + 1 < len(toks):
            city = toks[i + 1]
            j = i + 2
            while j < len(toks) and len(want_toks) < 2:
                nt = toks[j]
                if nt in LABELS or DATE.fullmatch(nt) or re.fullmatch(r'\d{1,3}岁', nt):
                    break
                want_toks.append(nt); j += 1
            break
    return name, age, city, ' '.join(want_toks)


def city_rank(city):
    """0=prefer，1=acceptable/空/不限，2=其它。rank_only=true 时只用于排序，不淘汰。"""
    c = (city or '').strip()
    if c in (CONFIG['city'].get('prefer') or []):
        return 0
    if c in (CONFIG['city'].get('acceptable') or []) or c in ('', '不限'):
        return 1
    return 2


def parse_jobs(card):
    """「起 止 公司 岗位 起 止 …」→ [{start,end,months,text}]；「至今」按当前月算。"""
    hits = list(DATE.finditer(card))
    jobs = []
    i = 0
    while i + 1 < len(hits):
        a, b = hits[i], hits[i + 1]
        nxt = hits[i + 2].start() if i + 2 < len(hits) else len(card)
        blob = card[b.end():nxt].strip()
        jobs.append({'start': a.group(0), 'end': b.group(0),
                     'months': months_between(a.group(0), b.group(0)), 'text': blob[:120]})
        i += 2
    return jobs


def matched(card, rule):
    """返回 (总月数, 命中分段列表)"""
    total, segs = 0, []
    for j in parse_jobs(card):
        blob = j['text']
        if rule.get('role_kw') and not re.search(rule['role_kw'], blob):
            continue
        if rule.get('company_kw') and not re.search(rule['company_kw'], blob):
            continue
        if rule.get('exclude_kw') and re.search(rule['exclude_kw'], blob):
            continue
        total += j['months']
        segs.append({'start': j['start'], 'end': j['end'], 'months': j['months'], 'text': blob})
    return total, segs


def judge_card(card):
    """← 换口径时主要改这个函数。返回记录 dict（达标）或 None（不达标）。"""
    name, age, city, want = parse_basic(card)
    if not name or age is None:           # 缺姓名/年龄：无法可靠去重、审核与回滚，跳过
        return None
    c1_months, c1_segs = matched(card, CONFIG['c1'])
    c3_months, c3_segs = matched(card, CONFIG['c3'])
    a = [m.group(0) for m in re.finditer(CONFIG['c2']['a_kw'], card)]
    b = [m.group(0) for m in re.finditer(CONFIG['c2']['b_kw'], card)]
    c2_level = 'A' if a else ('B' if b else 'none')
    c2_evidence = ([{'level': 'A', 'text': a[0]}] if a else []) + ([{'level': 'B', 'text': b[0]}] if b else [])
    city_ok = city in CONFIG['city']['prefer']
    if not CONFIG['city']['rank_only'] and not city_ok:
        return None
    c3_rule = CONFIG['c3']
    if c3_rule.get('mode') == 'evidence' and c3_rule.get('evidence_kw'):
        ev = re.findall(c3_rule['evidence_kw'], card)
        c3_pass = bool(ev)
        c3_months = sum(j['months'] for j in parse_jobs(card) if re.search(c3_rule['evidence_kw'], j['text']))
        if ev:
            c3_segs = c3_segs + [{'start': '', 'end': '', 'months': 0, 'text': 'evidence:' + ev[0]}]
    else:
        c3_pass = c3_months >= c3_rule['min_months']
    ok = (c1_months >= CONFIG['c1']['min_months'] and c3_pass and c2_level == 'A')
    if not ok:
        return None
    flags = [] if city_ok else ['city_not_preferred']
    return {'card_id': card_id(card), 'name': mask_name(name), 'age': age, 'city': city, 'want': want,
            'verdict': 'PASS',
            'c1_months': int(c1_months), 'c1_segments': c1_segs,
            'c2_level': c2_level, 'c2_evidence': c2_evidence[:8],
            'c3_months': int(c3_months), 'c3_segments': c3_segs,
            'city_rank': city_rank(city),
            'flags': flags}


def dump(p, obj):
    os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
    fd = os.open(p, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


CONTRACT = {'card_id': str, 'name': str, 'age': int, 'city': str, 'want': str, 'verdict': str,
            'c1_months': int, 'c1_segments': list, 'c2_level': str, 'c2_evidence': list,
            'c3_months': int, 'c3_segments': list}


def validate(rec):
    for k, t in CONTRACT.items():
        if k not in rec or not isinstance(rec[k], t):
            raise JudgeError('字段 %s 缺失或类型错误（期望 %s）' % (k, t.__name__))
    if rec['verdict'] != 'PASS':
        raise JudgeError('verdict 必须为 PASS')
    if not rec['name'].strip():
        raise JudgeError('name 不能为空')
    if '*' not in rec['name']:
        raise JudgeError('name 必须掩码（如「张**」）')
    if not re.fullmatch(r'[0-9a-f]{16}', rec['card_id']):
        raise JudgeError('card_id 必须为 16 位 hex')


def main():
    if '--selftest' in sys.argv[1:]:
        return selftest()
    if len(sys.argv) < 2:
        print('usage: judge_template.py <cards.jsonl> | --selftest', file=sys.stderr)
        return 2
    rows = []
    with open(sys.argv[1], encoding='utf-8') as f:
        for line in f:
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except Exception as e:
                    print('WARN 跳过坏行:', e, file=sys.stderr)
    cards = [r.get('card') or '' for r in rows]
    cards = [c for c in cards if c.strip()]
    if not cards:
        print('FATAL 没有有效卡片（输入为空或 card 字段全空）——判定器不会写空结果', file=sys.stderr)
        return 2
    ok, allrows, seen, skipped_no_age, skipped_no_name = [], [], set(), 0, 0
    for card in cards:
        cid = card_id(card)
        if cid in seen:
            continue
        seen.add(cid)
        name, age, city, want = parse_basic(card)
        if not name:
            skipped_no_name += 1
            continue
        rec = judge_card(card)
        base = {'card_id': cid, 'name': mask_name(name), 'age': age, 'city': city, 'want': want}
        allrows.append({**base, 'verdict': 'PASS' if rec else 'FAIL'})
        if rec is None:
            if age is None:
                skipped_no_age += 1
            continue
        try:
            validate(rec)
        except JudgeError as e:
            print('FATAL 判定器输出不合契约：%s（card_id=%s）' % (e, cid), file=sys.stderr)
            return 2
        ok.append(rec)
    if skipped_no_age:
        print('WARN %d 张卡缺年龄，已跳过（无法可靠去重/审核）' % skipped_no_age, file=sys.stderr)
    if skipped_no_name:
        print('WARN %d 张卡缺姓名，已跳过（无法可靠去重/回滚）' % skipped_no_name, file=sys.stderr)
    payloads = [ok, [], allrows, {'cards': len(allrows), 'pass': len(ok),
                                  'skipped_no_age': skipped_no_age, 'skipped_no_name': skipped_no_name}]
    for name, obj in zip(OUTS, payloads):
        dump(os.path.join(BASE, name), obj)
    print('judge_template: cards=%d pass=%d -> %s' % (len(allrows), len(ok), os.path.join(BASE, OUTS[0])))
    return 0


# =============================== 自检（冒烟） ===============================
SMOKE = [
    ('PASS', '20-30K 张** 本周活跃 32岁 8年 硕士 离职-随时到岗 期望 长沙 项目经理 优势 英语专八，可作为工作语言。 '
             '2020.05 2024.08 中联重科股份有限公司 项目经理 2016 2018 曼彻斯特大学 硕士 2012 2016 中南大学 本科'),
    ('FAIL', '12-18K 李** 刚刚活跃 29岁 5年 本科 离职-随时到岗 期望 长沙 行政专员 优势 性格开朗。 '
             '2023.01 2024.06 某公司 行政专员 2018 2022 湖南大学 本科'),
    ('PASS', '32岁 王** 本周活跃 20-30K 硕士 期望 长沙 项目经理 2021.01 2025.01 中联重科股份有限公司 项目经理 专八'),
    ('FAIL', '面议 赵** 刚刚活跃 硕士 期望 长沙 项目经理 2021.01 2025.01 中联重科股份有限公司 项目经理 专八'),
    ('FAIL', '20-30K 本周活跃 32岁 8年 硕士 期望 长沙 项目经理 2021.01 2025.01 中联重科股份有限公司 项目经理 专八'),  # 缺姓名
]


def selftest():
    bad = 0
    for want, card in SMOKE:
        rec = judge_card(card)
        got = 'PASS' if rec else 'FAIL'
        if rec is not None:
            try:
                validate(rec)
            except JudgeError as e:
                print('FAIL 契约错误 %s | %s' % (e, card[:40]))
                bad += 1
                continue
        if got != want:
            bad += 1
            print('FAIL expect %s got %s | %s' % (want, got, card[:40]))
        else:
            print('ok   %s' % want)
    print('\nselftest: %d/%d passed' % (len(SMOKE) - bad, len(SMOKE)))
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
