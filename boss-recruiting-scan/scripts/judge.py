#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
strict3v2.py —— 「留学 + 英语可作为工作语言 + 非教培知名企业职能岗≥2年」三条件判定器 v2

相对 /tmp/boss/strict3.py 的改动（对应 review_protocol v1.1 §V7 FR-6..FR-9 + Lead 裁决）：
  c1'  留学：中文校名白名单（≥80 所）+ 繁体/港台校名 + 大小写不敏感英文名校名
       + 港澳校区/中外合作办学/短期交换/线上学位/企业大学/中学及以下 排除
       + BOSS 标签（海外留学/海归/QS前500）不采信；港澳打 hk_macau、台湾打 tw_region
  c2   分级 A / A10 / B / none，ok 与 c2.pass 严格一致（FR-6）：
         A   = 专八 / 雅思分数 / 托福分数 / CATTI·口译笔译 / TESOL·CELTA / 翻译硕士 /
               全英文工作或授课 / 「英语可作为工作语言」类声明（窗口放宽到 40 字、允许逗号顿号）
         A10 = 海外院校学位连续≥24 个月 + 明确英语能力表述（Lead 裁决，可作 c2 通过）
         B   = 专四 / 六级 / 英语专业 / 留学·海归 / 流利·熟练 / 无分数雅思托福 / BEC·托业·PTE / 四级
       c2.pass = level in (A, A10)；纯国内学历 + 仅「英语流利」= B → 不通过
  c3   非教培 + 知名企业 + 职能序列 + ≥24 月（并集）：
         FR-9 知名企业增加「上市/500强/央企/外企/行业龙头」补充白名单（EXTRA_ENTERPRISE）；
         SALES_RE 补 渠道经理/财富管理/券商经纪/营业部/客户经理/大客户/业务经理 等销售序列

用法：
  python3 strict3v2.py [pool.jsonl]              # 扫描并落盘 ok/near/all/summary
  python3 strict3v2.py <pool> --list             # 只打印 PASS
  python3 strict3v2.py <pool> --near             # 打印 two_of_three 近失
  python3 strict3v2.py <pool> --explain 姓名      # 解释某人的三条条件证据
  python3 strict3v2.py --selftest                # 回归用例（strict3_fixtures.json）
  python3 strict3v2.py <pool> --attr-claim       # 额外打开「正文自称500强/上市/央企」通道（默认关，噪声大）
