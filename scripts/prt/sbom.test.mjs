// scripts/prt/sbom.test.mjs
// ============================================================================
// PRT-901 / PRT-902 的生产入口判据。
//
// 这里盯的是**报表的形状**，不是数值：数值随仓库变化，形状不会。
// 一条断言"当前有 43 个依赖"的用例会在仓库正常演进时变红，
// 却证明不了判据本身是否在。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, rmSync } from 'node:fs'

import { discoverVendoredTrees, generate, parseArgs, render, VENDORED_ROOTS } from './sbom.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(ROOT, 'scripts', 'prt', 'sbom.mjs')

function runCli(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT }) }
  } catch (e) { return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` } }
}

/** 假磁盘：`{ 路径: 'dir'|内容 | null }`，null 表示读不了。 */
function fakeIo(tree) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '') || '.'
  const kids = new Map()
  for (const [p, kind] of Object.entries(tree)) {
    const key = norm(p)
    const parts = key.split('/')
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/') || '.'
      if (!kids.has(parent)) kids.set(parent, [])
      if (!kids.get(parent).includes(parts[i])) kids.get(parent).push(parts[i])
    }
  }
  const dirs = new Set(Object.entries(tree).filter(([, v]) => v === 'dir').map(([k]) => norm(k)))
  return {
    listDir: (d) => {
      const here = norm(d)
      return (kids.get(here) ?? []).map((n) => {
        const child = here === '.' ? n : `${here}/${n}`
        return { name: n, isDirectory: () => dirs.has(child) || (kids.has(child) && !(child in tree)) }
      })
    },
    exists: (p) => norm(p) in tree || dirs.has(norm(p)),
  }
}

test('① `parseArgs` 认参数，未知参数报错（不能静默当成"没给"）', () => {
  assert.deepEqual(parseArgs([]), { json: false, write: null, check: false, help: false })
  assert.deepEqual(parseArgs(['--json', '--check']), { json: true, write: null, check: true, help: false })
  assert.equal(parseArgs(['--write', 'out']).write, 'out')
  assert.ok(parseArgs(['--jsn']).error)
})

test('② ★★ vendored 树发现是**可注入**的，且两层与一层都能找到', () => {
  // 两层：`.skills-cache/<owner>/<repo>/package.json`；一层：`vendor/<name>/`。
  const io = fakeIo({
    '.skills-cache': 'dir',
    '.skills-cache/main': 'dir',
    '.skills-cache/main/repo/package.json': '{}',
    'vendor': 'dir',
    'vendor/loose/thing.js': '// 没有 package.json 的 vendored 代码',
  })
  const found = discoverVendoredTrees('.', io)
  assert.ok(found.includes('.skills-cache/main/repo'), `实际 ${JSON.stringify(found)}`)
  // 没有清单的那棵也必须被发现——这正是"只读清单"会漏掉的那一类
  assert.ok(found.includes('vendor/loose'), `没有清单的 vendored 树也必须被发现，实际 ${JSON.stringify(found)}`)
})

test('② ★★ 找不到任何 vendored 根时返回空数组，而不是编一个', () => {
  const found = discoverVendoredTrees('.', fakeIo({ 'app/package.json': '{}' }))
  assert.deepEqual([...found], [])
  assert.ok(VENDORED_ROOTS.length > 0)
})

test('③ ★★ 真实仓库上：完整性覆盖**两个来源**（声明依赖与 vendored 树都 > 0）', () => {
  const r = generate(ROOT)
  assert.ok(r.sbom.declaredCount > 0, '真实仓库里必须扫到声明依赖')
  assert.ok(r.sbom.vendoredCount > 0, `真实仓库里必须扫到 vendored 树，实际 ${r.sbom.vendoredCount}`)
  assert.equal(r.completeness.ok, true, JSON.stringify(r.completeness.problems))
  // 那棵 vendored 树**不能**同时以 workspace 身份再出现一次
  const alpha = r.sbom.components.filter((c) => c.kind === 'workspace' && c.path.startsWith('.skills-cache'))
  assert.equal(alpha.length, 0, '带清单的 vendored 树不该再以 workspace 身份记一次')
})

test('③ ★★ 报表按码归并，不倾倒重复行', () => {
  const text = render(generate(ROOT))
  assert.match(text, /清单根/)
  assert.match(text, /组件：声明依赖 \d+ \/ vendored 源码树 \d+/)
  assert.match(text, /商业分发条件/)
  // 归并后同一码只出现一次，带 ×N
  const declLines = text.split('\n').filter((l) => l.includes('inventory-declared-not-installed'))
  assert.ok(declLines.length <= 2, `同码发现应归并，实际出现 ${declLines.length} 行`)
  if (declLines.length > 0) assert.match(declLines[0], /×\d+/)
})

test('③ ★★ 未知许可**不是**宽松许可（报表上必须分开计数）', () => {
  const r = generate(ROOT)
  const { counts } = r.distribution
  assert.equal(typeof counts.unknown, 'number')
  assert.equal(typeof counts.permissive, 'number')
  assert.equal(counts.permissive + counts.unknown + counts.copyleft + counts.restricted, r.distribution.rows.length)
  // 只要有 unknown，就不能说"可分发"
  if (counts.unknown > 0) assert.equal(r.distribution.clear, false)
})

test('④ ★★ CLI：`--check` 在 SBOM 不完整**或**有 blocker 时退出 1', () => {
  const r = runCli(['--check'])
  const g = generate(ROOT)
  const expectZero = g.completeness.ok && g.distribution.clear
  assert.equal(r.code, expectZero ? 0 : 1)
  // 真实仓库当前状态：完整性 ok，但许可大量未知 → 退出 1 是对的
  assert.equal(g.completeness.ok && g.distribution.clear, expectZero)
})

test('④ ★★ CLI：`--write` 真的写出两个文件（不是只打印一句话）', () => {
  const out = join(ROOT, '.ci', 'prt-sbom-test')
  const r = runCli(['--write', out])
  assert.equal(r.code, 0, r.out)
  const sbom = JSON.parse(readFileSync(join(out, 'sbom.json'), 'utf8'))
  const dist = JSON.parse(readFileSync(join(out, 'distribution.json'), 'utf8'))
  assert.ok(Array.isArray(sbom.components) && sbom.components.length > 0)
  assert.ok(Array.isArray(dist.rows) && dist.rows.length > 0)
  rmSync(out, { recursive: true, force: true })
})

test('④ ★ CLI：未知参数退出 2，`--help` 退出 0', () => {
  assert.equal(runCli(['--jsn']).code, 2)
  const h = runCli(['--help'])
  assert.equal(h.code, 0)
  assert.match(h.out, /--write/)
})

test('④ ★ `--json` 可解析且形状完整', () => {
  const r = runCli(['--json'])
  const parsed = JSON.parse(r.out)
  assert.ok(parsed.sbom && parsed.distribution && parsed.completeness)
  assert.equal(parsed.sbom.version, generate(ROOT).sbom.version)
})
