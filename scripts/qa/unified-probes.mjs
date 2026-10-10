#!/usr/bin/env node
/**
 * unified-probes.mjs — 三端统一 E2E 的**破坏性验证**（T-195）。
 *
 * ## 为什么交付物里必须有它
 *
 * 本仓库的纪律（各轮 `docs/STATUS.md` 的「破坏性验证 N/N 全红」）要求：
 * **每一条关键判据都要有探针证明它真的能红**。原因不是形式——
 * 一套全绿的用例与一套"根本没测到东西"的用例，在 CI 报表上是同一个东西。
 *
 * 而且这个脚本要防的不只是"判据没红"，还有**探针自己的错**：
 * 仓库里反复踩过的三种形状（`docs/STATUS.md` 多处记录）——
 *
 * 1. **锚点没命中**：多行锚点对 CRLF 文件永远命中不了，而它的表现**像"探针没效果"**；
 * 2. **跑错了测试文件**：补丁打在 A 上、却去跑 B 的用例，`fail=0`
 *    被读成"这条判据测不出来"；
 * 3. **崩溃式变红**：探针让代码抛 `TypeError` 而不是断言失败，
 *    按纪律**崩溃不算证据**（它没证明那条判据在工作）。
 *
 * 所以本脚本对每条探针都**分开报**三件事，而不是只报"红/绿"：
 *   `applied`（补丁真的改到了字节）/ `red`（断言级失败，不是崩溃）/ `restored`（逐字节还原）。
 *
 * 用法：`node scripts/qa/unified-probes.mjs`
 * 退出码：全部探针都（改到 ∧ 变红 ∧ 还原）→ 0；否则 1。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 一条探针。
 *
 * - `file`：要被改坏的源文件（相对仓库根）
 * - `find` / `replace`：**字面量**替换（不是正则）。`find` 必须恰好出现一次，
 *   否则报 `anchor` 失败——这一条专治"锚点没命中却被读成判据无效"。
 * - `test`：跑哪个用例文件（必须与 `file` 真的相关，否则就是这个脚本自己在犯第 2 种错）
 * - `desc`：这条判据在守什么（写给人看）
 */