"""
import json
import os
import re
import sys
import tempfile
import hashlib
from datetime import date
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
# 默认输出目录：macOS/Linux 仍是 /tmp/boss；Windows 用 %TEMP%\boss（与 scan-favorite.mjs 一致）
DEFAULT_WORK = os.path.join(tempfile.gettempdir(), 'boss') if os.name == 'nt' else '/tmp/boss'
# 输出目录：默认 BOSS_WORK；只读安装目录也可安全运行
OUTDIR = os.environ.get('BOSS_WORK') or DEFAULT_WORK
os.makedirs(OUTDIR, exist_ok=True)


def mask_name(name):
    s = (name or '').strip()
    return (s[0] + '**') if s else ''

import strict2 as s2  # noqa: E402  复用卡片清洗/条目解析/时间区间/教学/职能/公司归一

# NOW：生产用系统当月；selftest 固定参考月 2026-10；也可用 JUDGE_NOW=YYYY-MM 覆盖
_selftest_run = 'selftest' in sys.argv[1:]
_judge_now = os.environ.get('JUDGE_NOW') or ('2026-10' if _selftest_run else '')
if _judge_now:
    _y, _m = (int(v) for v in _judge_now.split('-')[:2])
    NOW = (_y, _m)
else:
    _today = date.today()
    NOW = (_today.year, _today.month)
NOW_MI = NOW[0] * 12 + (NOW[1] - 1)
s2.NOW = NOW
s2.NOW_MI = NOW_MI
mi = s2.mi
strip_company = s2.strip_company
parse_entries = s2.parse_entries
clean_card = s2.clean_card
months_union = s2.months_union

# ============================================================ c1' 留学：校名识别
# 1) 国名/地区名（简繁）——出现在「校名段」即可视为境外院校线索
COUNTRY = [
    # 亚洲
    '新加坡', '香港', '澳门', '澳門', '台湾', '台灣', '臺灣', '日本', '韩国', '韓國', '朝鲜',
    '马来西亚', '馬來西亞', '泰国', '泰國', '越南', '老挝', '寮國', '柬埔寨', '缅甸', '緬甸',
    '菲律宾', '菲律賓', '印尼', '印度尼西亚', '印度尼西亞', '文莱', '汶萊', '印度', '巴基斯坦',
    '孟加拉国', '孟加拉', '斯里兰卡', '斯里蘭卡', '尼泊尔', '尼泊爾', '不丹', '马尔代夫',
    '阿富汗', '哈萨克斯坦', '乌兹别克斯坦', '土库曼斯坦', '吉尔吉斯斯坦', '塔吉克斯坦', '蒙古',
    '以色列', '巴勒斯坦', '约旦', '黎巴嫩', '叙利亚', '伊拉克', '伊朗', '沙特阿拉伯', '沙烏地阿拉伯',
    '阿联酋', '阿聯酋', '迪拜', '杜拜', '卡塔尔', '科威特', '巴林', '阿曼', '也门', '格鲁吉亚',
    '亚美尼亚', '阿塞拜疆',
    # 欧洲
    '英国', '英國', '爱尔兰', '愛爾蘭', '法国', '法國', '德国', '德國', '意大利', '義大利', '西班牙',
    '葡萄牙', '荷兰', '荷蘭', '比利时', '比利時', '卢森堡', '瑞士', '奥地利', '奧地利', '瑞典',
    '挪威', '丹麦', '丹麥', '芬兰', '芬蘭', '冰岛', '冰島', '波兰', '波蘭', '捷克', '斯洛伐克',
    '匈牙利', '罗马尼亚', '羅馬尼亞', '保加利亚', '希腊', '希臘', '塞尔维亚', '克羅地亞', '克罗地亚',
    '斯洛文尼亚', '波黑', '黑山', '阿尔巴尼亚', '北马其顿', '乌克兰', '烏克蘭', '白俄罗斯',
    '俄羅斯', '俄罗斯', '立陶宛', '拉脱维亚', '爱沙尼亚', '摩尔多瓦', '马耳他', '塞浦路斯',
    '摩纳哥', '列支敦士登', '安道尔', '圣马力诺', '梵蒂冈',
    # 美洲
    '美国', '美國', '加拿大', '墨西哥', '巴西', '阿根廷', '智利', '秘鲁', '秘魯', '哥伦比亚',
    '委内瑞拉', '厄瓜多尔', '玻利维亚', '巴拉圭', '乌拉圭', '危地马拉', '洪都拉斯', '萨尔瓦多',
    '尼加拉瓜', '哥斯达黎加', '巴拿马', '古巴', '多米尼加', '海地', '牙买加', '特立尼达',
    # 大洋洲
    '澳大利亚', '澳洲', '澳大利亞', '新西兰', '新西蘭', '紐西蘭', '斐济', '巴布亚新几内亚',
    '萨摩亚', '汤加',
    # 非洲
    '南非', '埃及', '摩洛哥', '突尼斯', '阿尔及利亚', '利比亚', '苏丹', '埃塞俄比亚', '肯尼亚',
    '坦桑尼亚', '乌干达', '卢旺达', '尼日利亚', '加纳', '科特迪瓦', '塞内加尔', '喀麦隆', '刚果',
    '津巴布韦', '赞比亚', '莫桑比克', '安哥拉', '纳米比亚', '博茨瓦纳', '马达加斯加', '毛里求斯',
]
COUNTRY_RE = re.compile('|'.join(sorted(COUNTRY, key=len, reverse=True)))

# 语言类专业词：会与国名同形（西班牙语/日本语/意大利语…），匹配国名前先抹掉，
# 避免「湖南涉外经济学院 西班牙语」被当成留学（正是 strict3 的假阳家族）。
LANGUAGE_WORDS = [
    '西班牙语', '葡萄牙语', '意大利语', '阿拉伯语', '希伯来语', '土耳其语', '波斯语',
    '印地语', '乌尔都语', '孟加拉语', '泰语', '越南语', '柬埔寨语', '老挝语', '缅甸语',
    '马来语', '印尼语', '菲律宾语', '荷兰语', '瑞典语', '挪威语', '丹麦语', '芬兰语',
    '冰岛语', '波兰语', '捷克语', '斯洛伐克语', '匈牙利语', '罗马尼亚语', '保加利亚语',
    '塞尔维亚语', '克罗地亚语', '斯洛文尼亚语', '阿尔巴尼亚语', '希腊语', '乌克兰语',
    '白俄罗斯语', '立陶宛语', '拉脱维亚语', '爱沙尼亚语', '格鲁吉亚语', '亚美尼亚语',
    '阿塞拜疆语', '哈萨克语', '乌兹别克语', '蒙古语', '藏语', '维吾尔语', '日语', '日本语',
    '韩国语', '韩语', '朝鲜语', '英语', '法语', '德语', '俄语', '西语', '葡语', '意语',
    '阿语', '韩日', '英日', '英韩',
]
LANGUAGE_RE = re.compile('|'.join(sorted(LANGUAGE_WORDS, key=len, reverse=True)))

# 2) 中文校名白名单（含港澳台、日韩、欧洲、美加澳新；只收「境外院校」，国内同名院校不收）
CN_SCHOOL_GROUPS = {
    '美国': """
        哈佛大学 耶鲁大学 斯坦福大学 麻省理工学院 麻省大学 加州理工学院 普林斯顿大学 哥伦比亚大学
        芝加哥大学 宾夕法尼亚大学 康奈尔大学 杜克大学 布朗大学 达特茅斯学院 莱斯大学 范德堡大学
        圣母大学 乔治城大学 埃默里大学 塔夫茨大学 密歇根大学 密歇根州立大学 宾州州立大学
        普渡大学 罗切斯特大学 凯斯西储大学 匹兹堡大学 卡内基梅隆大学 约翰霍普金斯大学 纽约大学
        雪城大学 佩珀代因大学 南加州大学 加州大学洛杉矶分校 加州大学伯克利分校 加州大学圣地亚哥分校
        加州大学戴维斯分校 加州大学尔湾分校 加州大学欧文分校 加州大学圣芭芭拉分校
        加州大学圣塔芭芭拉分校 加州大学圣克鲁兹分校 加州大学河滨分校 加州大学 加州州立大学
        印第安纳大学 伊利诺伊大学 俄亥俄州立大学 俄亥俄大学 北卡罗莱纳州立大学 北卡罗来纳州立大学
        密苏里州立大学 东南密苏里州立大学 密苏里科技大学 迈阿密大学 天普大学 乔治华盛顿大学
        美利坚大学 克拉克大学 伍斯特理工学院 史蒂文斯理工学院 伦斯勒理工学院 杜肯大学 德保罗大学
        圣路易斯大学 华盛顿大学 波士顿大学 波士顿学院 布兰迪斯大学 威廉玛丽学院 罗格斯大学
        石溪大学 纽约州立大学 亚利桑那州立大学 亚利桑那大学 明尼苏达大学 马里兰大学 弗吉尼亚大学
        北德克萨斯大学 阿拉巴马大学 北阿拉巴马大学 恩波利亚州立大学 诺斯伍德大学 内华达大学
        夏威夷大学 韦恩州立大学 佐治亚大学 佐治亚理工学院 佛罗里达大学 科罗拉多大学 犹他大学
        俄勒冈大学 华盛顿州立大学 爱荷华大学 堪萨斯大学 俄克拉荷马大学 田纳西大学 肯塔基大学
        阿肯色大学 内布拉斯加大学 路易斯安那州立大学 康涅狄格大学 马萨诸塞大学 新罕布什尔大学
        佛蒙特大学 缅因大学 罗德岛大学 特拉华大学 西弗吉尼亚大学 南卡罗来纳大学 南卫理公会大学
        贝勒大学 德克萨斯大学 德州大学 德州农工大学 休斯顿大学 圣地亚哥州立大学 旧金山州立大学
        圣何塞州立大学 佩斯大学 福特汉姆大学 叶史瓦大学 帕森斯设计学院 罗德岛设计学院
        加州艺术学院 芝加哥艺术学院 普瑞特艺术学院 纽约视觉艺术学院 萨凡纳艺术与设计学院
        伯克利音乐学院 茱莉亚学院 曼哈顿音乐学院 新英格兰音乐学院 密苏里州立大学
    """,
    '英国': """
        牛津大学 剑桥大学 帝国理工学院 伦敦大学学院 伦敦政治经济学院 伦敦国王学院
        伦敦玛丽女王大学 伦敦大学伯贝克学院 伦敦城市大学 伦敦艺术大学 伦敦南岸大学 伦敦都市大学
        皇家艺术学院 皇家音乐学院 爱丁堡大学 曼彻斯特大学 曼彻斯特城市大学 曼彻斯特都会大学
        华威大学 谢菲尔德大学 谢菲尔德哈勒姆大学 利兹大学 利兹贝克特大学 伯明翰大学 伯明翰城市大学
        阿斯顿大学 格拉斯哥大学 诺丁汉大学 诺丁汉特伦特大学 南安普顿大学 南安普敦大学
        布里斯托大学 杜伦大学 圣安德鲁斯大学 约克大学 巴斯大学 兰卡斯特大学 埃克塞特大学
        纽卡斯尔大学 利物浦大学 利物浦约翰摩尔斯大学 卡迪夫大学 贝尔法斯特女王大学 女王大学
        斯特灵大学 邓迪大学 阿伯丁大学 萨里大学 萨塞克斯大学 苏塞克斯大学 雷丁大学 肯特大学
        埃塞克斯大学 拉夫堡大学 布鲁内尔大学 班戈大学 斯旺西大学 赫尔大学 普利茅斯大学
        普茅斯大学 布莱顿大学 牛津布鲁克斯大学 德蒙福特大学 伍尔弗汉普顿大学 诺森比亚大学
        提赛德大学 伯恩茅斯大学 考文垂大学 密德萨斯大学 格林威治大学 威斯敏斯特大学
        斯特拉斯克莱德大学 阿伯泰大学 哈德斯菲尔德大学 索尔福德大学 桑德兰大学 中央兰开夏大学
        赫特福德大学 莱斯特大学 白金汉大学 东英吉利大学 东安格利亚大学 卡迪夫都会大学
    """,
    '港澳台': """
        香港大学 香港中文大学 香港科技大学 香港理工大学 香港城市大学 香港浸会大学 岭南大学
        香港教育大学 香港树仁大学 香港都会大学 香港演艺学院 澳门大学 澳門大學 澳门科技大学
        澳门城市大学 澳门理工大学 澳门旅游学院 台湾大学 臺灣大學 台湾政治大学 台湾政治大學
        国立台湾大学 国立政治大学 台湾国立政治大学 国立清华大学 国立交通大学 国立成功大学
        国立中山大学 国立中央大学 国立中正大学 国立阳明交通大学 国立云林科技大学 台湾科技大学
        台北科技大学 淡江大学 辅仁大学 东吴大学 逢甲大学 元智大学 长荣大学 义守大学 静宜大学
        中国文化大学 铭传大学 实践大学 世新大学 高雄医学大学 中山医学大学
    """,
    '日本': """
        东京大学 京都大学 大阪大学 名古屋大学 北海道大学 早稻田大学 庆应义塾大学 上智大学
        明治大学 青山学院大学 立教大学 法政大学 中央大学 日本大学 同志社大学 立命馆大学
        关西大学 关西学院大学 近畿大学 筑波大学 神户大学 横滨国立大学 东京工业大学 东京理科大学
        埼玉大学 广岛大学 冈山大学 金泽大学 熊本大学 千叶大学 一桥大学 御茶水女子大学
        樱美林大学 亚细亚大学 文化服装学院 多摩美术大学 武藏野美术大学 京都精华大学 芝浦工业大学
        丽泽大学 明海大学 创价大学 东京外国语大学 神奈川大学 大阪市立大学 名古屋工业大学 九州大学
        山口大学 德岛大学 高知大学 长崎大学 弘前大学 岩手大学 山形大学 福岛大学 茨城大学
        宇都宫大学 群马大学 山梨大学 新潟大学 富山大学 福井大学 岐阜大学 三重大学 滋贺大学
        京都府立大学 兵库县立大学 奈良女子大学 和歌山大学 鸟取大学 岛根大学 冈山理科大学
        广岛市立大学 爱媛大学 佐贺大学 大分大学 宫崎大学 鹿儿岛大学 琉球大学 东京艺术大学
    """,
    '韩国': """
        首尔大学 首尔国立大学 高丽大学 延世大学 成均馆大学 汉阳大学 庆熙大学 梨花女子大学
        西江大学 韩国外国语大学 釜山国立大学 全北国立大学 国民大学 建国大学 东国大学 弘益大学
        世宗大学 庆北国立大学 忠南国立大学 全南国立大学 仁荷大学 亚洲大学 光云大学 檀国大学
        淑明女子大学 诚信女子大学 公州国立大学 大邱大学 明知大学 启明大学 朝鲜大学 京畿大学
        庆尚国立大学 江原国立大学 清州大学 又松大学 首尔市立大学 韩国科学技术院 浦项工科大学
        汉城大学 世明大学 庆南大学 湖西大学 韩世大学 拿撒勒大学
    """,
    '新马泰菲': """
        新加坡国立大学 南洋理工大学 新加坡管理大学 新加坡科技设计大学 新加坡理工大学
        詹姆斯库克大学 马来亚大学 马来西亚国立大学 博特拉大学 马来西亚理科大学 马来西亚理工大学
        思特雅大学 泰莱大学 玛拉工艺大学 国立发展管理学院 朱拉隆功大学 易三仓大学 博仁大学
        曼谷大学 斯坦福国际大学 菲律宾大学 德拉萨大学 印尼大学 印度尼西亚大学 万隆理工学院
        加札马达大学 河内大学 胡志明市国家大学 巴基斯坦拉合尔教育大学 拉合尔教育大学
    """,
    '欧洲': """
        索邦大学 巴黎第一大学 巴黎第四大学 巴黎高等商学院 巴黎政治学院 里昂商学院
        北方高等商学院 里昂高等商学院 格勒诺布尔高等商学院 斯特拉斯堡大学 拉罗谢尔高等商学院
        阿姆斯特丹大学 阿姆斯特丹自由大学 代尔夫特理工大学 莱顿大学 乌得勒支大学 鹿特丹大学
        伊拉斯姆斯大学 马斯特里赫特大学 格罗宁根大学 蒂尔堡大学 特温特大学 埃因霍温理工大学
        瓦格宁根大学 苏黎世联邦理工学院 洛桑联邦理工学院 苏黎世大学 日内瓦大学 伯尔尼大学
        圣加仑大学 维也纳大学 博洛尼亚大学 米兰理工大学 米兰大学 罗马大学 罗马美术学院 佛罗伦萨大学
        都灵理工大学 都灵大学 帕多瓦大学 比萨大学 博科尼大学 锡耶纳大学 威尼斯大学 那不勒斯大学
        热那亚大学 贝尔加莫大学 瓦伦西亚大学 马德里康普顿斯大学 马德里理工大学 马德里自治大学
        巴塞罗那大学 巴塞罗那自治大学 庞培法布拉大学 加泰罗尼亚理工大学 阿尔卡拉大学 格拉纳达大学
        塞维利亚大学 萨拉曼卡大学 里斯本大学 波尔图大学 科英布拉大学 鲁汶大学 根特大学
        布鲁塞尔自由大学 安特卫普大学 哥本哈根大学 奥胡斯大学 斯德哥尔摩大学 隆德大学
        乌普萨拉大学 哥德堡大学 查尔姆斯理工大学 皇家理工学院 奥斯陆大学 卑尔根大学 挪威科技大学
        赫尔辛基大学 阿尔托大学 都柏林大学 圣三一学院 都柏林城市大学 科克大学 华沙大学 雅盖隆大学
        查理大学 莫斯科国立大学 喀山联邦大学 俄罗斯人民友谊大学 圣彼得堡国立大学 白俄罗斯国立大学
        白俄罗斯国立经济大学 基辅大学 伊斯坦布尔大学 伊斯坦布尔城市大学 海峡大学 以色列理工学院
        希伯来大学 特拉维夫大学 哈瓦那大学 墨西哥国立自治大学 圣保罗大学 开罗大学 金山大学
        开普敦大学 阿联酋大学 哈利法大学 欧洲管理与技术学院 柏林欧洲管理与技术学院 柏林工业大学
        柏林自由大学 柏林洪堡大学 慕尼黑工业大学 慕尼黑大学 海德堡大学 亚琛工业大学 德累斯顿工业大学
        斯图加特大学 卡尔斯鲁厄理工学院 弗莱堡大学 图宾根大学 哥廷根大学 波恩大学 科隆大学
        汉堡大学 法兰克福大学 曼海姆大学 明斯特大学 纽伦堡大学 维尔茨堡大学 奥格斯堡大学
        马格德堡大学 帕德博恩大学 魏玛包豪斯大学 波鸿大学 多特蒙德大学 汉诺威大学 布伦瑞克工业大学
        达姆施塔特工业大学 卡塞尔大学 锡根大学 特里尔大学 罗斯托克大学 莱比锡大学 耶拿大学
        开姆尼茨工业大学 弗莱堡大学 美因茨大学 萨尔大学 凯泽斯劳滕工业大学 吕讷堡大学
    """,
    '澳新加': """
        悉尼大学 墨尔本大学 新南威尔士大学 莫纳什大学 蒙纳士大学 昆士兰大学 阿德莱德大学 西澳大学
        澳大利亚国立大学 澳洲国立大学 悉尼科技大学 麦考瑞大学 迪肯大学 格里菲斯大学 科廷大学
        皇家墨尔本理工大学 拉筹伯大学 卧龙岗大学 塔斯马尼亚大学 昆士兰科技大学 南澳大学
        西悉尼大学 堪培拉大学 维多利亚大学 邦德大学 澳洲天主教大学 新英格兰大学 查尔斯达尔文大学
        埃迪斯科文大学 斯文本科技大学 奥克兰大学 奥塔哥大学 惠灵顿维多利亚大学 坎特伯雷大学
        梅西大学 怀卡托大学 奥克兰理工大学 林肯大学 多伦多大学 麦吉尔大学 滑铁卢大学
        阿尔伯塔大学 渥太华大学 西安大略大学 韦仕敦大学 西蒙弗雷泽大学 西蒙菲莎大学 曼尼托巴大学
        达尔豪斯大学 戴尔豪斯大学 康考迪亚大学 卡尔加里大学 麦克马斯特大学 皇后大学 布鲁克大学
        温莎大学 劳伦森大学 湖首大学 特伦特大学 卡尔顿大学 圭尔夫大学 瑞尔森大学 多伦多都会大学
        北不列颠哥伦比亚大学 温哥华岛大学 汤姆逊河大学 菲莎国际学院 范莎学院 圣力嘉学院
        百年理工学院 汉博学院 乔治布朗学院 乔治亚学院 康尼斯托加学院 谢里丹学院 皇家大学
    """,
}
CN_SCHOOLS = sorted({w for group in CN_SCHOOL_GROUPS.values() for w in group.split()},
                    key=len, reverse=True)
CN_SCHOOL_RE = re.compile('|'.join(map(re.escape, CN_SCHOOLS)))

# 3) 英文名校名（大小写不敏感）：长名子串 + 缩写词边界
LATIN_LONG = [
    'harvard', 'yale', 'stanford', 'princeton', 'columbia', 'chicago', 'cornell', 'duke',
    'dartmouth', 'rice university', 'vanderbilt', 'notre dame', 'georgetown', 'emory',
    'tufts', 'michigan', 'purdue', 'rochester', 'carnegie mellon', 'johns hopkins', 'nyu',
    'syracuse', 'pepperdine', 'southern california', 'ucla', 'berkeley', 'san diego',
    'davis', 'irvine', 'santa barbara', 'santa cruz', 'riverside', 'indiana university',
    'illinois', 'ohio state', 'north carolina', 'missouri', 'miami', 'temple', 'george washington',
    'american university', 'clark university', 'worcester polytechnic', 'stevens institute',
    'rensselaer', 'duquesne', 'depaul', 'saint louis', 'washington university', 'boston university',
    'boston college', 'brandeis', 'william & mary', 'rutgers', 'stony brook', 'suny',
    'arizona state', 'minnesota', 'maryland', 'virginia', 'alabama', 'hawaii', 'wayne state',
    'georgia', 'florida', 'colorado', 'utah', 'oregon', 'iowa', 'kansas', 'oklahoma',
    'tennessee', 'kentucky', 'arkansas', 'nebraska', 'louisiana state', 'connecticut',
    'massachusetts', 'new hampshire', 'vermont', 'maine', 'rhode island', 'delaware',
    'west virginia', 'south carolina', 'southern methodist', 'baylor', 'texas', 'houston',
    'san francisco state', 'san jose state', 'pace university', 'fordham', 'yeshiva',
    'parsons', 'rhode island school', 'calarts', 'school of the art institute', 'pratt',
    'school of visual arts', 'savannah college', 'berklee', 'juilliard', 'manhattan school',
    'new england conservatory',
    'oxford', 'cambridge', 'imperial college', 'university college london', 'lse',
    'london school of economics', 'kings college', "king's college", 'queen mary',
    'birkbeck', 'city university london', 'university of the arts london', 'royal college of art',
    'royal academy of music', 'edinburgh', 'manchester', 'manchester met', 'warwick',
    'sheffield', 'sheffield hallam', 'leeds', 'leeds beckett', 'birmingham', 'aston',
    'glasgow', 'nottingham', 'nottingham trent', 'southampton', 'bristol', 'durham',
    'st andrews', 'york', 'bath', 'lancaster', 'exeter', 'newcastle', 'liverpool',
    'liverpool john moores', 'cardiff', 'queen\'s university belfast', 'stirling', 'dundee',
    'aberdeen', 'surrey', 'sussex', 'reading', 'kent', 'essex', 'loughborough', 'brunel',
    'bangor', 'swansea', 'hull', 'plymouth', 'brighton', 'oxford brookes', 'de montfort',
    'wolverhampton', 'northumbria', 'teesside', 'bournemouth', 'coventry', 'middlesex',
    'greenwich', 'westminster', 'strathclyde', 'abertay', 'huddersfield', 'salford',
    'sunderland', 'central lancashire', 'hertfordshire', 'leicester', 'buckingham',
    'east anglia', 'kingston university', 'solent', 'roehampton',
    'sorbonne', 'sciences po', 'hec paris', 'essec', 'escp', 'edhec', 'emlyon', 'insead',
    'kedge', 'skema', 'audencia', 'grenoble ecole', 'strasbourg', 'la rochelle',
    'amsterdam', 'delft', 'leiden', 'utrecht', 'erasmus', 'maastricht', 'groningen',
    'tilburg', 'twente', 'eindhoven', 'wageningen', 'eth zurich', 'epfl', 'zurich',
    'geneva', 'bern', 'st gallen', 'vienna', 'bocconi', 'politecnico di milano', 'bologna',
    'milan', 'sapienza', 'padua', 'pisa', 'siena', 'venice', 'naples', 'genoa', 'bergamo',
    'valencia', 'complutense', 'madrid', 'barcelona', 'pompeu fabra', 'catalonia',
    'alcala', 'granada', 'sevilla', 'salamanca', 'lisbon', 'porto', 'coimbra', 'leuven',
    'ghent', 'brussels', 'antwerp', 'copenhagen', 'aarhus', 'stockholm', 'lund', 'uppsala',
    'gothenburg', 'chalmers', 'kth', 'oslo', 'bergen', 'helsinki', 'aalto', 'dublin',
    'trinity college', 'cork', 'warsaw', 'jagiellonian', 'charles university', 'lomonosov',
    'kazan', 'st petersburg', 'minsk', 'kyiv', 'istanbul', 'bogazici', 'technion',
    'hebrew university', 'tel aviv', 'havana', 'unam', 'sao paulo', 'cairo', 'witwatersrand',
    'cape town', 'uae university', 'khalifa', 'esmt', 'berlin', 'humboldt', 'tu munich',
    'munich', 'heidelberg', 'aachen', 'dresden', 'stuttgart', 'karlsruhe', 'freiburg',
    'tuebingen', 'goettingen', 'bonn', 'cologne', 'hamburg', 'frankfurt', 'mannheim',
    'muenster', 'wuerzburg', 'augsburg', 'magdeburg', 'paderborn', 'weimar', 'bochum',
    'dortmund', 'hannover', 'braunschweig', 'darmstadt', 'kassel', 'siegen', 'trier',
    'rostock', 'leipzig', 'jena', 'chemnitz', 'mainz', 'saarland', 'kaiserslautern',
    'lueneburg',
    'sydney', 'melbourne', 'unsw', 'monash', 'queensland', 'adelaide', 'uwa', 'anu',
    'uts', 'macquarie', 'deakin', 'griffith', 'curtin', 'rmit', 'latrobe', 'wollongong',
    'tasmania', 'qut', 'unisa', 'western sydney', 'canberra', 'bond university',
    'australian catholic', 'new england', 'charles darwin', 'edith cowan', 'swinburne',
    'auckland', 'otago', 'wellington', 'canterbury', 'massey', 'waikato', 'aut university',
    'lincoln university', 'toronto', 'mcgill', 'waterloo', 'alberta', 'ottawa', 'western ontario',
    'simon fraser', 'manitoba', 'dalhousie', 'concordia', 'calgary', 'mcmaster',
    'queen\'s university', 'brock', 'windsor', 'laurentian', 'lakehead', 'trent', 'carleton',
    'guelph', 'ryerson', 'toronto metropolitan', 'unbc', 'vancouver island', 'thompson rivers',
    'fanshawe', 'seneca', 'centennial', 'humber', 'george brown', 'georgian', 'conestoga',
    'sheridan', 'royal roads',
]
LATIN_RE = re.compile('|'.join(re.escape(x) for x in sorted(LATIN_LONG, key=len, reverse=True)),
                      re.I)
LATIN_ACRONYM_RE = re.compile(
    r'(?<![a-z])(?:mit|ucl|kcl|nyu|nus|ntu|hku|cuhk|hkust|hkbu|cityu|polyu|unsw|anu|lse|eth|epfl|'
    r'kaist|uic|suny|uts|rmit|qut|unbc|esmt|hec|essec|escp|edhec|emlyon|insead|kedge|skema|'
    r'boğaziçi|bogazici)(?![a-z])', re.I)
# 英文校名通名副名：必须与国家形容词同现，避免 "New Oriental School" 等教培名误判
LATIN_ADJ = (
    'american|british|english|australian|canadian|singaporean|singapore|hong kong|macau|macao|'
    'taiwan|japanese|korean|german|french|italian|spanish|portuguese|dutch|swiss|swedish|'
    'norwegian|danish|finnish|irish|new zealand|malaysian|thai|russian|ukrainian|polish|czech|'
    'hungarian|brazilian|mexican|south african|israeli|turkish|indian|indonesian|philippine|'
    'vietnamese|pakistani|bangladeshi|sri lankan|nepali|kazakh|egyptian|nigerian|kenyan|ghanaian'
)
LATIN_SCHOOL_RE = re.compile(r'(?:%s)[^，。；;\n]{0,20}(?:university|college|school of|institute)'
                             % LATIN_ADJ, re.I)
# 英文/拉丁写法里的港澳台地名（含「Institute of Hong Kong」这类倒序写法）
LATIN_PLACE_RE = re.compile(
    r'hong\s*kong|macao|macau|taiwan|kowloon|new\s*territories', re.I)

# 4) 排除规则
FOREIGN_OVERRIDE = ['西安大略大学', '中国香港', '中国澳门', '中国台湾']
JV_RE = re.compile(
    '西交利物浦|宁波诺丁汉|上海纽约|昆山杜克|温州肯恩|深圳北理莫斯科|广东以色列理工|'
    '北师香港浸会|北京师范大学.{0,4}香港浸会|联合国际学院|UIC|中外合作办学|中外合作|合作办学|'
    '联合培养|国际本科|国际班|学分互认|[234]\\+[0-2]|中外联合|中美合作|中英合作|中澳合作|中加合作')
DOMESTIC_CAMPUS_RE = re.compile(
    '香港中文大学[（(]?深圳|香港科技大学[（(]?广州|香港城市大学[（(]?东莞|香港理工大学[（(]?'
    '香港大学[（(]?深圳|澳门大学[（(]?横琴')
DOMESTIC_PREFIX_RE = re.compile(
    '^(?:北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|'
    '湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|宁夏|新疆|西藏|内蒙古|苏州|无锡|常州|'
    '郑州|武汉|长沙|株洲|湘潭|衡阳|岳阳|益阳|常德|郴州|邵阳|娄底|怀化|永州|张家界|成都|西安|'
    '南京|广州|深圳|珠海|佛山|东莞|杭州|宁波|温州|合肥|济南|青岛|烟台|威海|大连|沈阳|厦门|福州|'
    '泉州|南昌|昆明|南宁|桂林|贵阳|太原|石家庄|哈尔滨|长春|呼和浩特|兰州|西宁|银川|乌鲁木齐|拉萨|'
    '徐州|扬州|南通|连云港|洛阳|开封|新乡|宜昌|襄阳|中国|西南|西北|东北|华东|华南|华中|华北|中南|'
    '东南)[\\u4e00-\\u9fff●·&,，/（()]{0,8}(?:大学|学院|学校|职业技术|专修|专科学院)')
CORP_ACADEMY_RE = re.compile(
    '(?:集团|公司|企业|控股)[\\u4e00-\\u9fff]{0,8}(?:学院|大学|商学院|企业大学)|企业大学|'
    '美的学院|华为大学|阿里学院|腾讯学院|培训学校|培训中心|培训机构|进修学校|职业技术学院')
NOT_DEGREE_RE = re.compile(
    '中学|高中|初中|小学|幼儿园|幼稚园|学前|中专|技校|职高|国际学校|外国语学校|附属中学|'
    '语言学校|語言學校|语言中心|語学|预科|桥梁课程|pathway|foundation|diploma')
SHORT_TERM_RE = re.compile(
    '暑期|暑假|寒假|夏校|夏令营|冬令营|游学|短期|交换|交流项目|交流学习|访学|访问学者|'
    '一学期|一学年|半年|三个月的|三个月的|国际交流|短期课程|证书课程|研修|研学')
ONLINE_RE = re.compile(
    '线上|在线|远程|网络教育|网课|online|函授|自考|继续教育|成人教育|夜大|电大|开放大学|'
    '远程教育学院|网络教育学院')
DEGREE_UG_RE = re.compile(
    '本科|学士|硕士|研究生|博士|MBA|EMBA|MPA|MPH|MSc|MSc|MA\\b|MS\\b|BA\\b|BS\\b|BSc|'
    'Master|Bachelor|PhD|Doctor|Postgraduate|Undergraduate', re.I)


def classify_edu(company, role):
    """对一条 edu 条目判「是否境外院校学历」。返回 (verdict, reason, region)

    verdict: 'overseas' | 'domestic' | 'reject'
    """
    line = ' '.join(x for x in (company or '', role or '') if x).strip()
    if not line:
        return 'reject', 'empty', None
    # 0) 显式例外（西安大略大学这类会被「西安」开头的国内前缀误伤）
    for w in FOREIGN_OVERRIDE:
        if w in line:
            return 'overseas', 'foreign_override', region_of(line)
    # 1) 企业大学 / 培训机构 / 非学位层次
    if CORP_ACADEMY_RE.search(line):
        return 'reject', 'corp_or_training_school', None
    # 2) 中外合作办学、港澳内地校区
    if DOMESTIC_CAMPUS_RE.search(line):
        return 'reject', 'domestic_campus_of_hk_school', None
    if JV_RE.search(line):
        return 'reject', 'joint_program', None
    if NOT_DEGREE_RE.search(line):
        return 'reject', 'below_undergraduate_level', None
    # 3) 国内院校（省份/城市前缀）
    if DOMESTIC_PREFIX_RE.search(line):
        return 'reject', 'domestic_school', None
    # 4) 短期交换 / 线上学位
    if SHORT_TERM_RE.search(line):
        return 'reject', 'short_term_exchange', None
    if ONLINE_RE.search(line):
        return 'reject', 'online_or_nonfulltime', None
    # 5) 境外线索：先抹掉语言类专业词，避免「西班牙语」被当成西班牙
    scrubbed = LANGUAGE_RE.sub('§', line)
    if not (COUNTRY_RE.search(scrubbed) or CN_SCHOOL_RE.search(scrubbed)
            or LATIN_PLACE_RE.search(line)
            or LATIN_RE.search(line) or LATIN_ACRONYM_RE.search(line)
            or LATIN_SCHOOL_RE.search(line)):
        return 'domestic', 'no_overseas_signal', None
    # 6) 学位层次：必须本科及以上
    if not DEGREE_UG_RE.search(line):
        return 'reject', 'no_undergraduate_degree', None
    return 'overseas', 'overseas_school', region_of(scrubbed)


def region_of(line):
    """境外院校 → 地区标记"""
    if re.search('香港|澳门|澳門|港澳|澳门', line) or re.search(r'hong\s*kong|macao|macau', line, re.I):
        return 'hk_macau'
    if re.search('台湾|台灣|臺灣', line) or re.search('taiwan', line, re.I):
        return 'tw_region'
    return 'foreign'


def overseas_of(entries):
    """c1'：从 edu 条目里挑出境外学历段。返回 (accepted, rejected, flags)"""
    accepted, rejected, flags = [], [], []
    for e in entries:
        if e.get('kind') != 'edu':
            continue
        v, reason, region = classify_edu(e.get('company'), e.get('role'))
        e2 = dict(e)
        e2['overseas_reason'] = reason
        e2['region'] = region
        if v == 'overseas':
            accepted.append(e2)
            if region == 'hk_macau':
                flags.append('hk_macau')
            elif region == 'tw_region':
                flags.append('tw_region')
        elif reason not in ('domestic_school', 'no_overseas_signal'):
            rejected.append(e2)
    return accepted, rejected, flags


