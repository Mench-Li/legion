// scratch/_mutate-path-roles.mjs —— 破验 `product/paths.mjs` 的目录角色接线
//
// ★ 规矩（第 40 轮立的）：新进程跑 / 换行无关（CRLF）/ 覆盖每一行 /
//   不许假变异体（两版行为完全相同 ⇒ 永远不咬，会被读成"判据漏了"）。
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = 'D:/project/DSH/legion'
const TARGET = 'product/paths.mjs'
const SUITE = 'product/paths.test.mjs'
const snap = (p) => createHash('sha256').update(readFileSync(`${ROOT}/${p}`)).digest('hex')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')
const write = (p, s) => writeFileSync(`${ROOT}/${p}`, s)
const toRe = (s) => new RegExp(s.split('\n').map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n'))
const toFile = (s) => s.replace(/\r?\n/g, '\r\n')

const MUTANTS = [
  {
    // 修之前那个真形状之一：兜底分支把任何新角色当成 logDir。
    name: 'M1 遍历 DIR_ROLES 的兜底改回"最后一个字段"（新角色冒充 logDir）',
    file: TARGET,
    find: '  for (const role of DIR_ROLES) out[role] = DIR_ROLE_READERS[role](layout)',
    repl: '  for (const role of DIR_ROLES) out[role] = DIR_ROLE_READERS[DIR_ROLES.includes(role) ? "log" : role](layout)',
  },
  {
    name: 'M2 取法表把 cache 与 log 指向同一个字段（两个角色读同一个目录）',
    file: TARGET,
    find: '  cache: (l) => l?.cacheDir ?? null,',
    repl: '  cache: (l) => l?.logDir ?? null,',
  },
  {
    // ★★ M3/M4 最初**漏网**，查下来是"行为完全等价"：手写四元对象与
    //    `DIR_ROLES.slice(1,5)` 在今天（声明正好是四个可写角色）与遍历
    //    `WRITABLE_ROLES` 得到的结果**一模一样**，任何行为用例都分不开。
    //    ⇒ 把角色清单做成可注入的（`writableDirsInsideInstall`），
    //      用例才能拿**第五个**角色去试；这两条这才咬得住。
    name: 'M3 角色清单改回手写的四元对象（WRITABLE_ROLES 声明即失效）',
    file: TARGET,
    find: "  for (const role of writableRoles) {\n    const reader = readers[role]",
    repl: "  const _hand = ['data', 'workspace', 'cache', 'log']\n  for (const role of _hand) {\n    const reader = readers[role]",
  },
  {
    name: 'M4 改成遍历 DIR_ROLES 的前四个（顺序敏感，加角色就错位）',
    file: TARGET,
    find: '  for (const role of writableRoles) {',
    repl: '  for (const role of DIR_ROLES.slice(1, 5)) {',
  },
  {
    name: 'M5 ★ 接线守卫关掉（声明了没取法不再抛 ⇒ 回到静默）',
    file: TARGET,
    find: '    ok: unwired.length === 0 && orphanReader.length === 0 && notADirRole.length === 0,',
    repl: '    ok: true,',
  },
  {
    name: 'M6 守卫只查"没取法"、不查"可写角色不在目录角色里"（半个守卫）',
    file: TARGET,
    find: '  const notADirRole = writableRoles.filter((r) => !declared.has(r))',
    repl: '  const notADirRole = writableRoles.filter((r) => false)',
  },
  {
    name: 'M7 取法表把一整个角色漏掉（install 无取法 ⇒ 守卫必须抛）',
    file: TARGET,
    find: '  install: (l) => l?.installDir ?? null,\n',
    repl: '',
  },
  {
    name: 'M8 绝对路径检查整段跳过（假绿：什么都没查）',
    file: TARGET,
    find: "    if (!api.isAbsolute(value)) {\n      add('error', 'PATH_NOT_ABSOLUTE', role,",
    repl: "    if (false) {\n      add('error', 'PATH_NOT_ABSOLUTE', role,",
  },
  {
    name: 'M9 安装目录包含检查整段跳过（假绿）',
    file: TARGET,
    find: '    if (isPathInside(installDir, value, platform) || samePath(installDir, value, platform)) {',
    repl: '    if (false) {',
  },
  {
    name: 'M10 可写角色表把 install 也列进去（与"安装目录内不得有可写角色"自相矛盾）',
    file: TARGET,
    find: "export const WRITABLE_ROLES = Object.freeze(['data', 'workspace', 'cache', 'log'])",
    repl: "export const WRITABLE_ROLES = Object.freeze(['install', 'data', 'workspace', 'cache', 'log'])",
  },
]

const before = snap(TARGET)
let bitten = 0
const escaped = []
const notFound = []

for (const m of MUTANTS) {
  const src = read(m.file)
  const re = toRe(m.find)
  if (!re.test(src)) {
    notFound.push(m.name)
    console.log(`  ⚠ 变异串没找到：${m.name}`)
    continue
  }
  write(m.file, src.replace(re, () => toFile(m.repl)))
  let failed = false
  try {
    execFileSync('node', ['--test', SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 600000 })
  } catch {
    failed = true
  }
  write(m.file, src)
  const restored = snap(m.file) === before
  if (failed) {
    bitten += 1
    console.log(`  ✔ 咬住（用例红）：${m.name}${restored ? '' : '  ⚠ 还原失败！'}`)
  } else {
    escaped.push(m.name)
    console.log(`  ✖ 漏网（用例仍绿）：${m.name}`)
  }
  if (!restored) throw new Error(`还原不是逐字节的：${m.file}`)
}

const finalOk = snap(TARGET) === before
console.log(`\n变异 ${bitten}/${MUTANTS.length} 咬住；漏网 ${escaped.length}；`
  + `变异串没找到 ${notFound.length}；还原逐字节 ${finalOk}`)
if (escaped.length > 0 || notFound.length > 0 || !finalOk) process.exit(1)
execFileSync('node', ['--test', SUITE], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 600000 })
console.log('还原后 26/26 复绿')
