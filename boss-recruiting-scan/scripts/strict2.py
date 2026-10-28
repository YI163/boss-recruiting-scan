# -*- coding: utf-8 -*-
"""
strict2.py — BOSS「推荐牛人」三条件判定器 v2（对齐 /tmp/boss/review_protocol.md v1.0）

用法（默认读取 /tmp/boss/rec10.jsonl；Windows 下为 %TEMP%/boss/rec10.jsonl）：
  python3 strict2.py                       # 扫描 + 摘要 + 落盘
  python3 strict2.py /tmp/boss/rec10.jsonl
  python3 strict2.py --selftest            # 回归体检（11 个已知样本，必须全绿）
  python3 strict2.py --explain 张**        # 单/多人证据明细
  python3 strict2.py --only-teach          # 只看有教学段的人
  python3 strict2.py --include-training    # 把「培训序列」也计入条件3（供裁决，默认不计，见协议 §4.3）

落盘：
  /tmp/boss/strict2_all.json         全部去重人员分析（诊断用）
  /tmp/boss/strict2_ok.json          PASS 名单（make_batch.py 可直接消费）
  /tmp/boss/strict2_near.json        差一条的近失候选（2/3），供 captain 定向取证
  /tmp/boss/strict2_summary.json     汇总计数与口径版本

相对 strict.py 的修复（编号对应 rules_report.md）：
  P1 姓名解析：活跃标签补全（本月活跃/N日内活跃/N周内活跃/N月内活跃）、多 token 英文名、
     薪资/UI 前缀剔除、掩码名与截断头识别（name_parse_error）
  P2 尾部 UI token 泄漏：打招呼 / 查看更多 / 热搜牛人推荐 / 近14天你首次看到该牛人 /
     该牛人正在关注贵公司的职位 → 不再污染「岗位」字段
  P3 学历段识别改按「学位 token 全匹配」，真实岗位「高中教师」不再被当学历丢弃
  P4 时长：起止同月/年份-only/至今/end>NOW 截断/end<start 不计，逐段累加改为
     「区间并集」，重叠段不再重复累加；<3 个月的教学段不计（协议 §2-1e）
  P5 公司识别：剥离括号注释、子公司→集团归一、截断公司名前缀匹配、最长别名优先、
     银行/保险/证券/信托/基金 类别规则（FR-1）；教培/学校从条件3剔除
  P6 教学判定：教学主体 + 英语学科证据双条件；教研/助教/班主任/教务/课程顾问/
     教学管理/培训序列一律不算教学（协议 §2-1c/1d、§5）
  P7 大厂判定：非教培 + 职能序列 + ≥24 月 + 与教学不同集团（同集团段剔除后重算，
     不是整人淘汰）；培训序列默认剔除（协议 §4.3），可用 --include-training 复核
  P8 英语证据分级：A 级硬证据（专八/雅思托福分数/CATTI/TESOL/翻译硕士/口译/全英文/
     工作语言声明）才可过条件2；六级/专四/英语专业/留学/流利 降为 B 级弱证据（协议 §3）
  P9 数据完整性：无工作经历区、公司名截断、日期序列异常 → 打标不影响他人
"""
import json
import os
import re
import sys
import tempfile
import hashlib
from collections import Counter, OrderedDict

# 默认读写目录：macOS/Linux 仍是 /tmp/boss（与文档一致）；Windows 用 %TEMP%\boss
DEFAULT_WORK = os.path.join(tempfile.gettempdir(), 'boss') if os.name == 'nt' else '/tmp/boss'

NOW = (2026, 10)
NOW_MI = NOW[0] * 12 + (NOW[1] - 1)

# ---------------------------------------------------------------- 基础工具
def mi(y, m):
    """年月 → 绝对月序号"""
    return y * 12 + (m - 1)


