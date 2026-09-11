// scripts/prt/golden-flow.test.mjs — PRT-004 黄金流程定义单测
//
// 本套件的核心断言是**夹具没有漂移**：黄金流程的全部价值建立在「输入固定」上，
// 一旦夹具悄悄变了而哈希没变（或哈希变了没人注意），阶段 3 的新旧对拍就会退化成
// 「两次输入不同却以为两条路径行为不同」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FIXTURE_FILES,
  FIXTURE_HASH,
  GOLDEN_FLOW_ID,
  GOLDEN_TASK,
  assertFixtureHash,
  checkFixtureHygiene,
  fixtureFileHashes,
  fixtureHash,
  materializeFixture,
} from './golden-flow.mjs'

// ---------------------------------------------------------------- 夹具冻结

test('夹具哈希与冻结值一致（漂移会在这里红）', () => {
  const res = assertFixtureHash()
  assert.equal(res.ok, true, `夹具已漂移：expected ${res.expected}，actual ${res.actual}`)
  assert.equal(FIXTURE_HASH, fixtureHash())
})

test('夹具哈希是稳定的（同一输入重复计算相同）', () => {
  assert.equal(fixtureHash(), fixtureHash())
})

test('夹具哈希对内容敏感：改一个字节即改变摘要', () => {
  const base = fixtureHash()
  const tweaked = fixtureHash({ ...FIXTURE_FILES, 'README.md': FIXTURE_FILES['README.md'] + 'x' })
  assert.notEqual(base, tweaked)
})

test('夹具哈希对路径敏感：内容互换也会改变摘要', () => {
  // 只对内容做有序拼接（不含路径）会漏掉这种情况
  const swapped = fixtureHash({
    ...FIXTURE_FILES,
    'README.md': FIXTURE_FILES['package.json'],
    'package.json': FIXTURE_FILES['README.md'],
  })
  assert.notEqual(fixtureHash(), swapped)
})

test('夹具哈希对文件集合敏感：增删文件即改变摘要', () => {
  const base = fixtureHash()
  assert.notEqual(base, fixtureHash({ ...FIXTURE_FILES, 'extra.txt': 'x\n' }))
  const fewer = { ...FIXTURE_FILES }
  delete fewer['README.md']
  assert.notEqual(base, fixtureHash(fewer))
})

test('每个夹具文件的哈希互不相同（无重复内容）', () => {
  const per = fixtureFileHashes()
  const values = Object.values(per)
  assert.equal(new Set(values).size, values.length)
  assert.equal(values.length, Object.keys(FIXTURE_FILES).length)
  assert.match(fixtureHash(), /^[0-9a-f]{64}$/)
})

test('夹具规范：LF、无制表符、全 ASCII、安全路径', () => {
  assert.deepEqual(checkFixtureHygiene(), [])
})

test('夹具规范检查真的会报错（不是永远返回空数组）', () => {
  const bad = (content) => checkFixtureHygiene({ 'f.txt': content })
  assert.ok(bad('a\r\n').some((p) => /CR/.test(p)), 'CR 未被识别')
  assert.ok(bad('a\tb\n').some((p) => /制表符/.test(p)), '制表符未被识别')
  assert.ok(bad('no newline').some((p) => /LF 结尾/.test(p)), '缺尾换行未被识别')
  assert.ok(bad('中文\n').some((p) => /非 ASCII/.test(p)), '非 ASCII 未被识别')
  assert.ok(checkFixtureHygiene({ '../escape.txt': 'x\n' }).some((p) => /安全/.test(p)), '越界路径未被识别')
  assert.ok(checkFixtureHygiene({ '/abs.txt': 'x\n' }).some((p) => /安全/.test(p)), '绝对路径未被识别')
  // 合规内容零告警，避免误报
  assert.deepEqual(checkFixtureHygiene({ 'ok.txt': 'fine\n' }), [])
})

test('物化夹具写出全部文件，且拒绝不合规夹具', () => {
  const written = []
  const res = materializeFixture((path, content) => written.push([path, content]))
  assert.equal(res.files, Object.keys(FIXTURE_FILES).length)
  assert.equal(written.length, res.files)
  assert.equal(res.hash, FIXTURE_HASH)
  for (const [path, content] of written) {
    assert.equal(content, FIXTURE_FILES[path])
    assert.ok(path.length > 0)
  }
})

