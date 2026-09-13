// product/diagnostics/auto-export.test.mjs
// ============================================================================
// PRT-710 收尾：**启动失败时自动出诊断包**
//
// ## 这一批的要点不是"能出包"，是"自动写盘不会变成新故障"
//
// `--diagnostics=<dir>` 早就能用。补的是"用户没想起来的时候它也在"。
// 而这一步同时引入一个新危险：**自动写盘 = 在失败循环里自动写盘**。
//
// 所以本套件的重心是三条界：
//   ① 磁盘有界——反复失败之后留下的包**不超过 keep 个**（用真文件系统数）；
//   ② 只动自己认得的——`diagnostics/` 里混进别人的东西时**一个都不删**；
//   ③ 失败不换原因——诊断包出不来时，调用方**仍然**报原来的启动失败。
//
// 第 ③ 条尤其要紧，因为它的坏形态**看起来像正常工作**：
//
//   > 一个"出不了诊断包于是报了个诊断包错误"的启动，
//   > 与一个"真的就是诊断包坏了"的启动，
//   > 在用户读到的第一行上是同一个东西——
//   > 只不过前者会把一个**已经查明的**故障，换成一句**关于工具的**抱怨。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTO_EXPORT_CODES, AUTO_EXPORT_DEFAULTS,
  isOwnPackageName, planAutoExport, runAutoExport, stampOf,
} from './auto-export.mjs'

function tmpRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `legion-${tag}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 造一个**有东西可收**的布局。
 *
 * ★ 第一版只给了 `{ productHome: dir }`，于是每次导出都拿到
 *   `DIAG_EMPTY_PACKAGE`——因为 `defaultCandidates` 的全部候选都来自
 *   `logDir` / `productConfigPath` / `secretsFile`，而这三样都没给。
 *
 *   这个失败读起来像"自动导出坏了"，其实是**夹具没给候选**：
 *
 *     > 一个"没什么可收"的空包与一个"导出功能坏了"，在没有候选的时候
 *     > 报的是同一个错——只不过前者是夹具的问题，而它会让人去查产品。
 */
function layoutWithLogs(dir) {
  const logDir = join(dir, 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'launcher.log'), '启动日志一行\ntoken=abcdef123456\n')
  return { productHome: dir, logDir, productConfigPath: join(dir, 'product.config.json'), secretsFile: null }
}

// ============================================================================
// ① 命名形状：这就是"什么是我认得的东西"的唯一定义
// ============================================================================

test('★ `stampOf` 出的是本地时间、定宽、可字典序排序', () => {
  // 用本地时间构造（`new Date(y, m, d, ...)` 就是本地时间），
  // 这样这条用例在任何时区下都成立。
  assert.equal(stampOf(new Date(2026, 8, 13, 9, 5, 3)), '20260913-090503')
  // 定宽：字典序 == 时间序。少一个补零这条就不成立了。
  const a = stampOf(new Date(2026, 0, 1, 0, 0, 0))
  const b = stampOf(new Date(2026, 0, 1, 0, 0, 9))
  const c = stampOf(new Date(2026, 0, 1, 0, 0, 10))
  assert.ok(a < b && b < c, `字典序必须等于时间序：${a} < ${b} < ${c}`)
})

test('★ `isOwnPackageName` 只认自己的形状——收紧安全，放宽危险', () => {
  assert.ok(isOwnPackageName('diag-20260913-090503'))
  assert.ok(isOwnPackageName('diag-20260913-090503-2'), '去重后缀也是自己的')
  // 下面这些**都不是**自己的。清理的授权范围就是这个函数的返回值——
  // 放宽它 = 允许删掉别人的东西。
  for (const foreign of [
    'diag-abc',                       // 时间戳形状不对
    'diag-2026-09-13',                // 分隔不对
    'diagnostics',                    // 只有前缀
    'diag-',                          // 空时间戳
    'credentials.yaml',               // 别人的文件
    'diag-2026091-090503',            // 位数不够
    'diag-20260913-09050',            // 秒缺一位
    'xdiag-20260913-090503',          // 前缀不对
    'diag-20260913-0905039',          // 多一位
    '', null, undefined, 42,
  ]) {
    assert.equal(isOwnPackageName(foreign), false,
      `${JSON.stringify(foreign)} 被当成了自己的包——清理会删到不该删的东西`)
  }
})

// ============================================================================
// ② 纯判定：写哪个、删哪些
// ============================================================================

test('★★ 同一秒内重复失败 → 加去重后缀，不覆盖第一个包', () => {
  const now = new Date(2026, 8, 13, 9, 5, 3)
  const first = planAutoExport({ entries: [], now, keep: 3 })
  assert.equal(first.dirName, 'diag-20260913-090503')

  // 第二个包：同名已被占。不加后缀的话第二次失败只会拿到
  // `DIAG_PACKAGE_EXISTS`（导出**不覆盖**，那是对的），于是
  // "第 2 到第 N 次崩溃没有证据"。
  //
  //   > 一个"同一秒内第二次失败就不留证据"的自动导出，
  //   > 与一个"只在第一次失败时留证据"的自动导出，在崩溃循环里是同一个东西——
  //   > 只不过前者会让人以为导出**一直在跑**。
  const second = planAutoExport({ entries: ['diag-20260913-090503'], now, keep: 3 })
  assert.equal(second.dirName, 'diag-20260913-090503-2')
  assert.notEqual(second.dirName, first.dirName)

  const third = planAutoExport({ entries: ['diag-20260913-090503', 'diag-20260913-090503-2'], now, keep: 3 })
  assert.equal(third.dirName, 'diag-20260913-090503-3')
})

test('★★ `keep` 是"写完总共留几份"，所以先腾到 keep-1（按旧到新）', () => {
  const now = new Date(2026, 8, 13, 9, 5, 3)
  const entries = ['diag-20260913-090500', 'diag-20260913-090501', 'diag-20260913-090502']

  const p = planAutoExport({ entries, now, keep: 3 })
  // ★ 3 个已存在 + 1 个待写 = 4 > keep(3) → 只需要删 **1** 个最旧的。
  //
  //   第一版这里写成了"删 2 个"，而那会**多删一份**：`keep` 的含义是
  //   "写完之后总共留几份"，不是"写之前留几份"。多删一份的代价是
  //   证据少一份，而它不会有任何报错。
  assert.deepEqual([...p.prune], ['diag-20260913-090500'])
  assert.ok(!p.prune.includes('diag-20260913-090502'), '最新的那个不能被删')

  // keep=1：写完之后只留 1 份，所以现存 3 个全删。
  const one = planAutoExport({ entries, now, keep: 1 })
  assert.deepEqual([...one.prune], entries, 'keep=1 时必须腾空，否则写完全场有 2 个')
})

test('★★ 认不出的条目**一个都不动**，但要在 `foreign` 里说出来', () => {
  const now = new Date(2026, 8, 13, 9, 5, 3)
  const entries = [
    'diag-20260913-090500', 'diag-20260913-090501',
    'credentials.yaml', 'notes.txt', 'diag-abc',
  ]
  const p = planAutoExport({ entries, now, keep: 2 })
  assert.deepEqual([...p.foreign].sort(), ['credentials.yaml', 'diag-abc', 'notes.txt'])
  for (const f of p.foreign) {
    assert.ok(!p.prune.includes(f), `${f} 被列进了清理名单——"最旧"对一个认不出的东西没有定义`)
  }
  // 认出的两个要腾到 keep-1=1 → 删最旧的 1 个
  assert.deepEqual([...p.prune], ['diag-20260913-090500'])
})

test('★ `keep < 1` 抛错（0 会让"保留几份"变成"每次失败都删掉上次的"）', () => {
  for (const bad of [0, -1, 1.5, '3', null]) {
    assert.throws(() => planAutoExport({ entries: [], now: new Date(), keep: bad }), /keep 必须是/,
      `keep=${JSON.stringify(bad)} 被接受了`)
  }
})

// ============================================================================
// ③ 真文件系统：磁盘有界 + 不动别人的东西
// ============================================================================

test('★★★ 崩溃循环：反复失败之后，留下的包**不超过 keep 个**', async () => {
  const { dir, cleanup } = tmpRoot('autoexport-loop')
  try {
    const layout = layoutWithLogs(dir)
    const baseDir = join(dir, AUTO_EXPORT_DEFAULTS.dirName)

    // 循环 7 次失败，每次都换一秒（模拟真实的崩溃重启）。
    // 用**真实** exportDiagnosticPackage（不注入），所以这条同时验证了
    // 两个模块的接线：命名、不覆盖、清单、落盘。
    for (let i = 0; i < 7; i++) {
      const r = await runAutoExport({
        layout,
        reason: `第 ${i + 1} 次启动失败`,
        keep: 3,
        now: () => new Date(2026, 8, 13, 9, 5, i),
      })
      assert.equal(r.ok, true, `第 ${i + 1} 次没出包：${r.message}（${r.code ?? ''}）`)
    }

    const left = readdirSync(baseDir).filter((n) => isOwnPackageName(n))
    assert.ok(left.length <= 3, `留下的包超过了 keep：${left.length} 个 → ${left.join(', ')}`)
    assert.ok(left.length > 0, '一个包都没留下——那这个功能就等于没做')

    // ★★ 断言**留下的具体是哪三个**，而不只是"不超过三个"。
    //
    //   这一条是被探针 ㊲ 逼出来的：把清理方向反过来（删最新、留最旧）时，
    //   "份数 ≤ keep" 与"最新那个在"**两条都仍然成立**——因为无论删哪一头，
    //   写完之后总数都是 keep，而刚写下去的那个永远是最新的。
    //
    //     > 一个"只断言份数上界"的用例，
    //     > 与一个"断言了清理方向"的用例，看起来都在守清理——
    //     > 只不过前者在方向反了的时候**照样是绿的**，
    //     > 而方向反了的后果恰恰是"最有用的那份证据先没"。
    //
    //   7 次失败、keep=3 → 留下的必须是**最后三次**。
    assert.deepEqual([...left].sort(),
      ['diag-20260913-090504', 'diag-20260913-090505', 'diag-20260913-090506'],
      `留下的不是最后三个：${[...left].sort().join(', ')}——清理方向可能反了`)
    const sorted = [...left].sort()
    assert.equal(sorted[sorted.length - 1], 'diag-20260913-090506',
      `最新的包没留下：${sorted.join(', ')}`)
  } finally { cleanup() }
})

test('★★★ `diagnostics/` 里混进别人的东西 → 清理之后**它们还在**', async () => {
  const { dir, cleanup } = tmpRoot('autoexport-foreign')
  try {
    const baseDir = join(dir, AUTO_EXPORT_DEFAULTS.dirName)
    mkdirSync(baseDir, { recursive: true })
    // 别人的东西：一个密钥库、一个用户自己的笔记、一个形状不对的目录。
    writeFileSync(join(baseDir, 'credentials.yaml'), 'token: super-secret\n')
    writeFileSync(join(baseDir, 'notes.txt'), '用户自己的笔记\n')
    mkdirSync(join(baseDir, 'diag-abc'))
    writeFileSync(join(baseDir, 'diag-abc', 'keep-me.txt'), 'x')

    const layout = layoutWithLogs(dir)
    // 先造出 4 个自己的包（超过 keep=3，逼出清理）
    for (let i = 0; i < 4; i++) {
      await runAutoExport({
        layout, keep: 3,
        now: () => new Date(2026, 8, 13, 10, 0, i),
      })
    }

    assert.ok(existsSync(join(baseDir, 'credentials.yaml')), '**密钥库被删了**——清理越界了')
    assert.ok(existsSync(join(baseDir, 'notes.txt')), '用户自己的文件被删了')
    assert.ok(existsSync(join(baseDir, 'diag-abc', 'keep-me.txt')), '形状不对的目录被删了')

    const mine = readdirSync(baseDir).filter((n) => isOwnPackageName(n))
    assert.ok(mine.length <= 3, `自己的包也没收敛：${mine.length}`)
  } finally { cleanup() }
})

test('★★ 保留份数由 `keep` 决定，且**先清理再写**（占用收敛而非先涨后清）', async () => {
  const { dir, cleanup } = tmpRoot('autoexport-keep')
  try {
    const baseDir = join(dir, AUTO_EXPORT_DEFAULTS.dirName)
    const layout = layoutWithLogs(dir)
    for (let i = 0; i < 5; i++) {
      await runAutoExport({
        layout, keep: 2,
        now: () => new Date(2026, 8, 13, 11, 0, i),
      })
      // ★ 每一次之后都必须已经收敛。若实现是"先写再清"，中间那一刻就会超。
      const n = readdirSync(baseDir).filter((x) => isOwnPackageName(x)).length
      assert.ok(n <= 2, `第 ${i + 1} 轮之后有 ${n} 个包（keep=2）——清理没有跑在写入之前`)
    }
  } finally { cleanup() }
})

// ============================================================================
// ④ 失败路径：**绝不**把原因换掉，也绝不抛
// ============================================================================

test('★★★ 没有产品家目录 → 报 `NO_BASE_DIR`，**不猜**位置', async () => {
  const r = await runAutoExport({ layout: { productHome: null }, reason: '启动失败' })
  assert.equal(r.ok, false)
  assert.equal(r.code, AUTO_EXPORT_CODES.NO_BASE_DIR)
  assert.equal(r.reason, '启动失败', '原始原因必须原样带回来')
  assert.match(r.message, /不猜/)
})

test('★★★ 导出失败时 `reason` **原样保留**（诊断包坏了不许改写启动失败的原因）', async () => {
  const { dir, cleanup } = tmpRoot('autoexport-fail')
  try {
    const r = await runAutoExport({
      layout: { productHome: dir },
      reason: '启动失败（阶段：readiness）',
      // 注入一个必然失败的导出
      exportFn: async () => ({ ok: false, code: 'DIAG_WRITE_FAILED', message: '磁盘满了' }),
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, AUTO_EXPORT_CODES.EXPORT_FAILED)
    assert.equal(r.reason, '启动失败（阶段：readiness）',
      '原因被换成了诊断包的错误——用户读到的第一行会变成一句关于工具的抱怨')
    assert.match(r.message, /磁盘满了/, '导出失败的原因也不能丢')
  } finally { cleanup() }
})

test('★★★ 导出**抛错**时也不向外抛（调用方正在处理一个已发生的故障）', async () => {
  const { dir, cleanup } = tmpRoot('autoexport-throw')
  try {
    const r = await runAutoExport({
      layout: { productHome: dir },
      reason: '启动失败',
      exportFn: async () => { throw new Error('boom') },
    })
    // 这里若抛出去，CLI 会以一个未捕获异常结束，而**原来的启动失败**就丢了。
    assert.equal(r.ok, false)
    assert.equal(r.code, AUTO_EXPORT_CODES.EXPORT_FAILED)
    assert.match(r.message, /boom/)
  } finally { cleanup() }
})

test('★★ 基础目录读不出来 → 报 `BASE_DIR_FAILED`，而不是当成"目录是空的"', async () => {
  const r = await runAutoExport({
    layout: { productHome: '/whatever' },
    reason: '启动失败',
    fs: {
      existsSync: () => true,
      readdirSync: () => { throw new Error('EACCES') },
      rmSync: () => {},
    },
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, AUTO_EXPORT_CODES.BASE_DIR_FAILED)
  // "读不出来"与"目录是空的"必须分开：前者会静默跳过清理，
  // 于是一个塞满的目录永远不被收缩。
  assert.match(r.message, /EACCES/)
})

test('★ 显式关闭 → `DISABLED`，且**不碰文件系统**', async () => {
  let touched = false
  const r = await runAutoExport({
    layout: { productHome: '/x' },
    reason: '启动失败',
    enabled: false,
    fs: {
      existsSync: () => { touched = true; return false },
      readdirSync: () => { touched = true; return [] },
      rmSync: () => { touched = true },
    },
  })
  assert.equal(r.code, AUTO_EXPORT_CODES.DISABLED)
  assert.equal(touched, false, '关掉之后仍然碰了文件系统')
})

test('★ 清理删不掉时**不抛**、不报成故障（删不掉不是启动失败的原因）', async () => {
  const { dir, cleanup } = tmpRoot('autoexport-rmfail')
  try {
    const baseDir = join(dir, AUTO_EXPORT_DEFAULTS.dirName)
    mkdirSync(baseDir, { recursive: true })
    // 造 3 个自己的包，keep=1 → 需要删 2 个
    for (const n of ['diag-20260913-090500', 'diag-20260913-090501', 'diag-20260913-090502']) {
      mkdirSync(join(baseDir, n))
    }
    const calls = []
    const realFs = await import('node:fs')
    const r = await runAutoExport({
      layout: layoutWithLogs(dir), keep: 1, reason: '启动失败',
      // ★ 时间戳要与预置的目录名同一天，否则新目录名和它们不冲突，
      //   这条用例就测不到"清理失败"了。
      now: () => new Date(2026, 8, 13, 9, 5, 30),
      // ⚠️ 替身必须**完整**（转发给真实实现，只覆盖 rmSync）。
      //
      //   第一版只给了 existsSync/readdirSync/rmSync 三个键，于是导出那一步
      //   拿到一个没有 `mkdirSync`/`writeFileSync` 的 fs，红在
      //   `DIAG_WRITE_FAILED：TypeError` 上——而真正的原因是**替身不完整**，
      //   不是清理逻辑。
      //
      //     > 一个"少给几个方法的 fs 替身"，与一个"写入真的坏了"的产品，
      //     > 报出来是同一个失败——只不过前者会让人去查导出模块。
      fs: { ...realFs, rmSync: (p) => { calls.push(p); throw new Error('EBUSY') } },
    })
    assert.ok(calls.length > 0, '没有尝试清理')
    assert.equal(r.ok, true, `清理失败不该让整体失败：${r.message}`)
    assert.deepEqual(r.pruned, [], '删失败了却报成删掉了')
  } finally { cleanup() }
})

// ============================================================================
// ⑤ CLI 接线：真的在启动失败那条路上被调用，且**不改退出码**
// ============================================================================

test('★★★ CLI：启动失败 → 自动导出被调用，**退出码仍是 5**', async () => {
  const { dir, cleanup } = tmpRoot('autoexport-cli')
  try {
    const { EXIT_CODES, run } = await import('../launcher/cli.mjs')
    const lines = []
    const seen = []

    // 注入一个"必然失败"的启动器：真实的 `start()` 失败形状由 createLauncher
    // 的契约决定，这里只换掉**谁去起进程**。
    const fakeLauncher = () => ({
      async start() { return { ok: false, phase: 'readiness', failures: [{ process: 'team-hub', code: 'READINESS_TIMEOUT', detail: '等不到就绪' }] } },
      status() { return { state: 'failed', stateText: '启动失败', scope: 'default', processes: [] } },
      allDiagnostics() { return [] },
    })

    const code = await run({
      argv: ['--workspace=' + join(dir, 'ws')],
      env: {
        LEGION_HOME: dir,
        LEGION_INSTALL_DIR: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        LEGION_DATA_DIR: join(dir, 'data'),
        LEGION_WORKSPACE_DIR: join(dir, 'ws'),
      },
      write: (m) => lines.push(String(m)),
      waitForSignal: false,
      createLauncherFn: fakeLauncher,
      autoExportFn: async (deps) => { seen.push(deps); return { ok: true, reason: deps.reason, pruned: [], foreign: [], path: join(dir, 'diagnostics', 'diag-x'), message: '已自动留下诊断包：x' } },
    })

    assert.equal(code, EXIT_CODES.start, '自动导出不得改变启动失败的退出码')
    assert.equal(seen.length, 1, '启动失败时没有调用自动导出')
    assert.match(seen[0].reason, /启动失败/, '传下去的 reason 没有说清是哪一次失败')
    assert.ok(seen[0].layout?.productHome, '没有把布局传下去——那样它无从决定写到哪里')
    const text = lines.join('\n')
    assert.ok(text.includes('已自动留下诊断包'), `没有把结果告诉用户：\n${text}`)
    assert.ok(text.includes('READINESS_TIMEOUT'), '原来的失败原因必须还在')
  } finally { cleanup() }
})

test('★★★ CLI：`--no-auto-diagnostics` 真的关掉它（关得掉的开关才算开关）', async () => {
  const { dir, cleanup } = tmpRoot('autoexport-cli-off')
  try {
    const { run } = await import('../launcher/cli.mjs')
    const lines = []
    const seen = []
    const fakeLauncher = () => ({
      async start() { return { ok: false, phase: 'readiness', failures: [{ process: 'x', code: 'C', detail: 'd' }] } },
      status() { return { state: 'failed', stateText: 'x', scope: 'default', processes: [] } },
      allDiagnostics() { return [] },
    })
    await run({
      argv: ['--no-auto-diagnostics'],
      env: {
        LEGION_HOME: dir,
        LEGION_INSTALL_DIR: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        LEGION_DATA_DIR: join(dir, 'data'),
        LEGION_WORKSPACE_DIR: join(dir, 'ws'),
      },
      write: (m) => lines.push(String(m)),
      waitForSignal: false,
      createLauncherFn: fakeLauncher,
      autoExportFn: async (deps) => { seen.push(deps); return { ok: false, reason: deps.reason, pruned: [], foreign: [], message: 'x' } },
    })
    assert.equal(seen.length, 0, '--no-auto-diagnostics 之后仍然调用了自动导出')
    assert.ok(!lines.join('\n').includes('诊断包'), `关掉之后不该提诊断包：\n${lines.join('\n')}`)
  } finally { cleanup() }
})

test('★★ CLI：自动导出失败**不改写**用户看到的启动失败', async () => {
  const { dir, cleanup } = tmpRoot('autoexport-cli-fail')
  try {
    const { EXIT_CODES, run } = await import('../launcher/cli.mjs')
    const lines = []
    const fakeLauncher = () => ({
      async start() { return { ok: false, phase: 'readiness', failures: [{ process: 'team-hub', code: 'READINESS_TIMEOUT', detail: '原来的原因' }] } },
      status() { return { state: 'failed', stateText: 'x', scope: 'default', processes: [] } },
      allDiagnostics() { return [] },
    })
    const code = await run({
      argv: [],
      env: {
        LEGION_HOME: dir,
        LEGION_INSTALL_DIR: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
        LEGION_DATA_DIR: join(dir, 'data'),
        LEGION_WORKSPACE_DIR: join(dir, 'ws'),
      },
      write: (m) => lines.push(String(m)),
      waitForSignal: false,
      createLauncherFn: fakeLauncher,
      autoExportFn: async () => ({ ok: false, reason: '启动失败', pruned: [], foreign: [], code: 'AUTO_EXPORT_FAILED', message: '磁盘满了' }),
    })
    assert.equal(code, EXIT_CODES.start)
    const text = lines.join('\n')
    // ★ 这两条一起才说明"没被改写"：原来的原因还在，且诊断包的错误是**附加**的。
    assert.ok(text.includes('原来的原因'), `启动失败的原因不见了：\n${text}`)
    assert.ok(text.includes('未留下诊断包'), `没有如实说出诊断包没出来：\n${text}`)
    assert.ok(text.indexOf('原来的原因') < text.indexOf('未留下诊断包'),
      '诊断包的消息排在了启动失败之前——它应当是一条附注，不是主因')
  } finally { cleanup() }
})

test('★ CLI 的帮助里列出了这两个参数（没有帮助的开关等于没有开关）', async () => {
  const { CLI_FLAGS } = await import('../launcher/cli.mjs')
  const names = CLI_FLAGS.map((f) => f.name)
  assert.ok(names.includes('--no-auto-diagnostics'))
  assert.ok(names.includes('--auto-diagnostics-keep=<n>'))
  // ★ 不能有 `--auto-diagnostics`：它已经是默认值，那个参数**没有任何效果**，
  //   而一个没有效果的参数会让人以为"这件事要显式打开"。
  assert.ok(!names.includes('--auto-diagnostics'),
    '存在一个与默认值同义的 --auto-diagnostics —— 它是个空操作，会误导读帮助的人')
})