# ============================================================ c2 英语证据分级（A / A10 / B）
# FR-6：strict2 的「工作语言声明」窗口 [^，。；;,]{0,8} 不含逗号，
#        「英语流利，可作为工作语言」被漏判（某海外双名校案例）。v2 放宽到 40 字、允许逗号顿号。
A_EXTRA = [
    ('工作语言声明', re.compile(
        r'(?:英语|英文|English)[^。；;\n]{0,15}?工作语言|'
        r'(?:英语|英文)[^。；;\n]{0,20}?(?:可作为|作为|当作|是|为)[^。；;\n]{0,12}?(?:工作|办公|交流)语言|'
        r'工作语言(?:为|是|：|:)?[^。；;\n]{0,20}?(?:英语|英文|English)|'
        r'(?:英语|英文)[^。；;\n]{0,20}(?:无障碍|无障碍沟通|沟通无障碍)')),
]
# 负向表述（英语不是工作语言）——命中后该条 A 证据作废
A_NEG = re.compile(r'(?:不|无法|不能|难以|未|非)[^。；;\n]{0,6}(?:工作语言|无障碍|可作为)')
# A10 的「明确英语能力表述」（Lead 裁决：海外学位 + 英语流利/无障碍/可作为工作语言可作 c2 通过）
A10_CLAIM = re.compile(
    r'(?:英语|英文)[^。；;\n]{0,20}?(?:流利|熟练|无障碍|良好|精通|可作为工作语言|工作语言|听说读写)'
    r'|(?:流利|熟练|无障碍)[^。；;\n]{0,10}?(?:英语|英文)'
    r'|全英文|全英语|英文授课|英语授课|English[- ]medium')
