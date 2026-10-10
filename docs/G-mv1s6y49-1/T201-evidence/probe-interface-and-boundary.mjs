// docs/G-mv1s6y49-1/T201-evidence/probe-interface-and-boundary.mjs
// T-201（tester）接口/边界探针：补齐六支新套件未覆盖的可执行用例
// （TC-S3-14 role 长度三值 / TC-S3-15 无身份被拒 / TC-S3-17 kind 缺省与 sort / TC-S1-13 size 三值 /
//  T-200 建议 S1 的"格式合法但不在位面表"令牌）。仅用临时库，不改任何仓库文件。
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const dir = mkdtempSync(join(tmpdir(), 'legion-t201-iface-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import(pathToFileURL(join(ROOT, 'team-hub', 'server.mjs')).href)
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port
const post = async (body, withBy = true) => {
  const payload = withBy ? Object.assign({ by: 'general' }, body) : body
  const res = await fetch(base + '/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  return res.status
}
const row = (scope, role) => mod.db.prepare('SELECT * FROM roster WHERE scope = ? AND role = ?').get(scope, role)
const clear = () => mod.db.prepare('DELETE FROM roster').run()
const out = []
const log = (s) => { out.push(s); console.log(s) }

log('# T-201 接口/边界探针  node=' + process.versions.node)

// TC-S3-14 role 长度三值：63/64/65
clear()
const lens = []
for (const n of [63, 64, 65]) { const st = await post({ scope: 'software', role: 'a'.repeat(n), name: '测试' }); lens.push(n + '=' + st) }
log('PROBE-A role 长度 63/64/65 → HTTP ' + lens.join(' ') + '  预期 63/64=2xx 65=400')

// TC-S3-17 kind 缺省 + sort 稳定递增
clear()
await post({ scope: 'software', role: 'coder', name: '衡码' })
const k = row('software', 'coder').kind
await post({ scope: 'software', role: 'aa-role', name: '甲' })
await post({ scope: 'software', role: 'bb-role', name: '乙' })
const sorts = mod.db.prepare("SELECT role, sort FROM roster WHERE scope='software' ORDER BY sort").all()
log('PROBE-B kind 缺省落库=' + JSON.stringify(k) + '（预期 ""）')
log('PROBE-B sort 递增序列=' + JSON.stringify(sorts) +
    '  严格递增=' + sorts.every((r, i) => i === 0 || r.sort > sorts[i - 1].sort))

// TC-S3-15 无操作者身份被拒 + 库零写入
clear()
const stNoBy = await post({ scope: 'software', role: 'coder', name: '衡码' }, false)
log('PROBE-C 无 by 字段 POST → HTTP ' + stNoBy + '  库行数=' + mod.db.prepare('SELECT COUNT(*) c FROM roster').get().c + '（预期 400 + 0）')

// T-200 建议 S1：格式合法但不在位面表的令牌被原样接受
clear()
await post({ scope: 'software', role: 'coder', name: '衡码', avatar: 'human:zzz' })
log('PROBE-D 显式传 human:zzz → 落库=' + JSON.stringify(row('software', 'coder').avatar) +
    '（格式合法即被接受；两端口位面表均无 zzz → 渲染退化为占位人形）')

// TC-S3-13 非法字符串不原样落库
clear()
for (const bad of ['not-a-token', '<img src=x onerror=alert(1)>', '🤖🦊']) {
  await post({ scope: 'software', role: 'coder', name: '衡码', avatar: bad })
  log('PROBE-E 显式传 ' + JSON.stringify(bad) + ' → 落库=' + JSON.stringify(row('software', 'coder').avatar))
}

// TC-S1-13 桌面 AgentAvatar size 三值/非法值（真渲染）
const wbRequire = createRequire(join(ROOT, 'workbench', 'package.json'))
const ts = wbRequire('typescript')
const react = wbRequire('react')
const { renderToString } = wbRequire('react-dom/server')
// 转译产物写到 workbench/scripts/ 下，保证 'react/jsx-runtime' 能从 workbench/node_modules 解析（同 agent-avatar.test.mjs）
const tmpSlots = join(ROOT, 'workbench', 'scripts', '.t201-probe.slots.mjs')
const tmpAvatar = join(ROOT, 'workbench', 'scripts', '.t201-probe.avatar.mjs')
const transpile = (from, to, rewrite) => {
  const o = ts.transpileModule(readFileSync(from, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } })
  let code = o.outputText
  if (rewrite) code = code.replace(/['"]\.\/slots['"]/g, "'.\/.t201-probe.slots.mjs'")
  writeFileSync(to, code, 'utf8')
}
transpile(join(ROOT, 'workbench', 'src', 'avatar', 'slots.ts'), tmpSlots, false)
transpile(join(ROOT, 'workbench', 'src', 'avatar', 'AgentAvatar.tsx'), tmpAvatar, true)
const AgentAvatar = (await import(pathToFileURL(tmpAvatar).href)).default
const render = (size) => renderToString(react.createElement(AgentAvatar, { token: 'human:coder', size }))
const wh = (html) => (html.match(/width="(\d+)"/) || [])[1]
log('PROBE-F AgentAvatar token=human:coder size 0/-1/1024/64/缺省 → width=' +
    [0, -1, 1024, 64, undefined].map((s) => String(s) + ':' + wh(render(s))).join(' ') + '（预期 0/-1/1024/缺省=32，64=64）')

writeFileSync(join(HERE, 'probe-interface-output.txt'), out.join('\n') + '\n', 'utf8')
try { mod.server.closeAllConnections?.() } catch { /* */ }
try { mod.server.close() } catch { /* */ }
try { mod.db.close() } catch { /* */ }
try { rmSync(tmpSlots, { force: true }) } catch { /* */ }
try { rmSync(tmpAvatar, { force: true }) } catch { /* */ }
try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
console.log('PROBE-DONE wrote probe-interface-output.txt')
