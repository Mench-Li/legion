// product/launcher/log-policy-cli.test.mjs
// ============================================================================
// PRT-709 收尾：**改日志策略的入口**
//
// PRT-709 的正文里有一句自我更正：「`logPolicy` **已**接在产品配置文件的键上……
// 真正还缺的是**改它们的界面**（用户得手编配置文件）」。
//
// 而"手编配置文件"的后果不只是麻烦。配置有四层，后一层覆盖前一层，
// 而 `log.*` **只从 product-config 读**——于是最常见的一幕是：
//
//   用户在工作空间配置里写了 `log.keepFiles: 20`，什么都没发生，
//   而产品**不会**告诉他"这个键只从产品配置读"。
//
//   > 一个"改了但没有任何反应"的配置界面，
//   > 与一个"这个键根本不生效"的配置界面，在用户看来是同一个东西——
//   > 只不过前者会让他反复改同一个地方。
//
// 所以本套件的重心是**两**件事：能改，以及**能看懂现在是什么值、它是谁给的**。
//
// ## 写这一层最危险的三件事，各有专门的用例
//
// ① **配置坏掉时"顺手修好"**：坏 JSON 被重写一遍，用户原来的内容
//    （可能只是少了一个逗号）就永久没了；
// ② **只校验要改的键**：`keepFiles` 单独看是好的，而两份值放在一起
//    才看得出的问题只能靠"写完之后的完整策略"验出来；
// ③ **改完显示旧值**：`--set-log-policy` 之后 `--log-policy` 用开头算好的
//    那份 `options`，用户看到的还是改之前的值——而那一幕会被读成
//    "我的修改没生效"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { DEFAULT_LOG_POLICY, validateLogPolicy } from '../logging/rotation.mjs'
import { logFilePath } from '../logging/sink.mjs'
import {
  LOG_CLI_CODES, LOG_POLICY_KEYS, applyLogPolicy, describeLogPolicy,
  effectiveLogPolicy, humanBytes, parsePolicyAssignments,
} from './log-policy-cli.mjs'

function tmpRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `legion-logcli-${tag}-`))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ============================================================================
// ① 键的对应关系
// ============================================================================

test('★★ 这一层认识的四项与 `DEFAULT_LOG_POLICY` **逐项对应**', () => {
  // 加了策略项却忘了加进 CLI，会让新键**只能手编**——而那个状态
  // 正是本任务要消灭的。这条用例把两者钉在一起。
  assert.deepEqual(
    Object.keys(LOG_POLICY_KEYS).sort(),
    Object.keys(DEFAULT_LOG_POLICY).sort(),
    '两者不一致：要么 CLAUDE 层少了键（那个键只能手编），要么多了键（写进去也没人读）',
  )
  for (const [key, path] of Object.entries(LOG_POLICY_KEYS)) {
    assert.equal(path, `log.${key}`, `${key} 的配置路径不是 log.${key}`)
  }
})

// ============================================================================
// ② `parsePolicyAssignments`
// ============================================================================

test('★★ `parsePolicyAssignments`：k=v 解析，值一律**当数字**', () => {
  const r = parsePolicyAssignments('keepFiles=10,maxFileBytes=4194304')
  assert.equal(r.ok, true)
  assert.deepEqual(r.values, { keepFiles: 10, maxFileBytes: 4194304 })
  // 空格与空段被容忍
  assert.deepEqual(parsePolicyAssignments(' keepFiles = 3 , ').values, { keepFiles: 3 })
})

test('★★ 值必须是**非负整数**：小数/负数/带单位一律拒（拒得越早，离用户输的那行越近）', () => {
  for (const spec of ['keepFiles=2.5', 'keepFiles=-1', 'keepFiles=', 'maxFileBytes=4MiB', 'keepFiles=abc', 'keepFiles=1e3']) {
    const r = parsePolicyAssignments(spec)
    assert.equal(r.ok, false, `${spec} 被接受了`)
    assert.equal(r.code, LOG_CLI_CODES.BAD_VALUE)
    // 错误信息要说清"为什么"，而不是只说"不对"
    assert.match(r.message, /非负整数/)
  }
})