# BOSS 标签（不采信）：出现这些词但无 edu 段/无 A 级证据时，仅作为「需人工核对」提示
TAG_ONLY_CLAIM = re.compile(r'海外留学|海外院校|海归|留学经历|出国留学|英国留学|美国留学|澳洲留学|'
                            r'QS前500|QS\s*\d{2,3}|名企大厂经历')


def c2_grade(card, a_hits, b_hits, ov_months, have_overseas):
    """c2 分级：A > A10 > B > none。返回 dict（pass 与 level 严格一致）"""
    A, demoted = [], []
    for h in a_hits:
        h2 = dict(h)
        # 口译/同传类证据若上下文中没有「英」，语种不明（中韩同传/阿语同传）→ 降为 B
        if re.search('同传|同声传译|交替传译|口译|笔译', h2['text']) and not re.search('英', h2.get('ctx') or ''):
            h2['label'] = '口译/同传(语种未明)'
            demoted.append(h2)
        else:
            A.append(h2)
    seen = {(h['label'], h['text']) for h in A}
    for label, rx in A_EXTRA:
        for m in rx.finditer(card):
            seg = m.group(0)
            if A_NEG.search(seg):
                continue
            key = (label, seg)
            if key in seen:
                continue
            seen.add(key)
            A.append({'label': label, 'text': seg,
                      'ctx': card[max(0, m.start() - 12):m.end() + 12]})
            break
    level, a10 = 'none', None
    if A:
        level = 'A'
    else:
        claim = A10_CLAIM.search(card)
        if have_overseas and ov_months >= 24 and claim:
            level = 'A10'
            a10 = {'months': ov_months,
                   'claim': claim.group(0),
                   'ctx': card[max(0, claim.start() - 16):claim.end() + 16]}
        elif b_hits or demoted:
            level = 'B'
    return {'level': level, 'pass': level in ('A', 'A10'), 'A': A, 'A10': a10,
            'B': list(b_hits) + demoted}


