// T-078 模块级小探针（TC-S1-03 / G-8 细节）：根 list 中 subrepo 条目 isRepo=true、.git 隐藏；list 进入 .git → 403
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const serveUrl = pathToFileURL(require.resolve('../../workbench/scripts/serve.mjs')).href + '?probe=' + Date.now()
const m = await import(serveUrl)

const root = mkdtempSync(join(tmpdir(), 't078-g8-'))
mkdirSync(join(root, 'subrepo', '.git', 'objects', 'pack'), { recursive: true })
writeFileSync(join(root, 'subrepo', '.git', 'config'), 'x')
writeFileSync(join(root, 'subrepo', 'readme.txt'), 'ok')
process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([{ id: 'fx', name: 'fx', localDir: root }])
try {
  const rootDir = await m.resolveScopeLocalDir('fx')
  const rootList = m.listDirEntries(rootDir, '')
  const sub = rootList.entries.find((e) => e.name === 'subrepo')
  console.log('root list: subrepo entry =', JSON.stringify(sub))
  console.log('hidden entries in root list:', rootList.entries.filter((e) => e.name.startsWith('.')))
  const subList = m.listDirEntries(rootDir, 'subrepo')
  console.log('subrepo list names:', subList.entries.map((e) => e.name))
  console.log('subrepo list has .git entry:', subList.entries.some((e) => e.name === '.git'))
  // 控制组：无 .git 的普通目录
  mkdirSync(join(root, 'plain'))
  const plain = rootList.entries.find((e) => e.name === 'plain')
  console.log('plain dir isRepo:', plain ? plain.isRepo : 'MISSING(应在 rootList)')
  // 直接列出 .git 内部 → 应抛「禁止访问 .git」
  try { m.listDirEntries(rootDir, 'subrepo/.git'); console.log('list subrepo/.git: NO THROW (FAIL)') }
  catch (e) { console.log('list subrepo/.git throws:', e.message) }
} finally {
  delete process.env.DSH_WORKBENCH_SPACES_JSON
  rmSync(root, { recursive: true, force: true })
}