// ---------------------------------------------------------------- 流程定义

test('黄金流程满足「单目标 + 至少两岗位交接」', () => {
  assert.equal(GOLDEN_FLOW_ID, 'GF-001')
  assert.ok(GOLDEN_TASK.handoffs.length >= 2, '至少两段交接')
  const roles = new Set(GOLDEN_TASK.handoffs.flatMap((h) => [h.from, h.to]))
  assert.ok(roles.size >= 2, '至少两个岗位')
  for (const h of GOLDEN_TASK.handoffs) {
    assert.ok(h.deliverable.length > 0, '每段交接必须有明确交付物')
  }
})

test('验收契约全部可机器判定（无主观项）', () => {
  const a = GOLDEN_TASK.acceptance
  assert.equal(a.schema.type, 'object')
  assert.deepEqual(
    [...a.schema.required].sort(),
    ['filesChanged', 'readmeUpdated', 'testCommand', 'testPassed'],
  )
  for (const [field, spec] of Object.entries(a.schema.properties)) {
    assert.ok(['string', 'boolean', 'array'].includes(spec.type), `${field} 类型不可机器判定`)
  }
  assert.ok(a.prompt.length > 0)
})

test('对拍基准：每条可接受序列要么走得通迁移表，要么是已记录的旁路', async () => {
  const { extractTransitions } = await import('./baseline-snapshot.mjs')
  const { readFileSync } = await import('node:fs')
  const { dirname, join, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const server = readFileSync(join(ROOT, 'team-hub', 'server.mjs'), 'utf8')
  const transitions = extractTransitions(server, 'TRANSITIONS')

  // `advanced` 是**审计动作名**，不是任务状态：`advance` 不写 `to`，所以旧路径里
  // 「推进到 done」在审计上表现为 `advanced`。校验合法性时必须先归一化回 `done`，
  // 否则会把旧路径最主流的形态判成非法迁移。
  const normalize = (s) => (s === 'advanced' ? 'done' : s)
  const bypass = new Set(GOLDEN_TASK.transitionBypass.allows)

  for (const raw of GOLDEN_TASK.acceptedTaskStateSequences) {
    const seq = raw.map(normalize)
    assert.ok(seq.length >= 2, `可接受序列至少要有一跳：${raw.join('→')}`)
    for (let i = 1; i < seq.length; i += 1) {
      const from = seq[i - 1]
      const to = seq[i]
      const legal = (transitions[from] ?? []).includes(to) || bypass.has(`${from}->${to}`)
      assert.ok(
        legal,
        `可接受序列 ${raw.join('→')} 含无人走过的迁移 ${from} → ${to}`
          + `（TRANSITIONS 允许 ${(transitions[from] ?? []).join('/')}；旁路 ${[...bypass].join(' ')}）`,
      )
    }
  }
})

test('对拍基准：`advanceTask` 确实绕过迁移表（绕过是实测出来的事实，不是推测）', async () => {
  // 这条用例的存在理由：`acceptedTaskStateSequences` 里含 `in_progress → done`，
  // 而 `TRANSITIONS` **不**允许这条边。若哪天有人「顺手」让 advanceTask 也查迁移表，
  // 那么可接受集合就必须重新对拍——本用例会立刻变红提醒，而不是等着阶段 3 静默判错。
  const { readFileSync } = await import('node:fs')
  const { dirname, join, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const server = readFileSync(join(ROOT, 'team-hub', 'server.mjs'), 'utf8')

  const body = server.slice(server.indexOf('function advanceTask('))
  const end = body.indexOf('\n}')
  const fn = body.slice(0, end)
  assert.ok(fn.includes('in_progress') && fn.includes('in_review'), 'advanceTask 应同时接受 in_progress 与 in_review')
  assert.ok(!/TRANSITIONS/.test(fn), 'advanceTask 不再绕过迁移表——可接受序列集合必须重新对拍')
  assert.ok(!/by !== 'general'|by === 'general'/.test(fn), 'advanceTask 新增了将军限制——可接受序列集合必须重新对拍')
})

test('对拍基准：模态序列必须**在**可接受集合里，且基准不再是单条字面序列', () => {
  const accepted = GOLDEN_TASK.acceptedTaskStateSequences.map((s) => s.join('→'))
  const modal = GOLDEN_TASK.modalTaskStateSequence.join('→')
  // 两个字段分头维护就会漂移：模态值改了、集合忘了改，于是「最常见的那种」
  // 反而被判成不可接受。这条断言把两者钉在一起。
  assert.ok(accepted.includes(modal), `模态序列 ${modal} 不在可接受集合内：${accepted.join(' | ')}`)

  // 基准必须是**集合**而不是单条字面序列：单条序列已被实测推翻（76 个完成任务只有 4 个走它），
  // 拿它当门禁会把与旧路径等价的新路径判成不等价。
  assert.ok(accepted.length > 1, '基准应为集合；单条字面序列已被实测推翻')
  assert.equal(GOLDEN_TASK.expectedTaskStateSequence, undefined, '旧的单条字面基准字段应已移除')

  // 证据指针必须与实测数值一致，否则文档与代码会各说各话。
  const ev = GOLDEN_TASK.stateSequenceEvidence
  assert.equal(ev.completedWithTrail, 76)
  assert.equal(ev.exactMatchWithLegacyExpectation, 4)
  assert.equal(ev.skipInReview, 42)
  assert.match(ev.source, /prt-009-execution-evidence\.json$/)
})

test('夹具初始状态确实缺少 greet（否则黄金任务无事可做）', () => {
  const cli = FIXTURE_FILES['src/cli.mjs']
  const readme = FIXTURE_FILES['README.md']
  const tests = FIXTURE_FILES['test/cli.test.mjs']
  for (const [name, content] of [['cli.mjs', cli], ['README.md', readme], ['cli.test.mjs', tests]]) {
    assert.doesNotMatch(content, /greet/, `夹具 ${name} 已包含 greet，黄金任务的前提被破坏`)
  }
})

test('夹具已有 --version / help / 未知命令三条分支（任务有真实上下文）', () => {
  const cli = FIXTURE_FILES['src/cli.mjs']
  assert.match(cli, /--version/)
  assert.match(cli, /help/)
  assert.match(cli, /unknown command/)
  assert.match(FIXTURE_FILES['test/cli.test.mjs'], /node:test/)
})

test('夹具初始提交是干净的：npm test 通过且无未跟踪文件（黄金流程的起点）', async () => {
  // 与上一条的区别：上一条只要「物化后能跑」，这一条要求「起点是一个已提交的、
  // 自洽的仓库状态」——implementer 会在 worktree 里工作，起点若自带未提交改动，
  // 最终 diff 就无法归因到这次执行。
  const pkg = JSON.parse(FIXTURE_FILES['package.json'])
  assert.equal(pkg.name, 'gf001-cli')
  assert.equal(pkg.type, 'module')
  assert.equal(Object.keys(FIXTURE_FILES).length, 4, '夹具应恰好 4 个文件')
  assert.deepEqual(
    Object.keys(FIXTURE_FILES).sort(),
    ['README.md', 'package.json', 'src/cli.mjs', 'test/cli.test.mjs'],
  )
})

// ------------------------------------------------- 夹具真实可执行（关键缺口）

// 上面全部用例都只读**字符串**。它们能证明夹具没漂移、内容是干净的、缺 greet，
// 却完全证明不了「夹具跑得起来」——而黄金流程的验收契约恰恰要求 `npm test` 通过。
//
// 这正是阶段 0 冻结时漏掉的一环：夹具的 package.json 写的是 `node --test test/`，
// 而 Node 24 把 `--test` 的位置参数当**模块路径**解析、不展开目录，于是
// `npm test` 报 `Cannot find module '...\test'` 并以退出码 1 结束。
// 3 条用例本身是对的（`node --test` 自动发现时 3/3 通过），坏的是那条脚本。
//
// 后果若未发现：黄金任务会带着一个「基线就是红的」测试命令开跑，
// implementer 被要求「让测试通过」，而它面前的失败与 greet 毫无关系——
// 这次执行作为阶段 0 的证据就不成立了。
//
// 所以这里真的落盘、真的执行 `npm test`。跑得慢一点（约 1 秒），换的是
// 「夹具可执行」这条性质从此由 CI 守着，而不是靠人记得。
test('夹具真实物化后 `npm test` 通过（不只是内容干净，而是真能跑）', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  // 复用执行台里那个 runner，而不是各写一份：验收时跑的与这里跑的必须是同一条命令，
  // 否则「CI 绿」与「验收真跑」又会分叉。
  const { runDeclaredTest } = await import('./gf001-run.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'gf001-fixture-'))
  try {
    materializeFixture((path, content) => {
      const abs = join(dir, path)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, content, 'utf8')
    })

    // 先证明脚本本身没写坏：必须存在 test 脚本，且不含目录式位置参数
    const pkg = JSON.parse(FIXTURE_FILES['package.json'])
    assert.ok(pkg.scripts?.test, 'package.json 必须声明 test 脚本（验收契约要用）')
    assert.doesNotMatch(
      pkg.scripts.test,
      /--test\s+\S*\/\s*$/,
      'test 脚本不得把目录当作 --test 的位置参数：Node 不展开目录，会以退出码 1 失败',
    )

    const run = runDeclaredTest(dir)
    assert.ok(run.ok, `夹具的 npm test 必须通过，但失败了：\n${run.output.slice(0, 1200)}`)

    // 而且必须真的跑了 3 条用例——退出码 0 也可能是「一个用例都没发现」
    assert.match(run.output, /pass 3/, `npm test 应报告 3 条通过，实际输出：\n${run.output.slice(0, 800)}`)
    assert.doesNotMatch(run.output, /fail [1-9]/, 'npm test 不应有失败用例')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------- 入口判据：真的把 CLI 当命令跑

// 这一节锁的是**第一次真实执行黄金流程时才暴露**的夹具缺陷：
//
//   if (import.meta.url === `file://${argv[1]}`)   // Windows 上恒不成立
//
// `import.meta.url` 是 `file:///D:/...`（三斜杠 + 正斜杠），而手拼得到
// `file://D:\...`（两斜杠 + 反斜杠），两者永不相等 → 脚本主体不执行，
// `node src/cli.mjs --version` **退出码 0 且没有任何输出**。
//
// 为什么此前 14 条用例全绿却漏了它：它们只读字符串或直接 `import { main }` 调函数，
// 没有一条真的执行过 `node src/cli.mjs`。这正是「输入固定 + 验收可机器判定」
// 之外还需要「端到端真跑一次」的原因——发现它的是 planner（deepseek-v4-pro）
// 在现状勘察里实测出的 E3 节，不是任何静态检查。
test('夹具 CLI 作为命令运行时真的会输出（入口判据必须在 Windows 成立）', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { runCli } = await import('./gf001-run.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'gf001-cli-'))
  try {
    materializeFixture((path, content) => {
      const abs = join(dir, path)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, content, 'utf8')
    })

    const version = runCli(dir, ['--version'])
    assert.equal(version.ok, true, 'node src/cli.mjs --version 应以 0 退出')
    assert.equal(version.out.trim(), '1.0.0', '必须真的打印版本号，而不是空输出')

    const help = runCli(dir, ['help'])
    assert.equal(help.ok, true)
    assert.match(help.out, /Usage:/)

    const unknown = runCli(dir, ['nope'])
    assert.equal(unknown.code, 2, '未知命令应退出 2')
    assert.match(unknown.out, /unknown command: nope/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('夹具源码不得手拼 file:// URL 做入口判据（该写法在 Windows 恒不成立）', () => {
  // 直接对源码做形状检查，与上一条的行为检查互为补充：
  // 行为检查证明「现在是对的」，形状检查说明「为什么不能那样写」，
  // 避免后来者「简化」回去。
  const cli = FIXTURE_FILES['src/cli.mjs']
  assert.doesNotMatch(cli, /`file:\/\/\$\{/, '不得手拼 file:// URL：Windows 下斜杠数量与方向都不同')
  assert.match(cli, /pathToFileURL/, '入口判据必须用 pathToFileURL 归一化')
})
