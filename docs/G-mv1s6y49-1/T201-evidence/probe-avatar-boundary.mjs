// docs/G-mv1s6y49-1/T201-evidence/probe-avatar-boundary.mjs
// T-201（tester）一次性只读探针：独立复现 T-200 审查的 M1（备用位面池越界）与 M2（重复 POST 漂移），
// 并顺手取数据面（25 名成员名单 / 令牌 / 跨空间一致）证据。仅用临时库，不写 live 库、不改任何仓库文件。
// 运行：node docs/G-mv1s6y49-1/T201-evidence/probe-avatar-boundary.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const dir = mkdtempSync(join(tmpdir(), 'legion-t201-probe-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''

const mod = await import(pathToFileURL(join(ROOT, 'team-hub', 'server.mjs')).href)
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port
const post = async (body) => {
  const res = await fetch(base + '/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ by: 'general' }, body)) })
  return { status: res.status, text: await res.text() }
}
const row = (scope, role) => mod.db.prepare('SELECT * FROM roster WHERE scope = ? AND role = ?').get(scope, role)
const clear = () => mod.db.prepare('DELETE FROM roster').run()

const out = []
const log = (s) => { out.push(s); console.log(s) }

log('# T-201 探针输出  env.node=' + process.versions.node)

// ── PROBE-1：同一自建 role 重复 POST 的头像漂移（M2） ──────────────────────
clear()
const seq = []
let statuses = []
for (let i = 0; i < 3; i += 1) {
  const res = await post({ scope: 'software', role: 'hr-analyst', name: '甄才' })
  statuses.push(res.status)
  seq.push(row('software', 'hr-analyst').avatar)
}
log('PROBE-1 重复 POST (software,hr-analyst) x3  HTTP=' + statuses.join('/') +
    '  落库 avatar: ' + seq.join(' -> ') +
    '  => ' + (new Set(seq).size === 1 ? 'STABLE' : 'DRIFT'))

// ── PROBE-2：备用池边界（第 16 个自建 role）（M1） ──────────────────────────
clear()
const toks = []
for (let i = 1; i <= 16; i += 1) {
  const role = 'custom-' + String(i).padStart(2, '0')
  await post({ scope: 'software', role, name: '自建' + i })
  toks.push(row('software', role).avatar)
}
log('PROBE-2 连续 16 个自建 role 落库 avatar: ' + toks.join(', '))
log('PROBE-2 第 16 个令牌=' + toks[15] + '（第 1..15=' + toks.slice(0, 15).join(',') + '）')

const mob = await import(pathToFileURL(join(ROOT, 'workbench', 'mobile', 'avatar.mjs')).href)
const mkeys = mob.slotKeys()
log('PROBE-2 移动端位面表 slotKeys 长度=' + mkeys.length + ' 含s15=' + mkeys.includes('s15') + ' 含s16=' + mkeys.includes('s16'))
log('PROBE-2 移动端 resolveSlot("human:s16")=' + JSON.stringify(mob.resolveSlot('human:s16')))
log('PROBE-2 移动端 renderAvatar("human:s16") === renderAvatar(null)（是否退化为占位）: ' +
    (mob.renderAvatar('human:s16') === mob.renderAvatar(null)))
log('PROBE-2 移动端两个不同自建令牌渲染是否相同: ' + (mob.renderAvatar('human:s16') === mob.renderAvatar('human:s15')))

// 桌面真源 slots.ts：用 typescript 转译后真跑 resolveSlot / slotKeys
const wbRequire = createRequire(join(ROOT, 'workbench', 'package.json'))
const ts = wbRequire('typescript')
const tmp = mkdtempSync(join(tmpdir(), 'legion-t201-slots-'))
const transpiled = ts.transpileModule(
  (await import('node:fs')).readFileSync(join(ROOT, 'workbench', 'src', 'avatar', 'slots.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText
const slotsPath = join(tmp, 'slots.mjs')
writeFileSync(slotsPath, transpiled, 'utf8')
const slots = await import(pathToFileURL(slotsPath).href)
const dkeys = slots.slotKeys()
log('PROBE-2 桌面真源 slots.ts slotKeys 长度=' + dkeys.length + ' 含s15=' + dkeys.includes('s15') + ' 含s16=' + dkeys.includes('s16'))
log('PROBE-2 桌面真源 resolveSlot("human:s16")=' + JSON.stringify(slots.resolveSlot('human:s16')))

// ── PROBE-3：数据面 25 名成员名单（seed） ─────────────────────────────────
clear()
mod.db.prepare('DELETE FROM spaces').run()
const seed = await import(pathToFileURL(join(ROOT, 'team-hub', 'scripts', 'seed-roster.mjs')).href)
seed.applyRosterSeed(mod.db, { quiet: true })
const all = mod.db.prepare('SELECT scope, role, name, kind, avatar FROM roster ORDER BY scope, role').all()
log('PROBE-3 播种后成员数=' + all.length)
for (const r of all) log('  ' + [r.scope, r.role, r.name, r.kind, r.avatar].join(' | '))
const dup = mod.db.prepare('SELECT scope, name, COUNT(*) c FROM roster GROUP BY scope, name HAVING c > 1').all()
log('PROBE-3 同空间重名行数=' + dup.length)
const perRole = mod.db.prepare('SELECT role, COUNT(DISTINCT name) n, COUNT(DISTINCT avatar) a FROM roster GROUP BY role').all()
log('PROBE-3 跨空间同 role name/avatar 分叉数=' + perRole.filter(r => r.n !== 1 || r.a !== 1).length)

writeFileSync(join(HERE, 'probe-output.txt'), out.join('\n') + '\n', 'utf8')
try { mod.server.closeAllConnections?.() } catch { /* 无连接 */ }
try { mod.server.close() } catch { /* 已关 */ }
try { mod.db.close() } catch { /* 已关 */ }
try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄延迟 */ }
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄延迟 */ }
console.log('PROBE-DONE wrote ' + join(HERE, 'probe-output.txt'))