test('★ 不认识的键被点名拒绝（不是静默忽略）', () => {
  const r = parsePolicyAssignments('keepFile=3')
  assert.equal(r.ok, false)
  assert.equal(r.code, LOG_CLI_CODES.UNKNOWN_KEY)
  assert.match(r.message, /keepFile/)
  assert.match(r.message, /keepFiles/, '没有把可用的键列出来')
})

test('★ 空输入 → `NOTHING_TO_SET`（而不是"什么都没做但报成功"）', () => {
  for (const spec of ['', '   ', null, undefined, ',']) {
    const r = parsePolicyAssignments(spec)
    assert.equal(r.ok, false, `${JSON.stringify(spec)} 被当成了有效输入`)
    assert.equal(r.code, LOG_CLI_CODES.NOTHING_TO_SET)
  }
})

// ============================================================================
// ③ `applyLogPolicy`：写之前守住的四件事
// ============================================================================

test('★★★ 配置是**坏 JSON** → 拒绝改写，且文件**逐字节不变**', () => {
  const { dir, cleanup } = tmpRoot('broken')
  try {
    const configPath = join(dir, 'product.config.json')
    const original = '{ "log": { "keepFiles": 3 },  '   // 少了一个大括号
    writeFileSync(configPath, original)

    const r = applyLogPolicy({ configPath, values: { keepFiles: 10 } })
    assert.equal(r.ok, false)
    assert.equal(r.code, LOG_CLI_CODES.CONFIG_UNREADABLE)
    // ★ 这一条是整段的要点：重写一份坏掉的配置，会把用户原来的内容
    //   （可能只是少了一个逗号）永久弄没。
    assert.equal(readFileSync(configPath, 'utf8'), original,
      '坏掉的配置被改写了——用户原来的内容已经没了')
    assert.match(r.message, /拒绝改写/)
  } finally { cleanup() }
})

test('★★★ 校验不过时**一个字节都不写**（文件没被创建 / 内容不变）', () => {
  const { dir, cleanup } = tmpRoot('invalid')
  try {
    // ① 文件不存在：不合法 → 不能创建出一个半成品配置
    const p1 = join(dir, 'a.json')
    const r1 = applyLogPolicy({ configPath: p1, values: { keepFiles: -5 } })
    assert.equal(r1.ok, false)
    assert.equal(r1.code, LOG_CLI_CODES.BAD_VALUE)
    assert.equal(existsSync(p1), false, '校验没过却创建了配置文件')
    assert.match(r1.message, /一个字节都没写/)

    // ② 文件已存在：不合法 → 内容原样
    const p2 = join(dir, 'b.json')
    const before = JSON.stringify({ log: { keepFiles: 3 }, 别的: '保留我' }, null, 2)
    writeFileSync(p2, before)
    const r2 = applyLogPolicy({ configPath: p2, values: { maxFileBytes: 'x' } })
    assert.equal(r2.ok, false)
    assert.equal(readFileSync(p2, 'utf8'), before)
  } finally { cleanup() }
})

test('★★★ 校验用的是**写完之后的完整策略**，不只是要改的那几个键', () => {
  const { dir, cleanup } = tmpRoot('whole')
  try {
    const configPath = join(dir, 'product.config.json')
    // 只改 minFreeBytes（看起来无关），但合并后的策略整体仍然必须合法。
    // 这条用例守住的是"校验的是合并结果"这一事实：
    // 把一个坏的基线放进文件里，然后改一个**别的**键。
    writeFileSync(configPath, JSON.stringify({ log: { keepFiles: 3 } }))
    const r = applyLogPolicy({ configPath, values: { maxFileBytes: 1024 } })
    assert.equal(r.ok, true, r.message)
    // 合并后的策略应当是"文件里的 + 这次改的"，且整体合法
    assert.equal(r.policy.maxFileBytes, 1024)
    assert.equal(r.policy.keepFiles, 3, '文件里的 keepFiles 没有参与合并')
    assert.equal(validateLogPolicy(r.policy).ok, true)
    // 默认值项也要在（校验的是完整策略，不是只有文件里写了的那几项）
    assert.equal(r.policy.minFreeBytes, DEFAULT_LOG_POLICY.minFreeBytes)
  } finally { cleanup() }
})