# ============================================================ c3 知名企业补充白名单（FR-9）
# 依据：中国 500 强 / 上市公司 / 央企国企 / 行业龙头 / 知名外企（含长沙本地知名雇主）。
# 只补「招聘方/员工」意义上可确认的雇主；不确定的不进表，宁缺勿滥。
EXTRA_ENTERPRISE = """
Thoughtworks 思维特 兴盛优选 老百姓大药房 益丰大药房 水羊股份 水羊国际 水羊集团 御家汇
三诺生物 芒果TV 芒果超媒 湖南广播电视台 草花互动 盈峰环境 盈峰中联 澳优 澳优乳业
茶颜悦色 天鹅到家 万兴科技 天职国际 安居客 爱尔眼科 华强方特 中科星城 中伟股份 湖南裕能
航天凯天环保 佳源集团 贝贝熊 绝味食品 步步高 九典制药 华致酒行 随行付 楚天科技 山河智能
铁建重工 拓维信息 景嘉微 国科微 华曙高科 圣湘生物 尔康制药 九芝堂 方盛制药 千山制药
湘电 湘财证券 财信证券 财信人寿 湖南银行 长沙农商行 三湘银行 湖南高速 长沙轨道交通
中联重科 三一重工 蓝思科技 中车 比亚迪 宁德时代 亿纬锂能 欣旺达 立讯精密 歌尔股份
传音控股 荣耀 华勤技术 闻泰科技 中软国际 软通动力 博彦科技 中电金信 神州数码 东软集团
德科 科锐国际 用友网络 金蝶 浪潮 中科曙光 太极股份 神州信息 东华软件 恒生电子 同花顺
东方财富 中信建投 国泰君安 招商证券 广发证券 华泰证券 中泰证券 国信证券 兴业证券 方正证券
泰康 太平洋保险 新华保险 众安保险 微众银行 苏宁 苏宁易购 国美 永辉超市 盒马 名创优品
泡泡玛特 周黑鸭 良品铺子 三只松鼠 珀莱雅 完美日记 花西子 蓝月亮 立白 维达 恒安 安踏
李宁 特步 波司登 海澜之家 太平鸟 森马 欧派家居 索菲亚 顾家家居 红星美凯龙 居然之家
月星 富森美 万科 保利 中海 龙湖 华润置地 招商蛇口 碧桂园 绿城 金地 旭辉 世茂 佳兆业
金科 中国中车 中国铁建 中国中铁 中国交建 中国建筑 中国电建 中国能建 中国中冶 中国化学
中国五矿 中国铝业 中国宝武 鞍钢 首钢 河钢 沙钢 中国建材 海螺水泥 华新水泥 冀东水泥
国家电网 南方电网 国家能源 华能 大唐 华电 国电投 三峡 中核 中广核 中国石油 中国石化
中海油 中化 中国化工 中国船舶 中国商飞 中国航发 中国电子 中国电科 中国普天 中国联通
中国移动 中国电信 中通服 中移在线 中国邮政 中国外运 中远海运 招商局 中粮 中储粮
华为 中兴 小米 OPPO vivo 联想 大疆 海康威视 大华股份 京东方 TCL 创维 康佳 格力 美的
海尔 海信 长虹 奥克斯 方太 老板电器 九阳 苏泊尔 公牛 德力西 正泰 施耐德 ABB 西门子
博世 大陆集团 采埃孚 电装 麦格纳 佛吉亚 法雷奥 博格华纳 康明斯 卡特彼勒 霍尼韦尔
通用电气 通用汽车 福特 克莱斯勒 特斯拉 丰田 本田 日产 大众汽车 宝马 奔驰 奥迪 沃尔沃
现代汽车 起亚 塔塔 捷豹路虎 保时捷 法拉利 玛莎拉蒂 一汽 上汽 广汽 东风 长安汽车 北汽
长城汽车 吉利 奇瑞 江淮 江铃 宇通 金龙 蔚来 理想汽车 小鹏 零跑 哪吒 赛力斯 福田汽车
普华永道 德勤 安永 毕马威 立信 天健 信永中和 大华会计师事务所 中审众环 致同 中汇
麦肯锡 BCG 贝恩 罗兰贝格 埃森哲 IBM 凯捷 印孚瑟斯 高德纳
汇丰 花旗 渣打 摩根大通 摩根士丹利 高盛 瑞银 瑞信 德意志银行 法国巴黎银行 星展银行
恒生银行 东亚银行 华侨永亨 大新银行 招商银行 中信银行 浦发银行 兴业银行 民生银行
光大银行 广发银行 华夏银行 平安银行 北京银行 上海银行 江苏银行 宁波银行 长沙银行
京东 美团 阿里巴巴 腾讯 字节跳动 拼多多 快手 小红书 网易 滴滴 百度 携程 同程旅行
去哪儿 途家 马蜂窝 飞猪 哔哩哔哩 知乎 微博 新浪 搜狐 凤凰网 36氪 界面 财新
喜马拉雅 荔枝FM 映客 虎牙 斗鱼 欢聚时代 金山办公 WPS 猎豹移动 奇安信 深信服 启明星辰
绿盟 安恒 中孚信息 三六零 每日互动 顺丰 中通 圆通 韵达 申通 极兔 德邦
满帮 货拉拉 达达 闪送 菜鸟 京东物流 苏宁物流 安能 百世
沃尔玛 家乐福 麦德龙 大润发 欧尚 山姆 开市客 宜家 迪卡侬 优衣库 ZARA H&M
耐克 阿迪达斯 彪马 斯凯奇 新百伦 亚瑟士 露露乐蒙 宝洁 联合利华 欧莱雅 雅诗兰黛
资生堂 花王 高露洁 强生 金佰利 玛氏 雀巢 亿滋 可口可乐 百事 康师傅 统一企业 农夫山泉
伊利 蒙牛 光明乳业 飞鹤 君乐宝 青岛啤酒 雪花啤酒 燕京啤酒 百威 嘉士伯 茅台 五粮液
泸州老窖 洋河 汾酒 剑南春 郎酒 古井贡 今世缘 迎驾贡 口子窖 老白干 酒鬼酒 舍得酒业
辉瑞 默沙东 罗氏 诺华 阿斯利康 拜耳 赛诺菲 葛兰素史克 礼来 诺和诺德 默克 艾伯维
吉利德 百时美施贵宝 武田 卫材 第一三共 勃林格殷格翰 费森尤斯 贝朗 美敦力
强生医疗 西门子医疗 GE医疗 飞利浦 迈瑞 联影 万东 鱼跃 乐普 微创医疗 恒瑞 复星医药
药明康德 康龙化成 泰格医药 凯莱英 博腾 九洲药业 华海药业 石药 齐鲁制药 扬子江
修正药业 葵花药业 仁和药业 云南白药 片仔癀 同仁堂 太极集团 华润三九 昆药 天士力 以岭
步长 巴斯夫 陶氏 杜邦 拜耳作物 先正达 孟山都 科迪华 汉高 阿克苏诺贝尔 PPG 立邦 三棵树
东方雨虹 北新建材 中国巨石 中材科技 金发科技 万华化学 华峰化学 恒力 荣盛 桐昆 新凤鸣
PwC KPMG Deloitte 普华永道中天 德勤华永 安永华明 毕马威华振 Accenture McKinsey
""".split()
EXTRA_ALIASES = collections.OrderedDict()
for _w in EXTRA_ENTERPRISE:
    EXTRA_ALIASES.setdefault(_w, (_w, 'L1', 'extra'))