const PROBES = [
  {
    id: 'P1',
    leg: '腿 1 移动端',
    desc: '关掉 mobile 标志位（screen.width/height 判据必须红）',
    file: 'scripts/e2e/cdp.mjs',
    find: `        deviceScaleFactor: this.deviceScaleFactor,
        mobile: this.mobile,
      })`,
    replace: `        deviceScaleFactor: this.deviceScaleFactor,
        mobile: false,
      })`,
    test: 'tests/e2e-unified/mobile.e2e.test.mjs',
  },
  {
    id: 'P1b',
    leg: '腿 1 移动端',
    desc: '关掉触屏仿真（maxTouchPoints / pointer:coarse 判据必须红）',
    file: 'scripts/e2e/cdp.mjs',
    find: `      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: this.maxTouchPoints })`,
    replace: `      await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: this.maxTouchPoints })`,
    test: 'tests/e2e-unified/mobile.e2e.test.mjs',
  },
  {
    id: 'P1c',
    leg: '腿 1 移动端',
    desc: '把 DPR 写成 1（deviceScaleFactor 判据必须红）',
    file: 'scripts/e2e/cdp.mjs',
    find: `        deviceScaleFactor: this.deviceScaleFactor,
        mobile: this.mobile,`,
    replace: `        deviceScaleFactor: 1,
        mobile: this.mobile,`,
    test: 'tests/e2e-unified/mobile.e2e.test.mjs',
  },
  {
    id: 'P2',
    leg: '腿 1 移动端',
    desc: '把 tap() 换成合成鼠标点击（触屏判据必须红）',
    file: 'scripts/e2e/cdp.mjs',
    find: `    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points })
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })`,
    replace: `    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })`,
    test: 'tests/e2e-unified/mobile.e2e.test.mjs',
  },
  {
    id: 'P3',
    leg: '腿 2 桌面端',
    desc: '协议不再校验 id 形状（BAD_ID 判据必须红）',
    file: 'product/launcher/desktop-protocol.mjs',
    find: `  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)) throw protocolError('BAD_ID')`,
    replace: `  if (typeof value.id !== 'string') throw protocolError('BAD_ID')`,
    test: 'tests/e2e-unified/desktop.e2e.test.mjs',
  },
  {
    id: 'P4',
    leg: '腿 3 自动更新',
    desc: '信封验签恒通过（篡改 payload 判据必须红）',
    file: 'product/update/envelope.mjs',
    find: `  if (ok !== true) {`,
    replace: `  if (false) {`,
    test: 'tests/e2e-unified/update.e2e.test.mjs',
  },
  {
    id: 'P5',
    leg: '腿 3 自动更新',
    desc: '严格 JSON 不再拒绝重复键（"同一字节串两种读法"判据必须红）',
    file: 'product/update/canonical.mjs',
    find: `      if (Object.hasOwn(acc, key)) throw err(CANONICAL_CODES.DUPLICATE_KEY, \`对象里出现重复键 \${JSON.stringify(key)}\`, { key })`,
    replace: `      if (false) throw err(CANONICAL_CODES.DUPLICATE_KEY, \`对象里出现重复键 \${JSON.stringify(key)}\`, { key })`,
    test: 'tests/e2e-unified/update.e2e.test.mjs',
  },
  {
    id: 'P6',
    leg: '腿 3 自动更新',
    desc: '路径段白名单不再生效（编码绕过/盘符/父目录类判定必须红）',
    file: 'product/update/release.mjs',
    // ★ 第一版打的是**上面那条** `if (value.includes('%'))`，实测 **fail=0**——
    //   不是因为判据缺失，而是那条检查**是冗余的**：`%2e%2e` 会被这条
    //   段白名单（`SAFE_SEGMENT_RE`，不允许以 `%`/`.`/`:` 开头）拒掉。
    //   同理 `segment === '..'` 那条显式检查也被白名单覆盖。
    //
    //   三条检查叠在一起是**纵深防御**（好事），但探针必须打**起决定作用的**
    //   那一条：打在冗余检查上，输出是"改了却不变红"，而它与"判据缺失"
    //   长得一模一样。
    find: `    if (!SAFE_SEGMENT_RE.test(segment)) {`,
    replace: `    if (false) {`,
    test: 'tests/e2e-unified/update.e2e.test.mjs',
  },
  {
    id: 'P7',
    leg: '腿 3 自动更新',
    desc: 'transport 不再校验落盘字节的摘要（"托管被换包"判据必须红）',
    file: 'product/update/transport.mjs',
    // ★ 锚点要连行尾注释一起写。只写 `if (actual !== expectedSha256) {` 会**跨缩进**
    //   命中（4 空格是 6 空格那一行的子串），改到的位置虽然对，但下一个读的人
    //   无法从锚点看出它匹配的是哪一行——而"锚点匹配到了别处"这种错，
    //   在探针输出里和"改对了"长得一样。
    find: `      if (actual !== expectedSha256) {        // 摘要必须与**落盘的字节**对上，所以是对文件重算，而不是复用`,
    replace: `      if (false) {        // 摘要必须与**落盘的字节**对上，所以是对文件重算，而不是复用`,
    test: 'tests/e2e-unified/update.e2e.test.mjs',
  },
  {
    // ★★ 这一条守的是 T-198 在真 Hub 上**真的抓出来**的那个生产缺陷。
    //
    //   把 Hub 的缓存策略改回"自己写一份字面量"（原来的 `max-age=86400`），
    //   客户端的 `evaluateResponse()` 就会拒收发行文件，整条链在检查阶段失败。
    //
    //   它同时证明两件事：
    //     ① 腿 3 的 ⑨ 真的能发现"托管方与客户端对缓存头的要求不一致"；
    //     ② 修完之后这个缺口**有判据守着**，不会被人再次写回字面量。
    id: 'P10',
    leg: '腿 3 自动更新',
    desc: '★ Hub 缓存头退回自己写的字面量（客户端拒收发行文件 ⇒ 整条链断）',
    file: 'team-hub/routes/releases.mjs',
    find: `    return expectedCacheControl(String(rel).replace(/^[\\\\/]+/, ''))`,
    replace: `    return String(rel).replace(/^[\\\\/]+/, '').startsWith('feeds/') ? 'no-store' : 'public, max-age=86400'`,
    test: 'tests/e2e-unified/update.e2e.test.mjs',
  },
  {
    id: 'P8',
    leg: '腿 4 闭环',
    desc: '执行器不在工作区落盘（"电脑真的执行过"判据必须红）',
    file: 'tests/e2e-unified/fixtures/executor-worker.mjs',
    find: `  proofFile = join(workDir, 'executor-proof.json')
  writeFileSync(proofFile, \`\${JSON.stringify(stamp, null, 2)}\\n\`, 'utf8')`,
    replace: `  proofFile = join(workDir, 'executor-proof.json')
  void proofFile`,
    test: 'tests/e2e-unified/loop.e2e.test.mjs',
  },
  {
    id: 'P9',
    leg: '腿 4 闭环',
    desc: '进展不再出境（"进展回到手机"判据必须红）',
    file: 'tests/e2e-unified/fixtures/executor-worker.mjs',
    find: `emit({ type: 'progress', kind: 'step', summary: \`已在工作区落盘 \${'executor-proof.json'}\` })`,
    replace: `void 0`,
    test: 'tests/e2e-unified/loop.e2e.test.mjs',
  },
]

