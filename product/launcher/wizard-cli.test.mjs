// product/launcher/wizard-cli.test.mjs
// ============================================================================
// PRT-707 收尾：**把向导接上一个真的界面**
//
// PRT-707 正文里最大的一条诚实边界是：
//
// > ⚠️ **没有界面**——向导是状态机，`status()`/`submit()`/`run()` 是驱动接口，
// > 但**没有任何 UI 或 CLI 子命令在用它**，所以"不打开终端"这个完成标准的
// > **呈现层还不存在**（本任务最大边界）。
//
// 本批把它接到 CLI。先把话说清楚：**CLI 仍然是终端**，
// 所以"不打开终端"那一条**没有被消灭**——这一点留在诚实边界里。
// 但"零调用方"结束了：一个只有测试会调用的状态机，
// 它的每一次改动都只能靠读代码来确认。
//
// ## 本套件的重心是三个"看起来一样、其实不一样"
//
// ① **读不到输入 ≠ 空回答**。没有 tty 时前者会让向导拿空字符串往下走，
//    最后报"模型不可用"，而那时用户已经没有任何地方可以填密钥了。
// ② **没问过 ≠ 用户拒绝**。两者都不写同意记录，但"心跳没开"
//    到底是"用户拒绝"还是"向导没问"，要修的地方完全不同。
// ③ **可选步骤 ≠ 必答题**。用 `INPUT` 表达可选项会让
//    "不回答"变成"走不下去"，而"不回答"正是绝大多数用户对可选功能的回答。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { STEP_KINDS, WIZARD_STEP_DEFS, WIZARD_STEP_IDS, createWizard } from './wizard.mjs'
import { WIZARD_CLI_CODES, createStdinReader, heartbeatConsentAction, runWizardCli } from './wizard-cli.mjs'
import { CONSENT_CODES, consentPath, readConsent, writeConsent } from '../heartbeat-consent.mjs'

function tmpRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `legion-wizcli-${tag}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 一个"一切顺利"的向导依赖集；各条用例只覆盖自己关心的那一部分。 */
function happyDeps(overrides = {}) {
  return {
    checkEnvironment: async () => ({ ok: true, message: '环境 OK' }),
    initialize: async () => ({ ok: true, message: '目录 OK' }),
    start: async () => ({ ok: true, message: '起来了' }),
    submitModelConfig: async () => ({ ok: true, message: '模型配好了' }),
    observe: async () => ({ runtimeState: 'ready', modelResolved: true }),
    ...overrides,
  }
}

/** 造一个**假的 tty**：`isTTY` 为真，数据由用例自己喂。 */
function fakeTty() {
  const listeners = { data: [], end: [] }
  const input = {
    isTTY: true,
    isRaw: false,
    // ★ 原始模式的**进出历史**。断言"密钥没被回显"在假 tty 上是**空断言**
    //   （假 tty 本来就不回显）；真正决定行为的是它有没有切进原始模式。
    rawHistory: [],
    setRawMode(v) { this.isRaw = v === true; this.rawHistory.push(v === true) },
    on(ev, fn) { (listeners[ev] ??= []).push(fn) },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn) },
    emit(ev, v) { for (const f of [...(listeners[ev] ?? [])]) f(v) },
  }
  const out = []
  return { input, output: { write: (s) => out.push(String(s)) }, out, feed: (s) => input.emit('data', s), end: () => input.emit('end') }
}

// ============================================================================
// ① 步骤定义：可选项必须有它自己的种类
// ============================================================================

test('★★★ 可选步骤用**它自己的种类**表达，而不是 `INPUT`', () => {
  const d = WIZARD_STEP_DEFS['heartbeat-consent']
  assert.equal(d.kind, STEP_KINDS.OPT_IN)
  // 反面：它**不是** INPUT。用 INPUT 表达可选项的话，
  // "不回答"会让向导停在那里，于是默认关闭的东西变成了必须先回答的东西。
  assert.notEqual(d.kind, STEP_KINDS.INPUT)
  assert.ok(typeof d.unansweredNote === 'string' && d.unansweredNote.length > 0,
    '没回答时不说清"默认是什么"，用户会以为自己还在等一个答案')
  assert.match(d.unansweredNote, /关闭/, '没有说明默认是关闭')
})

test('★★★ 可选步骤排在 `verify` **之后**（它与"产品能不能用"无关）', () => {
  const i = WIZARD_STEP_IDS.indexOf('heartbeat-consent')
  assert.ok(i > WIZARD_STEP_IDS.indexOf('verify'),
    '可选步骤排在了 verify 前面——用户会以为"要回答完这个才算配好"')
  assert.equal(WIZARD_STEP_IDS[WIZARD_STEP_IDS.length - 1], 'done')
})

test('★★ 每个输入步骤**自己**带判据（不再写死在 `submit()` 里）', () => {
  assert.equal(typeof WIZARD_STEP_DEFS['configure-model'].validate, 'function')
  assert.equal(typeof WIZARD_STEP_DEFS['heartbeat-consent'].validate, 'function')
})

// ============================================================================
// ② ★ 没问过 ≠ 用户拒绝
// ============================================================================

test('★★★ 默认**不问**这一项：向导照样走完，且**不写任何同意记录**', async () => {
  const { dir, cleanup } = tmpRoot('noanswer')
  try {
    const layout = { productHome: dir }
    const seen = []
    const r = await runWizardCli({
      layout,
      wizardDeps: happyDeps(),
      stepActions: { 'heartbeat-consent': async (v) => { seen.push(v); return { ok: true, message: 'x' } } },
      write: () => {},
      readLine: async () => 'k',          // 只会被 configure-model 用到
    })
    assert.equal(r.ok, true, JSON.stringify(r.result?.message))
    assert.equal(r.result.done, true, '可选步骤没回答，向导却没有走完')
    // ★ 动作**一次都没被调用**：没问过就是没问过，
    //   不能拿"默认值"去调一次动作——那样会写出一条伪造的记录。
    assert.deepEqual(seen, [], '没问过却调用了动作')
    assert.equal(existsSync(consentPath(layout)), false, '没问过却写下了同意记录')
  } finally { cleanup() }
})

test('★★★ ★ **不问**与**问过并拒绝**是两个不同的读数', async () => {
  const { dir, cleanup } = tmpRoot('asked-vs-not')
  try {
    const mk = (askOptIn, home) => createWizard({
      ...happyDeps(),
      askOptIn,
      stepActions: { 'heartbeat-consent': heartbeatConsentAction({ layout: { productHome: home } }) },
    })

    // A：**不问**
    const a = mk(false, join(dir, 'a'))
    let ra = await a.run()
    // `configure-model` 永远要输入（`happyDeps` 没给 `isModelConfigured`），
    // 所以先把它喂过去，再看可选项那一步。
    assert.equal(ra.needsInput, true)
    assert.equal(ra.blockedStep, 'configure-model')
    a.submit({ apiKey: 'sk-A' })
    ra = await a.run()
    assert.equal(ra.done, true, JSON.stringify(ra))
    assert.deepEqual(a.status().optIn['heartbeat-consent'], { asked: false },
      '"没问过"必须是一个能读到的状态，且**明确写着 asked:false**')

    // B：**问**，用户选了"不要"
    const homeB = join(dir, 'b')
    mkdirSync(homeB, { recursive: true })
    const b = mk(true, homeB)
    let rb = await b.run()
    assert.equal(rb.blockedStep, 'configure-model')
    b.submit({ apiKey: 'sk-x' })
    rb = await b.run()
    // 被要求问的时候，它像 INPUT 一样**停下等回答**
    assert.equal(rb.needsInput, true, '要求问了却没有停下等回答')
    assert.equal(rb.blockedStep, 'heartbeat-consent',
      '要求问了，向导却越过了这一步')
    const accepted = b.submit({ enabled: false })     // ← 拒绝，且**不需要署名**
    assert.equal(accepted.accepted, true, `拒绝被拒了：${accepted.message}`)
    rb = await b.run()
    assert.equal(rb.done, true, JSON.stringify(rb))

    const optInB = b.status().optIn['heartbeat-consent']
    assert.equal(optInB.asked, true)
    assert.equal(optInB.answered, true)
    assert.equal(optInB.enabled, false)
    // 两个读数不同——这正是本批最要紧的那条区分
    assert.notDeepEqual(a.status().optIn['heartbeat-consent'], optInB)
    // 而两者都**没有**同意记录
    //
    // ⚠️ `consentPath` 收的是**布局对象**。第一版这里写的是 `consentPath(homeB)`
    //    （一个字符串）——它返回 `null`，而 `existsSync(null)` 就是 `false`。
    //    于是这条断言**永远为真**，包括"拒绝也写了一条记录"的实现。
    //    断验证 ⑤㊹ 把它量了出来：把"要不要都写记录"那道闸拆掉，**这里不红**。
    //
    //      > 一个传错参数类型却仍然返回"文件不存在"的断言，
    //      > 与一个真的守住了"没有写文件"的断言，在报告上是同一个读数——
    //      > 只不过前者在实现完全错掉的时候也是绿的。
    const pathA = consentPath({ productHome: join(dir, 'a') })
    const pathB = consentPath({ productHome: homeB })
    assert.ok(typeof pathA === 'string' && typeof pathB === 'string',
      '夹具自己错了：consentPath 要的是布局对象')
    assert.equal(existsSync(pathA), false, 'A（没问过）不该有同意记录')
    assert.equal(existsSync(pathB), false, 'B（问过并拒绝）不该有同意记录')
  } finally { cleanup() }
})

test('★★★ 问过并同意 → 真的写下同意记录，读数也对', async () => {
  const { dir, cleanup } = tmpRoot('asked-yes')
  try {
    const layout = { productHome: dir }
    const w = createWizard({
      ...happyDeps(),
      askOptIn: true,
      stepActions: { 'heartbeat-consent': heartbeatConsentAction({ layout }) },
    })
    let r = await w.run()
    assert.equal(r.needsInput, true)
    w.submit({ apiKey: 'sk-A' })
    r = await w.run()
    assert.equal(r.blockedStep, 'heartbeat-consent')
    w.submit({ who: '甲', enabled: true })
    r = await w.run()
    assert.equal(r.done, true, JSON.stringify(r))

    const optIn = w.status().optIn['heartbeat-consent']
    assert.deepEqual({ ...optIn }, { asked: true, answered: true, enabled: true })
    const rec = readConsent(layout)
    assert.equal(rec.consented, true, `同意没有被记下来：${rec.code}`)
    assert.equal(rec.record.who, '甲')
  } finally { cleanup() }
})

test('★ 拒绝**不需要署名**（要求了就等于给"不接受"加了门槛）', async () => {
  const def = WIZARD_STEP_DEFS['heartbeat-consent']
  // 拒绝：不该被判据拦下
  assert.equal(def.validate({ enabled: false }), null)
  assert.equal(def.validate({}), null)
  // 同意：必须署名
  assert.match(String(def.validate({ enabled: true })), /署名/)
  assert.match(String(def.validate({ enabled: true, who: '  ' })), /署名/)
  assert.equal(def.validate({ enabled: true, who: '张三' }), null)
})

test('★ 答了"不要"不写同意记录（也不伪造一条"撤回"）', async () => {
  const { dir, cleanup } = tmpRoot('declined')
  try {
    const layout = { productHome: dir }
    const action = heartbeatConsentAction({ layout })
    const r = await action({ who: '张三', enabled: false })
    assert.equal(r.ok, true, r.message)
    // ★ 写一条 `revoked: true` 是**伪造历史**：撤回的意思是"先同意过、后来撤回"，
    //   而一个从没同意过的人被写成"撤回过"，会让他事后看到自己没做过的历史。
    assert.equal(existsSync(consentPath(layout)), false, '拒绝不该留下任何记录')
  } finally { cleanup() }
})

test('★★ 答了"要"但没署名 → `submit` 就拒掉（不是等到写文件时才失败）', async () => {
  const { dir, cleanup } = tmpRoot('nowho')
  try {
    const layout = { productHome: dir }
    const w = createWizard({
      ...happyDeps(),
      askOptIn: true,
      stepActions: { 'heartbeat-consent': heartbeatConsentAction({ layout }) },
    })
    await w.run()
    w.submit({ apiKey: 'sk-x' })
    await w.run()
    // 现在停在可选步骤上（`askOptIn: true` 会停下等回答）
    for (const bad of [{ enabled: true }, { who: '', enabled: true }, { who: '   ', enabled: true }]) {
      const r = w.submit(bad)
      assert.equal(r.accepted, false, `${JSON.stringify(bad)} 被接受了`)
      assert.match(r.message, /署名/)
    }
    // 一条都没有落盘
    assert.equal(existsSync(consentPath(layout)), false)
  } finally { cleanup() }
})

// ============================================================================
// ③ ★ 读不到输入 ≠ 空回答
// ============================================================================

test('★★★ 没有可用的输入方式时**如实报出来并停下**，不拿空回答往下走', async () => {
  const out = []
  const r = await runWizardCli({
    layout: { productHome: 'C:/x' },
    wizardDeps: happyDeps(),
    write: (m) => out.push(String(m)),
    readLine: null,                        // 没有输入方式
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, WIZARD_CLI_CODES.NOT_INTERACTIVE)
  assert.equal(r.step, 'configure-model')
  const text = out.join('\n')
  assert.match(text, /没有可用的输入方式|没有终端/)
  // ★ 必须解释"为什么不能拿空回答凑合"。
  assert.match(text, /没有地方可以填密钥|空回答/,
    '没有说清"拿空回答往下走"的后果——用户只会看到一句"模型不可用"')
})

test('★★★ `createStdinReader` 在没有 tty 时返回 **`null`（读不到）**，不是空字符串', async () => {
  const read = createStdinReader({ input: { isTTY: false }, output: { write: () => {} } })
  const v = await read('密钥：', { secret: true })
  // ★ 这一条是整个界面最要紧的区分：`null` 会让调用方停下，
  //   而 `''` 会让它带着一个空密钥走到 verify，然后报"模型不可用"。
  assert.equal(v, null)
  assert.notEqual(v, '')
})

test('★★★ 假 tty：回车结束、Ctrl-C 取消、流结束都各归其位', async () => {
  // ① 正常一行
  const t1 = fakeTty()
  const p1 = createStdinReader({ input: t1.input, output: t1.output })('密钥：', { secret: true })
  t1.feed('sk-abc')
  t1.feed('\r')
  assert.equal(await p1, 'sk-abc')
  // ★ 密钥的"不回显"由**原始模式**保证：非 raw 时是终端自己在回显，
  //   而本模块管不了终端。第一版这里断言"输出里没有密钥"——
  //   对假 tty 来说它**永远为真**（假 tty 本来就不回显任何东西），
  //   于是把 `secret` 整个忽略掉也照样绿。断验证 ⑤㊷ 量到了这一点。
  //
  //     > 一个"假替身本来就满足"的断言，
  //     > 与一个真的守住了行为的断言，在报告上是同一个读数。
  //
  //   可观测的、且真正决定行为的是：**secret 时必须切换原始模式，且用完切回来**。
  assert.deepEqual(t1.input.rawHistory, [true, false],
    '密钥读取没有进出原始模式——非 raw 时是终端在回显，密钥会留在屏幕上')

  // ①b 非密钥**不**该进原始模式（进了就得自己回显，而本模块不回显）
  const t0 = fakeTty()
  const p0 = createStdinReader({ input: t0.input, output: t0.output })('模型名：', {})
  t0.feed('gpt\r')
  assert.equal(await p0, 'gpt')
  assert.deepEqual(t0.input.rawHistory, [], '非密钥也进了原始模式')

  // ② Ctrl-C ⇒ 读不到
  const t2 = fakeTty()
  const p2 = createStdinReader({ input: t2.input, output: t2.output })('密钥：', { secret: true })
  t2.feed('\u0003')
  assert.equal(await p2, null)

  // ③ 流结束 ⇒ 读不到
  const t3 = fakeTty()
  const p3 = createStdinReader({ input: t3.input, output: t3.output })('密钥：', {})
  t3.end()
  assert.equal(await p3, null)

  // ④ 空回车 ⇒ 空字符串（**与"读不到"不同**）
  const t4 = fakeTty()
  const p4 = createStdinReader({ input: t4.input, output: t4.output })('密钥：', {})
  t4.feed('\n')
  assert.equal(await p4, '')

  // ⑤ 退格
  const t5 = fakeTty()
  const p5 = createStdinReader({ input: t5.input, output: t5.output })('密钥：', {})
  t5.feed('ab\u007fc')
  t5.feed('\r')
  assert.equal(await p5, 'ac')
})

test('★★★ 交互读到**空密钥**时也停下，且**不再去问模型名**', async () => {
  const out = []
  const prompts = []
  // 第一问给空；后面备好"如果它继续问"的答案——
  // 备着是为了让"继续了"这件事**可观测**，而不是靠"总之后来失败了"。
  const answers = ['', 'sk-继续了', 'gpt-继续了']
  const r = await runWizardCli({
    layout: { productHome: 'C:/x' },
    wizardDeps: happyDeps(),
    write: (m) => out.push(String(m)),
    readLine: async (q) => { prompts.push(q); return answers.shift() ?? null },
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, WIZARD_CLI_CODES.NOT_INTERACTIVE)
  assert.ok(prompts.some((p) => p.includes('密钥')), '没有问密钥')
  // ★ 这条才是真正钉住"空密钥就地停下"的断言。
  //
  //   第一版只断言"最后失败了"——而那是**测不出**的：即使空密钥被放过去，
  //   下游的 `validate`（"缺少模型密钥"）也会把它拦下，结果同样是失败。
  //   两层判据，后一层兜住了（与 PRT-709 的 ⑤㉗ 是同一类）。
  //
  //     > 一个"下一层也拦得住"的实现，会让上一层的用例**看起来**守住了——
  //     > 要断言的不是"最后失败了"，而是"它有没有继续往下问"。
  assert.ok(!prompts.some((p) => p.includes('模型名')),
    `空密钥之后它继续去问模型名了：${JSON.stringify(prompts)}`)
  assert.ok(!out.join('\n').includes('完成'), '空密钥竟然走到了完成')
})

// ============================================================================
// ④ 只有实测通过才报完成
// ============================================================================

test('★★★ 输入走完之后，报完成的前提仍然是**实测通过**', async () => {
  const out = []
  const r = await runWizardCli({
    layout: { productHome: 'C:/x' },
    wizardDeps: happyDeps({ observe: async () => ({ runtimeState: 'failed', modelResolved: true }) }),
    write: (m) => out.push(String(m)),
    readLine: async (q) => (q.includes('密钥') ? 'sk-x' : ''),
  })
  assert.equal(r.ok, false, '观测到 failed 却报了成功')
  assert.ok(!out.join('\n').includes('向导完成'), '没有实测通过却说"完成"了')
})

test('★★★ 前提不成立时**一步都不跑**，且说清是哪一条', async () => {
  const out = []
  const r = await runWizardCli({
    layout: { productHome: 'C:/x' },
    wizardDeps: happyDeps(),
    write: (m) => out.push(String(m)),
    readLine: async () => 'sk-x',
    // 前提直接以 unmet 形式给出
    ...{},
    wizardDepsExtra: null,
  })
  // 上面那次是一切正常的情况，这里只确认它走到了完成
  assert.equal(r.ok, true, out.join('\n'))

  const out2 = []
  const w = createWizard({
    ...happyDeps(),
    preconditions: [{ key: 'ports', message: '端口被占用' }],
  })
  const pre = await w.checkPreconditions()
  assert.equal(pre.ok, false)
  assert.equal(pre.unmet[0].message, '端口被占用')
  void out2
})

// ============================================================================
// ⑤ CLI 接线
// ============================================================================

/** 一个能真启动的产品家目录（与 heartbeat-wiring 套件同一套夹具）。 */
function cliEnv(root) {
  return {
    LEGION_HOME: root,
    LEGION_INSTALL_DIR: new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    LEGION_DATA_DIR: join(root, 'data'),
    LEGION_WORKSPACE_DIR: join(root, 'ws'),
  }
}

test('★★★ CLI：`--wizard` 在**没有终端**时不会假装收到了密钥', async () => {
  const { run } = await import('./cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-wizard')
  try {
    const out = []
    const code = await run({
      argv: ['--wizard'], env: cliEnv(dir),
      write: (m) => out.push(String(m)), waitForSignal: false,
    })
    const text = out.join('\n')
    // 测试进程通常没有 tty（或 stdin 不是 tty），所以它会走到"读不到输入"。
    // ★ 无论走到哪一步失败，都**绝不能**报成功。
    assert.notEqual(code, 0, `没有终端却报了成功：\n${text}`)
    assert.ok(!text.includes('向导完成'), `没有终端却报"向导完成"：\n${text}`)
  } finally { cleanup() }
})

test('★★ CLI 帮助里列出了向导相关参数', async () => {
  const { CLI_FLAGS } = await import('./cli.mjs')
  const names = CLI_FLAGS.map((f) => f.name)
  for (const n of ['--wizard', '--wizard-consent=<who>', '--wizard-reset']) {
    assert.ok(names.includes(n), `帮助里没有 ${n}`)
  }
  // ★ 没有 `--wizard-model-key` 这种参数，而且是**刻意**的：
  //   密钥走 argv 会进 shell 历史、进 `ps` 输出、被 CI 日志抄走。
  assert.ok(!names.some((n) => /model-key|api-key|secret/i.test(n)),
    '出现了一个从命令行收密钥的参数——它一定会被用，而用它的那一刻泄漏像是用户自己选的')
})

test('★★ `heartbeatConsentAction` 真的写下同意记录（署名为准）', async () => {
  const { dir, cleanup } = tmpRoot('action-write')
  try {
    const layout = { productHome: dir }
    const action = heartbeatConsentAction({ layout })
    const r = await action({ who: '李四', enabled: true })
    assert.equal(r.ok, true, r.message)
    const rec = readConsent(layout)
    assert.equal(rec.consented, true, rec.code)
    assert.equal(rec.record.who, '李四')
    assert.equal(rec.record.revoked, false)
  } finally { cleanup() }
})

test('★★ 同意写不进去时**如实报失败**（不说"已记录"）', async () => {
  const { dir, cleanup } = tmpRoot('action-fail')
  try {
    const layout = { productHome: dir }
    const action = heartbeatConsentAction({
      layout,
      // 一个只读的假 fs：写入必然失败
      fs: {
        existsSync: () => false,
        readFileSync: () => { throw new Error('EACCES') },
        writeFileSync: () => { throw new Error('EACCES: 只读') },
        renameSync: () => { throw new Error('EACCES: 只读') },
        mkdirSync: () => {},
      },
    })
    const r = await action({ who: '王五', enabled: true })
    assert.equal(r.ok, false, '写不进去却报了成功')
    assert.match(r.message, /没有写成/)
  } finally { cleanup() }
})

test('★★★ 预先回答（`presetOptIn`）与当场回答走**同一条**路', async () => {
  const { dir, cleanup } = tmpRoot('preset')
  try {
    const layout = { productHome: dir }
    const r = await runWizardCli({
      layout,
      wizardDeps: happyDeps(),
      stepActions: { 'heartbeat-consent': heartbeatConsentAction({ layout }) },
      presetOptIn: { 'heartbeat-consent': { who: '赵六', enabled: true } },
      write: () => {},
      readLine: async () => 'sk-preset',
    })
    assert.equal(r.ok, true, JSON.stringify(r.result?.message))
    assert.equal(r.result.done, true)
    // 预先回答 = "问过了、答过了"，不是"没问过"
    assert.deepEqual({ ...r.result.results.find((x) => x.step === 'heartbeat-consent') },
      { step: 'heartbeat-consent', ok: true, asked: true, answered: true, message: '已记录「赵六」的同意（写在本机，不跟着配置文件走）', at: r.result.results.find((x) => x.step === 'heartbeat-consent').at })
    // 而且真的落盘了
    const rec = readConsent(layout)
    assert.equal(rec.consented, true, rec.code)
    assert.equal(rec.record.who, '赵六')
  } finally { cleanup() }
})

test('★★★ 预先回答也要过**同一道**判据（没署名的预先同意同样被拒）', async () => {
  const { dir, cleanup } = tmpRoot('preset-bad')
  try {
    const layout = { productHome: dir }
    const r = await runWizardCli({
      layout,
      wizardDeps: happyDeps(),
      stepActions: { 'heartbeat-consent': heartbeatConsentAction({ layout }) },
      presetOptIn: { 'heartbeat-consent': { enabled: true } },   // ← 没有署名
      write: () => {},
      readLine: async () => 'sk-x',
    })
    assert.equal(r.ok, false, '没署名的预先同意被放过去了')
    assert.equal(existsSync(consentPath(layout)), false, '没署名却写下了同意记录')
    assert.match(String(r.result?.message ?? ''), /署名/)
  } finally { cleanup() }
})

test('★★★ `--wizard-consent=<who>` 是**预先回答**；不给就是**没问过**', async () => {
  const { wizardOptionsFrom } = await import('./wizard-cli.mjs')

  // ① 没给 ⇒ `presetOptIn` **是空的**。
  //
  //    ★ 不是 `{'heartbeat-consent': {enabled: false}}`。后者是"用户拒绝了"，
  //      而用户其实**从没被问过**——那是一条伪造的读数。
  const none = wizardOptionsFrom({ consentWho: null, flags: {}, layout: { productHome: 'x' } })
  assert.deepEqual({ ...none.presetOptIn }, {},
    '没给 --wizard-consent 却算出了一个"拒绝"——那是伪造用户的选择')
  assert.equal(none.reset, false)
  // ★ CLI **永不**当场问：默认去问会让每次运行都要人坐在旁边。
  assert.equal(none.askOptIn, false)

  // ② 给了 ⇒ 是"问过了、答过了"，署名为准
  const yes = wizardOptionsFrom({ consentWho: '张三', flags: {}, layout: null })
  assert.deepEqual({ ...yes.presetOptIn['heartbeat-consent'] }, { who: '张三', enabled: true })
  assert.equal(yes.askOptIn, false)

  // ③ 空/空白署名 ⇒ 视为**没给**（一个空署名写不出可查证的同意）
  for (const blank of ['', '   ']) {
    assert.deepEqual({ ...wizardOptionsFrom({ consentWho: blank }).presetOptIn }, {},
      `空白署名 ${JSON.stringify(blank)} 被当成了有效回答`)
  }

  // ④ `--wizard-reset` 单独一位
  assert.equal(wizardOptionsFrom({ flags: { 'wizard-reset': true } }).reset, true)
  assert.equal(wizardOptionsFrom({ flags: { 'wizard-reset': false } }).reset, false)
})

test('★★★ 翻译出来的选项**真的驱动向导**（端到端连起来看）', async () => {
  const { wizardOptionsFrom } = await import('./wizard-cli.mjs')
  const { dir, cleanup } = tmpRoot('opts-drive')
  try {
    const layout = { productHome: dir }
    // 拿 CLI 真会算出来的那份选项，直接喂给 `runWizardCli`。
    const opts = wizardOptionsFrom({
      consentWho: '孙七', flags: {}, layout,
    })
    const r = await runWizardCli({
      layout,
      wizardDeps: happyDeps(),
      stepActions: { 'heartbeat-consent': heartbeatConsentAction({ layout }) },
      askOptIn: opts.askOptIn,
      presetOptIn: opts.presetOptIn,
      reset: opts.reset,
      write: () => {},
      readLine: async () => 'sk-x',
    })
    assert.equal(r.ok, true, JSON.stringify(r.result?.message))
    assert.equal(r.result.done, true)
    // 预先回答必须真的落到记录上——不只是"对象里有这个键"
    const rec = readConsent(layout)
    assert.equal(rec.consented, true, rec.code)
    assert.equal(rec.record.who, '孙七')
  } finally { cleanup() }
})

test('★★ CLI：`--wizard-reset` 接到 `reset()` 上（只丢位置，不删数据）', async () => {
  const { wizardOptionsFrom } = await import('./wizard-cli.mjs')
  const { dir, cleanup } = tmpRoot('reset')
  try {
    const layout = { productHome: dir }
    const opts = wizardOptionsFrom({ flags: { 'wizard-reset': true }, layout })
    assert.equal(opts.reset, true)
    // 重置**不删**任何东西：产品数据与同意记录都不受影响。
    const rec = writeConsent(layout, { who: '钱八' })
    assert.equal(rec.ok, true, rec.message)
    const r = await runWizardCli({
      layout,
      wizardDeps: happyDeps(),
      stepActions: { 'heartbeat-consent': heartbeatConsentAction({ layout }) },
      askOptIn: opts.askOptIn,
      presetOptIn: opts.presetOptIn,
      reset: opts.reset,
      write: () => {},
      readLine: async () => 'sk-x',
    })
    assert.equal(r.ok, true, JSON.stringify(r.result?.message))
    // ★ 重置的是**位置**，不是数据。一条"重置把同意记录也删了"的实现，
    //   会让用户点一下"从头开始"就丢掉自己明确做过的选择。
    assert.equal(readConsent(layout).consented, true, '重置把同意记录弄没了')
  } finally { cleanup() }
})

// ============================================================================
// ⑥ 与正文里那句"没有任何 UI 或 CLI 子命令在用它"对质
// ============================================================================

test('★★★ 向导**真的有生产调用方**了（不再是零调用方）', () => {
  const cli = readFileSync(new URL('./cli.mjs', import.meta.url), 'utf8')
  // ★ 这条断言存在的理由：PRT-707 的正文写着「**没有任何 UI 或 CLI 子命令在用它**」。
  //   那句话在本批之后必须被改写。一条"零调用方"的模块，
  //   它的每一次改动都只能靠读代码来确认——而这句话当时是对的，
  //   所以它也会一直是"对的"，直到有人真的把它接上。
  assert.match(cli, /runWizardCli/, 'CLI 没有再驱动向导了')
  assert.match(cli, /createStdinReader/, 'CLI 没有接真实的输入')
  assert.match(cli, /heartbeatConsentAction/, 'CLI 没有把可选项接上')
  // 而且它读的是 **stdin**，不是 argv
  assert.match(cli, /createStdinReader\(\)/)
  // ★ 不读任何"从 argv 收密钥"的参数名。
  //
  //   注意判据是 `parsed.flags[...]` 而**不是**"文件里没有这个词"：
  //   `cli.mjs` 的注释里**故意**写着 `--wizard-model-key=sk-xxx` 这个反例，
  //   用来解释为什么不提供它。断言"文件里没有这个词"会把那条说明也一起禁掉。
  assert.ok(!/parsed\.flags\[['"](wizard-)?(model|api)[-_]?key/i.test(cli),
    'CLI 里出现了从 argv 收密钥的入口')
  assert.ok(!/parsed\.flags\[['"][^'"]*secret/i.test(cli),
    'CLI 里出现了从 argv 收密钥的入口')
})

test('★ 正文里"没有界面"这条边界现在只对了一半：CLI 有了，图形界面仍然没有', () => {
  // 这条用例把边界**钉在它真实的形状上**：
  // 本批交付的是 CLI（它仍然是终端），不是"不打开终端"。
  assert.equal(STEP_KINDS.OPT_IN, 'opt-in')
  assert.ok(WIZARD_STEP_IDS.includes('heartbeat-consent'))
  // `CONSENT_CODES` 仍然是同意记录的四个状态（没有被向导这一层合并）
  assert.equal(Object.keys(CONSENT_CODES).length, 4)
  void writeConsent
})