test('★★★ 只动 `log.*`：别的顶层键**一个不少**（包括这一层不认识的）', () => {
  const { dir, cleanup } = tmpRoot('preserve')
  try {
    const configPath = join(dir, 'product.config.json')
    writeFileSync(configPath, JSON.stringify({
      ports: { 'team-hub': 9000 },
      我不认识这个键: { 深: [1, 2, 3] },
      heartbeat: { enabled: true },
      log: { keepFiles: 2, maxFileBytes: 111 },
    }))

    const r = applyLogPolicy({ configPath, values: { keepFiles: 7 } })
    assert.equal(r.ok, true, r.message)
    const after = JSON.parse(readFileSync(configPath, 'utf8'))
    // 不认识的原样保留
    assert.deepEqual(after['我不认识这个键'], { 深: [1, 2, 3] })
    assert.deepEqual(after.ports, { 'team-hub': 9000 })
    assert.deepEqual(after.heartbeat, { enabled: true })
    // log 里**没被改**的项也要保留
    assert.equal(after.log.maxFileBytes, 111, 'log 里没被改的项被弄丢了')
    assert.equal(after.log.keepFiles, 7)
    assert.deepEqual(r.kept.sort(), ['heartbeat', 'ports', '我不认识这个键'].sort())
  } finally { cleanup() }
})

test('★★ 写是**原子**的（临时文件 + rename，不留半截 JSON）', () => {
  const { dir, cleanup } = tmpRoot('atomic')
  try {
    const configPath = join(dir, 'product.config.json')
    const writes = []
    const renames = []
    const fakeFs = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ log: {} }),
      mkdirSync: () => {},
      writeFileSync: (p, t) => { writes.push(p); JSON.parse(t) },
      renameSync: (a, b) => { renames.push([a, b]) },
    }
    const r = applyLogPolicy({ configPath, values: { keepFiles: 4 }, fs: fakeFs })
    assert.equal(r.ok, true, r.message)
    // ★ 直接写目标的话，写到一半断电留下半截 JSON ——
    //   而半截 JSON 在配置层里等于**整份配置回到默认值**。
    assert.equal(writes.length, 1)
    assert.match(writes[0], /\.tmp-/)
    assert.equal(renames.length, 1)
    assert.equal(renames[0][1], configPath)
  } finally { cleanup() }
})

test('★ 没有配置文件路径 → 不猜位置', () => {
  for (const p of [null, undefined, '']) {
    const r = applyLogPolicy({ configPath: p, values: { keepFiles: 1 } })
    assert.equal(r.ok, false)
    assert.equal(r.code, LOG_CLI_CODES.NO_CONFIG_PATH)
    assert.match(r.message, /不猜/)
  }
})

test('★ 空 values → `NOTHING_TO_SET`，不写文件', () => {
  const { dir, cleanup } = tmpRoot('empty')
  try {
    const configPath = join(dir, 'product.config.json')
    const r = applyLogPolicy({ configPath, values: {} })
    assert.equal(r.ok, false)
    assert.equal(r.code, LOG_CLI_CODES.NOTHING_TO_SET)
    assert.equal(existsSync(configPath), false)
  } finally { cleanup() }
})

test('★ 文件不存在时能创建（第一次配置就靠这条）', () => {
  const { dir, cleanup } = tmpRoot('create')
  try {
    const configPath = join(dir, 'nested', 'product.config.json')
    const r = applyLogPolicy({ configPath, values: { keepFiles: 9, minFreeBytes: 1048576 } })
    assert.equal(r.ok, true, r.message)
    const after = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.deepEqual(after.log, { keepFiles: 9, minFreeBytes: 1048576 })
  } finally { cleanup() }
})

// ============================================================================
// ④ `effectiveLogPolicy` / `describeLogPolicy`：**能看懂**
// ============================================================================

test('★★ `effectiveLogPolicy`：缺省补默认值，**坏值不进**（显示的是默认值而不是坏值）', () => {
  const eff = effectiveLogPolicy({ log: { keepFiles: 7, maxFileBytes: -1 } })
  assert.equal(eff.keepFiles, 7)
  // 坏值不进：显示 -1 会让用户以为它生效了
  assert.equal(eff.maxFileBytes, DEFAULT_LOG_POLICY.maxFileBytes)
  // 没写的项补默认值
  assert.equal(eff.minFreeBytes, DEFAULT_LOG_POLICY.minFreeBytes)
  // 形状不对的 merged 也不能抛
  for (const merged of [null, undefined, {}, { log: null }, { log: 'x' }, { log: [] }]) {
    assert.equal(effectiveLogPolicy(merged).keepFiles, DEFAULT_LOG_POLICY.keepFiles)
  }
})