def month_from_mi(x):
    return (x // 12, x % 12 + 1)


DATE_RE = re.compile(r'^(?:19|20)\d{2}(?:[.\-/]\d{1,2})?$')
YEAR_ONLY_RE = re.compile(r'^(?:19|20)\d{2}$')
AGE_RE = re.compile(r'^(\d{1,2})岁$')
SALARY_RE = re.compile(r'^(?:面议|\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*[Kk千万]|\d+(?:\.\d+)?\s*[Kk千万](?:以上|起)?|\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?[Kk千万]?)$')
ACT_RE = re.compile(r'^(?:刚刚活跃|今日活跃|昨日活跃|本周活跃|本月活跃|\d+日内活跃|\d+周内活跃|\d+月内活跃|在线|离线|新牛人|高学历|大厂|应届生)$')

DEGREE_TOKENS = {'本科', '硕士', '博士', '大专', '中专', '中技', '中专/中技', '高中', '初中', 'MBA', 'EMBA',
                 '学士', '研究生', '专科', '专升本', '非全日制本科', '非全日制硕士'}
DEGREE_RE = re.compile(r'^(?:本科|硕士|博士|大专|中专/中技|中专|中技|高中|初中|MBA|EMBA|学士|研究生|专科|专升本)$')

# 卡片尾部/头部 UI 噪声（不是简历内容）
UI_PHRASES = [
    '近14天你首次看到该牛人', '该牛人正在关注贵公司的职位', '搜索畅聊卡', '打招呼',
    '查看更多', '热搜牛人推荐', '致电客服', '名企大厂经历',
]
UI_TOKEN_SET = {'打招呼', '查看更多', '热搜牛人推荐', '致电客服', '名企大厂经历', '大厂', '高学历', '新牛人', '应届生'}
NONAME_TOKENS = {'面议', '期望', '最近关注', '优势', '在职-月内到岗', '离职-随时到岗', '在职-考虑机会',
                 '离职-看看机会', '在职-暂不考虑', '本科', '硕士', '博士', '大专', '高中', '中专', '中技',
                 '硕士', '本科', '10年以上', '在线', '离线'}
STATUS_RE = re.compile(r'^(?:在职|离职)-.*$')

def clean_card(text):
    t = re.sub(r'\s+', ' ', text).strip()
    for p in UI_PHRASES:
        t = t.replace(p, ' ')
    t = re.sub(r'\s+', ' ', t).strip()
    return t


# ---------------------------------------------------------------- 集团 / 白名单
# 协议附录 A.3 集团归一表（用于「同体」判定 + 子公司计入母公司）
GROUP_ALIASES = OrderedDict([
    # 教培集团（同体判定；条件3 永不认）
    ('新东方考研', '新东方'), ('新东方国际教育', '新东方'), ('新东方在线', '新东方'),
    ('新东方长沙学校', '新东方'), ('新东方', '新东方'),
    ('世纪好未来', '好未来'), ('学而思', '好未来'), ('好未来', '好未来'),
    ('环球雅思', '环球雅思'), ('环球教育', '环球教育'),
    ('美联英语', '美联英语'), ('华尔街英语', '华尔街英语'),
    ('昂立', '昂立'), ('文都', '文都'), ('中公', '中公'), ('华图', '华图'), ('高途', '高途'),
    ('猿辅导', '猿辅导'), ('作业帮', '作业帮'), ('粉笔', '粉笔'), ('启德', '启德'), ('新航道', '新航道'),
    ('学大教育', '学大'), ('英孚', '英孚'), ('培生', '培生'), ('久趣', '久趣'), ('小站', '小站'),
    ('沪江', '沪江'), ('朗阁', '朗阁'), ('瑞思', '瑞思'), ('贝乐', '贝乐'), ('精锐', '精锐'),
    ('新通', '新通'), ('金吉列', '金吉列'), ('澳际', '澳际'), ('博商', '博商'), ('羊驼教育', '羊驼教育'),
    ('洋葱教育', '洋葱教育'), ('乐小奇', '乐小奇'), ('威学教育', '威学'), ('超级学长', '超级学长'),
    ('泰能教育', '泰能教育'), ('西维外语', '西维外语'), ('海博英语', '海博英语'), ('思齐芙蓉', '思齐芙蓉'),
    # 互联网 / 科技
    ('腾讯课堂', '腾讯'), ('腾讯云', '腾讯'), ('腾云悦智', '腾讯'), ('腾讯', '腾讯'),
    ('字节跳动', '字节系'), ('抖音', '字节系'), ('飞书', '字节系'), ('字节', '字节系'),
    ('阿里巴巴', '阿里系'), ('蚂蚁集团', '阿里系'), ('蚂蚁', '阿里系'), ('淘宝', '阿里系'),
    ('天猫', '阿里系'), ('菜鸟', '阿里系'), ('数字马力', '阿里系'), ('浩鲸云', '阿里系'),
    ('阿里云', '阿里系'), ('阿里', '阿里系'),
    ('网易有道', '网易'), ('网易', '网易'),
    ('京东', '京东'), ('美团', '美团'), ('百度', '百度'), ('拼多多', '拼多多'), ('快手', '快手'),
    ('小红书', '小红书'), ('滴滴', '滴滴'), ('小米', '小米'), ('华为', '华为'), ('OPPO', 'OPPO'),
    ('vivo', 'vivo'), ('联想', '联想'), ('中兴', '中兴'), ('大疆', '大疆'), ('SHEIN', 'SHEIN'),
    ('希音', 'SHEIN'), ('Shopee', 'Shopee'), ('Lazada', 'Lazada'), ('携程', '携程'),
    # 制造 / 能源 / 消费
    ('三一重工', '三一重工'), ('中联重科', '中联重科'), ('蓝思', '蓝思'), ('中车', '中车'),
    ('中国中车', '中车'), ('比亚迪', '比亚迪'), ('蔚来', '蔚来'), ('理想汽车', '理想汽车'),
    ('小鹏', '小鹏'), ('宁德时代', '宁德时代'), ('海尔', '海尔'), ('美的', '美的'), ('格力', '格力'),
    ('国家电网', '国家电网'), ('中石油', '中石油'), ('中石化', '中石化'), ('中国石化', '中石化'),
    ('石化盈科', '中石化'), ('中建', '中建'), ('中国建筑', '中建'), ('中铁', '中铁'),
    ('中国中铁', '中铁'), ('中国铁建', '中铁'), ('中交', '中交'), ('中国交建', '中交'),
    ('中国移动', '中国移动'), ('中移', '中国移动'), ('中国电信', '中国电信'), ('中电信数智', '中国电信'),
    ('中国联通', '中国联通'), ('一汽', '一汽'), ('上汽', '上汽'), ('长城汽车', '长城汽车'),
    ('博世', '博世'), ('西门子', '西门子'), ('宝马', '宝马'), ('飞利浦', '飞利浦'),
    # 金融 / 专业服务
    ('普华永道', '普华永道'), ('德勤', '德勤'), ('安永', '安永'), ('毕马威', '毕马威'),
    ('中航', '中航'), ('中航工业', '中航'), ('中航集团', '中航'), ('中国航空工业', '中航'),
    ('中钢', '中钢'), ('中国中钢', '中钢'), ('安赛乐米塔尔', '安赛乐米塔尔'), ('ArcelorMittal', '安赛乐米塔尔'),
    ('埃森哲', '埃森哲'), ('麦肯锡', '麦肯锡'), ('BCG', 'BCG'), ('贝恩', '贝恩'),
    ('汇丰', '汇丰'), ('花旗', '花旗'), ('摩根', '摩根'), ('中金', '中金'), ('中信证券', '中信证券'),
    ('中信', '中信'), ('招商银行', '招商银行'), ('平安银行', '平安集团'), ('平安保险', '平安集团'),
    ('中国平安', '平安集团'), ('平安', '平安集团'), ('中国人寿', '中国人寿'), ('长沙银行', '长沙银行'),
    ('国药', '国药'), ('辉瑞', '辉瑞'), ('默沙东', '默沙东'), ('罗氏', '罗氏'), ('诺华', '诺华'),
    ('阿斯利康', '阿斯利康'), ('拜耳', '拜耳'), ('巴斯夫', '巴斯夫'),
    # 快消 / 零售 / 物流
    ('宝洁', '宝洁'), ('联合利华', '联合利华'), ('欧莱雅', '欧莱雅'), ('玛氏', '玛氏'), ('雀巢', '雀巢'),
    ('可口可乐', '可口可乐'), ('百事', '百事'), ('麦当劳', '麦当劳'), ('星巴克', '星巴克'),
    ('耐克', '耐克'), ('阿迪达斯', '阿迪达斯'), ('优衣库', '优衣库'), ('宜家', '宜家'),
    ('沃尔玛', '沃尔玛'), ('家乐福', '家乐福'), ('屈臣氏', '屈臣氏'), ('安克', 'Anker'), ('Anker', 'Anker'),
    ('宝尊', '宝尊'), ('DHL', 'DHL'), ('FedEx', 'FedEx'), ('UPS', 'UPS'), ('顺丰', '顺丰'),
    # 地产 / 物业
    ('万科', '万科'), ('碧桂园', '碧桂园'), ('保利', '保利'), ('中海', '中海'), ('龙湖物业', '龙湖'),
    ('龙湖', '龙湖'), ('华润置地', '华润'), ('华润', '华润'), ('招商蛇口', '招商蛇口'),
    ('绿城', '绿城'), ('金地', '金地'),
    # 外包/驻场（协议 §5-15：可计但 L2）
    ('中软国际', '中软国际'), ('软通动力', '软通动力'), ('博彦科技', '博彦科技'), ('中电金信', '中电金信'),
    ('神州数码', '神州数码'), ('东软', '东软'), ('德科', '德科'),
])
GROUP_ALIAS_KEYS = sorted(GROUP_ALIASES.keys(), key=len, reverse=True)

# 协议 A.2 白名单（strict.py BIG 的超集）：别名 → 集团
BIG_ALIASES = OrderedDict([
    # 互联网/科技
    ('腾讯', '腾讯'), ('阿里', '阿里系'), ('阿里巴巴', '阿里系'), ('蚂蚁', '阿里系'), ('淘宝', '阿里系'),
    ('菜鸟', '阿里系'), ('数字马力', '阿里系'), ('浩鲸云', '阿里系'), ('腾云悦智', '腾讯'),
    ('字节跳动', '字节系'), ('抖音', '字节系'), ('飞书', '字节系'), ('百度', '百度'), ('京东', '京东'),
    ('美团', '美团'), ('拼多多', '拼多多'), ('快手', '快手'), ('小红书', '小红书'), ('网易', '网易'),
    ('滴滴', '滴滴'), ('小米', '小米'), ('华为', '华为'), ('OPPO', 'OPPO'), ('vivo', 'vivo'),
    ('联想', '联想'), ('中兴', '中兴'), ('大疆', '大疆'), ('SHEIN', 'SHEIN'), ('希音', 'SHEIN'),
    ('Shopee', 'Shopee'), ('虾皮', 'Shopee'), ('Lazada', 'Lazada'), ('携程', '携程'), ('顺丰', '顺丰'),
    ('微软', '微软'), ('IBM', 'IBM'), ('英特尔', '英特尔'), ('英伟达', '英伟达'), ('三星', '三星'),
    ('索尼', '索尼'), ('松下', '松下'), ('戴尔', '戴尔'), ('惠普', '惠普'), ('高通', '高通'),
    # 外企/快消/零售
    ('宝洁', '宝洁'), ('联合利华', '联合利华'), ('欧莱雅', '欧莱雅'), ('玛氏', '玛氏'), ('雀巢', '雀巢'),
    ('可口可乐', '可口可乐'), ('百事', '百事'), ('麦当劳', '麦当劳'), ('星巴克', '星巴克'),
    ('耐克', '耐克'), ('阿迪达斯', '阿迪达斯'), ('优衣库', '优衣库'), ('宜家', '宜家'),
    ('沃尔玛', '沃尔玛'), ('家乐福', '家乐福'), ('屈臣氏', '屈臣氏'), ('Anker', 'Anker'), ('安克', 'Anker'),
    ('宝尊', '宝尊'), ('DHL', 'DHL'), ('FedEx', 'FedEx'), ('UPS', 'UPS'),
    # 金融 / 专业服务
    ('普华永道', '普华永道'), ('德勤', '德勤'), ('安永', '安永'), ('毕马威', '毕马威'),
    ('中航', '中航'), ('中航工业', '中航'), ('中航集团', '中航'), ('中国航空工业', '中航'),
    ('中钢', '中钢'), ('中国中钢', '中钢'), ('安赛乐米塔尔', '安赛乐米塔尔'), ('ArcelorMittal', '安赛乐米塔尔'),
    ('埃森哲', '埃森哲'), ('麦肯锡', '麦肯锡'), ('BCG', 'BCG'), ('贝恩', '贝恩'), ('汇丰', '汇丰'),
    ('花旗', '花旗'), ('摩根', '摩根'), ('中金', '中金'), ('中信证券', '中信证券'), ('中信', '中信'),
    ('招商银行', '招商银行'), ('平安', '平安集团'), ('中国人寿', '中国人寿'), ('长沙银行', '长沙银行'),
    ('兴业银行', '兴业银行'), ('浦发银行', '浦发银行'), ('民生银行', '民生银行'), ('光大银行', '光大银行'),
    ('广发银行', '广发银行'), ('华夏银行', '华夏银行'), ('北京银行', '北京银行'), ('三湘银行', '三湘银行'),
    ('长沙农商行', '长沙农商行'),
    # 制造/能源/医药
    ('宝马', '宝马'), ('博世', '博世'), ('西门子', '西门子'), ('三一重工', '三一重工'),
    ('中联重科', '中联重科'), ('蓝思', '蓝思'), ('中车', '中车'), ('中国中车', '中车'),
    ('比亚迪', '比亚迪'), ('蔚来', '蔚来'), ('理想汽车', '理想汽车'), ('小鹏', '小鹏'),
    ('宁德时代', '宁德时代'), ('海尔', '海尔'), ('美的', '美的'), ('格力', '格力'),
    ('国家电网', '国家电网'), ('中石油', '中石油'), ('中石化', '中石化'), ('中国石化', '中石化'),
    ('石化盈科', '中石化'), ('中建', '中建'), ('中国建筑', '中建'), ('中铁', '中铁'),
    ('中国铁建', '中铁'), ('中交', '中交'), ('中国移动', '中国移动'), ('中国电信', '中国电信'),
    ('中电信数智', '中国电信'), ('中国联通', '中国联通'), ('辉瑞', '辉瑞'), ('默沙东', '默沙东'),
    ('罗氏', '罗氏'), ('诺华', '诺华'), ('阿斯利康', '阿斯利康'), ('拜耳', '拜耳'), ('国药', '国药'),
    ('巴斯夫', '巴斯夫'), ('陶氏', '陶氏'), ('杜邦', '杜邦'), ('飞利浦', '飞利浦'), ('宝武', '宝武'),
    ('鞍钢', '鞍钢'), ('首钢', '首钢'), ('海螺', '海螺'), ('中远海运', '中远海运'), ('五矿', '五矿'),
    ('中国五矿', '五矿'), ('中铝', '中铝'), ('中国铝业', '中铝'), ('中化', '中化'), ('中国化学', '中国化学'),
    ('中核', '中核'), ('中广核', '中广核'), ('三峡', '三峡集团'), ('中国船舶', '中国船舶'),
    ('中国航天', '航天'), ('航天科技', '航天'), ('航天科工', '航天'), ('中国商飞', '中国商飞'),
    ('中国航发', '中国航发'), ('国家能源', '国家能源'), ('华能', '华能'), ('大唐', '大唐'),
    ('华电', '华电'), ('国电投', '国电投'), ('中国电子', '中国电子'), ('长城汽车', '长城汽车'),
    ('一汽', '一汽'), ('上汽', '上汽'), ('广汽', '广汽'), ('重汽', '重汽'), ('中联', '中联重科'),
    ('三一', '三一重工'), ('中烟', '中烟'), ('烟草', '中烟'), ('中粮', '中粮'), ('招商局', '招商局'),
    ('招商银行', '招商银行'),
    # 地产/物业
    ('万科', '万科'), ('碧桂园', '碧桂园'), ('保利', '保利'), ('中海', '中海'), ('龙湖', '龙湖'),
    ('华润', '华润'), ('招商蛇口', '招商蛇口'), ('绿城', '绿城'), ('金地', '金地'), ('恒大', '恒大'),
    ('融创', '融创'), ('旭辉', '旭辉'), ('世茂', '世茂'),
    # 外包（计但 L2）
    ('中软国际', '中软国际'), ('软通动力', '软通动力'), ('博彦科技', '博彦科技'), ('中电金信', '中电金信'),
    ('神州数码', '神州数码'), ('东软', '东软'), ('德科', '德科'), ('用友', '用友'), ('金蝶', '金蝶'),
])
BIG_ALIAS_KEYS = sorted(BIG_ALIASES.keys(), key=len, reverse=True)
OUTSOURCE_GROUPS = {'中软国际', '软通动力', '博彦科技', '中电金信', '神州数码', '东软', '德科',
                    '阿里系', '腾讯'}  # 阿里系/腾讯含子公司，单独标注
OUTSOURCE_HINT = re.compile(r'中软国际|软通|博彦|中电金信|神州数码|东软|德科|驻场|外包|派遣')

# 教培行业（协议 §4.1）：命中即该段不计条件3
EDU_RE = re.compile(r'教育|培训|学校|学院|中学|小学|幼儿园|大学|留学|雅思|托福|英语|外语|语培|教辅|考研|公考|考培|在线教育|网校|辅导|家教|托育|早教|书院|学堂|国际课程|国际部|'
                     r'51talk|51Talk|VIPKID|vipkid|阿卡索|iTutor|Itutor|美联|朗阁|新通|启德|金吉列|小站|沪江|猿辅导|作业帮|高途|好未来|学而思|新东方|新航道|'
                     r'英孚|EF英孚|华尔街英语|环球雅思|环球教育|培生|久趣|斑马|瑞思|贝乐|精锐|学大|文都|中公|华图|粉笔|考虫|嗨学|优路|高顿|恒企|达内|千锋')
EDU_BLACKLIST = re.compile(r'新东方|好未来|学而思|中公|文都|高途|美联|环球雅思|环球教育|启德|新航道|学大|英孚|华尔街英语|培生|久趣|小站|沪江|猿辅导|作业帮|粉笔|华图|博商|新通|金吉列|澳际|朗阁|瑞思|贝乐|精锐|羊驼教育|洋葱教育|乐小奇|威学教育|超级学长|泰能教育|西维外语|海博英语|思齐芙蓉|向学帮|一中国际部|周南中学国际部')

# 条件3 岗位序列（协议 §4.3）
FUNC_RE = re.compile(r'总助|总经理助理|总裁助理|CEO助理|ceo助理|董事长助理|董助|董秘|管培|管理培训生|'
                     r'HRBP|HR|人力资源|人事|招聘|薪酬|绩效|组织发展|'
                     r'运营|项目经理|项目管理|PMO|PM|市场|品牌|公关|PR|战略|行政|秘书|董办|董事会|总裁办|总经理办|咨询|'
                     r'投资|投资者关系|商务|采购|供应链|物流|产品|数据分析|商业分析|'
                     r'风控|合规|内控|法务|财务|会计|审计|税务|投行|研究|顾问|经营|解决方案|规划|'
                     r'BD|bd|计划|招商|总经理|总裁|副总裁|首席|CHO|CFO|COO|活动|内容|用户|渠道|销售运营|销售策略|销售支持|销售管理|销售分析')
NOT_FUNC_RE = re.compile(r'教师|老师|讲师|主讲|教授|助教|辅导|班主任|辅导员|教研|教务|学管|课程顾问|招生|校长|'
                         r'培训师|内训|培训经理|培训主管|培训专员|培训总监|活动培训|销售培训|'
                         r'创始人|联合创始人|合伙人|股东|自营|店长|导购|销售代表|大客户销售|销售顾问|'
                         r'实习|兼职')
TRAINING_RE = re.compile(r'培训师|内训师|培训经理|培训主管|培训专员|培训总监|活动培训|销售培训|培训岗|培训管理|'
                         r'企业培训|内部讲师|内训')
SALES_RE = re.compile(r'销售代表|销售专员|大客户销售|销售顾问|客户经理|导购|门店销售|电销|面销|渠道销售|业务员|销售|'
                      r'理财顾问|投资顾问|保险顾问|置业顾问|留学顾问|移民顾问|招生顾问|健康顾问|地推|经纪人|中介')
FOUNDER_RE = re.compile(r'创始人|联合创始人|合伙人|股东|自营|个体')
INTERN_RE = re.compile(r'实习|在校|兼职|派遣|外包|劳务')

# 条件1 岗位序列（协议 §2-1c）
TEACH_CORE_RE = re.compile(r'教师|老师|讲师|主讲|教授|Teacher|teacher|Tutor|tutor|Instructor|Lecturer')
TEACH_ANY_RE = re.compile(r'教师|老师|讲师|主讲|教授|助教|辅导|班主任|辅导员|教研|教学|家教|Teacher|tutor|Tutor|Instructor|Lecturer')
TEACH_EXCL_RE = re.compile(r'培训师|内训|企业培训|活动培训|销售培训|培训经理|培训主管|培训总监|培训专员|'
                           r'课程顾问|咨询师|教务|学管|班主任|辅导员|助教|教研|教学管理|教学主管|教学督导|'
                           r'校长|招生|运营|市场|销售|主管|经理|总监|院长|助理')
SUBJECT_NONENGLISH_RE = re.compile(r'数学|语文|物理|化学|生物|历史|地理|政治|思想|美术|体育|音乐|舞蹈|钢琴|'
                                   r'艺术|设计|编程|信息技术|科学|书法|围棋|播音|表演|心理')
ENG_SUBJECT_RE = re.compile(r'英语|英文|外语|双语|雅思|托福|ESL|EFL|English|english|IELTS|TOEFL|语培|留学|'
                            r'国际课程|国际部|国际学校|剑桥|新概念|SAT|ACT|四六级|CET|口语|听力|写作|阅读|'
                            r'商务英语|笔译|口译|翻译|外语|外国语')
ENG_INST_HINT = re.compile(r'新东方|新航道|环球雅思|英孚|华尔街英语|美联|朗阁|新通|启德|小站|沪江|VIPKID|'
                           r'阿卡索|51talk|斑马|久趣|瑞思|贝乐|EF|培生|剑桥|外研社|海博英语|西维外语')

# 条件2 英语证据（协议 §3 A/B 分级）
ENG_A = [
    ('专八', re.compile(r'专八|专8|专业八级|专业英语八级|TEM-?\s*8')),
    ('雅思分数', re.compile(r'雅思\s*[5-9](?:\.\d)?|IELTS\s*[5-9](?:\.\d)?')),
    ('托福分数', re.compile(r'托福\s*(?:1[0-2]\d|\d{2,3})\s*分?|TOEFL\s*(?:1[0-2]\d|\d{2,3})')),
    ('CATTI/口译笔译', re.compile(r'CATTI|(?:二级|三级|一级)(?:笔译|口译)|同传|同声传译|交替传译|会议口译|英语口译|英语笔译|口译硕士|笔译硕士')),
    ('TESOL/CELTA', re.compile(r'TESOL|CELTA|TEFL')),
    ('翻译硕士', re.compile(r'翻译硕士|MTI|英语笔译硕士|口译硕士|英语口译|英语笔译|笔译硕士')),
    ('全英文', re.compile(r'全英文(?!课程|学习|教育|项目|班|专业|院校|学校|生活)|全英语(?!课程|学习|教育|项目|班|专业|院校|学校|生活)|纯英文|英文授课|英语授课|双语授课|English[- ]medium|English[- ]only')),
    ('工作语言声明', re.compile(r'(?:英语|英文)[^，。；;,]{0,8}(?:作为|作为?日?常|为|是)[^，。；;,]{0,8}工作语言|'
                          r'以(?:英语|英文)作为?[^，。；;,]{0,4}工作语言|'
                          r'工作语言(?:为|是|：|:)?[^，。；;,]{0,6}(?:英语|英文)|'
                          r'(?:英语|英文)无障碍|无障碍[^，。；;,]{0,4}(?:英语|英文)|'
                          r'English as (?:a )?working language|'
                          r'(?:英语|英文)[^，。；;,]{0,6}(?:日常|主要)?(?:交流|沟通|办公)(?:语言|工具)')),
]
ENG_B = [
    ('专四', re.compile(r'专四|专4|专业四级|TEM-?\s*4')),
    ('六级/CET6', re.compile(r'六级|CET-?\s*6|大学英语六级')),
    ('英语专业/学历', re.compile(r'英语专业|英语语言文学|商务英语|英语教育|外贸英语|应用英语|英语翻译|英语本科|英语硕士')),
    ('留学/海归', re.compile(r'留学|海归|海外留学|英语国家|海外工作|海外经历|英美')),
    ('流利/熟练', re.compile(r'(?:英语|英文)[^，。；;,]{0,10}(?:流利|熟练|无障碍|良好|精通)|流利的(?:英语|英文)|'
                        r'听说读写(?:流畅|流利|熟练)|英语口语(?:好|佳|流利)|(?:英语|英文)(?:听说|沟通|交流)能力(?:佳|强|好|不错)')),
    ('雅思/托福(无分数)', re.compile(r'雅思|IELTS|托福|TOEFL')),
    ('BEC/托业/PTE', re.compile(r'BEC|托业|TOEIC|PTE')),
    ('四级/CET4', re.compile(r'四级|CET-?\s*4')),
]


# ---------------------------------------------------------------- 解析：头部 / 条目
def is_name_token(t):
    if not t or t in NONAME_TOKENS or t in UI_TOKEN_SET:
        return False
    if SALARY_RE.match(t) or ACT_RE.match(t) or STATUS_RE.match(t):
        return False
    if re.search(r'\d', t):
        return False
    if re.match(r'^(?:本科|硕士|博士|大专|中专|中技|高中|MBA|EMBA|学士|研究生|专科)$', t):
        return False
    if len(t) > 24:
        return False
    return bool(re.search(r'[\u4e00-\u9fffA-Za-z]', t))


def parse_head(text):
    """返回 name/age/city/want + 头部异常标记。"""
    toks = text.split(' ')
    age_idx = None
    age = None
    for i, t in enumerate(toks[:12]):
        m = AGE_RE.match(t)
        if m:
            age_idx, age = i, int(m.group(1))
            break
    name, flags = '', []
    if age_idx is None:
        return {'name': '', 'age': None, 'city': '', 'want': '', 'flags': ['no_age_token']}
    pre = toks[:age_idx]
    # 去掉紧邻年龄的活跃标签/薪资/状态/UI
    while pre and (ACT_RE.match(pre[-1]) or SALARY_RE.match(pre[-1]) or pre[-1] in UI_TOKEN_SET
                   or STATUS_RE.match(pre[-1]) or pre[-1] in ('期望', '最近关注', '优势')):
        pre.pop()
    got = []
    while pre and len(got) < 5 and is_name_token(pre[-1]):
        tok = pre[-1]
        # 中文名只取 1 个 token；英文名可连续多个（如 Jane Doe）
        if got and re.search(r'[\u4e00-\u9fff]', got[0]):
            break
        if got and re.search(r'[\u4e00-\u9fff]', tok):
            break
        got.insert(0, pre.pop())
    name = ' '.join(got)
    if not name:
        flags.append('name_parse_error')
    elif re.match(r'^(?:活跃|日内活跃|周内活跃|月内活跃|内活跃|在线|离线|面议)$', name):
        flags.append('name_parse_error')
    # 期望城市 / 岗位
    city, want = '', ''
    m = re.search(r'(?:期望|最近关注)\s+(\S+)\s+(\S+)', text)
    if m:
        city, want = m.group(1), m.group(2)
        if want in ('优势', '名企大厂经历') or ACT_RE.match(want):
            want = ''
    else:
        m2 = re.search(r'(?:期望|最近关注)\s+(\S+)', text)
        if m2:
            city = m2.group(1)
    return {'name': name, 'age': age, 'city': city, 'want': want, 'flags': flags}


def span_months(start_tok, end_tok):
    """区间 → (start_mi, end_mi, anomalies)；end_mi 为开区间端点。"""
    anom = []
    s = (int(start_tok[:4]), 1)
    if not YEAR_ONLY_RE.match(start_tok):
        try:
            s = (int(start_tok[:4]), int(re.split(r'[.\-/]', start_tok)[1]))
        except Exception:
            return None, ['bad_start:' + start_tok]
        if not (1 <= s[1] <= 12):
            return None, ['bad_start_month:' + start_tok]
    sm = mi(s[0], 1) if YEAR_ONLY_RE.match(start_tok) else mi(*s)
    if end_tok == '至今':
        em = NOW_MI
    elif YEAR_ONLY_RE.match(end_tok):
        em = mi(int(end_tok), 1)
    else:
        try:
            e = (int(end_tok[:4]), int(re.split(r'[.\-/]', end_tok)[1]))
        except Exception:
            return None, ['bad_end:' + end_tok]
        if not (1 <= e[1] <= 12):
            return None, ['bad_end_month:' + end_tok]
        em = mi(*e)
    if em > NOW_MI:
        em = NOW_MI
        anom.append('end>NOW')
    if sm > NOW_MI:
        return None, anom + ['start>NOW']
    if em < sm:
        return None, anom + ['end<start']
    if em == sm:
        if YEAR_ONLY_RE.match(start_tok) and YEAR_ONLY_RE.match(end_tok):
            em = sm + 12
        else:
            return (sm, sm), anom
    return (sm, em), anom


def parse_entries(text):
    """切出工作/学历条目。返回 (entries, anomalies)"""
    toks = text.split(' ')
    didx = [i for i, t in enumerate(toks) if DATE_RE.match(t) or t == '至今']
    entries, anoms = [], []
    if len(didx) % 2 == 1:
        anoms.append('odd_date_tokens')
    i = 0
    while i + 1 < len(didx):
        st, et = toks[didx[i]], toks[didx[i + 1]]
        a, b = didx[i], didx[i + 1]
        span, seg_anom = (None, ['bad_date'])
        if DATE_RE.match(st) and (DATE_RE.match(et) or et == '至今'):
            span, seg_anom = span_months(st, et)
        if span is None:
            anoms.extend(seg_anom)
            i += 1
            continue
        nxt = didx[i + 2] if i + 2 < len(didx) else len(toks)
        chunk = toks[b + 1:nxt]
        while chunk and (chunk[-1] in UI_TOKEN_SET or SALARY_RE.match(chunk[-1]) or ACT_RE.match(chunk[-1])):
            chunk.pop()
        if not chunk:
            anoms.append('empty_segment')
            i += 2
            continue
        role = chunk[-1] if len(chunk) >= 2 else ''
        company = ' '.join(chunk[:-1]) if len(chunk) >= 2 else chunk[0]
        if len(chunk) == 1:
            anoms.append('company_only_segment')
        ent = {'company': company, 'role': role, 'start': st, 'end': et,
               'start_mi': span[0], 'end_mi': span[1],
               'months': max(0, span[1] - span[0]),
               'anomaly': seg_anom}
        if DEGREE_RE.match(role) or role in DEGREE_TOKENS:
            ent['kind'] = 'edu'
        else:
            ent['kind'] = 'work'
        entries.append(ent)
        i += 2
    return entries, anoms


# ---------------------------------------------------------------- 公司归一
def strip_company(company):
    c = re.sub(r'[（(][^）)]{0,40}[）)]', '', company)  # 剥离括号注释（子公司/调任说明）
    c = re.sub(r'\s+', ' ', c).strip(' /·-')
    return c


def resolve_group(company):
    """公司 → (集团名, 命中别名)。先剥离括号注释，再最长别名优先。"""
    c = strip_company(company)
    for alias in GROUP_ALIAS_KEYS:
        if alias in c:
            return GROUP_ALIASES[alias], alias
    return None, None


def big_hit(company):
    """条件3 知名企业判定 → (group, matched_alias, level)"""
    c = strip_company(company)
    for alias in BIG_ALIAS_KEYS:
        if alias in c:
            g = BIG_ALIASES[alias]
            lvl = 'L2' if (g in OUTSOURCE_GROUPS or OUTSOURCE_HINT.search(c)) else 'L1'
            if OUTSOURCE_HINT.search(c):
                lvl = 'L2'
            return g, alias, lvl
    # FR-1：银行/保险/证券/信托/基金 类别规则
    m = re.search(r'([\u4e00-\u9fff]{2,6}(?:银行|保险|证券|信托|基金|农商行|资产管理))', c)
    if m:
        return m.group(1), m.group(1), 'L1'
    return None, None, None


def norm_entity(c):
    x = strip_company(c)
    x = re.sub(r'(有限责任公司|股份有限公司|有限公司|集团|公司|分公司|子公司)', '', x)
    x = re.sub(r'(长沙市|长沙|湖南省|湖南|北京市|北京|上海市|上海|深圳市|深圳)', '', x)
    x = re.sub(r'[·\s/_\\\-—]+', '', x)
    return x


def same_entity(a, b):
    if not a or not b:
        return False
    ga, _ = resolve_group(a)
    gb, _ = resolve_group(b)
    if ga and gb and ga == gb:
        return True
    na, nb = norm_entity(a), norm_entity(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if len(na) >= 4 and len(nb) >= 4 and (na in nb or nb in na):
        return True
    return False


# ---------------------------------------------------------------- 条件判定
def months_union(entries):
    s = set()
    for e in entries:
        s.update(range(e['start_mi'], e['end_mi']))
    return len(s)


def teach_verdict(company, role):
    """条件1：返回 (is_teach, reason)"""
    r = role or ''
    c = strip_company(company or '')
    if not TEACH_ANY_RE.search(r):
        return False, 'not_teach_role'
    if not TEACH_CORE_RE.search(r) and not re.search(r'主讲|授课', r):
        return False, 'non_teaching_sequence'  # 助教/班主任/教研/教学管理…
    if TEACH_EXCL_RE.search(r):
        return False, 'excluded_role'
    if re.search(r'实习|在校|家教|兼职教师|兼职老师', r):
        return False, 'intern_or_home_tutor'
    # 英语学科证据
    if ENG_SUBJECT_RE.search(r):
        return True, 'subject_in_role'
    if SUBJECT_NONENGLISH_RE.search(r) and not ENG_SUBJECT_RE.search(c):
        return False, 'non_english_subject'
    if ENG_SUBJECT_RE.search(c):
        return True, 'subject_in_company'
    if ENG_INST_HINT.search(c):
        return True, 'subject_inferred_from_institution'
    return False, 'no_english_evidence'


def c3_segment_verdict(ent, teach_companies, include_training=False):
    """条件3：返回 (counted, reason)。"""
    c, r = ent['company'], ent['role'] or ''
    if ent['kind'] == 'edu':
        return False, 'edu_segment'
    if not c:
        return False, 'no_company'
    if EDU_BLACKLIST.search(c):
        return False, 'edu_blacklist'
    if EDU_RE.search(c):
        return False, 'edu_industry'
    if INTERN_RE.search(r):
        return False, 'intern_or_parttime'
    if FOUNDER_RE.search(r):
        return False, 'founder'
    if re.search(r'教师|老师|讲师|主讲|教授|助教|辅导|教研|教务|学管|班主任|课程顾问|招生|校长', r):
        return False, 'teach_role'
    training_seq = bool(TRAINING_RE.search(r))
    if training_seq and not include_training:
        return False, 'training_sequence'
    if SALES_RE.search(r) and not re.search(r'销售运营|销售策略|销售支持|销售管理|销售分析|销售赋能|销售计划|销售内勤|销售行政', r):
        return False, 'sales_role'
    if not (FUNC_RE.search(r) or training_seq):
        return False, 'non_func_role'
    g, alias, lvl = big_hit(c)
    if not g:
        return False, 'not_whitelisted'
    for tc in teach_companies:
        if same_entity(c, tc):
            return False, 'same_body_as_teaching'
    ent['group'] = g
    ent['level'] = lvl
    return True, 'counted'


def eng_evidence(text):
    a_hits, b_hits = [], []
    for label, rx in ENG_A:
        m = rx.search(text)
        if m:
            a_hits.append({'label': label, 'text': m.group(0),
                           'ctx': text[max(0, m.start() - 12):m.end() + 12]})
    for label, rx in ENG_B:
        m = rx.search(text)
        if m:
            b_hits.append({'label': label, 'text': m.group(0),
                           'ctx': text[max(0, m.start() - 12):m.end() + 12]})
    return a_hits, b_hits


def analyze(text, include_training=False):
    card = clean_card(text)
    head = parse_head(card)
    entries, anoms = parse_entries(card)
    flags = list(head['flags'])
    work = [e for e in entries if e['kind'] == 'work']
    if not work:
        flags.append('no_work_history')
    if len(entries) < 2:
        flags.append('sparse_history')

    # ---- 条件1
    teach_segs, teach_excluded = [], []
    for e in work:
        ok, reason = teach_verdict(e['company'], e['role'])
        if ok:
            if e['months'] < 3:
                e['note'] = 'lt3_months'
                teach_excluded.append({**e, 'reason': 'lt3_months'})
                flags.append('teach_lt3_months')
                continue
            teach_segs.append(e)
        else:
            if reason in ('excluded_role', 'non_teaching_sequence', 'non_english_subject',
                          'no_english_evidence', 'intern_or_home_tutor'):
                if TEACH_ANY_RE.search(e['role'] or ''):
                    teach_excluded.append({**e, 'reason': reason})
    teach_months = months_union(teach_segs)
    teach_companies = [e['company'] for e in teach_segs]

    # ---- 条件3
    counted, excluded = [], []
    for e in work:
        ok, reason = c3_segment_verdict(e, teach_companies, include_training)
        if ok:
            counted.append(e)
        else:
            if reason != 'edu_segment':
                excluded.append({**e, 'reason': reason})
    big_months = months_union(counted)

    # ---- 条件2
    a_hits, b_hits = eng_evidence(card)

    c1 = teach_months > 0
    c2 = len(a_hits) > 0
    c3 = big_months >= 24
    ok = c1 and c2 and c3
    city_ok = bool(re.search(r'长沙|不限', head['city'] or ''))
    if not city_ok:
        flags.append('city_not_changsha')
    for e in teach_segs + counted:
        if e['anomaly']:
            flags.extend(e['anomaly'])
    for a in anoms:
        flags.append('anom:' + a)
    if counted and any(e.get('level') == 'L2' for e in counted):
        flags.append('L2_outsourcing')
    if any('overlap' for _ in ()):  # 占位：重叠并集在 months_union 内消化
        pass

    return {
        'name': head['name'], 'age': head['age'], 'city': head['city'], 'want': head['want'],
        'card': card,
        'teach': round(teach_months / 12, 1), 'big': round(big_months / 12, 1),
        'eng': c2, 'city_ok': city_ok, 'ok': ok,
        'teachMonths': teach_months, 'bigMonths': big_months,
        'c1': {'pass': c1, 'months': teach_months,
               'segments': [seg_brief(e) for e in teach_segs],
               'excluded': [seg_brief(e) for e in teach_excluded]},
        'c2': {'pass': c2, 'level': 'A' if a_hits else ('B' if b_hits else 'none'),
               'A': a_hits, 'B': b_hits},
        'c3': {'pass': c3, 'months': big_months,
               'segments': [seg_brief(e) for e in counted],
               'excluded': [seg_brief(e) for e in excluded]},
        'teachJobs': [seg_brief(e) for e in teach_segs],
        'bigJobs': [seg_brief(e) for e in counted],
        'flags': sorted(set(flags)),
        'verdict': 'PASS' if ok else 'FAIL',
    }


def seg_brief(e):
    d = {'company': e['company'], 'role': e['role'], 'start': e['start'], 'end': e['end'],
         'months': e['months']}
    if e.get('group'):
        d['group'] = e['group']
    if e.get('level'):
        d['level'] = e['level']
    if e.get('reason'):
        d['reason'] = e['reason']
    if e.get('anomaly'):
        d['anomaly'] = e['anomaly']
    if e.get('note'):
        d['note'] = e['note']
    return d


# ---------------------------------------------------------------- 扫描 / 汇总
def load_rows(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        txt = f.read().strip()
    if txt.startswith('['):
        return json.loads(txt)
    for line in txt.splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def scan(path, include_training=False):
    rows = load_rows(path)
    seen = {}
    texts = set()
    dup = 0
    for r in rows:
        t = r.get('text') or r.get('card') or ''
        if not t:
            continue
        h = hashlib.md5(t.encode('utf-8')).hexdigest()
        if h in texts:
            dup += 1
            continue
        texts.add(h)
        a = analyze(t, include_training)
        key = (a['name'], a['age'], a['want'])
        prev = seen.get(key)
        if prev is None or len(a['card']) > len(prev['card']):
            seen[key] = a
    vals = list(seen.values())
    return {'rows': len(rows), 'dup_text': dup, 'persons': vals}


def summary(vals):
    n = len(vals)
    return {
        'persons': n,
        'c1_teach': sum(1 for x in vals if x['c1']['pass']),
        'c2_eng_A': sum(1 for x in vals if x['c2']['pass']),
        'c2_eng_B_only': sum(1 for x in vals if (not x['c2']['pass']) and x['c2']['level'] == 'B'),
        'c3_big24': sum(1 for x in vals if x['c3']['pass']),
        'both_c1_c3': sum(1 for x in vals if x['c1']['pass'] and x['c3']['pass']),
        'pass': sum(1 for x in vals if x['ok']),
        'two_of_three': sum(1 for x in vals if sum([x['c1']['pass'], x['c2']['pass'], x['c3']['pass']]) == 2),
        'city_changsha': sum(1 for x in vals if x['city_ok']),
        'name_parse_error': sum(1 for x in vals if 'name_parse_error' in x['flags']),
        'no_work_history': sum(1 for x in vals if 'no_work_history' in x['flags']),
        'with_L2_outsourcing': sum(1 for x in vals if 'L2_outsourcing' in x['flags']),
    }


def fmt_seg(s):
    g = f"[{s.get('group')}]" if s.get('group') else ''
    ex = f" ({s.get('reason')})" if s.get('reason') else ''
    return f"{s['company']}{g}·{s['role']} {s['start']}–{s['end']} {s['months']}mo{ex}"


def report_one(x, deep=True):
    print(f"### {x['name']}|{x['age']}  {x['city']} / {x['want']}  verdict={x['verdict']}  "
          f"teach={x['teach']}y big={x['big']}y eng={x['c2']['level']} city_ok={x['city_ok']}")
    if not deep:
        return
    print('  c1:', 'pass' if x['c1']['pass'] else 'fail', f"union={x['c1']['months']}mo")
    for s in x['c1']['segments']:
        print('     ✓', fmt_seg(s))
    for s in x['c1']['excluded']:
        print('     ✗', fmt_seg(s))
    print('  c3:', 'pass' if x['c3']['pass'] else 'fail', f"union={x['c3']['months']}mo")
    for s in x['c3']['segments']:
        print('     ✓', fmt_seg(s))
    for s in x['c3']['excluded']:
        print('     ✗', fmt_seg(s))
    print('  c2:', 'pass' if x['c2']['pass'] else 'fail',
          'A=', [h['text'] for h in x['c2']['A']], 'B=', [h['text'] for h in x['c2']['B']][:5])
    if x['flags']:
        print('  flags:', ','.join(x['flags']))


def main(argv):
    include_training = '--include-training' in argv
    path = os.path.join(DEFAULT_WORK, 'rec10.jsonl')
    args, skip = [], False
    for a in argv[1:]:
        if a == '--explain':
            skip = True
            continue
        if skip:
            skip = False
            continue
        if a.startswith('--') or '=' in a:
            continue
        args.append(a)
    if args:
        path = args[0]
    if '--selftest' in argv:
        return selftest()
    res = scan(path, include_training)
    vals = res['persons']
    summ = summary(vals)
    summ.update({'rows': res['rows'], 'dup_text': res['dup_text'],
                 'rule': 'strict2.py v2 (review_protocol v1.0)', 'now': f'{NOW[0]}.{NOW[1]:02d}',
                 'include_training': include_training})
    print('== strict2 扫描 ==')
    print(f"rows={res['rows']} unique_text={res['rows']-res['dup_text']} persons={len(vals)}")
    for k, v in summ.items():
        if k not in ('rows', 'dup_text', 'rule', 'now', 'include_training'):
            print(f'  {k}: {v}')
    if '--explain' in argv:
        i = argv.index('--explain')
        names = [a for a in argv[i + 1:] if not a.startswith('--')]
        names += [a.split('=', 1)[1] for a in argv if a.startswith('--explain=')]
        hits = [x for x in vals if x['name'] in names or f"{x['name']}|{x['age']}" in names]
        for x in hits:
            report_one(x)
        if not hits:
            print('no match:', names)
        return 0
    ok = [x for x in vals if x['ok']]
    ok.sort(key=lambda x: (not x['city_ok'], -x['teachMonths'], -x['bigMonths']))
    print(f'-- PASS ({len(ok)}) --')
    for x in ok:
        report_one(x)
    near = [x for x in vals if (not x['ok']) and sum([x['c1']['pass'], x['c2']['pass'], x['c3']['pass']]) == 2]
    near.sort(key=lambda x: (not x['city_ok'], -max(x['teachMonths'], x['bigMonths'])))
    if '--near' in argv:
        print(f'-- near miss 2/3 ({len(near)}) --')
        for x in near:
            report_one(x, deep=True)
    # 落盘
    os.makedirs(DEFAULT_WORK, exist_ok=True)
    json.dump(ok, open(os.path.join(DEFAULT_WORK, 'strict2_ok.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(near, open(os.path.join(DEFAULT_WORK, 'strict2_near.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(vals, open(os.path.join(DEFAULT_WORK, 'strict2_all.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(summ, open(os.path.join(DEFAULT_WORK, 'strict2_summary.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('saved ' + os.path.join(DEFAULT_WORK, 'strict2_ok.json') + ' / strict2_near.json / strict2_all.json / strict2_summary.json')
    return 0


# ---------------------------------------------------------------- 回归体检
def _fixtures():
    import os
    p = os.environ.get('STRICT2_FIXTURES') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'strict2_fixtures.json')
    if not os.path.exists(p):
        return None
    return json.load(open(p, encoding='utf-8'))


def selftest():
    fx = _fixtures()
    if fx is None:
        print('SKIP: strict2_fixtures.json 未随包提供（真实候选人回归用例不进包；本机开发可设 STRICT2_FIXTURES 指向本机文件）'); return 0
    fails = 0
    for case in fx['cases']:
        a = analyze(case['card'], case.get('include_training', False))
        exp = case['expect']
        got = {k: a.get(k) for k in ('name', 'age', 'verdict', 'teach', 'big', 'eng')}
        got['c1'] = a['c1']['pass']; got['c2'] = a['c2']['pass']; got['c3'] = a['c3']['pass']
        bad = []
        groups = {s.get('group') for s in a['c3']['segments'] + a['c1']['segments']}
        for need in case.get('expect_groups_any', []):
            if not (need in groups or any(need and g and need in g for g in groups)):
                bad.append(f'group {need!r} 未出现（现有 {sorted(x for x in groups if x)}）')
        for k, v in exp.items():
            if k in ('reason',):
                continue
            gv = got.get(k, a.get(k))
            if isinstance(v, (int, float)) and isinstance(gv, (int, float)) and not isinstance(v, bool):
                if abs(v - gv) > case.get('tol', 0.6):
                    bad.append(f'{k}: exp≈{v} got {gv}')
            elif gv != v:
                bad.append(f'{k}: exp {v!r} got {gv!r}')
        tag = 'OK ' if not bad else 'FAIL'
        if bad:
            fails += 1
        print(f"[{tag}] {case['id']}: {case.get('purpose','')}")
        if bad:
            for b in bad:
                print('        -', b)
            report_one(a)
    print(f'-- selftest: {len(fx["cases"])-fails}/{len(fx["cases"])} passed --')
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
