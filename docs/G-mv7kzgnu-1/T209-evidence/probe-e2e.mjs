// docs/G-mv7kzgnu-1/T209-evidence/probe-e2e.mjs
// T-209 tester 的端到端探针（E2E-1/2/3/4/6 口径）——**只读 live 库 + 快照副本上起真 hub**。
//
//   ① 用 node:sqlite(readOnly) 对 live team.db 做一次一致性快照（VACUUM INTO）；
//   ② TEAM_HUB_DB 指向快照，import team-hub/server.mjs 并在 127.0.0.1:0 真监听；
//   ③ 通过真 HTTP 抓 /api/roster、/api/agents、/api/spaces，按 TEST_CASES.md §4.6 判据计算；
//   ④ 位面解析用 workbench/mobile/avatar.mjs 的 resolveSlot（与桌面 slots.ts 由 parity 锁死）。
//
// 用法：
//   node docs/G-mv7kzgnu-1/T209-evidence/probe-e2e.mjs --state=st1.json
//   node docs/G-mv7kzgnu-1/T209-evidence/probe-e2e.mjs --compare=st1.json --state=st2.json
//
// 边界：不写 live 库（readOnly 快照）；只写 --state/--compare 指定的 JSON 与临时快照目录。

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = process.cwd()
const LIVE_DB = process.env.LIVE_DB || 'D:/project/DSH/legion/team-hub/team.db'
const argv = process.argv.slice(2)
const pick = (name) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3).trim() : null
}
const statePath = pick('state')
const comparePath = pick('compare')

const dir = mkdtempSync(join(tmpdir(), 't209-e2e-'))
const snapshot = join(dir, 'team.db')

// ① 一致性快照（readOnly 源；VACUUM INTO 不修改源库）
const stat = statSync(LIVE_DB)
const ro = new DatabaseSync(LIVE_DB, { readOnly: true })
ro.exec("VACUUM INTO '" + snapshot.replace(/'/g, "''") + "'")
ro.close()

// ② 起真 hub（快照库副本）
process.env.TEAM_HUB_DB = snapshot
process.env.TEAM_HUB_TOKEN = ''
const mod = await import(pathToFileURL(resolve(ROOT, 'team-hub/server.mjs')).href)
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port
const getJson = async (p) => {
  const res = await fetch(base + p)
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

const { isAvatarToken } = await import(pathToFileURL(resolve(ROOT, 'team-hub/agent-avatars.mjs')).href)
const mobile = await import(pathToFileURL(resolve(ROOT, 'workbench/mobile/avatar.mjs')).href)
const { resolveSlot, photoFileFor } = mobile

const NAMED = ['general', 'soldier-a', 'soldier-b', 'soldier-auto', 'soldier-market']
const badToken = (v) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s !== '' && !isAvatarToken(s)
}
const unresolved = (v) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s !== '' && (unresolvedInternal(s))
}
const unresolvedInternal = (s) => s !== '' && resolveSlot(s) === null
const r1fail = (v) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' || !isAvatarToken(s) || resolveSlot(s) === null
}
const describe = (a) => ({
  role: a.role,
  avatar: a.avatar ?? '',
  resolvedKey: resolveSlot(a.avatar) ? resolveSlot(a.avatar).key : null,
  photo: resolveSlot(a.avatar) ? photoFileFor(resolveSlot(a.avatar).key) : null,
  external: !!a.external,
  scope: a.scope,
})

const out = { env: { node: process.version, cwd: ROOT, liveDb: LIVE_DB, liveDbBytes: stat.size, liveDbMtime: stat.mtime.toISOString(), snapshot } }

// ── DB 基线（用于 E2E-6 无副作用） ──
const dbRows = () => ({
  rosterCount: mod.db.prepare('SELECT COUNT(*) AS n FROM roster').get().n,
  taskCount: mod.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
  rosterByScope: Object.fromEntries(mod.db.prepare('SELECT scope, COUNT(*) AS n FROM roster GROUP BY scope ORDER BY scope').all().map((r) => [r.scope, r.n])),
  taskOwners: mod.db.prepare('SELECT id, scope, role, soldier FROM tasks ORDER BY id').all().map((r) => [r.id, r.scope ?? '', r.role ?? '', r.soldier ?? '']),
})
const before = dbRows()

// ── E2E-1 / 2 / 3 / 4 / 6 ──
const sw = await getJson('/api/roster?scope=software')
const swAgents = sw.body.agents ?? []
const swBad = swAgents.filter((a) => r1fail(a.avatar))
const swExternal = swAgents.filter((a) => a.external)
out.e2e1 = {
  httpStatus: sw.status,
  softwareAgents: swAgents.length,
  invalidCount: swBad.length,
  invalid: swBad.map(describe),
  external: swExternal.map(describe),
}

