// ============================================================================
// `mutate-lib.mjs` 自己的判据。
//
// ★★★★★ 为什么要给**量具**写判据：切片 41/43/46/47/50 各踩过一次同一个坑 ——
//   某条变异的锚点没命中 ⇒ 旧实现在那里 `throw` ⇒ 循环**中断**、后面的变异
//   **一条都没跑**，而末尾的总结**永远不打印**。
//   现象是"输出里一条 `没咬住` 都没有"，那**看起来**与"全部咬住"一模一样。
//
//   > 一个「破验输出里没有"没咬住"，所以都咬住了」的印象，
//   > 与一个「脚本在中间那个锚点没命中时抛异常退出，后面那些变异根本没跑」的事实，
//   > 在我数输出行数与 `MUT` 条数对不对得上之前是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runMutations, applyMutation } from './mutate-lib.mjs'

/** 造一个临时"目标 + 判据"对，返回 { dir, target, suite }。
 *
 *  ★ 目标里有三个导出，而判据**只断言前两个** —— `UNCHECKED` 是**故意没被判据覆盖**的，
 *    用来造"真缺口"（改了它判据照样绿）。
 */
function scaffold(body = 'export const VALUE = 1\nexport const OTHER = 2\nexport const UNCHECKED = 3\n') {
  const dir = mkdtempSync(join(tmpdir(), 'mlib-'))
  const target = join(dir, 'target.mjs')
  writeFileSync(target, body, 'utf8')
  const suite = join(dir, 'target.test.mjs')
  writeFileSync(suite, [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { VALUE, OTHER } from './target.mjs'",
    "test('VALUE 是 1', () => { assert.equal(VALUE, 1) })",
    "test('OTHER 是 2', () => { assert.equal(OTHER, 2) })",
  ].join('\n'), 'utf8')
  return { dir, target, suite }
}

test('① ★★★★★ 中间一条锚点没命中 ⇒ **后面的变异照样跑**，且跑了 N/M 条', () => {
  const { dir, target, suite } = scaffold()
  const ORIG = readFileSync(target, 'utf8')
  try {
    const s = runMutations(target, [suite], [
      ['M1 ★ 会咬住', 'export const VALUE = 1', 'export const VALUE = 2'],
      ['M2 ★ 锚点故意写错', '这段源码根本不存在', 'x'],
      ['M3 ★ 咬不住（真缺口）', 'export const UNCHECKED = 3', 'export const UNCHECKED = 4'],
    ], '自测', { setExitCode: false })

    // ★★★★★ 这一条就是那个坑：旧实现在 M2 处抛异常 ⇒ M3 **根本没跑**。
    assert.equal(s.processed, 3, '★★★★★ M2 之后的那条**必须也跑了**（旧实现在这里中断）')
    assert.equal(s.declared, 3)
    assert.equal(s.complete, true, '★★★ 声明 3 条、处理 3 条 ⇒ 这一轮是**完整的**')
    assert.equal(s.anchorMissed.length, 1, '★ 没跑成的那条要被单列出来')
    assert.match(s.anchorMissed[0].name, /M2/)
    assert.match(s.anchorMissed[0].why, /锚点没命中/)
    assert.deepEqual(s.bitten, ['M1 ★ 会咬住'], '★ M1 真的咬住了')
    assert.equal(s.gaps.length, 1, '★ M3 是真的没咬住')
    assert.match(s.gaps[0], /M3/)
    assert.equal(s.restoredByteIdentical, true, '★ 收尾必须逐字节还原')
    assert.equal(readFileSync(target, 'utf8'), ORIG, '★ 磁盘上也要与原始相同')
    assert.ok(!existsSync(`${target}.pristine`), '★ 恢复文件要清掉')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('② ★★★ 全部命中锚点 ⇒ 一轮完整、没有"没跑成"', () => {
  const { dir, target, suite } = scaffold()
  try {
    const s = runMutations(target, [suite], [
      ['M1 ★ 咬住', 'export const VALUE = 1', 'export const VALUE = 2'],
      ['M2 ★ 咬住', 'export const OTHER = 2', 'export const OTHER = 9'],
    ], '自测', { setExitCode: false })
    assert.equal(s.complete, true)
    assert.equal(s.anchorMissed.length, 0)
    assert.equal(s.bitten.length, 2)
    assert.equal(s.gaps.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③ ★★★ `equivalent: true` 的那条不算真缺口', () => {
  const { dir, target, suite } = scaffold()
  try {
    const s = runMutations(target, [suite], [
      ['M1 ≈ 可证等价', 'export const UNCHECKED = 3', 'export const UNCHECKED = 4', { equivalent: true }],
    ], '自测', { setExitCode: false })
    assert.equal(s.gaps.length, 0, '★★ 标了 equivalent 的不进真缺口')
    assert.equal(s.equivalent.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('④ ★★★★★ 锚点没命中**不许**被算成"通过"（退出码语义）', () => {
  // ★ 这条只验**判定函数**本身：坏的一轮（有没跑成的）必须被判为 bad。
  const { dir, target, suite } = scaffold()
  try {
    const s = runMutations(target, [suite], [
      ['M1 ★ 锚点故意写错', '不存在的东西', 'x'],
    ], '自测', { setExitCode: false })
    assert.equal(s.anchorMissed.length, 1)
    assert.equal(s.gaps.length, 0, '★ 它**不是**"真缺口"，是另一类')
    // ★ 把两者合起来看：只要有"没跑成"，这一轮就**不可用**。
    const bad = s.gaps.length > 0 || s.anchorMissed.length > 0 || !s.complete
    assert.equal(bad, true, '★★★★★ "没跑成"必须让整轮判为坏 —— 不许读成"通过"')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑤ ★★★ 基线是红的 ⇒ 直接断言失败，不许继续跑', () => {
  const { dir, target } = scaffold()
  const suite = join(dir, 'always-red.test.mjs')
  writeFileSync(suite, [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "test('永远红', () => { assert.fail('红的') })",
  ].join('\n'), 'utf8')
  try {
    assert.throws(
      () => runMutations(target, [suite], [['M1', 'export const VALUE = 1', 'x']], '自测', { setExitCode: false }),
      /基线必须是绿的/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑥ ★★★ `applyMutation` 换行符无关（切片 19 的教训要一直守着）', () => {
  const lf = 'async function f() {\n  await r.run(req, res, ctx)\n}\n'
  const crlf = lf.replace(/\n/g, '\r\n')
  const from = 'await r.run(req, res, ctx)'
  const to = 'await r.run(req, res, ctx, true)'
  // ★ 同一个锚点在两种换行下都必须命中
  assert.match(applyMutation(lf, from, to), /ctx, true\)/)
  assert.match(applyMutation(crlf, from, to), /ctx, true\)/)
  // ★ 而且**保持**各自原本的换行风格
  assert.ok(!applyMutation(lf, from, to).includes('\r\n'), '★ LF 的文件不该被写成 CRLF')
  assert.ok(applyMutation(crlf, from, to).includes('\r\n'), '★ CRLF 的文件要保持 CRLF')
})
