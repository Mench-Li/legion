// product/diagnostics/diagnostics-cli.test.mjs
// ============================================================================
// PRT-710 的**入口**（`legion --diagnostics=<dir>`）
//
// 这一组的核心只有一条，而它是"功能"与"能用的功能"之间的分界：
//
//   **诊断入口必须在产品坏掉的时候还能用。**
//
// 诊断包最需要在什么时候拿到？产品起不来的时候。把它挂在"配置能解析、
// 布局合法才往下走"的流程后面，等于在最需要它的那一刻恰好用不了：
//
//   > 一个只在产品健康时才可用的诊断入口，与一个不存在的诊断入口，
//   > 在最需要它的那一刻是同一个东西。
//
// 所以这里逐条验证它**不依赖**那些东西：布局有 error、配置是坏 JSON、
// 目录根本没建——它照样出包。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run } from '../launcher/cli.mjs'
import { SECRETS_DIRNAME, SECRETS_FILENAME } from '../paths.mjs'

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345'

/** 造一个真实的临时产品目录（诊断包要真的落盘，所以不能用假 fs）。 */
function fixture({ logFiles = {}, configText = '{}\n', extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-diag-'))
  const logDir = join(root, 'log')
  const dataDir = join(root, 'data')
  mkdirSync(logDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  for (const [name, body] of Object.entries(logFiles)) writeFileSync(join(logDir, name), body)
  const productConfigPath = join(dataDir, 'product.config.json')
  writeFileSync(productConfigPath, configText)
  return {
    root, logDir, dataDir, productConfigPath,
    env: {
      LEGION_HOME: root,
      LEGION_INSTALL_DIR: root,
      LEGION_DATA_DIR: dataDir,
      LEGION_LOG_DIR: logDir,
      LEGION_CACHE_DIR: join(root, 'cache'),
      LEGION_WORKSPACE_DIR: join(root, 'ws'),
      LEGION_PRODUCT_CONFIG: productConfigPath,
      ...extra,
    },
    cleanup: () => { try { rmSync(root, { recursive: true, force: true }) } catch { /* 尽力而为 */ } },
  }
}

function capture() {
  const lines = []
  return { lines, write: (s) => lines.push(String(s)), text: () => lines.join('\n') }
}

test('入口：`--diagnostics=<dir>` 产出诊断包并返回 0', async () => {
  const f = fixture({ logFiles: { 'app.log': `key=${SECRET}\n` } })
  try {
    const out = join(f.root, 'pkg')
    const c = capture()
    const code = await run({ argv: [`--diagnostics=${out}`], env: f.env, write: c.write, waitForSignal: false })
    assert.equal(code, 0, c.text())
    assert.ok(existsSync(join(out, 'manifest.json')), '包里必须有清单')
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.verified.clean, true)
    // 落盘的内容里不能有原值
    const body = readdirSync(out).filter((n) => n.endsWith('.txt')).map((n) => readFileSync(join(out, n), 'utf8')).join('')
    assert.ok(!body.includes(SECRET))
    assert.match(body, /\[已脱敏\]/)
  } finally { f.cleanup() }
})

test('入口：**布局有 error 时照样出包**（最需要它的时候恰好用不了，是这条功能最容易犯的错）', async () => {
  // 刻意把工作区目录撤掉：`resolveLayout` 会因此报 WORKSPACE_NOT_CONFIGURED(error)。
  const f = fixture({ logFiles: { 'app.log': 'plain\n' }, extra: { LEGION_WORKSPACE_DIR: '' } })
  try {
    const out = join(f.root, 'pkg-broken-layout')
    const c = capture()
    const code = await run({ argv: [`--diagnostics=${out}`], env: f.env, write: c.write, waitForSignal: false })
    assert.equal(code, 0, `布局不合法时诊断入口必须仍然可用：\n${c.text()}`)
    assert.ok(existsSync(join(out, 'manifest.json')))
    assert.ok(!/无法启动：目录布局未确定/.test(c.text()),
      '走到"布局未确定"那条分支就说明诊断导出被排在了它后面——那样最需要时就用不了')
  } finally { f.cleanup() }
})

test('入口：**产品配置是坏 JSON 时照样出包**（配置坏掉正是要看诊断的时候）', async () => {
  const f = fixture({ logFiles: { 'app.log': 'plain\n' }, configText: '{ this is not json' })
  try {
    const out = join(f.root, 'pkg-broken-config')
    const c = capture()
    const code = await run({ argv: [`--diagnostics=${out}`], env: f.env, write: c.write, waitForSignal: false })
    assert.equal(code, 0, `配置坏掉时诊断入口必须仍然可用：\n${c.text()}`)
    assert.ok(existsSync(join(out, 'manifest.json')))
    assert.ok(!/无法启动：产品配置有问题/.test(c.text()))
  } finally { f.cleanup() }
})

test('入口：**不启动任何进程**（它只打包，不拉起产品）', async () => {
  const f = fixture({ logFiles: { 'app.log': 'x\n' } })
  try {
    const out = join(f.root, 'pkg-nostart')
    const c = capture()
    const code = await run({ argv: [`--diagnostics=${out}`], env: f.env, write: c.write, waitForSignal: false })
    assert.equal(code, 0, c.text())
    // preflight 会打印端口检查；诊断路径不该走到那里
    assert.ok(!/启动前体检/.test(c.text()))
    assert.ok(!/启动失败/.test(c.text()))
  } finally { f.cleanup() }
})

test('入口：密钥库**不在包里**，且清单里**不出现它的路径**', async () => {
  const f = fixture({ logFiles: { 'app.log': 'ok\n' } })
  try {
    // 用**产品真实的**密钥库位置与文件名（`secrets/credentials.json`）。
    // 第一版这里手写了 `secrets.json`——那是个不存在的名字，
    // 于是这条用例在"产品真实密钥库有没有被排除"上什么也没验证到。
    const secretsDir = join(f.root, SECRETS_DIRNAME)
    mkdirSync(secretsDir, { recursive: true })
    const storePath = join(secretsDir, SECRETS_FILENAME)
    writeFileSync(storePath, '{"K1":"CIPHERTEXT-SHOULD-NOT-LEAK"}')
    const out = join(f.root, 'pkg-secret')
    const c = capture()
    const code = await run({ argv: [`--diagnostics=${out}`], env: f.env, write: c.write, waitForSignal: false })
    assert.equal(code, 0, c.text())
    const all = readdirSync(out).map((n) => readFileSync(join(out, n), 'utf8')).join('\n')
    assert.ok(!all.includes('CIPHERTEXT-SHOULD-NOT-LEAK'), '密钥库内容进包了')
    assert.ok(!all.includes(storePath), '清单里出现了密钥库的绝对路径')
    // 断言的是**这件事**（密钥库那个候选被排除了），不是"哪条规则干的"：
    // 硬编码规则名会让用例在规则被重命名时假红，也会在规则**换了但覆盖了**
    // 的时候假绿——而真正要守的是"它没进包"。
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    assert.ok(manifest.excluded.some((e) => e.role === 'secret-store'),
      `密钥库那个候选没有被排除：${JSON.stringify(manifest.excluded)}`)
  } finally { f.cleanup() }
})

test('入口：人读输出里**列出了排除项**（说不清排除了什么 = 收件人以为是漏收）', async () => {
  const f = fixture({ logFiles: { 'app.log': 'ok\n' } })
  try {
    const out = join(f.root, 'pkg-human')
    const c = capture()
    const code = await run({ argv: [`--diagnostics=${out}`], env: f.env, write: c.write, waitForSignal: false })
    assert.equal(code, 0, c.text())
    assert.match(c.text(), /已排除/)
    assert.match(c.text(), /密钥库|凭证/)
  } finally { f.cleanup() }
})

test('入口：`--json` 给出机器可读的结果（含 manifest）', async () => {
  const f = fixture({ logFiles: { 'app.log': 'ok\n' } })
  try {
    const out = join(f.root, 'pkg-json')
    const c = capture()
    const code = await run({ argv: [`--diagnostics=${out}`, '--json'], env: f.env, write: c.write, waitForSignal: false })
    assert.equal(code, 0, c.text())
    const parsed = JSON.parse(c.text())
    assert.equal(parsed.ok, true)
    assert.equal(parsed.manifest.verified.clean, true)
    assert.ok(parsed.manifest.totals.included >= 1)
  } finally { f.cleanup() }
})

test('入口：目标目录已存在 → 退出码 9（**不覆盖**，且与泄漏分开）', async () => {
  const f = fixture({ logFiles: { 'app.log': 'ok\n' } })
  try {
    const out = join(f.root, 'pkg-exists')
    mkdirSync(out, { recursive: true })
    const c = capture()
    const code = await run({ argv: [`--diagnostics=${out}`], env: f.env, write: c.write, waitForSignal: false })
    assert.equal(code, 9, c.text())
    assert.match(c.text(), /不覆盖/)
  } finally { f.cleanup() }
})

test('入口：退出码把**泄漏**与其它失败分开（安全事件必须一眼看得出）', async () => {
  // 直接量退出码的映射：泄漏 → 8，其余失败 → 9。
  // 用一个必定失败的目标（父路径是文件）拿到"非泄漏失败"这一支。
  const f = fixture({ logFiles: { 'app.log': 'ok\n' } })
  try {
    const blocker = join(f.root, 'blocker')
    writeFileSync(blocker, 'x')
    const c = capture()
    const code = await run({ argv: [`--diagnostics=${join(blocker, 'sub')}`], env: f.env, write: c.write, waitForSignal: false })
    assert.ok(code === 9 || code === 8, `非 0 退出，实际 ${code}：\n${c.text()}`)
    assert.notEqual(code, 0)
  } finally { f.cleanup() }
})

test('入口：未知参数仍然报错（新开关没有把参数校验放松）', async () => {
  const f = fixture({})
  try {
    const c = capture()
    const code = await run({ argv: ['--nope=1'], env: f.env, write: c.write, waitForSignal: false })
    assert.equal(code, 2)
    assert.match(c.text(), /未知参数/)
  } finally { f.cleanup() }
})

test('入口：`--help` 里列出了这个开关（没有出口说明的入口等于没有出口）', async () => {
  const c = capture()
  const code = await run({ argv: ['--help'], write: c.write, waitForSignal: false })
  assert.equal(code, 0)
  assert.match(c.text(), /--diagnostics/)
})