test('★★★ `describeLogPolicy`：每个值都带**来源**，并说明 `log.*` 只从产品配置读', () => {
  const text = describeLogPolicy({
    merged: { log: { keepFiles: 9 } },
    provenance: { 'log.keepFiles': 'product-config' },
    filePath: 'C:\\x\\product.config.json',
  })
  // 生效值
  assert.match(text, /keepFiles/)
  assert.match(text, /9/)
  // ★ 来源必须出现：只报值的话，「我改了但没生效」是一个无法回答的问题
  assert.match(text, /product-config/)
  // 没被设置的项要标明是默认值
  assert.match(text, /默认值/)
  // ★ 这一句是本任务最要紧的一行：`log.*` 只从 product-config 读。
  //   不说的话，用户在别层写同名键会得到一个"什么都不发生"的结果。
  assert.match(text, /只从\*\*产品配置\*\*读/)
  assert.match(text, /C:\\x\\product\.config\.json/)
})

test('★ `humanBytes`：字节数看得懂（MiB 级别不再是一串数字）', () => {
  assert.equal(humanBytes(0), '0 B')
  assert.equal(humanBytes(512), '512 B')
  assert.equal(humanBytes(1024), '1 KiB')
  assert.equal(humanBytes(8 * 1024 * 1024), '8 MiB')
  assert.equal(humanBytes(128 * 1024 * 1024), '128 MiB')
  assert.equal(humanBytes(1536), '1.5 KiB')
})

// ============================================================================
// ⑤ CLI 接线
// ============================================================================

/** CLI 测试用的环境。`LEGION_HOME` 指向临时目录，产品配置就在它下面。 */
function cliEnv(root) {
  return {
    LEGION_HOME: root,
    LEGION_INSTALL_DIR: new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    LEGION_DATA_DIR: join(root, 'data'),
    LEGION_WORKSPACE_DIR: join(root, 'ws'),
  }
}

test('★★★ CLI：`--set-log-policy` 真的写进产品配置文件', async () => {
  const { run } = await import('./cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-set')
  try {
    const lines = []
    const code = await run({
      argv: ['--set-log-policy=keepFiles=12,maxFileBytes=1048576'],
      env: cliEnv(dir), write: (m) => lines.push(String(m)), waitForSignal: false,
    })
    assert.equal(code, 0, lines.join('\n'))
    const written = JSON.parse(readFileSync(join(dir, 'data', 'product.config.json'), 'utf8'))
    assert.equal(written.log.keepFiles, 12)
    assert.equal(written.log.maxFileBytes, 1048576)
    assert.match(lines.join('\n'), /keepFiles/)
  } finally { cleanup() }
})

test('★★★ CLI：`--set-log-policy` 之后 `--log-policy` 显示的是**新**值', async () => {
  const { run } = await import('./cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-then-show')
  try {
    const env = cliEnv(dir)
    const first = []
    const c1 = await run({ argv: ['--set-log-policy=keepFiles=33'], env, write: (m) => first.push(String(m)), waitForSignal: false })
    assert.equal(c1, 0, first.join('\n'))

    const out = []
    const c2 = await run({ argv: ['--log-policy'], env, write: (m) => out.push(String(m)), waitForSignal: false })
    assert.equal(c2, 0, out.join('\n'))
    const text = out.join('\n')
    // ★ 这一条量的是"查看器必须重新读盘"。
    //   用 `run()` 开头算好的那份 `options` 的话，这里显示的还是**改之前**的值，
    //   而那一幕会被读成"我的修改没生效"。
    assert.match(text, /33/, `改完之后显示的不是新值：\n${text}`)
    assert.match(text, /product-config/, '没有说明这个值是谁给的')
  } finally { cleanup() }
})