EXTRA_KEYS = sorted(EXTRA_ALIASES.keys(), key=len, reverse=True)

CATEGORY_RE = re.compile(r'([\u4e00-\u9fff]{2,8}(?:银行|保险|证券|信托|基金|农商行|资产管理|'
                         r'人寿|财险|寿险|证券营业部))')
# ---- 外包/OD/ODC/派遣 识别（FR-14，batch1 fix_request）
# 口径：不改变 c3 是否计入，但命中即标 confidence=L1 / employer_verified=false，
# 供台账与人工复核区分「雇主实体为外派/外包驻场」的经历。
OUTSOURCE_RE = re.compile(
    r'外包|驻场|外派|派遣|劳务|人力外包|人事代理|人力资源服务|BPO|ODC|（OD）|\(OD\)|'
    r'中软国际|软通动力|博彦科技|中电金信|神州数码|东软集团|外企德科|德科|赛意信息|法本信息|'
    r'文思海辉|柯莱特|中科软|宇信科技|高伟达|长亮科技|润和软件|中电太极')


def is_outsourcing(company, role):
    return bool(OUTSOURCE_RE.search((company or '') + ' ' + (role or '')))


_S2_BIG_HIT = s2.big_hit          # 原白名单 + 类别规则（银行/保险/证券/信托/基金）
_S2_SALES_RE = s2.SALES_RE

# FR-9：销售序列补充（渠道/财富管理/券商经纪/营业部/客户经理等一线创收岗）
SALES_EXTRA = ('渠道经理|渠道总监|渠道主管|渠道专员|财富管理|财富顾问|私人银行|券商经纪|证券经纪|'
               '营业部|机构销售|大客户经理|大客户总监|客户总监|客户主管|客户开发|业务经理|'
               '业务代表|代理商管理|团购|直销|区域销售|区域经理|城市经理|招商经理|门店经理|'
               '店长|柜员|信贷员|客户成功?经理')


USE_EXTRA = True


def install_patches(use_extra=True):
    """把 v2 的 c3 规则装进 strict2（c3_segment_verdict 运行时查模块全局）"""
    global USE_EXTRA
    USE_EXTRA = use_extra
    s2.SALES_RE = re.compile(_S2_SALES_RE.pattern + '|' + SALES_EXTRA)
    s2.big_hit = lambda company: big_hit_v2(company)[:3]


