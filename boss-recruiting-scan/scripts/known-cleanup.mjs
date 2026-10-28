// known-cleanup.mjs — 回滚成功后清理 known_fav（姓名键 + card_id 映射）
// 背景：收藏成功时 known_fav 同时写入 16hex card_id 与「姓名|年龄」；
//       审核闸门 X2 要求被拒者不在 known_fav（card_id 或姓名键都不在），
//       所以回滚必须同时删掉这两类键，否则「被拒→回滚→继续」永远 42。
import fs from 'node:fs'
import path from 'node:path'

export function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
export function writeJSON(p, v, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2), { mode })
}

const ACT = ['热搜', '刚刚活跃', '今日活跃', '3日内活跃', '本周活跃', '本月活跃', '2周内活跃', '在线', '面议', '新牛人']
// 从收藏卡文本解析「姓名 + 年龄」：允许姓名与年龄之间夹任意多个活动标签/角标
export function nameAgeFromCard(cardText) {
  const s = String(cardText || '')
  const re = new RegExp(`(\\S{1,8}?)(?:\\s+(?:${ACT.join('|')}|\\d{1,4}\\*?))*\\s+(\\d{1,3})岁`)
  const m = s.match(re)
  return m ? { name: m[1], age: m[2] } : null
}

// 返回 {removedKeys, removedIds}
export function cleanupKnown({ base, key, cardText, known }) {
  const kf = known instanceof Set ? known : new Set(known || readJSON(path.join(base, 'known_fav.json'), []))
  const rmKeys = new Set()
  const ids = new Set()

  const fromText = nameAgeFromCard(cardText)
  const keyAge = (String(key || '').match(/\|(\d{1,3})$/) || [])[1]
  const name = fromText?.name || String(key || '').split('|')[0]
  const age = fromText?.age || keyAge
  const masked = name && name.includes('*')
  const first = name ? name[0] : ''

  // 1) known_fav_map.json：card_id -> 姓名|年龄
  const mapPath = path.join(base, 'known_fav_map.json')
  const map = readJSON(mapPath, {})
  for (const [id, na] of Object.entries(map)) {
    const naAge = (String(na).match(/\|(\d{1,3})$/) || [])[1]
    const hit = (name && age && String(na) === `${name}|${age}`) ||
      (age && naAge === String(age) && first && String(na)[0] === first)
    if (hit) ids.add(id)
  }

  // 2) review_batch_*.json：同姓名/年龄候选的 card_id
  let files = []
  try { files = fs.readdirSync(base).filter(f => /^review_batch_\d+\.json$/.test(f)) } catch {}
  for (const f of files) {
    const b = readJSON(path.join(base, f), null)
    for (const c of (b?.candidates || [])) {
      const hit = (name && age && c.name === name && String(c.age) === String(age)) ||
        (age && c.age != null && String(c.age) === String(age) && first && String(c.name || '')[0] === first)
      if (hit && c.card_id) ids.add(c.card_id)
    }
  }

  // 3) 姓名类键
  for (const k of kf) {
    const kAge = (String(k).match(/\|(\d{1,3})$/) || [])[1]
    const hit = k === key ||
      (name && age && k === `${name}|${age}`) ||
      (age && kAge === String(age) && first && String(k)[0] === first)
    if (hit) rmKeys.add(k)
  }
  for (const id of ids) rmKeys.add(id)

  for (const k of rmKeys) kf.delete(k)
  for (const id of ids) delete map[id]
  return { removedKeys: [...rmKeys], removedIds: [...ids], known: kf, map }
}

// 命令行自测：node known-cleanup.mjs <base> "<key>" "<cardText>"
if (process.argv[1] && process.argv[1].endsWith('known-cleanup.mjs')) {
  const [base, key, card] = process.argv.slice(2)
  if (!base || !key) { console.error('usage: known-cleanup.mjs <base> "<key>" "<cardText>"'); process.exit(2) }
  const r = cleanupKnown({ base, key, cardText: card || key })
  writeJSON(path.join(base, 'known_fav.json'), [...r.known])
  writeJSON(path.join(base, 'known_fav_map.json'), r.map)
  console.log(JSON.stringify({ removedKeys: r.removedKeys, removedIds: r.removedIds }, null, 2))
}