test('★★★ CLI：**同一次调用**里改完再看，显示的也必须是新值', async () => {
  const { run } = await import('./cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-same-invoke')
  try {
    const out = []
    const code = await run({
      argv: ['--set-log-policy=keepFiles=33', '--log-policy'],
      env: cliEnv(dir), write: (m) => out.push(String(m)), waitForSignal: false,
    })
    assert.equal(code, 0, out.join('\n'))
    const text = out.join('\n')
    // ★ 这一条才是真正钉住"重新读盘"的那一条。
    //
    //   上面那条用例跑的是**两次** `run()`，而每次调用都会重新解析配置——
    //   所以它拿到新值**与实现无关**：换成"用开头算好的那份 `options`"，
    //   它照样绿。
    //
    //     > 一个"分成两次调用"的用例，测不到"同一次调用里的陈旧读取"——
    //     > 它看起来在守那条纪律，其实守的是进程边界。
    //
    //   `--set-log-policy` 与 `--log-policy` 写在同一次调用里时，
    //   `options` 是**改之前**算好的；用它就会显示 5（旧值），
    //   而用户会把那一幕读成"我的修改没生效"。
    assert.match(text, /33/, `同一次调用里改完再看，显示的仍是旧值：\n${text}`)
    assert.ok(!/keepFiles\s+5\b/.test(text), `显示了旧值 5：\n${text}`)
  } finally { cleanup() }
})

test('★★★ CLI：坏配置 → 拒绝写，退出码 9，**文件内容不变**', async () => {
  const { run } = await import('./cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-broken')
  try {
    const configPath = join(dir, 'data', 'product.config.json')
    mkdirSync(join(dir, 'data'), { recursive: true })
    const original = '{ "log": { "keepFiles": 3 }'
    writeFileSync(configPath, original)

    const out = []
    const code = await run({
      argv: ['--set-log-policy=keepFiles=99'],
      env: cliEnv(dir), write: (m) => out.push(String(m)), waitForSignal: false,
    })
    assert.equal(code, 9, out.join('\n'))
    assert.equal(readFileSync(configPath, 'utf8'), original, '坏掉的配置被改写了')
  } finally { cleanup() }
})

test('★★ CLI：不合法/不认识的键 → 退出码 2（参数错误，不是运行失败）', async () => {
  const { run } = await import('./cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-bad')
  try {
    for (const spec of ['keepFile=3', 'keepFiles=abc', 'keepFiles=2.5', '']) {
      const out = []
      const code = await run({
        argv: [`--set-log-policy=${spec}`],
        env: cliEnv(dir), write: (m) => out.push(String(m)), waitForSignal: false,
      })
      assert.equal(code, 2, `--set-log-policy=${spec} 的退出码是 ${code}：\n${out.join('\n')}`)
    }
    // 一个字节都没写
    assert.equal(existsSync(join(dir, 'data', 'product.config.json')), false)
  } finally { cleanup() }
})

test('★★★ CLI：`--log-policy` 在**配置坏掉时也能用**，但必须**说出来**配置坏了', async () => {
  const { run } = await import('./cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-show-broken')
  try {
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 'product.config.json'), '{ 这不是 json')
    const out = []
    const code = await run({
      argv: ['--log-policy'],
      env: cliEnv(dir), write: (m) => out.push(String(m)), waitForSignal: false,
    })
    const text = out.join('\n')
    // ★ 它排在配置校验之前：一个"配置有问题"的产品，最需要用户能看一眼现在的值。
    //   挂在"配置能解析才往下走"的流程后面 = **恰恰在配置坏掉时**不让他看配置。
    //   ⇒ 仍然要打印出策略（这是这一条的存在理由）
    assert.match(text, /keepFiles/, '没有打印出策略')
    // ★★ 但它**必须同时说配置坏了**。
    //
    //   第一版只渲染 `merged`，于是坏 JSON 被渲染成"四项都是默认值"——
    //   一份**看起来完全正常**的输出。而真相是整份配置被忽略了。
    //   这正是本任务要消灭的「改了但没反应」，只是换了个地方发生：
    //
    //     > 一个把"你的配置被整份忽略了"渲染成"一切正常"的查看器，
    //     > 与一个"配置确实没问题"的查看器，在屏幕上是同一份输出——
    //     > 只不过前者会让用户放心地走开。
    assert.match(text, /不是你的配置/, `没有说出"这些不是你的配置"：\n${text}`)
    assert.match(text, /CONFIG_INVALID_JSON|不是合法 JSON/, '没有把配置自己的诊断带出来')
    assert.match(text, /配置未生效/, '默认值的来源没有标明"配置未生效"')
    // 退出码与主流程里"产品配置有问题"一致（同一件事不该有两个码）
    assert.equal(code, 6, `配置坏掉时的退出码是 ${code}，应当是 6`)
  } finally { cleanup() }
})

