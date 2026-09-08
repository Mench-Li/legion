// plugins/tests/space-digest.test.mjs —— S4（R-2 决策 C1）buildSpaceDigest 契约
// 运行：node plugins/tests/space-digest.test.mjs（需先构建 plugins/lib）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSpaceDigest } from '../lib/spaceDigest.js'

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'digest-fixture-'))
  mkdirSync(join(root, 'sub', 'nested'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '产品说明 FACT-README-TOP')
  writeFileSync(join(root, 'LEGION.md'), '仓库规则 FACT-LEGION')
  writeFileSync(join(root, 'AGENTS.md'), '代理规则 FACT-AGENTS')
  writeFileSync(join(root, 'plain.txt'), '普通文件 FACT-PLAIN')
  writeFileSync(join(root, 'sub', 'a.ts'), '代码文件')
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'NOISE-NM')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'dist'), { recursive: true })
  mkdirSync(join(root, '.legion-worktrees', 'T-x'), { recursive: true })
  writeFileSync(join(root, '.legion-worktrees', 'T-x', 'wip.txt'), 'NOISE-WT')
  return root
}

test('TC-S4-01 allowlist 与顶层结构入摘要（目录在前）；TC-S4-02 噪声不入', () => {
  const root = makeFixture()
  try {
    const out = buildSpaceDigest({ dir: root, budget: 4000 })
    assert.ok(out.text.includes('FACT-README-TOP'))
    assert.ok(out.text.includes('FACT-LEGION'))
    assert.ok(out.text.includes('FACT-AGENTS'))
    assert.ok(!out.text.includes('NOISE-NM') && !out.text.includes('NOISE-WT'))
    assert.ok(!out.text.includes('node_modules'))
    assert.ok(!out.text.includes('.git') && !out.text.includes('.legion-worktrees'))
    assert.ok(!out.text.includes('dist'), 'dist 噪声不入')
    assert.equal(out.truncated, false)
    assert.ok(out.sources.includes('README.md') && out.sources.includes('LEGION.md') && out.sources.includes('AGENTS.md'))
    assert.ok(out.text.indexOf('sub/') < out.text.indexOf('plain.txt'), '目录在前')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('TC-S4-03 确定性：同 fixture 两次输出一致', () => {
  const root = makeFixture()
  try {
    const a = buildSpaceDigest({ dir: root, budget: 4000 })
    const b = buildSpaceDigest({ dir: root, budget: 4000 })
    assert.equal(a.text, b.text)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('TC-S4-04/05 预算与单文件截断：带「已截断」标记、truncated=true、不抛', () => {
  const root = makeFixture()
  try {
    const out = buildSpaceDigest({ dir: root, budget: 120 })
    assert.ok(out.text.length <= 120)
    assert.equal(out.truncated, true)
    assert.ok(out.text.includes('已截断'))
    writeFileSync(join(root, 'COMMAND.md'), '命令手册 ' + 'c'.repeat(2000))
    const cap = buildSpaceDigest({ dir: root, budget: 5000, fileCap: 60 })
    assert.ok(cap.text.includes('COMMAND.md'))
    assert.ok(/c{50,}…（文件过长已截断）/.test(cap.text), '单文件截断标记：' + cap.text.slice(-120))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('TC-S4-06 空目录/不存在目录/二进制 allowlist → 不抛', () => {
  const root = makeFixture()
  try {
    const empty = buildSpaceDigest({ dir: join(root, 'sub', 'nested'), budget: 4000 })
    assert.ok(empty.text.length >= 0)
    const gone = buildSpaceDigest({ dir: join(root, 'no-such-dir'), budget: 4000 })
    assert.ok(gone.text.length >= 0)
    assert.ok(gone.reason && gone.reason.length > 0, '不可读目录带 reason')
    const root2 = mkdtempSync(join(tmpdir(), 'digest-binary-'))
    writeFileSync(join(root2, 'README.md'), Buffer.from([0xff, 0xfe, 0x00, 0x61]))
    writeFileSync(join(root2, 'AGENTS.md'), '正常文件 OK-FACT')
    const bin = buildSpaceDigest({ dir: root2, budget: 4000 })
    assert.ok(!bin.sources.includes('README.md'), '二进制文件被跳过')
    assert.ok(bin.sources.includes('AGENTS.md'), '其它 allowlist 正常读取')
    assert.ok(bin.text.includes('OK-FACT'), '正常 allowlist 内容入摘要')
    rmSync(root2, { recursive: true, force: true })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('TC-S4-07 只读：调用前后目录内容与文件哈希不变（零写入）', () => {
  const root = makeFixture()
  try {
    const snapshot = () => {
      const out = {}
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name)
          if (e.isDirectory()) walk(p)
          else out[p.replace(root, '')] = readFileSync(p).toString('hex')
        }
      }
      walk(root)
      return out
    }
    const before = snapshot()
    buildSpaceDigest({ dir: root, budget: 200 })
    buildSpaceDigest({ dir: root, budget: 4000 })
    const after = snapshot()
    assert.deepEqual(after, before, '目录内容与文件哈希零变化')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('TC-S4-09 allowlist 空数组/仅元数据 → 仍产结构块不抛', () => {
  const root = makeFixture()
  try {
    const out = buildSpaceDigest({ dir: root, budget: 4000, allowlist: [], meta: { name: 'fixture-space', id: 'fixture-space' } })
    assert.ok(out.text.includes('名称：fixture-space'), '元数据块产出')
    assert.ok(out.text.includes('顶层结构'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('TC-S4-08 静态：spaceDigest.ts 无子进程引用（模块源码断言）', () => {
  const src = readFileSync(new URL('../src/spaceDigest.ts', import.meta.url), 'utf8')
  const re = /from ['"]node:child_process['"]|require\s*\(['"]child_process|\bchild_process\.[a-zA-Z]+\s*\(|\b(spawn|exec|execFile|execSync|fork)\s*\(/
  assert.ok(!re.test(src), '无子进程引用')
})
