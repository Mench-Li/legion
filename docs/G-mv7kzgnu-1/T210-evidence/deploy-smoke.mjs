// docs/G-mv7kzgnu-1/T210-evidence/deploy-smoke.mjs
// T-210 devops 的部署冒烟探针 —— **只读 live 库快照 + 进程内真 hub + 真 HTTP**。
//
//   ① node:sqlite(readOnly) 对 live team.db 做一次一致性快照（VACUUM INTO，不写源库）；
//   ② TEAM_HUB_DB 指向快照，import team-hub/server.mjs 并在 127.0.0.1:0 真监听（等价于部署后起服务）；
//   ③ 真 HTTP 抓 /api/roster?scope=software，按 R-1 判据（合法令牌 且 resolveSlot 命中）统计；
//   ④ 位面解析用 workbench/mobile/avatar.mjs 的 resolveSlot（与桌面 slots.ts 由 parity 锁死）。
//
// 用法：node docs/G-mv7kzgnu-1/T210-evidence/deploy-smoke.mjs --out <path.json>
// 退出码：0 = 部署冒烟通过（software 不满足 R-1 的条数 = 0 且 4 条外部条目令牌合法）。

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = process.cwd()
const LIVE_DB = process.env.LIVE_DB || 'D:/project/DSH/legion/team-hub/team.db'
const argv = process.argv.slice(2)
const pick = (n) => { const h = argv.find((a) => a.startsWith('--' + n + '=')); if (h) return h.slice(n.length + 3).trim(); const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1].trim() : null }
const outPath = pick('out')

const dir = mkdtempSync(join(tmpdir(), 't210-smoke-'))
const snapshot = join(dir, 'team.db')
const stat = statSync(LIVE_DB)
const ro = new DatabaseSync(LIVE_DB, { readOnly: true })
ro.exec("VACUUM INTO '" + snapshot.replace(/'/g, "''") + "'")
ro.close()

process.env.TEAM_HUB_DB = snapshot
process.env.TEAM_HUB_TOKEN = ''
const mod = await import(pathToFileURL(resolve(ROOT, 'team-hub/server.mjs')).href)
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port
const getJson = async (p) => { const res = await fetch(base + p); return { status: res.status, body: await res.json() } }

const { isAvatarToken } = await import(pathToFileURL(resolve(ROOT, 'team-hub/agent-avatars.mjs')).href)
const mobile = await import(pathToFileURL(resolve(ROOT, 'workbench/mobile/avatar.mjs')).href)
const { resolveSlot } = mobile

const NAMED = ['general', 'soldier-a', 'soldier-b', 'soldier-auto']
const r1fail = (v) => { const s = String(v ?? '').trim(); return s === '' || !isAvatarToken(s) || resolveSlot(s) === null }
const desc = (a) => ({ role: a.role, avatar: a.avatar ?? '', key: resolveSlot(a.avatar)?.key ?? null, external: !!a.external })

const sw = await getJson('/api/roster?scope=software')
const agents = sw.body.agents ?? []
const ext = agents.filter((a) => a.external)
const bad = agents.filter((a) => r1fail(a.avatar))
const named = Object.fromEntries(ext.filter((a) => NAMED.includes(a.role)).map((a) => [a.role, a.avatar]))
const namedOk = NAMED.every((n) => !r1fail(named[n]))
const distinct = new Set(agents.map((a) => String(a.avatar ?? '').trim())).size

const out = {
  tool: 'T-210 deploy-smoke',
  at: new Date().toISOString(),
  env: { node: process.version, cwd: ROOT, liveDb: LIVE_DB, liveDbBytes: stat.size, liveDbMtime: stat.mtime.toISOString() },
  http: { status: sw.status, endpoint: base + '/api/roster?scope=software' },
  software: { agents: agents.length, external: ext.length, invalidCount: bad.length, invalid: bad.map(desc) },
  externalNamed: named,
  externalNamedOk: namedOk,
  distinctAvatarsInSoftware: distinct,
  external: ext.map(desc),
  verdict: bad.length === 0 && ext.length === 4 && namedOk && distinct === agents.length ? 'PASS' : 'FAIL',
}
const text = JSON.stringify(out, null, 2)
if (outPath) writeFileSync(outPath, text + '\n')
console.log(text)
try { mod.server.close() } catch {}
try { rmSync(dir, { recursive: true, force: true }) } catch {}
process.exit(out.verdict === 'PASS' ? 0 : 1)