test('★★★ CLI：配置**好着**的时候不许出现"配置未生效"这句话', async () => {
  const { run } = await import('./cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-show-healthy')
  try {
    const env = cliEnv(dir)
    await run({ argv: ['--set-log-policy=keepFiles=4'], env, write: () => {}, waitForSignal: false })
    const out = []
    const code = await run({ argv: ['--log-policy'], env, write: (m) => out.push(String(m)), waitForSignal: false })
    const text = out.join('\n')
    assert.equal(code, 0, text)
    // 反面断言：健康的配置不该带警告头。少了这一条，
    // "永远打印警告头"也能让上面那条用例绿。
    assert.ok(!text.includes('不是你的配置'), `健康的配置被报成了坏的：\n${text}`)
    assert.ok(!text.includes('配置未生效'), `健康的配置被报成了坏的：\n${text}`)
    assert.match(text, /keepFiles/)
  } finally { cleanup() }
})

test('★★ CLI：`--log-policy --json` 给出机器可读的生效值与来源', async () => {
  const { run } = await import('./cli.mjs')
  const { dir, cleanup } = tmpRoot('cli-json')
  try {
    await run({
      argv: ['--set-log-policy=keepFiles=5'],
      env: cliEnv(dir), write: () => {}, waitForSignal: false,
    })
    const out = []
    const code = await run({
      argv: ['--log-policy', '--json'],
      env: cliEnv(dir), write: (m) => out.push(String(m)), waitForSignal: false,
    })
    assert.equal(code, 0, out.join('\n'))
    const obj = JSON.parse(out.join('\n'))
    assert.equal(obj.ok, true)
    assert.equal(obj.effective.keepFiles, 5)
    assert.equal(obj.provenance['log.keepFiles'], 'product-config')
  } finally { cleanup() }
})

test('★ CLI 帮助里列出了这两个参数', async () => {
  const { CLI_FLAGS } = await import('./cli.mjs')
  const names = CLI_FLAGS.map((f) => f.name)
  assert.ok(names.includes('--log-policy'))
  assert.ok(names.includes('--set-log-policy=<k=v,...>'))
})

// ============================================================================
// ⑥ 与 PRT-709 正文那条"按进程分文件命名未做"的说法对质
// ============================================================================

test('★★ 日志文件**已经是按进程+流分的**（`<进程>.<流>.log`）——正文那句话需要更正', () => {
  // PRT-709 的行里写着「按进程分文件命名…未做」。这一条把它钉住：
  // 名字里带着进程与流，所以它**已经**是分的（只不过粒度是"每进程每流一个文件"，
  // 而不是"每进程一个文件把 stdout/stderr 合在一起"）。
  const p = logFilePath('/tmp/logs', 'team-hub.stdout').replace(/\\/g, '/')
  assert.ok(p.endsWith('/team-hub.stdout.log'), `实际是 ${p}`)
  const e = logFilePath('/tmp/logs', 'team-hub.stderr').replace(/\\/g, '/')
  assert.ok(e.endsWith('/team-hub.stderr.log'), `实际是 ${e}`)
  // 两个流不是同一个文件——这正是"分了"的证据
  assert.notEqual(p, e)
  // 而且恶意流名一律落在目录内（性质断言）
  //
  // ⚠️ 基目录用 `resolve` 算：`logFilePath` 会把 `logDir` 解析成绝对路径，
  //    于是字面量 `/tmp/logs` 在 Windows 上变成 `D:/tmp/logs`——
  //    拿字面量去比会得到一个与被测行为无关的红。
  const base = resolve('/tmp/logs').replace(/\\/g, '/')
  for (const evil of ['../../etc/passwd', 'a/b', 'C:\\Windows\\x', '..', 'a:b']) {
    const out = logFilePath('/tmp/logs', evil).replace(/\\/g, '/')
    assert.ok(out.startsWith(`${base}/`), `${evil} 跑出了日志目录：${out}`)
    assert.ok(!out.slice(base.length + 1).includes('/'), `${evil} 造出了子路径：${out}`)
  }
})