/**
 * 锚点匹配必须**对行尾不敏感**。
 *
 * 实测（本脚本第一次跑就踩到）：`scripts/e2e/cdp.mjs` 是**全文 CRLF**
 * （540 个 CRLF / 0 个 LF），而锚点在源码里写成 LF 多行字符串 ——
 * 于是 P1/P2 两条探针报"锚点未命中"。
 *
 * 危险的地方在于它**看起来像"这条判据测不出来"**，
 * 而真相是探针自己没打中（`docs/STATUS.md` 记过同一形状）。
 *
 * 做法：把文件与锚点都归一到 LF 做匹配，命中后再按**原文件的**行尾还原，
 * 而还原用的是原始字节串本身，所以"逐字节一致"这条判据不受影响。
 */
function patchText(original, find, replace) {
  const eol = /\r\n/.test(original) ? '\r\n' : '\n'
  const norm = original.replace(/\r\n/g, '\n')
  const occurrences = norm.split(find).length - 1
  if (occurrences !== 1) return { occurrences, patched: null, eol }
  const patched = norm.replace(find, replace)
  return { occurrences, patched: eol === '\r\n' ? patched.replace(/\n/g, '\r\n') : patched, eol }
}

/** 从 `node --test` 输出里读出断言级失败数（崩溃不算）。 */
function readOutcome(out) {
  const fail = /^ℹ fail (\d+)$/m.exec(out)
  const pass = /^ℹ pass (\d+)$/m.exec(out)
  // ★ 崩溃式变红不算证据：没有 ℹ fail 汇总行，就是 runner 自己炸了。
  const crashed = fail === null
  const assertions = /AssertionError/g.test(out) || /ERR_ASSERTION/.test(out)
  return {
    failCount: fail ? Number(fail[1]) : null,
    passCount: pass ? Number(pass[1]) : null,
    crashed,
    assertions,
  }
}

const results = []
for (const p of PROBES) {
  const abs = join(ROOT, p.file)
  const original = readFileSync(abs, 'utf8')
  const { occurrences, patched, eol } = patchText(original, p.find, p.replace)
  const row = { ...p, occurrences, eol, applied: false, red: false, crashed: false, restored: false, detail: '' }

  if (occurrences !== 1 || patched === null) {
    // 锚点没命中（或命中多次）——这一条**必须先报出来**，否则后面所有的绿都是假的。
    row.detail = occurrences === 0
      ? `锚点未命中（行尾=${eol}，已按行尾归一后仍不匹配：写法漂移？）`
      : `锚点命中 ${occurrences} 次（应为 1）`
    results.push(row)
    continue
  }

  try {
    writeFileSync(abs, patched)
    row.applied = readFileSync(abs, 'utf8') !== original

    const r = spawnSync(process.execPath, ['--test', p.test], {
      cwd: ROOT, encoding: 'utf8', timeout: 240_000,
      env: { ...process.env },
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const o = readOutcome(out)
    row.crashed = o.crashed
    row.red = o.failCount !== null && o.failCount > 0
    row.assertions = o.assertions
    row.detail = o.crashed
      ? 'runner 未产出汇总（崩溃式变红，按纪律不算证据）'
      : `fail=${o.failCount} pass=${o.passCount}${o.assertions ? ' 含断言级失败' : ''}`
  } finally {
    writeFileSync(abs, original)
    row.restored = readFileSync(abs, 'utf8') === original
  }
  results.push(row)
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n, ' ')
console.log('\n破坏性验证（T-195 三端统一 E2E）\n')
console.log(`${pad('探针', 6)}${pad('腿', 14)}${pad('改到', 6)}${pad('变红', 6)}${pad('还原', 8)}说明`)
console.log('-'.repeat(110))
for (const r of results) {
  const mark = (b) => (b ? '✔' : '✖')
  const ok = r.applied && r.red && r.restored && !r.crashed
  console.log(
    `${pad(r.id, 6)}${pad(r.leg, 14)}${pad(mark(r.applied), 6)}${pad(mark(r.red), 6)}${pad(mark(r.restored), 8)}`
    + `${ok ? '' : '← '}${r.desc}｜${r.detail}`,
  )
}

const bad = results.filter((r) => !(r.applied && r.red && r.restored && !r.crashed))
console.log('-'.repeat(110))
console.log(`合计 ${results.length - bad.length}/${results.length} 条探针同时满足：改到 ∧ 变红 ∧ 逐字节还原 ∧ 非崩溃\n`)

if (bad.length > 0) {
  console.log('不合格的探针：')
  for (const r of bad) console.log(`  ${r.id}  ${r.desc}｜${r.detail}`)
  console.log('')
  process.exit(1)
}
process.exit(0)