const all = await getJson('/api/roster')
const agents = await getJson('/api/agents')
const rosterAgents = all.body.agents ?? []
const agentList = agents.body.agents ?? []
out.e2e2 = {
  rosterHttpStatus: all.status,
  rosterTotal: rosterAgents.length,
  rosterInvalidNonEmpty: rosterAgents.filter((a) => badToken(a.avatar)).length,
  rosterEmojiAvatar: rosterAgents.filter((a) => /[\u{1F300}-\u{1FAFF}\u2699]/u.test(String(a.avatar ?? ''))).length,
  rosterEmptyAvatar: rosterAgents.filter((a) => String(a.avatar ?? '').trim() === '').length,
  agentsHttpStatus: agents.status,
  agentsTotal: agentList.length,
  agentsInvalidNonEmpty: agentList.filter((a) => badToken(a.avatar)).length,
  agentInvalidList: agentList.filter((a) => badToken(a.avatar)).map((a) => ({ role: a.role, avatar: a.avatar })),
}

// E2E-3：software 12 条（8 内编 + 4 外部）三轴去重
const swAvatars = swAgents.map((a) => String(a.avatar ?? '').trim())
const swKeys = swAgents.map((a) => (resolveSlot(a.avatar) ? resolveSlot(a.avatar).key : null))
const swPhotos = swAgents.map((a) => {
  const s = resolveSlot(a.avatar)
  if (!s) return null
  return photoFileFor(s.key) ?? ('vector:' + s.key)
})
out.e2e3 = {
  total: swAgents.length,
  distinctAvatars: new Set(swAvatars).size,
  distinctKeys: new Set(swKeys).size,
  distinctPhotos: new Set(swPhotos).size,
  avatars: swAvatars,
  keys: swKeys,
  photos: swPhotos,
  externalKeys: swExternal.map((a) => (resolveSlot(a.avatar) ? resolveSlot(a.avatar).key : null)),
  builtinKeys: swAgents.filter((a) => !a.external).map((a) => (resolveSlot(a.avatar) ? resolveSlot(a.avatar).key : null)),
}

// E2E-4：连续 3 次 + 其它空间内编令牌
const repeats = []
for (let i = 0; i < 3; i += 1) {
  const r = await getJson('/api/roster?scope=software')
  repeats.push((r.body.agents ?? []).filter((a) => a.external).map((a) => [a.role, a.avatar]))
}
const ozon = await getJson('/api/roster?scope=ozon')
const ozonMarket = (ozon.body.agents ?? []).filter((a) => a.role === 'soldier-market').map(describe)
const otherSpaces = {}
for (const scope of [...new Set(rosterAgents.map((a) => a.scope))].filter((s) => s !== 'software').sort()) {
  const r = await getJson('/api/roster?scope=' + encodeURIComponent(scope))
  otherSpaces[scope] = (r.body.agents ?? []).map((a) => [a.role, String(a.avatar ?? '').trim()])
}
out.e2e4 = {
  repeatsStable: JSON.stringify(repeats[0]) === JSON.stringify(repeats[1]) && JSON.stringify(repeats[1]) === JSON.stringify(repeats[2]),
  repeats,
  ozonMarket,
  otherSpaces,
}

// E2E-6：无副作用 + agentCount 一致性
const spaces = await getJson('/api/spaces')
const spaceList = spaces.body.spaces ?? []
const agentCountByName = Object.fromEntries(spaceList.map((s) => [s.id, s.agentCount]))
const rosterByScope = before.rosterByScope
const agentCountMismatch = spaceList
  .filter((s) => (rosterByScope[s.id] ?? 0) !== s.agentCount)
  .map((s) => ({ id: s.id, agentCount: s.agentCount, rosterRows: rosterByScope[s.id] ?? 0 }))
const after = dbRows()
out.e2e6 = {
  rosterCountBefore: before.rosterCount,
  rosterCountAfter: after.rosterCount,
  taskCountBefore: before.taskCount,
  taskCountAfter: after.taskCount,
  tasksUnchanged: JSON.stringify(before.taskOwners) === JSON.stringify(after.taskOwners),
  agentCountMismatch,
  agentCountByName,
  agentsRoleSetMatchesRoster: JSON.stringify([...new Set(agentList.map((a) => a.role))].sort()) ===
    JSON.stringify([...new Set(mod.db.prepare('SELECT DISTINCT role FROM roster').all().map((r) => r.role))].sort()),
}

// ── 跨重启对比 ──
if (comparePath) {
  const prev = JSON.parse(readFileSync(comparePath, 'utf8'))
  const named = (o) => Object.fromEntries((o ?? []).filter((x) => NAMED.includes(x.role)).map((x) => [x.role, x.avatar]))
  const curNamed = named(out.e2e1.external)
  const prevNamed = named(prev.e2e1.external)
  out.restart = {
    prevSnapshot: prev.env.snapshot,
    curSnapshot: out.env.snapshot,
    namedStable: JSON.stringify(curNamed) === JSON.stringify(prevNamed),
    prevNamed,
    curNamed,
    ozonMarketStable: JSON.stringify(out.e2e4.ozonMarket) === JSON.stringify(prev.e2e4.ozonMarket),
    otherSpacesStable: JSON.stringify(out.e2e4.otherSpaces) === JSON.stringify(prev.e2e4.otherSpaces),
  }
}

console.log(JSON.stringify(out, null, 2))
if (statePath) writeFileSync(statePath, JSON.stringify(out, null, 2), 'utf8')

try { mod.server.closeAllConnections?.() } catch { /* noop */ }
try { mod.server.close?.() } catch { /* noop */ }
try { mod.db.close?.() } catch { /* noop */ }
try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
process.exit(0)
