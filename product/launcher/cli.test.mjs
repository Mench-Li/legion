// product/launcher/cli.test.mjs
// ============================================================================
// PRT-251 命令行入口的判据。
//
// CLI 层最容易出的两类问题是「参数解析」与「退出码」：
//   - `--port.team-hub=abc` 若被静默忽略，用户会以为端口改了，实际没有；
//   - 失败返回 0 会让脚本化的启动流程把「起不来」当成「起好了」。
// 这两类都不抛异常，因此必须有用例盯着。
//
// `run()` 全程不碰真实进程与真实信号：`write` 注入、`waitForSignal: false`，
// 且只用 `--check` 或参数错误这两种不启动进程的路径。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLI_FLAGS, parseArgs, readEnv, readReadinessTimeoutMs, run } from './cli.mjs'
import { reserveEphemeralPort } from './ports.mjs'

/** 收集输出的收集器。 */
function collector() {
  const lines = []
  return { lines, write: (m) => lines.push(String(m)), text: () => lines.join('\n') }
}

function envFor(root) {
  return {
    LEGION_HOME: root,
    LEGION_INSTALL_DIR: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    LEGION_DATA_DIR: join(root, 'data'),
    LEGION_WORKSPACE_DIR: join(root, 'ws'),
  }
}

test('parseArgs：只接受 --k=v，位置参数与未知参数都被点名拒绝', () => {
  assert.deepEqual(parseArgs([]).errors, [])
  const ok = parseArgs(['--install-dir=C:\\L', '--port.team-hub=9000', '--include=a,b', '--check'])
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.flags['install-dir'], 'C:\\L')
  assert.equal(ok.ports['team-hub'], 9000)
  assert.equal(ok.flags.include, 'a,b')
  assert.equal(ok.flags.check, true)

  const positional = parseArgs(['start'])
  assert.equal(positional.errors.length, 1)
  assert.match(positional.errors[0], /无法识别的参数「start」/)

  const unknown = parseArgs(['--gizmo=1'])
  assert.match(unknown.errors[0], /未知参数「--gizmo」/)

  const badPort = parseArgs(['--port.team-hub=abc'])
  assert.match(badPort.errors[0], /不是合法端口/)
  assert.equal('team-hub' in badPort.ports, false, '非法端口不得被静默丢弃成一个键')
})

test('readEnv：逐字读取七个 LEGION_* 布局键（供 scan --check 列出读取点）', () => {
  const env = readEnv({
    LEGION_HOME: '/h', LEGION_INSTALL_DIR: '/i', LEGION_DATA_DIR: '/d', LEGION_WORKSPACE_DIR: '/w',
    LEGION_CACHE_DIR: '/c', LEGION_LOG_DIR: '/l', LEGION_PRODUCT_CONFIG: '/p',
    TEAM_HUB_PORT: '9000', // 不属于本进程读取面
  })
  assert.deepEqual(Object.keys(env).sort(), [
    'LEGION_CACHE_DIR', 'LEGION_DATA_DIR', 'LEGION_HOME', 'LEGION_INSTALL_DIR',
    'LEGION_LOG_DIR', 'LEGION_PRODUCT_CONFIG', 'LEGION_WORKSPACE_DIR',
  ])
  assert.equal('TEAM_HUB_PORT' in env, false)
})

test('readReadinessTimeoutMs：非法值回落为「未设置」而不是变成一个诡异的超时', () => {
  assert.equal(readReadinessTimeoutMs({}), null)
  assert.equal(readReadinessTimeoutMs({ LEGION_READINESS_TIMEOUT_MS: '' }), null)
  assert.equal(readReadinessTimeoutMs({ LEGION_READINESS_TIMEOUT_MS: 'abc' }), null)
  assert.equal(readReadinessTimeoutMs({ LEGION_READINESS_TIMEOUT_MS: '-5' }), null)
  assert.equal(readReadinessTimeoutMs({ LEGION_READINESS_TIMEOUT_MS: '1500' }), 1500)
})

test('--help：列出全部支持的参数（帮助与实现同源，不会各自漂移）', async () => {
  const out = collector()
  const code = await run({ argv: ['--help'], env: {}, write: out.write })
  assert.equal(code, 0)
  assert.match(out.text(), /Legion Launcher/)
  for (const f of CLI_FLAGS) assert.ok(out.text().includes(f.name), `帮助里缺少 ${f.name}`)
})

test('参数错误返回退出码 2，且不启动任何进程', async () => {
  const out = collector()
  const code = await run({ argv: ['--nope=1'], env: {}, write: out.write })
  assert.equal(code, 2)
  assert.match(out.text(), /未知参数/)
})

test('布局未确定（未给工作区）返回退出码 3，并把原因说清楚', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  try {
    const out = collector()
    // 刻意不给 LEGION_WORKSPACE_DIR：工作区是用户授权的目录，产品不提供默认值
    const code = await run({
      argv: [],
      env: { LEGION_HOME: root, LEGION_INSTALL_DIR: process.cwd(), LEGION_DATA_DIR: join(root, 'data') },
      write: out.write,
    })
    assert.equal(code, 3)
    assert.match(out.text(), /工作区/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check 通过时返回 0；端口被占用时返回 4 并点名进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  const { createServer } = await import('node:net')
  const server = createServer()
  const port = await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, () => resolve(server.address().port)))
  try {
    const ok = collector()
    const freePort = await reserveEphemeralPort()
    const codeOk = await run({
      argv: [`--port.team-hub=${freePort}`, '--include=team-hub', '--check'],
      env: envFor(root),
      write: ok.write,
    })
    assert.equal(codeOk, 0, ok.text())
    assert.match(ok.text(), /启动前体检通过/)

    const bad = collector()
    const codeBad = await run({
      argv: [`--port.team-hub=${port}`, '--include=team-hub', '--check'],
      env: envFor(root),
      write: bad.write,
    })
    assert.equal(codeBad, 4)
    assert.match(bad.text(), /端口/)
    assert.match(bad.text(), /team-hub/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})

test('--check --json：输出机器可读结论（供验收脚本使用）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  try {
    const out = collector()
    const port = await reserveEphemeralPort()
    const code = await run({
      argv: [`--port.team-hub=${port}`, '--include=team-hub', '--check', '--json'],
      env: envFor(root),
      write: out.write,
    })
    assert.equal(code, 0)
    const parsed = JSON.parse(out.text())
    assert.equal(parsed.ok, true)
    assert.equal(parsed.phase, null)
    // 受限范围的提醒必须出现在 JSON 里，而不是只出现在人读的文案里
    assert.ok(parsed.diagnostics.some((d) => d.code === 'PROCESS_EXCLUDED_BY_SCOPE'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 说明：这里**故意没有**「受限范围下启动真实进程并检查状态」的用例。
// `run()` 的启动路径会一直持有子进程直到收到信号，从用例里调用它只能靠
// 泄漏一个 team-hub 进程来收场。受限范围的状态语义因此放在
// `launcher.test.mjs`（直接构造 Launcher，用完显式 stop）里断言。
