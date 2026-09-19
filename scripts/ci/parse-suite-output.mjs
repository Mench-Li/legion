// scripts/ci/parse-suite-output.mjs
// ============================================================================
// 从 `node --test` 的输出里读出 **tests / pass / fail / skipped**。
//
// ---------------------------------------------------------------------------
// 这一格被两个方向的错都咬过，两次都让一个数说谎：
//
//   ① **看不见**：`skipped` 曾经**没有被解析**。摘要行里只有 tests/pass/fail，
//      跳过数只能靠减法反推，而"反推"与"看见"不是同一件事。
//      实测代价（2026-09-17）：四个真进程套件 **38 条里跳过 20 条**，
//      而那四行的读数是 `exit=0 tests=38 pass=18 fail=0`——一个字都没说"有 20 条没跑"。
//
//   ② **看见了一个假的**（2026-09-18，第 35 轮）：取值用的是 `re.exec(all)`，
//      也就是**第一个**匹配。而 node 的 `ℹ tests N …` 摘要在**输出末尾**，
//      套件名 / 用例名 / 断言文案 / `console.log` 里**可以**出现同样形状的字样。
//      实测：`scripts/prt/ledger-evidence.test.mjs` 有一个用例名叫
//      `` 运行器摘要那句话不是套件名 ``，而它的**夹具**里带着 `tests 21 / pass 20 / skipped 1`
//      ——node 把用例名打进 stdout ⇒ 那一行被读成 `tests=21 pass=20 skipped=1`，
//      而它真实是 **10/10/0**；`test` 阶段的总 `skipped` 也跟着从 1 变 2，
//      多出来的那一条**根本不存在**。
//
//   > 一个用例的**名字**，改写了一次 CI 的读数——
//   > 而"跳过了 1 条"与"跳过了 0 条"，在那一行里长得一模一样。
//
// ---------------------------------------------------------------------------
// 两条规则：
//   ① 取**最后**一个匹配（node 的摘要在末尾）；
//   ② 若首个匹配与最后匹配不同 ⇒ 记进 `spoofed`。
//      **不静默**：那说明输出里有别的东西长得像摘要，读数需要人看一眼。
// ============================================================================

/** 一次运行的计数。取不到就是 `NaN`——**不许**悄悄当 0。 */
export function parseSuiteCounts(all) {
  const text = String(all)
  const pick = (re) => {
    const all2 = [...text.matchAll(new RegExp(re.source, 'g'))].map((m) => Number(m[1]))
    return { first: all2.length === 0 ? NaN : all2[0], last: all2.length === 0 ? NaN : all2[all2.length - 1], count: all2.length }
  }
  const tests = pick(/\btests\s+(\d+)/)
  const pass = pick(/\bpass\s+(\d+)/)
  const fail = pick(/\bfail\s+(\d+)/)
  const skipped = pick(/\bskipped\s+(\d+)/)

  /** ★ 首个 ≠ 最后 ⇒ 输出里有别的东西长得像摘要。 */
  const spoofed = []
  for (const [name, v] of [['tests', tests], ['pass', pass], ['fail', fail], ['skipped', skipped]]) {
    if (v.count > 1 && v.first !== v.last) spoofed.push(`${name}(${v.first}→${v.last})`)
  }
  return { tests: tests.last, pass: pass.last, fail: fail.last, skipped: skipped.last, spoofed }
}

/** 摘要行里那一小段（`skipped` 取不到时报 0，与既有行为一致）。 */
export function countsFragment(counts) {
  return 'tests=' + counts.tests + ' pass=' + counts.pass + ' fail=' + counts.fail
    + ' skipped=' + (Number.isNaN(counts.skipped) ? 0 : counts.skipped)
    + (counts.spoofed && counts.spoofed.length > 0
      ? ' ⚠计数被输出干扰:' + counts.spoofed.join(',') : '')
}
