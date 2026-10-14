// docs/G-mv7kzgnu-1/T204-evidence/probe-avatar-gap.mjs
// T-204（方案搜索）证据脚本：**只读**枚举「软件流水线空间里还没换头像的 Agent」，并实测可用的位面。
//
// 运行（仓库根）：node docs/G-mv7kzgnu-1/T204-evidence/probe-avatar-gap.mjs
//   · 不联网、不写库（DatabaseSync readOnly: true）、不调任何 HTTP 接口。
//   · 只用 Node 内置模块（node:sqlite 需 Node >= 22；本仓实测 v24.19.0）。
//   · 移动端 avatar.mjs 与桌面 src/avatar 由 avatar-parity.test.mjs 逐 key 锁死，
//     所以用 renderAvatar() 实测的各种结论对桌面同样成立。
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { resolveSlot, renderAvatar, slotKeys, PLACEHOLDER_SLOT } from '../../../workbench/mobile/avatar.mjs'

const DB = 'D:/project/DSH/legion/team-hub/team.db'
const TOKEN_RE = /^human:[a-z0-9][a-z0-9-]*$/ // = team-hub/agent-avatars.mjs:16
const db = new DatabaseSync(DB, { readOnly: true })
console.log('db = ' + DB + '  (mtime ' + statSync(DB).mtime.toISOString() + ', readOnly)')

// ── 图片资产表（镜像自 workbench/src/avatar/photo-assets.ts，见 avatar-photo.test.mjs ④）──
const PHOTO_KEYS = ['requirement','researcher','breaker','test-designer','coder','reviewer','tester','devops',
  'assistant','research-assistant','writer','s01','s02','s03','s04','s05','s06','s07','s08','s09']
const PHOTOS = new Set(PHOTO_KEYS)

function kindOf(token) {
  const t = String(token ?? '').trim()
  if (!TOKEN_RE.test(t)) return 'ILLEGAL=placeholder'
  const slot = resolveSlot(t)
  if (slot === null) return 'valid-token-but-NO-SLOT=placeholder'
  return PHOTOS.has(slot.key) ? 'PHOTO:' + slot.key : 'VECTOR:' + slot.key
}

// ── 复算 GET /api/roster 的合成逻辑（team-hub/routes/team-views.mjs:74-120）──
const scopes = [...new Set([
  ...db.prepare("SELECT DISTINCT scope FROM roster WHERE scope != ''").all().map(r => r.scope),
  ...db.prepare("SELECT DISTINCT scope FROM tasks WHERE scope IS NOT NULL AND scope != ''").all().map(r => r.scope),
])].sort()
let totalIllegal = 0, totalExternal = 0
for (const scope of scopes) {
  const roster = db.prepare('SELECT role, name, avatar FROM roster WHERE scope = ? ORDER BY sort, role').all(scope)
  const rosterRoles = new Set(roster.map(r => r.role))
  const tasks = db.prepare('SELECT id, status, role, soldier FROM tasks WHERE scope = ?').all(scope)
  const bySoldier = new Map()
  for (const t of tasks) {
    if (t.status === 'canceled' || !t.soldier) continue
    if (rosterRoles.has(t.role ?? t.soldier)) continue
    const arr = bySoldier.get(t.soldier) ?? []; arr.push(t.id + ':' + t.status); bySoldier.set(t.soldier, arr)
  }
  const badRoster = roster.filter(r => kindOf(r.avatar) === 'ILLEGAL=placeholder')
  console.log('')
  console.log('== scope ' + scope + ' | roster ' + roster.length + ' | 非法令牌 roster ' + badRoster.length + ' | external ' + bySoldier.size)
  for (const r of roster) console.log('   roster   ' + r.role.padEnd(22) + ' | ' + String(r.name).padEnd(9) + ' | ' + String(r.avatar).padEnd(22) + ' -> ' + kindOf(r.avatar))
  for (const [soldier, ids] of bySoldier) {
    totalExternal += 1
    totalIllegal += 1
    console.log('   EXTERNAL ' + soldier.padEnd(22) + ' | name="' + soldier + ' · 执行中" | avatar="\u2699\uFE0F" (team-views.mjs:119 硬编码) -> ' + kindOf('\u2699\uFE0F') + '   tasks=' + ids.join(','))
  }
}
console.log('')
console.log('TOTAL: 渲染成同一张灰阶占位人形的条目 = ' + totalIllegal + '（其中 software 的 4 条 = 本目标对象）')

// ── 供给盘点 ──
const used = new Set(db.prepare("SELECT DISTINCT avatar FROM roster").all().map(r => String(r.avatar ?? '').trim()))
const usedPhotoKeys = [...used].map(t => (resolveSlot(t) || {}).key).filter(k => k !== undefined)
console.log('')
console.log('图片资产：' + PHOTOS.size + ' 个 key；被 roster 实际使用的图片 key = ' + new Set(usedPhotoKeys.filter(k => PHOTOS.has(k))).size + ' / ' + PHOTOS.size)
const spareAll = slotKeys().filter(k => /^s[0-9]+$/.test(k))
const spareUsed = spareAll.filter(k => used.has('human:' + k))
const spareFree = spareAll.filter(k => !used.has('human:' + k))
console.log('备用位面：共 ' + spareAll.length + ' 个；全库已占用 ' + spareUsed.join(',') + '；空闲 ' + spareFree.join(','))
const sig = (k) => { const s = resolveSlot('human:' + k); return [s.skin,s.hair,s.hairStyle,s.top,s.accessory,s.background].join('|') }
const allSigs = new Set(slotKeys().map(sig))
console.log('位面表：' + slotKeys().length + ' 个 key，两两不同的特征签名 = ' + allSigs.size + '（构造性唯一）')
for (const k of spareFree) console.log('   空闲位面 ' + k + ' -> ' + JSON.stringify(resolveSlot('human:' + k)) + ' | 有图? ' + renderAvatar('human:' + k, 24).startsWith('<img'))

// ── 两个关键反例 ──
console.log('')
console.log('反例 1：合法令牌但未登记 key —— human:general 与空串渲染结果相同? ' + (renderAvatar('human:general', 32) === renderAvatar('', 32)) + '（是 ⇒ 写进库里等于什么都没做）')
console.log('反例 2：已登记的空闲位面 human:s11 与占位人形相同? ' + (renderAvatar('human:s11', 32) === renderAvatar('', 32)) + '（否 ⇒ 真的换了脸）')
console.log('占位人形 PLACEHOLDER_SLOT = ' + JSON.stringify(PLACEHOLDER_SLOT))
db.close()