// scripts/legion-profile.test.mjs
// ============================================================================
// 「Legion 随宿主自动起」这件事的两份档案侧事实，必须可判、可复现：
//   ① 四个包在该档案的 node_modules 里可解析（junction 指向仓库内的包目录）；
//   ② 该档案的 cordis.patch.yml 里有那两行 insert。
//
// 本套件**不碰**真实的 `$DSH_HOME`：所有用例都在临时目录里造一个假档案。
// 一条会把用户真实档案改掉的用例，与一条没有用例的脚本，在它第一次跑错的那天
// 是同一个东西 —— 只不过前者的破坏是持久的。
//
// 运行：node --test scripts/legion-profile.test.mjs
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LEGION_PACKAGES,
  appendPatchRows,
  checkInsertBlockText,
  entryObjectsFor,
  expectedDependencies,
  latestBackupOf,
  planProfile,
  renderYamlValue,
  repoRootOf,
  restoreProfile,
  wireProfile,
  yamlInsertBlock,
  yamlScalar,
} from './legion-profile.mjs'

const ROOT = repoRootOf(new URL('./legion-profile.mjs', import.meta.url).href)

function fakeHome({ withPackage = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'legion-profile-test-'))
  const profileDir = join(home, 'profiles', 'fake')
  mkdirSync(profileDir, { recursive: true })
  if (withPackage) {
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-fake', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2)}\n`)
  }
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# fake profile patch layer\n[]\n')
  return { home, profileDir, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const entries = () => entryObjectsFor(ROOT)

test('① 未接线的档案被如实报成缺口（依赖 4 条 / junction 4 个 / 补丁行 2 行）', () => {
  const f = fakeHome()
  try {
    const plan = planProfile({ root: ROOT, profileDir: f.profileDir, patchEntries: entries() })
    assert.equal(plan.exists, true)
    assert.equal(plan.missingDeps.length, LEGION_PACKAGES.length)
    assert.equal(plan.brokenJunctions.length, LEGION_PACKAGES.length)
    assert.deepEqual(plan.patchMissingRows.map((r) => r.id), ['legion-services', 'legion-scrum-worker'])
  } finally { f.cleanup() }
})

test('② wire 之后复查零缺口，且 package.json 里落下 4 条 file: 依赖', () => {
  const f = fakeHome()
  try {
    const w = wireProfile({ root: ROOT, profileDir: f.profileDir, patchEntries: entries() })
    assert.equal(w.afterGaps, 0)
    const pkg = JSON.parse(readFileSync(join(f.profileDir, 'package.json'), 'utf8'))
    const want = expectedDependencies(ROOT)
    for (const p of LEGION_PACKAGES) assert.equal(pkg.dependencies[p.name], want[p.name])
    // junction 真的在，且指向仓库内的包目录
    for (const p of LEGION_PACKAGES) {
      const link = join(f.profileDir, 'node_modules', ...p.name.split('/'))
      assert.ok(existsSync(link), `${p.name} 的 junction 不存在`)
      assert.ok(lstatSync(link).isSymbolicLink(), `${p.name} 不是符号链接/junction`)
    }
  } finally { f.cleanup() }
})

test('③ 幂等：第二次 wire 不产生新备份、不重复追加行', () => {
  const f = fakeHome()
  try {
    wireProfile({ root: ROOT, profileDir: f.profileDir, patchEntries: entries() })
    const patch1 = readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')
    const bak1 = latestBackupOf(join(f.profileDir, 'cordis.patch.yml'))
    const w2 = wireProfile({ root: ROOT, profileDir: f.profileDir, patchEntries: entries() })
    assert.equal(w2.afterGaps, 0)
    assert.equal(w2.steps.patch.action, 'unchanged', '第二次不该再追加补丁行')
    assert.equal(w2.steps.dependencies.action, 'unchanged')
    assert.equal(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8'), patch1)
    assert.equal(latestBackupOf(join(f.profileDir, 'cordis.patch.yml')).path, bak1.path, '第二次不该产生新备份')
    // 每个包名在补丁文件里只出现一次
    for (const p of LEGION_PACKAGES) {
      const n = patch1.split(p.name).length - 1
      if (['@dsh-external/dsh-legion-services', '@dsh-external/dsh-scrum-worker'].includes(p.name)) {
        assert.equal(n, 1, `${p.name} 在补丁文件里出现 ${n} 次`)
      }
    }
  } finally { f.cleanup() }
})

test('④ 生成的补丁块形状合法；DOM 级错位（兄弟键少一层缩进）会被检查器抓住', () => {
  const block = yamlInsertBlock(entries().map((e) => ({ name: e.name, config: e.config })))
  assert.deepEqual(checkInsertBlockText(block), [])
  // 把一个 config 子键拉回到 name 那一层：YAML 里这是**非法**的（映射项必须自成层级）
  const broken = block.replace('\n      intervalMs:', '\n  intervalMs:')
  assert.notDeepEqual(broken, block, '替换必须真的发生，否则这条用例什么也没测')
  const problems = checkInsertBlockText(broken)
  assert.ok(problems.length > 0, '错位缩进没有被抓住')
  assert.match(problems.join('\n'), /键层级/)
})

test('⑤ 单引号标量：Windows 路径原样可读，路径里的单引号被翻倍', () => {
  assert.equal(yamlScalar('D:\\project\\DSH\\legion'), "'D:\\project\\DSH\\legion'")
  assert.equal(yamlScalar("it's"), "'it''s'")
  // 生成的文本里必须真的出现那条路径（不是被转义成别的形状）
  const block = yamlInsertBlock([{ name: '@x/y', config: { p: "C:\\a'b" } }])
  assert.match(block, /p: 'C:\\a''b'/)
})

test('⑥ 嵌套 config（对象/数组/空数组）渲染成块状 YAML，且缩进成对', () => {
  const doc = { a: 'x', n: 1, t: true, empty: [], list: ['p', 'q'], deep: { k: ['z'] } }
  const text = renderYamlValue(doc, 1)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    assert.equal(/^ */.exec(line)[0].length % 2, 0, `缩进不是偶数：${line}`)
  }
  assert.match(text, /^ {2}a: 'x'$/m)
  assert.match(text, /^ {2}empty: \[\]$/m)
  assert.match(text, /^ {2}list:\n {4}- 'p'\n {4}- 'q'$/m)
  assert.match(text, /^ {2}deep:\n {4}k:\n {6}- 'z'$/m)
})

test('⑦ restore 把两个文件都退回最近备份；没有备份时如实报 no-backup', () => {
  const f = fakeHome()
  try {
    const before = readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')
    wireProfile({ root: ROOT, profileDir: f.profileDir, patchEntries: entries() })
    assert.notEqual(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8'), before)
    const res = restoreProfile({ profileDir: f.profileDir })
    assert.deepEqual(res.map((r) => r.action), ['restored', 'restored'])
    assert.equal(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8'), before)
    const pkg = JSON.parse(readFileSync(join(f.profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(pkg.dependencies, {})
    // 再回退一次：已经没有"比空更早"的备份了，但备份文件本身还在（不会报 no-backup）
    const again = restoreProfile({ profileDir: f.profileDir })
    assert.deepEqual(again.map((r) => r.action), ['restored', 'restored'])
  } finally { f.cleanup() }
})

test('⑧ dry-run 不改任何文件', () => {
  const f = fakeHome()
  try {
    const before = readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')
    const pkgBefore = readFileSync(join(f.profileDir, 'package.json'), 'utf8')
    const w = wireProfile({ root: ROOT, profileDir: f.profileDir, patchEntries: entries(), dryRun: true })
    assert.equal(w.steps.patch.action, 'would-append')
    assert.equal(w.steps.dependencies.action, 'would-write')
    assert.equal(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8'), before)
    assert.equal(readFileSync(join(f.profileDir, 'package.json'), 'utf8'), pkgBefore)
    assert.equal(existsSync(join(f.profileDir, 'node_modules')), false)
  } finally { f.cleanup() }
})

test('⑨ appendPatchRows 拒绝把畸形块写进文件（形状检查是写入门禁，不是事后提醒）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-profile-test-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, '[]\n')
    assert.throws(
      () => appendPatchRows({ patchFile: file, entries: [{ config: { a: 1 } }] }),
      /必须有 name/,
    )
    assert.equal(readFileSync(file, 'utf8'), '[]\n', '被拒绝时文件必须原样不动')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑩ 档案没有 package.json 时 wire 不写任何东西', () => {
  const f = fakeHome({ withPackage: false })
  try {
    const w = wireProfile({ root: ROOT, profileDir: f.profileDir, patchEntries: entries() })
    assert.equal(w.exists, false)
    assert.deepEqual(w.steps, {})
  } finally { f.cleanup() }
})
