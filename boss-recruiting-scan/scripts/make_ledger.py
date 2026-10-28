#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_ledger.py — 生成候选台账 xlsx + md（openpyxl 可选）

用法：
  python3 make_ledger.py --work /tmp/boss --out ./ --title 招聘筛人台账-20261027

读取（存在才读）：
  <work>/strict3v2_ok.json      判定器 PASS（name 已掩码、含 card_id）
  <work>/passes.jsonl           收藏成功累积记录
  <work>/fav15.jsonl            收藏流水（favorited / failed）
  <work>/review_batch_*.json    审核批次
  <work>/review_ok_*.json       审核结论（approved/rejected）
  <work>/known_fav.json         当前收藏（判断"已收藏/已回滚"）
  <work>/rejected.json          被拒名单（判断"已拒绝"）
  <work>/rollbacks.jsonl        回滚事件（判断"已回滚"）
  <work>/strict3v2_all.json     全部候选（用于「已回滚」标记与排序）
  <work>/ledger_config.json     可选：{"c1":"条件1(月)","c2":"条件2","c3":"条件3(月)"}
输出：
  <out>/<title>.xlsx            sheet：候选人总表 / 收藏记录 / 审核批次 / 说明
  <out>/<title>.md              摘要
"""
import argparse
import glob
import json
import os
import tempfile
from datetime import datetime, timezone

# 默认工作目录：macOS/Linux 仍是 /tmp/boss；Windows 用 %TEMP%\boss（与 scan-favorite.mjs 一致）
DEFAULT_WORK = os.path.join(tempfile.gettempdir(), 'boss') if os.name == 'nt' else '/tmp/boss'


def local_ts(v):
    """把 JSON 里的 UTC ISO 时间串转成本机本地时间显示（台账列标「本地时间」）。

    以前直接把 UTC 原串塞进台账/日志，和本地时间列摆在一起会对不上（审计缺口 D23）。
    """
    if not v:
        return ''
    try:
        s = str(v).replace('Z', '+00:00')
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone().strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return str(v)

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font
    HAVE_OPENPYXL = True
except ImportError:  # 没装 openpyxl 时退化为 md-only，不静默失败
    HAVE_OPENPYXL = False


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def load_jsonl(path):
    rows = []
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except Exception:
                        pass
    except Exception:
        pass
    return rows


def key_of(x):
    """card_id 或 姓名|年龄"""
    if x.get('card_id'):
        return x['card_id']
    if x.get('name') is not None and x.get('age') is not None:
        return '%s|%s' % (x.get('name'), x.get('age'))
    return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', default=os.environ.get('BOSS_WORK') or DEFAULT_WORK)
    # 默认输出到工作目录（BOSS_WORK），不再默默写进当前目录（审计缺口 D21）
    ap.add_argument('--out', default=None)
    ap.add_argument('--title', default='招聘筛人台账-' + datetime.now().strftime('%Y%m%d'))
    args = ap.parse_args()
    if not args.out:
        args.out = os.environ.get('BOSS_WORK') or DEFAULT_WORK
    os.makedirs(args.out, exist_ok=True)

    # 口径列名（换口径后可用 ledger_config.json 覆盖，避免贴错标签）
    labels = {'c1': '条件1(月)', 'c2': '条件2', 'c3': '条件3(月)'}
    labels.update(load_json(os.path.join(args.work, 'ledger_config.json'), {}) or {})

    # ---- 通过名单：judge PASS 合并 passes.jsonl（收藏成功累积），按 card_id 去重
    merged = {}
    for x in load_jsonl(os.path.join(args.work, 'passes.jsonl')):
        if x.get('card_id'):
            merged[x['card_id']] = x
    for x in load_json(os.path.join(args.work, 'strict3v2_ok.json'), []) or []:
        if x.get('card_id'):
            merged[x['card_id']] = {**merged.get(x['card_id'], {}), **x}
    ok = list(merged.values())

    # ---- 收藏状态：known_fav / rejected
    known = set(load_json(os.path.join(args.work, 'known_fav.json'), []) or [])
    known_map = load_json(os.path.join(args.work, 'known_fav_map.json'), {}) or {}
    known |= {v for v in known_map.values()}
    rollback_keys = set()
    rollback_ids = set()
    for r in load_jsonl(os.path.join(args.work, 'rollbacks.jsonl')):
        if r.get('key'):
            rollback_keys.add(str(r['key']))
        if r.get('card_id'):
            rollback_ids.add(str(r['card_id']))

    rejected = set()
    rejected_rows = load_json(os.path.join(args.work, 'rejected.json'), []) or []
    for r in rejected_rows:
        rejected.add(r.get('card_id'))
        if r.get('name') is not None and r.get('age') is not None:
            rejected.add('%s|%s' % (r.get('name'), r.get('age')))

    # ---- 审核结论
    verdict = {}
    for p in sorted(glob.glob(os.path.join(args.work, 'review_ok_*.json'))):
        d = load_json(p, {}) or {}
        for cid in d.get('approved_card_ids', []) or []:
            verdict[cid] = 'approved'
        for cid in d.get('rejected_card_ids', []) or []:
            verdict[cid] = 'rejected'
    batch_rows = []
    for p in sorted(glob.glob(os.path.join(args.work, 'review_batch_*.json'))):
        d = load_json(p, {}) or {}
        if not d:
            continue
        n = d.get('batch')
        rj = []
        ap = []
        okp = load_json(os.path.join(args.work, 'review_ok_%s.json' % n), {}) or {}
        ap = okp.get('approved_card_ids', []) or []
        rj = okp.get('rejected_card_ids', []) or []
        batch_rows.append({'batch': n, 'declared': d.get('declared'),
                           'candidates': len(d.get('candidates', []) or []),
                           'approved': len(ap), 'rejected': len(rj),
                           'status': ('已审核' if okp else '待审核')})

    def status(x):
        cid = x.get('card_id') or ''
        na = '%s|%s' % (x.get('name'), x.get('age'))
        if na in rejected or verdict.get(cid) == 'rejected':
            return '已拒绝'
        if cid in rollback_ids or na in rollback_keys:
            return '已回滚'
        if na in known or cid in known:
            return '已收藏'
        return '未收藏'

    def city_rank(x):
        v = x.get('city_rank')
        if isinstance(v, int):
            return v
        return 9

    def rank_label(x):
        v = city_rank(x)
        return {0: '城市优先', 1: '不限/可接受', 2: '其它城市'}.get(v, '未知')

    def review(x):
        return {'approved': '通过', 'rejected': '拒绝'}.get(verdict.get(x.get('card_id')), '未审')

    favs = [r for r in load_jsonl(os.path.join(args.work, 'fav15.jsonl')) if r.get('action') == 'favorited']
    # 排序：城市优先级（city_rank 升序，判定器输出）→ 条件 3 月数降序 → 姓名
    ok_sorted = sorted(ok, key=lambda y: (city_rank(y), -(y.get('c3_months') or 0), str(y.get('name') or '')))

    md = ['# %s' % args.title, '',
          '- 生成时间：%s（本地时间）' % datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %Z'),
          '- 判定通过：**%d** 人；收藏成功事件：**%d**；审核批次：%d' % (len(ok), len(favs), len(batch_rows)),
          '- 列名：%s / %s / %s（可用 ledger_config.json 覆盖）' % (labels['c1'], labels['c2'], labels['c3']), '']

    if HAVE_OPENPYXL:
        wb = Workbook()
        bold = Font(bold=True)
        ws = wb.active
        ws.title = '候选人总表'
        ws.append(['序号', 'card_id', '姓名', '年龄', '期望城市', '城市优先级', '期望岗位',
                   labels['c1'], labels['c2'], labels['c3'], '收藏状态', '审核结果'])
        for c in ws[1]:
            c.font = bold
        for i, x in enumerate(ok_sorted, 1):
            ws.append([i, x.get('card_id'), x.get('name'), x.get('age'), x.get('city'), rank_label(x), x.get('want'),
                       x.get('c1_months'), x.get('c2_level'), x.get('c3_months'), status(x), review(x)])
        for w, c in zip([6, 18, 10, 6, 10, 12, 18, 10, 10, 12, 12, 10], 'ABCDEFGHIJKL'):
            ws.column_dimensions[c].width = w

        ws2 = wb.create_sheet('收藏记录')
        ws2.append(['时间(本地)', 'card_id', '姓名(掩码)', '年龄', '结果', 'state'])
        for c in ws2[1]:
            c.font = bold
        for r in favs:
            ws2.append([local_ts(r.get('ts')), r.get('card_id'), r.get('name_masked'), r.get('age'), r.get('action'), r.get('state')])

        ws3 = wb.create_sheet('审核批次')
        ws3.append(['批次', '声明人数', '候选数', 'approved', 'rejected', '状态'])
        for c in ws3[1]:
            c.font = bold
        for b in batch_rows:
            ws3.append([b['batch'], b['declared'], b['candidates'], b['approved'], b['rejected'], b['status']])

        ws4 = wb.create_sheet('说明')
        for n in [
            labels.get('note') or '口径以 judge 输出为准（可用 JUDGE_PY 替换判定器；列名/说明可用 ledger_config.json 覆盖）。',
            '城市优先级来自判定器输出的 city_rank（0=优先、1=不限/可接受、2=其它），排序规则：city_rank 升序 → 条件3月数降序。',
            '姓名已掩码；不收录手机号/微信/邮箱等联系方式；本台账不含完整卡片原文。',
            '收藏状态来自 known_fav.json / rejected.json / rollbacks.jsonl：已收藏 / 已拒绝 / 已回滚 / 未收藏。',
            '审核：每 5 个收藏生成 review_batch_N.json，审核后写 review_ok_N.json；被拒者应 --rollback。',
        ]:
            ws4.append([n])

        out_xlsx = os.path.join(args.out, args.title + '.xlsx')
        wb.save(out_xlsx)
        os.chmod(out_xlsx, 0o600)
        print('saved', out_xlsx)

    md.append('## 候选人总表（%d）' % len(ok))
    md.append('| # | card_id | 姓名 | 年龄 | 期望城市 | 城市优先级 | 期望岗位 | %s | %s | %s | 收藏状态 | 审核结果 |' % (labels['c1'], labels['c2'], labels['c3']))
    md.append('|---|---|---|---|---|---|---|---|---|---|---|---|')
    for i, x in enumerate(ok_sorted, 1):
        md.append('| %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
            i, x.get('card_id'), x.get('name'), x.get('age'), x.get('city'), rank_label(x), x.get('want'),
            x.get('c1_months'), x.get('c2_level'), x.get('c3_months'), status(x), review(x)))
    md.append('')
    md.append('## 收藏记录（%d）' % len(favs))
    for r in favs:
        md.append('- %s %s %s岁 %s' % (local_ts(r.get('ts')), r.get('name_masked'), r.get('age'), r.get('action')))
    md.append('')
    md.append('## 审核批次（%d）' % len(batch_rows))
    for b in batch_rows:
        md.append('- batch %s：候选 %s，approved %s，rejected %s，%s' % (b['batch'], b['candidates'], b['approved'], b['rejected'], b['status']))

    out_md = os.path.join(args.out, args.title + '.md')
    with open(out_md, 'w', encoding='utf-8') as f:
        f.write('\n'.join(md) + '\n')
    os.chmod(out_md, 0o600)
    print('saved', out_md)
    if not HAVE_OPENPYXL:
        print('WARN: 当前解释器没有 openpyxl，只生成了 .md，没有 .xlsx。')
        print('      修法：换一个装了 openpyxl 的解释器重跑（例：pip install openpyxl，或用 DSH 自带 python），')
        print('      或显式指定：PYTHON_BIN=<带 openpyxl 的 python> 后重跑同一命令。')


if __name__ == '__main__':
    main()