def big_hit_v2(company):
    """知名企业判定 v2 → (group, alias, level, channel)"""
    c = strip_company(company or '')
    if not c:
        return None, None, None, None
    g, alias, lvl = _S2_BIG_HIT(c)
    if g:
        return g, alias, lvl, 'whitelist'
    if USE_EXTRA:
        for k in EXTRA_KEYS:
            if k in c:
                return EXTRA_ALIASES[k][0], k, 'L1', 'extra'
    m = CATEGORY_RE.search(c)
    if m:
        return m.group(1), m.group(1), 'L1', 'category'
    return None, None, None, None


# ============================================================ 三条件判定
def analyze(text, include_training=False, attr_claim=False):
    card = clean_card(text)
    x = s2.analyze(card, include_training=include_training)
    entries, anoms = parse_entries(card)
    accepted, rejected, ov_flags = overseas_of(entries)
    ov_months = months_union(accepted) if accepted else 0
    if not attr_claim:
        # 正文自称 500强/上市/央企 的通道默认关闭（443 张卡命中，噪声极大；
        # 多为「服务过外企客户」「产品上市」等表述）。打开后仅在 near 里打 flag 供人工复核。
        pass
    else:
        for e in entries:
            if e.get('kind') != 'work':
                continue
            seg_text = x.get('card', '')
            m = re.search(r'(?:世界500强|500强|上市公司|央企|国企|知名外企|跨国公司)', seg_text)
            if m and s2.FUNC_RE.search(e.get('role') or ''):
                xx = s2.c3_segment_verdict(e, [], include_training)
                if not xx[0] and xx[1] == 'not_whitelisted':
                    e['group'] = e['company']
                    e['level'] = 'L2'
                    e['channel'] = 'attr_claim'
                    x['c3'].setdefault('segments', []).append(s2.seg_brief(e))
                    x['flags'] = sorted(set(x['flags'] + ['c3_attr_claim']))

    # ---- c3 通道标注（FR-9）
    for seg in x['c3'].get('segments', []):
        ch = big_hit_v2(seg.get('company', ''))[3]
        if ch:
            seg['channel'] = ch
        if ch == 'extra':
            x['flags'] = sorted(set(x['flags'] + ['c3_extra_whitelist']))
        elif ch == 'category':
            x['flags'] = sorted(set(x['flags'] + ['c3_category_whitelist']))
        if seg.get('level') == 'L2':
            x['flags'] = sorted(set(x['flags'] + ['L2_outsourcing']))
        if is_outsourcing(seg.get('company'), seg.get('role')):
            seg['outsourcing'] = True
            seg['confidence'] = 'L1'
            seg['employer_verified'] = False
            x['flags'] = sorted(set(x['flags'] + ['c3_outsourcing_segment']))
        else:
            seg.setdefault('confidence', 'L0' if seg.get('level') != 'L2' else 'L1')
            seg.setdefault('employer_verified', seg.get('level') != 'L2')

    # ---- 人级 confidence（FR-14）：任一 c3 段为外包/驻场 → L1
    _segs = x['c3'].get('segments', [])
    x['c3']['confidence'] = 'L1' if any(s.get('outsourcing') for s in _segs) else 'L0'
    x['c3']['employer_verified'] = (not any(s.get('outsourcing') for s in _segs)) if _segs else None
    x['c3']['months'] = int(x['c3'].get('months') or 0)   # FR-13：整数月数，禁止浮点年参与门槛

    c2 = c2_grade(card, x['c2'].get('A') or [], x['c2'].get('B') or [], ov_months, bool(accepted))
    c1 = ov_months > 0
    flags = list(x['flags']) + ov_flags
    if accepted and ov_months < 3:
        flags.append('c1_lt3_months')
    if any('end>NOW' in (e.get('anomaly') or []) for e in accepted):
        flags.append('overseas_in_progress')   # 在读（或卡片把毕业时间写成未来）
    if accepted and ov_months >= 24 and c2['level'] == 'A10':
        flags.append('c2_A10_claim')
    if c2['level'] == 'B':
        flags.append('c2_B_only')
    if not c1 and TAG_ONLY_CLAIM.search(card):
        flags.append('text_overseas_claim_no_edu')   # 只有 BOSS 标签/正文自述，无独立学历条目
    if rejected:
        flags.extend(sorted({'c1_rej:' + r['overseas_reason'] for r in rejected}))
    c3 = x['c3']
    # age 缺失的卡片不进 PASS（无法可靠去重/审核；scan 的 schema 要求 age 为数字）
    ok = (c1 and c2['pass'] and c3['pass'] and x.get('age') is not None
          and bool((x.get('name') or '').strip()))
    x.update({
        'teach': x.get('teach'), 'teachMonths': x.get('teachMonths'),
        'c1': {'pass': c1, 'months': ov_months,
               'segments': [{'school': e['company'], 'major': e['role'],
                             'start': e['start'], 'end': e['end'], 'months': e['months'],
                             'region': e.get('region')} for e in accepted],
               'excluded': [{'school': e['company'], 'major': e['role'],
                             'start': e['start'], 'end': e['end'], 'months': e['months'],
                             'reason': e['overseas_reason']} for e in rejected]},
        'overseas': [e['company'] for e in accepted],
        'hk_macau': any(e.get('region') == 'hk_macau' for e in accepted),
        'tw_region': any(e.get('region') == 'tw_region' for e in accepted),
        'c2': c2,
        'flags': sorted(set(flags)),
    })
    x['ok'] = ok
    x['verdict'] = 'PASS' if ok else 'FAIL'
    return x


# ============================================================ 扫描 / 输出
def load_rows(path):
    with open(path, encoding='utf-8') as f:
        txt = f.read().strip()
    if txt.startswith('['):
        return json.loads(txt)
    return [json.loads(l) for l in txt.splitlines() if l.strip()]


def scan(path, include_training=False, attr_claim=False):
    rows = load_rows(path)
    by_text = {}
    for r in rows:
        t = r.get('card') or r.get('text') or ''
        if not t:
            continue
        h = hashlib.md5(t.encode('utf-8')).hexdigest()
        by_text.setdefault(h, t)
    persons = {}
    for t in by_text.values():
        x = analyze(t, include_training=include_training, attr_claim=attr_claim)
        x['card_id'] = hashlib.sha1(t.encode('utf-8')).hexdigest()[:16]
        k = x['card_id']  # 按卡片文本去重；不同卡片即使掩码姓名/年龄/期望相同也各自保留
        old = persons.get(k)
        if old is None or len(x['card']) > len(old['card']):
            persons[k] = x
    return rows, by_text, persons


def summary(persons):
    ps = list(persons.values())
    have = lambda x, key: bool(x[key]['pass'])
    both = [x for x in ps if have(x, 'c1') and have(x, 'c3')]
    two = [x for x in ps if have(x, 'c1') + have(x, 'c2') + have(x, 'c3') == 2]
    return {
        'persons': len(ps),
        'c1_overseas': sum(1 for x in ps if have(x, 'c1')),
        'c2_pass(A/A10)': sum(1 for x in ps if have(x, 'c2')),
        'c2_A': sum(1 for x in ps if x['c2']['level'] == 'A'),
        'c2_A10': sum(1 for x in ps if x['c2']['level'] == 'A10'),
        'c2_B_only': sum(1 for x in ps if x['c2']['level'] == 'B'),
        'c3_big24': sum(1 for x in ps if have(x, 'c3')),
        'both_c1_c3': len(both),
        'pass': sum(1 for x in ps if x['ok']),
        'c3_outsourcing': sum(1 for x in ps if x['c3'].get('confidence') == 'L1'),
        'two_of_three': len(two),
        'hk_macau': sum(1 for x in ps if x.get('hk_macau')),
        'tw_region': sum(1 for x in ps if x.get('tw_region')),
        'city_changsha': sum(1 for x in ps if x.get('city_ok')),
        'no_overseas_edu_at_all': sum(1 for x in ps if not x['c1']['segments'] and not x['c1']['excluded']),
    }


def line_of(x):
    miss = [k for k in ('c1', 'c2', 'c3') if not x[k]['pass']]
    return '%-4s %-14s %-3s %-12s c1=%.2fy c2=%-3s c3=%.2fy miss=%s' % (
        x['verdict'], mask_name(x['name']), x['age'], (x['want'] or '')[:12],
        x['c1']['months'] / 12, x['c2']['level'], x['c3']['months'] / 12, ','.join(miss))


