// 这一组验证 PRT-709 的**接线**：sink 真的接在子进程的输出上，
// 并且**排空**真的发生了。
//
// 为什么必须用真实子进程测：整个 bug 的形状就是"管道被写满之后子进程阻塞"。
// 用假 stream 测不出这个——假 stream 不会满。
//
//   一个用假流验证过的排空，与一个真的排空，
//   在"子进程会不会卡住"上原本是同一个答案。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createSupervisedProcess } from '../launcher/supervisor.mjs'
import { createLauncher } from '../launcher/launcher.mjs'
import { resolveLayout } from '../paths.mjs'
import { createLogSink } from './sink.mjs'
import * as nodeFs from 'node:fs'

const here = (p) => pathToFileURL(p).href

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legion-logwire-'))
  const logDir = join(root, 'log')
  mkdirSync(logDir, { recursive: true })
  return { root, logDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 让 launcher 在临时目录里解析出布局（与 `launcher.test.mjs` 同法）。 */
function layoutIn(root) {
  return resolveLayout({
    env: {
      LEGION_PRODUCT_HOME: root,
      LEGION_DATA_DIR: join(root, 'data'),
      LEGION_LOG_DIR: join(root, 'log'),
      LEGION_CACHE_DIR: join(root, 'cache'),
      LEGION_INSTALL_DIR: root,
      LEGION_WORKSPACE_DIR: join(root, 'ws'),
    },
    platform: process.platform,
  }).layout
}

/** 写一个"话很多"的脚本：输出远大于任何管道缓冲区。 */
function noisyScript(root, bytes = 2 * 1024 * 1024) {
  const p = join(root, 'noisy.mjs')
  writeFileSync(p, [
    '// 分成很多块写，确保真的会把管道填满',
    `const total = ${bytes}`,
    'const chunk = "x".repeat(8192) + "\\n"',
    'let written = 0',
    'while (written < total) {',
    '  process.stdout.write(chunk)',
    '  written += chunk.length',
    '}',
    'process.stderr.write("done\\n")',
  ].join('\n'))
  return p
}

test('接线：sink 建得起来时，子进程的输出**真的落到日志文件里**', async () => {
  const f = fixture()
  try {
    const script = noisyScript(f.root, 64 * 1024)
    const sink = createLogSink({ logDir: f.logDir, fs: nodeFs })
    const proc = createSupervisedProcess({
      key: 'noisy',
      label: 'noisy',
      command: { file: process.execPath, args: [script] },
      cwd: f.root,
      required: false,
      readiness: { kind: 'none' },
    }, {
      envFor: () => ({ env: { ...process.env } }),
      onOutput: (key, stream, chunk) => sink.write(`${key}.${stream}`, chunk),
    })
    proc.start()
    await new Promise((r) => setTimeout(r, 2500))
    proc.dispose?.()
    sink.flush()

    const files = readdirSync(f.logDir)
    assert.ok(files.length > 0, `日志目录是空的：子进程的输出没有被接上`)
    const body = files.map((n) => readFileSync(join(f.logDir, n), 'utf8')).join('\n')
    assert.ok(body.includes('done'), 'stderr 的收尾内容没有落盘')
    assert.ok(body.length > 1000, `落盘的日志太少（${body.length} 字节）`)
  } finally { f.cleanup() }
})

test('接线：launcher 停止时**把尾巴 flush 下去**（退出前那几行正是最需要的一段）', async () => {
  const f = fixture()
  try {
    // 用 `runtime`：它的就绪判据是 `none`，所以不必真的起一个 HTTP 服务。
    const layout = layoutIn(f.root)
    const launcher = createLauncher({
      layout,
      include: ['runtime'],
      spawnImpl: () => {
        const c = new EventEmitter()
        c.pid = 4321
        c.stdout = new EventEmitter(); c.stdout.resume = () => {}
        c.stderr = new EventEmitter(); c.stderr.resume = () => {}
        c.exitCode = null; c.signalCode = null; c.killed = false
        c.kill = () => { c.killed = true; return true }
        return c
      },
      logFs: nodeFs,
    })
    await launcher.start()
    const status = launcher.logStatus()
    assert.equal(status.available, true, '日志 sink 没建起来')
    // 关键：**启动在 preflight 就失败**（`runtime` 的入口在临时目录里解析不出来），
    // 而这恰恰是最该留证的场景。所以 sink 必须在 start 的**第一步**就存在。
    const stopped = await launcher.stop({ reason: '用例' })
    assert.ok('log' in stopped, 'stop 没有返回日志收尾结果——尾巴可能丢了')
    assert.notEqual(stopped.log, null,
      'stop 在"什么都没起来"的路径上**跳过了**日志收尾：' +
      '于是失败启动的日志既不会被 flush，也不会被轮转')
    // 收尾真的做了一件事：轮转跑过（返回的是轮转结果，不是一个占位对象）
    for (const k of ['ok', 'rotated', 'pruned', 'failures', 'notes']) {
      assert.ok(k in stopped.log, `轮转结果缺少 ${k}——这不像是一次真的轮转`)
    }
    assert.equal(stopped.log.ok, true, JSON.stringify(stopped.log.failures ?? []))
    assert.equal(launcher.logStatus().lastRotation !== null, true, 'lastRotation 没有留下痕迹')
  } finally { f.cleanup() }
})

test('接线：周期轮转的定时器**必须 `unref`**（否则启动器进程永远不退出）', async () => {
  const f = fixture()
  try {
    let unrefCalled = false
    const fakeTimer = { unref: () => { unrefCalled = true } }
    const layout = layoutIn(f.root)
    const launcher = createLauncher({
      layout,
      include: ['runtime'],
      spawnImpl: () => {
        const c = new EventEmitter()
        c.pid = 4322
        c.stdout = new EventEmitter(); c.stdout.resume = () => {}
        c.stderr = new EventEmitter(); c.stderr.resume = () => {}
        c.exitCode = null; c.signalCode = null; c.killed = false
        c.kill = () => { c.killed = true; return true }
        return c
      },
      logFs: nodeFs,
      logRotateIntervalMs: 1000,
      setIntervalImpl: () => fakeTimer,
      clearIntervalImpl: () => {},
    })
    await launcher.start()
    await launcher.stop({ reason: '用例' })
    assert.equal(unrefCalled, true,
      '轮转定时器没有 unref：一个被引用的定时器会让启动器进程永远不退出，' +
      '于是"命令跑完了但不返回"会成为一个莫名其妙的现场')
  } finally { f.cleanup() }
})

test('接线：`dispose()` 之后**不再往 sink 送输出**（调用方那时可能已经关掉 sink）', () => {
  const f = fixture()
  try {
    const child = new EventEmitter()
    child.pid = 9999
    child.stdout = new EventEmitter(); child.stdout.resume = () => {}
    child.stderr = new EventEmitter(); child.stderr.resume = () => {}
    child.exitCode = null; child.signalCode = null; child.killed = false
    child.kill = () => { child.killed = true; return true }

    const seen = []
    const proc = createSupervisedProcess({
      key: 'x', label: 'x',
      command: { file: process.execPath, args: ['-e', ''] },
      cwd: f.root, required: false, readiness: { kind: 'none' },
    }, {
      spawnImpl: () => child,
      envFor: () => ({ env: {} }),
      onOutput: (key, stream, chunk) => seen.push(String(chunk)),
    })
    proc.start()
    child.stdout.emit('data', 'before\n')
    const before = seen.length
    assert.ok(before > 0, 'dispose 之前就没有数据流过来，这条用例证明不了什么')

    proc.dispose()
    child.stdout.emit('data', 'after-dispose\n')
    assert.equal(seen.length, before,
      'dispose 之后仍往 sink 送数据：那时调用方很可能已经 close 了 sink' +
      '（launcher 的 stop() 就是先 dispose 再收尾日志），继续送只会写进一个已关掉的对象')
  } finally { f.cleanup() }
})

test('接线：**不接 sink 时也必须排空**——否则子进程会卡在写满的管道上', async () => {
  const f = fixture()
  try {
    // 2 MiB 远大于 Windows 管道缓冲区（几十 KB）。如果没人读，
    // 这个子进程会**永远写不完**——不退出、不报错。
    const script = noisyScript(f.root, 2 * 1024 * 1024)
    const proc = createSupervisedProcess({
      key: 'noisy',
      label: 'noisy',
      command: { file: process.execPath, args: [script] },
      cwd: f.root,
      required: false,
      readiness: { kind: 'none' },
    }, {
      envFor: () => ({ env: { ...process.env } }),
      // **刻意不给 onOutput**：这正是修复前的情形
    })
    proc.start()
    // 等它自己跑完。若管道没人排空，它会卡住 → 这里就超时。
    //
    // 判据是"它**退出过**"，而不是"它现在还停着"：监督层在子进程正常退出后
    // 会安排重启，所以状态会变成 `restarting`/`backoff`。第一版只认
    // `stopped`/`pending`，于是在**修复之后**仍然判失败——一个判据写错的用例，
    // 与一个真的失败的用例，在输出上长得一模一样。
    const exitedStates = new Set(['stopped', 'pending', 'restarting', 'backoff', 'circuit-open'])
    let exited = false
    let seen = []
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const st = proc.status().state
      if (!seen.includes(st)) seen.push(st)
      if (exitedStates.has(st)) { exited = true; break }
      await new Promise((r) => setTimeout(r, 100))
    }
    const st = proc.status()
    proc.dispose?.()
    assert.equal(exited, true,
      `子进程没有跑完（状态 ${st.state}，见过 ${seen.join('→')}）：` +
      '2 MiB 的输出把管道写满之后它卡住了。这正是"没人读 stdout"的那个 bug')
  } finally { f.cleanup() }
})
