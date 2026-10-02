import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runWorkflowTestCommand, validateWorkflowTestRunner } from '../lib/workflowTestRunner.js'

const runner = { executable: 'node', args: ['--version'], timeoutMs: 5000 }

test('独立测试 runner 只接受固定 executable 与无 shell argv', () => {
  assert.equal(validateWorkflowTestRunner(runner), null)
  assert.match(validateWorkflowTestRunner({ executable: 'sh', args: ['-c', 'echo ok'], timeoutMs: 5000 }), /不受支持/)
  assert.match(validateWorkflowTestRunner({ executable: 'node', args: ['--eval=process.exit(0)'], timeoutMs: 5000 }), /argv/)
  assert.match(validateWorkflowTestRunner({ executable: 'node', args: ['test;whoami'], timeoutMs: 5000 }), /argv/)
  assert.match(validateWorkflowTestRunner({ executable: 'node', args: ['--version'], timeoutMs: 999 }), /timeoutMs/)
})

test('runner 在指定 worktree 执行并返回 UUID、退出码、输出摘要且不继承密钥环境变量', async () => {
  let captured
  const previousToken = process.env.API_TOKEN
  process.env.API_TOKEN = 'private-token-value'
  try {
    const receipt = await runWorkflowTestCommand({
      runner,
      cwd: process.cwd(),
      id: 'wft-12345678-1234-1234-1234-123456789abc',
      spawnImpl(file, args, options) {
        captured = { file, args, options }
        return spawn(file, args, options)
      },
    })
    assert.equal(receipt.state, 'passed')
    assert.equal(receipt.exitCode, 0)
    assert.equal(receipt.executable, 'node')
    assert.deepEqual(receipt.args, ['--version'])
    assert.match(receipt.outputDigest, /^[0-9a-f]{64}$/)
    assert.match(receipt.outputExcerpt, /^v\d/)
    assert.equal(captured.options.shell, false)
    assert.equal(captured.options.cwd, process.cwd())
    assert.equal(Object.hasOwn(captured.options.env, 'API_TOKEN'), false)
  } finally {
    if (previousToken === undefined) delete process.env.API_TOKEN
    else process.env.API_TOKEN = previousToken
  }
})

test('runner failure is not reported as pass; malformed cwd or id never starts the command', async () => {
  const failed = await runWorkflowTestCommand({ runner: { ...runner, args: ['--invalid-option'] }, cwd: process.cwd() })
  assert.equal(failed.state, 'failed')
  assert.notEqual(failed.exitCode, 0)
  let started = false
  await assert.rejects(() => runWorkflowTestCommand({ runner, cwd: '', spawnImpl: () => { started = true; throw new Error('unexpected') } }), /cwd/)
  assert.equal(started, false)
  await assert.rejects(() => runWorkflowTestCommand({ runner, cwd: process.cwd(), id: 'bad id' }), /UUID/)
})

test('runner timeout is unknown and returns only after terminating the test process tree', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'legion-workflow-test-timeout-'))
  try {
    writeFileSync(join(cwd, 'slow.test.mjs'), [
      "import test from 'node:test'",
      "test('slow test', async () => await new Promise(resolve => setTimeout(resolve, 5000)))",
      '',
    ].join('\n'))
    const startedAt = Date.now()
    const receipt = await runWorkflowTestCommand({
      runner: { executable: 'node', args: ['--test', 'slow.test.mjs'], timeoutMs: 1000 }, cwd,
    })
    assert.equal(receipt.state, 'unknown')
    assert.equal(receipt.exitCode, null)
    assert.ok(Date.now() - startedAt < 5000, 'timeout does not wait for the test body to finish')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('Windows npm runner invokes npm-cli.js through Node without cmd.exe', { skip: process.platform !== 'win32' }, async () => {
  let captured
  const receipt = await runWorkflowTestCommand({
    runner: { executable: 'npm', args: ['--version'], timeoutMs: 5000 },
    cwd: process.cwd(),
    spawnImpl(file, args, options) {
      captured = { file, args, options }
      return spawn(file, args, options)
    },
  })
  assert.equal(receipt.state, 'passed')
  assert.equal(captured.file, process.execPath)
  assert.match(captured.args[0], /[\\/]node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/)
  assert.equal(captured.options.shell, false)
})

test('npm test executes the frozen project test script from an isolated worktree', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'legion-workflow-npm-test-'))
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'legion-workflow-runner-fixture',
      version: '1.0.0',
      scripts: { test: 'node --test test/smoke.test.mjs' },
    }))
    mkdirSync(join(cwd, 'test'))
    writeFileSync(join(cwd, 'test', 'smoke.test.mjs'), [
      "import assert from 'node:assert/strict'",
      "import test from 'node:test'",
      "test('fixture script runs', () => assert.equal(2 + 2, 4))",
      '',
    ].join('\n'))
    const receipt = await runWorkflowTestCommand({
      runner: { executable: 'npm', args: ['test'], timeoutMs: 15000 },
      cwd,
    })
    assert.equal(receipt.state, 'passed', receipt.error ?? receipt.outputExcerpt)
    assert.equal(receipt.exitCode, 0)
    assert.match(receipt.outputExcerpt, /fixture script runs/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