def dump(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


# ============================================================ CLI
CITY_PREFER = {'长沙'}


def _brief(x):
    return {'card_id': x.get('card_id'), 'name': mask_name(x['name']), 'age': x['age'], 'city': x['city'], 'want': x['want'],
            'c1_years': round(x['c1']['months'] / 12, 2), 'c2_level': x['c2']['level'],
            'c3_years': round(x['c3']['months'] / 12, 2),
            # FR-13：整数月数是判定权威字段（门槛 c3_months>=24），年数仅供展示
            'c1_months': int(x['c1']['months']), 'c3_months': int(x['c3']['months']),
            'c3_confidence': x['c3'].get('confidence'),
            'employer_verified': x['c3'].get('employer_verified'),
            'c3_segments': x['c3'].get('segments', []),
            'c1_segments': x['c1'].get('segments', []),
            'c2_evidence': ([{'level': 'A', **a} for a in (x['c2'].get('A') or [])]
                            + ([{'level': 'A10', **x['c2']['A10']}] if x['c2'].get('A10') else [])
                            + [{'level': 'B', 'text': b} for b in (x['c2'].get('B') or [])])[:8],
            'overseas': x['overseas'], 'hk_macau': x.get('hk_macau', False),
            'tw_region': x.get('tw_region', False),
            'big': [s.get('company') for s in x['c3'].get('segments', [])],
            # 城市优先级（流程层排序用）：0=优先城市，1=不限/空，2=其它（长沙优先排序）
            'city_rank': (0 if (x.get('city') or '') in CITY_PREFER else (1 if (x.get('city') or '') in ('', '不限') else 2)),
            'flags': x['flags'], 'verdict': x['verdict']}


def explain(x):
    out = [line_of(x)]
    out.append('  name=%s age=%s city=%s want=%s' % (mask_name(x['name']), x['age'], x['city'], x['want']))
    out.append('  c1 留学(%.2f 年 / %d 月)' % (x['c1']['months'] / 12, x['c1']['months']))
    for s in x['c1']['segments']:
        out.append('     + %s | %s | %s-%s | %s月 | %s' % (
            s['school'], s['major'], s['start'], s['end'], s['months'], s['region']))
    for s in x['c1']['excluded']:
        out.append('     - %s | %s | %s-%s | %s月 | %s' % (
            s['school'], s['major'], s['start'], s['end'], s['months'], s['reason']))
    out.append('  c2 level=%s pass=%s' % (x['c2']['level'], x['c2']['pass']))
    for a in x['c2']['A']:
        out.append('     A  %s: %s' % (a['label'], a['text']))
    if x['c2'].get('A10'):
        out.append('     A10: %s (%s 月海外学位)' % (x['c2']['A10']['claim'], x['c2']['A10']['months']))
    for b in x['c2']['B']:
        out.append('     B  %s: %s' % (b['label'], b['text']))
    out.append('  c3 知名企业职能岗(%.2f 年 / %d 月)' % (x['c3']['months'] / 12, x['c3']['months']))
    for s in x['c3'].get('segments', []):
        out.append('     + %s | %s | %s-%s | %s月 | %s | confidence=%s%s' % (
            s['company'], s['role'], s['start'], s['end'], s['months'],
            s.get('channel') or s.get('level'), s.get('confidence', 'L0'),
            ' | outsourcing(employer_verified=false)' if s.get('outsourcing') else ''))
    out.append('  c3 confidence=%s employer_verified=%s (整数月数门槛: %d>=24)' % (
        x['c3'].get('confidence'), x['c3'].get('employer_verified'), x['c3']['months']))
    out.append('  flags: %s' % ', '.join(x['flags']))
    return '\n'.join(out)


def selftest():
    path = os.path.join(HERE, 'strict3_fixtures.json')
    with open(path, encoding='utf-8') as f:
        cases = json.load(f)
    bad = 0
    for c in cases:
        x = analyze(c['card'], include_training=c.get('include_training', False),
                    attr_claim=c.get('attr_claim', False))
        errs = []
        exp = c['expect']
        if 'c1' in exp and x['c1']['pass'] != exp['c1']:
            errs.append('c1 %s != %s' % (x['c1']['pass'], exp['c1']))
        if 'c2' in exp and x['c2']['level'] != exp['c2']:
            errs.append('c2 %s != %s' % (x['c2']['level'], exp['c2']))
        if 'c2pass' in exp and x['c2']['pass'] != exp['c2pass']:
            errs.append('c2pass %s != %s' % (x['c2']['pass'], exp['c2pass']))
        if 'c3' in exp and x['c3']['pass'] != exp['c3']:
            errs.append('c3 %s != %s' % (x['c3']['pass'], exp['c3']))
        if 'ok' in exp and x['ok'] != exp['ok']:
            errs.append('ok %s != %s' % (x['ok'], exp['ok']))
        if 'c1min' in exp and x['c1']['months'] < exp['c1min']:
            errs.append('c1 months %d < %d' % (x['c1']['months'], exp['c1min']))
        if 'c3min' in exp and x['c3']['months'] < exp['c3min']:
            errs.append('c3 months %d < %d' % (x['c3']['months'], exp['c3min']))
        if 'c3months' in exp and x['c3']['months'] != exp['c3months']:
            errs.append('c3 months %d != %d' % (x['c3']['months'], exp['c3months']))
        if 'c3confidence' in exp and x['c3'].get('confidence') != exp['c3confidence']:
            errs.append('c3 confidence %s != %s' % (x['c3'].get('confidence'), exp['c3confidence']))
        if 'employer_verified' in exp and x['c3'].get('employer_verified') != exp['employer_verified']:
            errs.append('employer_verified %s != %s' % (x['c3'].get('employer_verified'), exp['employer_verified']))
        for f in exp.get('flags', []):
            if f not in x['flags']:
                errs.append('missing flag %s' % f)
        if errs:
            bad += 1
            print('FAIL %-28s %s' % (c['id'], '; '.join(errs)))
            print(explain(x))
        else:
            print('ok   %-28s %s' % (c['id'], line_of(x)))
    print('\nselftest: %d/%d passed' % (len(cases) - bad, len(cases)))
    return 0 if bad == 0 else 1


def main(argv):
    install_patches(use_extra='--no-extra' not in argv)
    args = argv[1:]
    path, modes, names = None, set(), []
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith('--'):
            name = a[2:]
            if '=' in name:
                k, v = name.split('=', 1)
                modes.add(k)
                if k == 'explain':
                    names.append(v)
                i += 1
                continue
            modes.add(name)
            if name == 'explain' and i + 1 < len(args):
                names.append(args[i + 1])
                i += 2
                continue
            i += 1
            continue
        if path is None and (a.endswith('.jsonl') or a.endswith('.json')):
            path = a
        i += 1
    if 'selftest' in modes:
        return selftest()
    path = path or os.path.join(os.environ.get('BOSS_WORK') or DEFAULT_WORK, 'merged_pool.jsonl')
    include_training = 'include-training' in modes
    attr_claim = 'attr-claim' in modes
    rows, by_text, persons = scan(path, include_training=include_training, attr_claim=attr_claim)
    valid_cards = [r for r in rows if (r.get('card') or r.get('text') or '').strip()]
    if not valid_cards:
        print('FATAL 没有有效卡片（输入为空或 card 字段全空）——判定器不会写空结果', file=sys.stderr)
        return 2
    summ = summary(persons)
    print('rows=%d unique_text=%d persons=%d' % (len(rows), len(by_text), len(persons)))
    for k, v in summ.items():
        print('  %-22s %s' % (k, v))
    ok = [x for x in persons.values() if x['ok']]
    near = [x for x in persons.values()
            if x['c1']['pass'] + x['c2']['pass'] + x['c3']['pass'] == 2]
    if names:
        for nm in names:
            hit = [x for x in persons.values() if nm in (x['name'] or '')]
            for x in hit:
                print(explain(x))
            if not hit:
                print('未找到：%s' % nm)
        return 0
    if 'near' in modes:
        for x in sorted(near, key=lambda y: -(y['c1']['months'] + y['c3']['months'])):
            ln = line_of(x)
            print('NEAR' + ln[4:])   # 用 NEAR 替换 verdict 位，保留 c1/c2/c3 明细
        return 0
    if 'list' in modes or 'ok' in modes:
        for x in sorted(ok, key=lambda y: (y['city_ok'], y['c1']['months']), reverse=True):
            print(line_of(x))
    dump(os.path.join(OUTDIR, 'strict3v2_ok.json'), [_brief(x) for x in ok])
    dump(os.path.join(OUTDIR, 'strict3v2_near.json'), [_brief(x) for x in near])
    dump(os.path.join(OUTDIR, 'strict3v2_all.json'), [_brief(x) for x in persons.values()])
    dump(os.path.join(OUTDIR, 'strict3v2_summary.json'), summ)
    print('\nwrote strict3v2_ok.json / strict3v2_near.json / strict3v2_all.json / strict3v2_summary.json')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
