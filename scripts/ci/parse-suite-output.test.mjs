// scripts/ci/parse-suite-output.test.mjs
// `node --test` 输出的计数解析——这一格被**两个方向**的错都咬过（第 35 轮）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSuiteCounts, countsFragment } from './parse-suite-output.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** 一段像 node `--test` spec reporter 的输出：用例名在前，摘要在末尾。 */
const tail = (name, tests, pass, fail, skipped) => [
  `✔ ${name} (0.2ms)`,
  'ℹ tests ' + tests,
  'ℹ pass ' + pass,
  'ℹ fail ' + fail,
  'ℹ skipped ' + skipped,
  '',
].join('\n')

test('① ★★★ 反向控制（第 35 轮的真事）：用例名里那句摘要形状的**夹具**不许改写读数', () => {
  // 真例：`ledger-evidence` 有一个用例名带了这段字面量（夹具），
  // node 会把用例名打进 stdout，而当时的解析取的是**第一个**匹配。
  // ★★ 而本用例的名字**也不能**带它——所以夹具在**函数体**里拼出来。
  const fixture = ['tests', '21', '/', 'pass', '20', '/', 'skipped', '1'].join(' ')
  const out = [
    '✔ ⑧ ★ 套件 `' + fixture + '` 不是套件名 (0.2ms)',
    'ℹ tests 10',
    'ℹ pass 10',
    'ℹ fail 0',
    'ℹ skipped 0',
  ].join('\n')
  const c = parseSuiteCounts(out)
  assert.equal(c.tests, 10, `tests 被读成 ${c.tests}`)
  assert.equal(c.pass, 10, `pass 被读成 ${c.pass}`)
  assert.equal(c.skipped, 0, `skipped 被读成 ${c.skipped}——多出来的那条**根本不存在**`)
  assert.equal(c.fail, 0)
  // ★ 而且必须**说出来**：输出里有东西长得像摘要
  assert.deepEqual(c.spoofed, ['tests(21→10)', 'pass(20→10)', 'skipped(1→0)'],
    JSON.stringify(c.spoofed))
})

test('② ★★ 干净输出：没有干扰时 `spoofed` 是空的，读数就是摘要那几个数', () => {
  const c = parseSuiteCounts(tail('✔ 某条用例', 14, 14, 0, 0))
  assert.deepEqual([c.tests, c.pass, c.fail, c.skipped], [14, 14, 0, 0])
  assert.deepEqual(c.spoofed, [])
})

test('③ ★★ 跳过数是**读出来**的，不是靠减法反推的（2026-09-17 那一课）', () => {
  const c = parseSuiteCounts(tail('✔ 四条真进程断言', 38, 18, 0, 20))
  assert.equal(c.tests, 38)
  assert.equal(c.pass, 18)
  assert.equal(c.skipped, 20, 'skipped 没被解析 ⇒ 只能靠 38-18=20 反推，而那是猜')
  // ★ 摘要行里必须**看得见**它
  assert.match(countsFragment(c), /skipped=20/)
})

test('④ ★★ 取不到就是 `NaN`，**不许**悄悄当 0', () => {
  const c = parseSuiteCounts('完全没有摘要的一段输出')
  assert.ok(Number.isNaN(c.tests), 'tests 读不到却给了个数')
  assert.ok(Number.isNaN(c.skipped), 'skipped 读不到却给了个数')
  // 而摘要行里仍照旧显示 0（既有行为，别改）
  assert.match(countsFragment(c), /skipped=0/)
})

test('⑤ ★ 干扰要**出现在摘要行里**，不能只活在对象里', () => {
  const fixture = ['tests', '21', '/', 'pass', '20', '/', 'skipped', '1'].join(' ')
  const out = [
    '✔ 套件 `' + fixture + '` 不是套件名',
    'ℹ tests 10', 'ℹ pass 10', 'ℹ fail 0', 'ℹ skipped 0',
  ].join('\n')
  const frag = countsFragment(parseSuiteCounts(out))
  assert.match(frag, /tests=10 pass=10 fail=0 skipped=0/,
    '读数位的数必须是真的那个：' + frag)
  assert.match(frag, /⚠计数被输出干扰/, '干扰没有出现在摘要行里：' + frag)
})

test('⑥ ★ 只出现一次时不算干扰（`spoofed` 不许在正常输出上乱叫）', () => {
  const c = parseSuiteCounts('ℹ tests 5\nℹ pass 5\nℹ fail 0\nℹ skipped 0')
  assert.deepEqual(c.spoofed, [], JSON.stringify(c.spoofed))
})

test('⑦ ★★★ 回归守卫：**任何**套件的用例名都不许长得像运行器摘要', () => {
  // 这是第 35 轮那件事的**根因**：`ledger-evidence` 的一个**用例名**里带了
  // `tests 21 / pass 20 / skipped 1`，node 把用例名打进 stdout，
  // 而当时的解析取**第一个**匹配 ⇒ 那一次的 CI 读数被改写了。
  //
  //   解析器已经改成取最后一个匹配（测试 ① 钉住），但**根因**是"用例名可以像摘要"。
  //   所以这里再钉一道：名字里不许出现 `tests N` / `pass N` / `skipped N` 这种形状。
  //   夹具要放**函数体**里（成功时不会被打进输出）。
  const files = execFileSync('git', ['ls-files', '*.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
  assert.ok(files.length > 300, `只扫到 ${files.length} 个套件——这次扫描什么都没查`)
  const SUMMARY_SHAPED = /\b(?:tests|pass|fail|skipped)\s+\d+/i
  const offenders = []
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    // 只看 `test('…'` 的**名字**（到第一个逗号/换行为止的那一段）
    for (const m of src.matchAll(/\btest\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1\s*,/g)) {
      const name = m[2]
      if (SUMMARY_SHAPED.test(name)) offenders.push(`${f}  ← 用例名「${name.slice(0, 60)}」`)
    }
  }
  assert.deepEqual(offenders, [],
    '有套件的**用例名**长得像运行器摘要 ⇒ 那一次的 CI 读数会被它改写：\n' + offenders.join('\n'))
})
