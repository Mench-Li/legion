// scripts/prt/gf001-run.test.mjs — 黄金流程执行台单测
//
// 两条主线：
//
//   ① **验收必须独立重算**。这套用真正造一个结果仓库、真正跑 `npm test`，
//      证明 verifyAcceptance 不是「读 agent 自述」而是重新测量。
//      如果它只是转发 worker 填的 `testPassed: true`，那整个阶段 0 就白跑了。
//
//   ② **配置不变量**。隔离性（scratch 仓库在 legion 仓库之外）、模型分工原则、
//      流水线链完整性、闸门必须有产物——这些是设计决定，不是运行期数据，
//      必须由用例钉死，否则一次随手编辑就可能让黄金流程跑到生产空间里去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FIXTURE_FILES, materializeFixture } from './golden-flow.mjs'
import {
  ROLE_MODELS,
  ROSTER,
  SCRATCH_DIR,
  SPACE_ID,
  STAGES,
  detectModelDrift,
  goalLatencyMs,
  listFiles,
  roleRunsForGoal,
  runDeclaredTest,
  sessionDirName,
  taskLatencyMs,
  verifyAcceptance,
} from './gf001-run.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 在临时目录里物化一份夹具，返回目录路径。 */
function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gf001-run-'))
  materializeFixture((path, content) => {
    const abs = join(dir, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  })
  return dir
}

// ---------------------------------------------------------------- ① 配置不变量

test('隔离：scratch 仓库在 legion 仓库之外（黄金执行不得碰本仓库工作区）', () => {
  const normalized = SCRATCH_DIR.replace(/\\/g, '/')
  const rootNorm = ROOT.replace(/\\/g, '/')
  assert.ok(
    !normalized.startsWith(`${rootNorm}/`) && normalized !== rootNorm,
    `scratch 仓库不得位于本仓库内：${normalized} ⊂ ${rootNorm}`,
  )
})

test('隔离：专用空间 id 不是既有生产空间', () => {
  assert.equal(SPACE_ID, 'gf001')
  for (const prod of ['software', 'ozon', 'default']) {
    assert.notEqual(SPACE_ID, prod, '黄金流程必须跑在专用空间，不能复用生产空间')
  }
})

test('模型分工**声明**符合将军下达的原则：方案/评审用 pro，实现用 flash', () => {
  // ⚠️ 这条只锁**台账里的声明**，不证明它被执行了。
  // 2026-09-11 的实测是：声明 planner=pro，实际跑的是 flash（见下面 modelDrift 的用例）。
  // 把「声明」当成「生效」正是这套验收要防的东西，所以运行时对拍另立一条。
  assert.equal(ROLE_MODELS.planner.model, 'deepseek-v4-pro-openai')
  assert.equal(ROLE_MODELS.reviewer.model, 'deepseek-v4-pro-openai')
  assert.equal(ROLE_MODELS.implementer.model, 'deepseek-v4-flash-openai')
  for (const m of Object.values(ROLE_MODELS)) assert.equal(m.provider, 'custom-ds')
})

test('流水线是一条完整的链：每环的 next 都指向下一环，末环为 null', () => {
  const roles = STAGES.map((s) => s.role)
  assert.deepEqual(roles, ['planner', 'implementer', 'reviewer'])
  for (let i = 0; i < STAGES.length - 1; i += 1) {
    assert.equal(STAGES[i].next, STAGES[i + 1].role, `${STAGES[i].role}.next 应指向下一环`)
  }
  assert.equal(STAGES.at(-1).next, null, '末环的 next 必须是 null')
})

test('每个岗位都进了编队（守护的扫单闸门是「任务 role ∈ 流水线 stage 集合」）', () => {
  // 守护只认领 role 同时出现在流水线 stage 与编队里的任务；
  // 少了任何一个角色，那条任务链会永远停在 todo。
  const stageRoles = STAGES.map((s) => s.role).sort()
  const rosterRoles = ROSTER.map((r) => r.role).sort()
  assert.deepEqual(rosterRoles, stageRoles)
  for (const m of ROSTER) assert.ok(m.name.length > 0 && m.avatar.length > 0)
})

test('闸门必须有产物：gate=1 的环必须声明 artifact（team-hub 写入期即校验）', () => {
  for (const s of STAGES) {
    if (s.gate === 1) assert.ok(s.artifact, `${s.role} 设了闸门却没有 artifact，写入会被拒`)
  }
})

test('至少两段岗位交接（spec §14.2 对黄金流程的硬要求）', () => {
  assert.ok(STAGES.length - 1 >= 2, '黄金流程需要至少两段交接')
})

test('黄金流程不设人工闸门：全链 gate=0，一次执行可自动跑完', () => {
  // `gate: true` 的语义是「完成并合入后停在 in_review，等将军验收 done」，
  // 而 `transitionTask` 硬性要求 `to === 'done'` 时 `by === 'general'`。
  // 一旦设了 gate，黄金流程就变成「每环都要人点一下」的人工接力，
  // 与「稳定复现一次端到端交付」相悖。
  // 留存计划书靠 **artifact**，不靠 gate —— 这两件事我起初混为一谈了。
  assert.ok(STAGES.every((s) => s.gate === 0), '黄金流程不应有 gate 环')
})

test('每环都要求交付物：planner 与 reviewer 各有契约文档', () => {
  const planner = STAGES.find((s) => s.role === 'planner')
  const reviewer = STAGES.find((s) => s.role === 'reviewer')
  assert.match(planner.artifact, /TASK_BREAKDOWN/, '计划书要落在守护认识的槽位上，否则不会被 goalize')
  assert.match(reviewer.artifact, /\{taskId\}/, 'reviewer 文档按任务动态命名，避免并行审查互相覆盖')
  assert.match(planner.prompt, /文件清单/)
  assert.match(planner.prompt, /验收步骤/)
})

test('契约文档路径只用守护认识的槽位名（否则不会被 goalize 到目标目录）', () => {
  // 守护只对 GOAL_DOC_NAMES = [REQUIREMENTS, RESEARCH, TASK_BREAKDOWN,
  // TEST_CASES, TEST_REPORT, DEPLOY] 里的名字做目标目录改写。
  // 用名单外的名字（如我第一版写的 PLAN.md），声明路径与实际落位就会不一致，
  // 只能靠守护的兜底逻辑才不卡住 —— 那是运气，不是设计。
  const KNOWN = new Set(['REQUIREMENTS.md', 'RESEARCH.md', 'TASK_BREAKDOWN.md', 'TEST_CASES.md', 'TEST_REPORT.md', 'DEPLOY.md'])
  for (const s of STAGES) {
    for (const p of [s.artifact, ...(s.docs ?? [])].filter(Boolean)) {
      // docs/review/{taskId}-REVIEW.md 这类多级/其他命名路径按语义原样保留
      if (p.startsWith('docs/review/')) continue
      const base = p.split('/').pop()
      assert.ok(KNOWN.has(base), `${s.role} 的契约路径 ${p} 不在槽位名单里，不会被 goalize 到目标目录`)
    }
  }
})

test('提示词必须字面点名契约文件名（否则工人自选文件名 → 契约判缺 → 停 in_review）', () => {
  // 第一次真实执行两次都卡在这里：契约声明 docs/TASK_BREAKDOWN.md 会被守护
  // goalize 成 docs/<goalId>/TASK_BREAKDOWN.md，而提示词只说「写入任务文档目录」，
  // worker 自行选了 PLAN.md → 契约校验正确地判缺失并停在 in_review。
  // 机制没错，错在提示词没把文件名说死。守护只改写提示词里**已出现**的槽位路径。
  const planner = STAGES.find((s) => s.role === 'planner')
  assert.match(planner.prompt, /docs\/TASK_BREAKDOWN\.md/, '提示词必须字面写出槽位路径，goalize 才有东西可改写')

  const reviewer = STAGES.find((s) => s.role === 'reviewer')
  // 占位符必须配一个可照抄的例子，否则工人可能把 `{taskId}` 原样当文件名写出去
  assert.match(reviewer.prompt, /T-\d+-REVIEW\.md|T-143-REVIEW\.md/, 'reviewer 提示词要给出任务 id 的实例')
})

// ---------------------------------------------------------------- ② 文件枚举

test('listFiles：递归、posix 分隔、跳过 .git 与隔离目录', () => {
  const dir = fixtureDir()
  try {
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'x')
    mkdirSync(join(dir, '.legion-worktrees', 'T-1'), { recursive: true })
    writeFileSync(join(dir, '.legion-worktrees', 'T-1', 'a'), 'x')
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'x', 'a'), 'x')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'PLAN.md'), 'x')

    const files = listFiles(dir)
    assert.deepEqual(files.sort(), ['README.md', 'docs/PLAN.md', 'package.json', 'src/cli.mjs', 'test/cli.test.mjs'])
    assert.ok(files.every((f) => !f.includes('\\')), '必须用 posix 分隔符（跨平台一致）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ③ 独立验收

test('verifyAcceptance：未改动的夹具 → 四项都不满足，accepted 为 false', () => {
  const dir = fixtureDir()
  try {
    const r = verifyAcceptance(dir, { runTests: false })
    assert.deepEqual(r.filesChanged, [], '夹具原样未改，不应报出任何改动')
    assert.equal(r.readmeUpdated, false, '夹具 README 本来就不含 greet')
    assert.equal(r.testPassed, null, '未跑测试应为 null，而不是 false 或 true')
    assert.equal(r.accepted, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyAcceptance：只改 README → 仍不通过（缺测试通过与真实改动）', () => {
  const dir = fixtureDir()
  try {
    writeFileSync(join(dir, 'README.md'), `${FIXTURE_FILES['README.md']}\n## greet\n\ngf001 greet <name>\n`, 'utf8')
    const r = verifyAcceptance(dir, { runTests: false })
    assert.deepEqual(r.detail.modified, ['README.md'])
    assert.equal(r.readmeUpdated, true)
    assert.equal(r.accepted, false, 'README 改了但没有可用实现，不能算验收通过')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyAcceptance：完整解 → 五项齐备、accepted 为 true（真跑 npm test + 真跑 CLI）', () => {
  const dir = fixtureDir()
  try {
    // 真的实现 greet，而不是伪造一个「通过」。
    // 注意这里必须是一份**真正完整**的解：加分支、加 USAGE 行、处理缺参。
    // 少了 USAGE 或缺参处理，CLI 行为检查会正确地判它不通过。
    const cli = FIXTURE_FILES['src/cli.mjs']
      .replace(
        "  '  gf001 help         print this message',",
        "  '  gf001 help         print this message',\n  '  gf001 greet <name>  print Hello, <name>!',",
      )
      .replace(
        '  return { code: 2, out: `unknown command: ${cmd}` }',
        "  if (cmd === 'greet') {\n"
        + "    const name = args[1]\n"
        + "    if (name === undefined || name === '') return { code: 2, out: 'usage: gf001 greet <name>' }\n"
        + '    return { code: 0, out: `Hello, ${name}!` }\n'
        + '  }\n'
        + '  return { code: 2, out: `unknown command: ${cmd}` }',
      )
    writeFileSync(join(dir, 'src', 'cli.mjs'), cli, 'utf8')
    writeFileSync(
      join(dir, 'test', 'greet.test.mjs'),
      "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n"
        + "import { main } from '../src/cli.mjs'\n\n"
        + "test('greet prints a greeting', () => {\n"
        + "  assert.deepEqual(main(['greet', 'Ada']), { code: 0, out: 'Hello, Ada!' })\n"
        + '})\n',
      'utf8',
    )
    writeFileSync(
      join(dir, 'README.md'),
      `${FIXTURE_FILES['README.md']}\n## greet\n\n    gf001 greet <name>\n`,
      'utf8',
    )

    const r = verifyAcceptance(dir, { runTests: true })
    assert.deepEqual(r.filesChanged, ['README.md', 'src/cli.mjs', 'test/greet.test.mjs'])
    assert.deepEqual(r.detail.added, ['test/greet.test.mjs'])
    assert.deepEqual([...r.detail.modified].sort(), ['README.md', 'src/cli.mjs'])
    assert.deepEqual([...r.detail.unchanged].sort(), ['package.json', 'test/cli.test.mjs'])
    assert.equal(r.testCommand, 'npm test')
    assert.equal(r.testPassed, true)
    assert.equal(r.readmeUpdated, true)
    assert.equal(r.cli.allPassed, true, `CLI 行为应全过：${JSON.stringify(r.cli.cases.filter((c) => !c.ok))}`)
    assert.equal(r.accepted, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyAcceptance：只加函数不改 USAGE/缺参 → CLI 检查拦住（单元测试全绿也没用）', () => {
  // 这条用例锁的正是黄金流程第一次真实执行时暴露的那类交付：
  // 单元测试通过、README 也改了，但用户敲的命令要么无输出、要么错得离谱。
  const dir = fixtureDir()
  try {
    const cli = FIXTURE_FILES['src/cli.mjs'].replace(
      '  return { code: 2, out: `unknown command: ${cmd}` }',
      "  if (cmd === 'greet') return { code: 0, out: `Hello, ${args[1]}!` }\n"
        + '  return { code: 2, out: `unknown command: ${cmd}` }',
    )
    writeFileSync(join(dir, 'src', 'cli.mjs'), cli, 'utf8')
    writeFileSync(join(dir, 'README.md'), `${FIXTURE_FILES['README.md']}\n## greet\n\ngf001 greet <name>\n`, 'utf8')

    const r = verifyAcceptance(dir, { runTests: true })
    assert.equal(r.testPassed, true, '单元测试确实通过')
    assert.equal(r.readmeUpdated, true, 'README 确实改了')
    assert.equal(r.cli.allPassed, false, 'CLI 检查必须发现问题')
    assert.equal(r.accepted, false, '不得凭单元测试全绿就放行')
    const failed = r.cli.cases.filter((c) => !c.ok).map((c) => c.name)
    assert.ok(failed.some((n) => /缺.*name|缺少/.test(n)), `应报出缺参处理缺陷，实际：${failed.join(' / ')}`)
    assert.ok(failed.some((n) => /help/.test(n)), `应报出 help 未更新，实际：${failed.join(' / ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyAcceptance：实现会失败时 testPassed 为 false，不能凭文件齐全通过', () => {
  const dir = fixtureDir()
  try {
    // 改坏实现：让既有用例失败
    writeFileSync(
      join(dir, 'src', 'cli.mjs'),
      FIXTURE_FILES['src/cli.mjs'].replace("return { code: 0, out: '1.0.0' }", "return { code: 0, out: '9.9.9' }"),
      'utf8',
    )
    writeFileSync(join(dir, 'README.md'), 'greet 用法\n', 'utf8')
    const r = verifyAcceptance(dir, { runTests: true })
    assert.ok(r.filesChanged.length > 0)
    assert.equal(r.readmeUpdated, true)
    assert.equal(r.testPassed, false, '测试真的挂了就必须报 false')
    assert.equal(r.accepted, false, '文件改了、README 也改了，但测试不过 —— 不能算通过')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyAcceptance：删除夹具文件被识别为改动，不被当成「没动」', () => {
  const dir = fixtureDir()
  try {
    rmSync(join(dir, 'test', 'cli.test.mjs'))
    const r = verifyAcceptance(dir, { runTests: false })
    assert.ok(
      r.detail.modified.some((m) => m.includes('cli.test.mjs') && m.includes('删除')),
      '删掉夹具文件必须显式记为改动',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ④ 会话残骸

test('sessionDirName：连续分隔符折叠为单个 `-`（前两例与真实目录名逐字对照过）', () => {
  // 这个映射错了会让 clearStaleForemanSessions 找不到目录、静默什么也不做，
  // 于是重复 setup 时守护仍然卡在残留会话上——而且不会报错。
  //
  // 前两例是在本机 `$DSH_HOME/sessions/` 下**实际存在**的目录名，逐字对照。
  assert.equal(sessionDirName('D:\\project\\DSH\\gf001-scratch'), '--D-project-DSH-gf001-scratch--')
  assert.equal(sessionDirName('D:\\project\\DSH\\legion'), '--D-project-DSH-legion--')
  // 下例是按同一规则推导的（本机没有 POSIX 实例可对照）：
  // 开头的 `/` 折叠成一个 `-`，再套上两侧的 `--`，所以前缀是三个 `-`。
  assert.equal(sessionDirName('/home/u/gf001-scratch'), '---home-u-gf001-scratch--')
})

test('waitForCompletion：只看**当前目标**的链，不被上一轮的陈旧任务拖住', async () => {
  // 第一版判定「本空间所有任务都终态」。这在重复执行时**永不返回**：
  // 上一轮被中断的链会留下一条停在 in_review 的任务，于是即使本轮三环全部 done，
  // 整体条件依然为假，等待器会一直转到超时。这个错误只在跑第二次时才出现。
  const { waitForCompletion } = await import('./gf001-run.mjs')

  const calls = []
  const fakeFetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/api/goal')) {
      return {
        ok: true,
        json: async () => ({
          goals: [
            { id: 'G-old', status: 'canceled', createdAt: '2026-09-11T10:00:00Z' },
            { id: 'G-new', status: 'active', createdAt: '2026-09-11T12:00:00Z' },
          ],
        }),
      }
    }
    return {
      ok: true,
      json: async () => ({
        tasks: [
          { id: 'T-1', goalId: 'G-old', status: 'in_review' },   // 陈旧：停在 in_review
          { id: 'T-8', goalId: 'G-new', status: 'done' },
          { id: 'T-9', goalId: 'G-new', status: 'done' },
          { id: 'T-10', goalId: 'G-new', status: 'done' },
        ],
      }),
    }
  }

  const logs = []
  const out = await waitForCompletion({
    hub: 'http://fake', intervalMs: 1, timeoutMs: 5_000,
    log: (m) => logs.push(m), fetchImpl: fakeFetch,
  })

  assert.equal(out.terminal, true, '当前目标全终态就该返回，不能被陈旧任务拖到超时')
  assert.equal(out.goalId, 'G-new')
  assert.equal(out.tasks.length, 3, '只统计当前目标的任务')
  assert.ok(calls.length >= 2, '每轮应同时取目标与看板')
})

// ---------------------------------------------------------------- ⑤ 会话残骸（续）

test('clearStaleForemanSessions：只动 foreman 会话，且是移出而非删除', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync: rd, existsSync: ex } = await import('node:fs')
  const { clearStaleForemanSessions } = await import('./gf001-run.mjs')

  const home = mkdtempSync(join(tmpdir(), 'gf001-home-'))
  try {
    const cwd = 'D:\\project\\DSH\\gf001-scratch'
    const dir = join(home, 'sessions', sessionDirName(cwd))
    // 一个该被移走的 foreman 会话，与一个不该被碰的普通会话
    mkdirSync(join(dir, 'scrum-worker-foreman-123'), { recursive: true })
    writeFileSync(join(dir, 'scrum-worker-foreman-123', 'session.jsonl.zstd'), 'x')
    mkdirSync(join(dir, '5acda7fd-15dd-4b32-88a8-ed142079b138'), { recursive: true })

    const out = clearStaleForemanSessions({ cwd, home, log: () => {} })

    assert.equal(out.moved.length, 1)
    assert.match(out.moved[0], /scrum-worker-foreman-123/)
    // 已被移出原位置
    assert.equal(ex(join(dir, 'scrum-worker-foreman-123')), false)
    // 但**没有删除**：备份目录里还在（残骸本身是生产缺陷的证据）
    const backupRoot = join(home, '.stale-session-backup')
    assert.ok(ex(backupRoot), '备份目录应存在')
    const backed = rd(backupRoot, { recursive: true }).filter((p) => String(p).includes('scrum-worker-foreman-123'))
    assert.ok(backed.length > 0, '被移出的会话必须仍存在于备份区')
    // 普通会话不受影响
    assert.equal(ex(join(dir, '5acda7fd-15dd-4b32-88a8-ed142079b138')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- ⑥ 真实执行证据（PRT-009）

test('roleRunsForGoal：会话按「cwd 末段 = 任务 id」挂到岗位，挂不上的不丢只留痕', () => {
  const tasks = [
    { id: 'T-144', role: 'planner', status: 'done' },
    { id: 'T-145', role: 'implementer', status: 'done' },
  ]
  const sessions = [
    { sessionId: 's1', cwd: 'D:\\p\\gf001-scratch\\.legion-worktrees\\T-144', models: ['m-a'], startedAt: '2026-01-01T00:00:00Z', tokens: { input: 1, output: 1, cacheRead: 0, reportedTotal: 2 }, counts: { assistantMessages: 3, steps: 3 } },
    // 属于**别的**目标的历史会话：挂不上任务，必须保留为 role=null 以便发现
    { sessionId: 's0', cwd: 'D:\\p\\gf001-scratch\\.legion-worktrees\\T-138', models: ['m-a'], startedAt: '2025-12-31T00:00:00Z', tokens: { input: 9, output: 9, cacheRead: 0, reportedTotal: 18 }, counts: {} },
    { sessionId: 's2', cwd: 'D:\\p\\gf001-scratch\\.legion-worktrees\\T-145', models: ['m-b'], startedAt: '2026-01-01T01:00:00Z', tokens: { input: 2, output: 2, cacheRead: 0, reportedTotal: 4 }, counts: {} },
  ]
  const runs = roleRunsForGoal({ tasks, sessions })
  assert.equal(runs.length, 3, '挂不上的会话也要保留')
  assert.deepEqual(runs.map((r) => r.role), [null, 'planner', 'implementer'], '按开始时间排序')
  assert.equal(runs[1].taskId, 'T-144')
  assert.equal(runs[1].model, 'm-a')
  assert.equal(runs[1].taskStatus, 'done')
})

test('roleRunsForGoal：同一任务的两条会话只算一条，另一条进 supersededSessions（不丢也不重算）', () => {
  // 实测形态：每个岗位任务下同时有一条 0 token 的派工**工头**会话 + 一条真正干活的
  // worker 会话。不合并就会把 runs 翻倍，读的人会以为跑了六轮。
  const tasks = [{ id: 'T-144', role: 'planner', status: 'done' }]
  const sessions = [
    { sessionId: 'foreman', cwd: 'D:\\p\\sc\\T-144', models: [], startedAt: '2026-01-01T00:00:00.000Z', tokens: { input: 0, output: 0, cacheRead: 0, reportedTotal: 0 }, counts: {} },
    { sessionId: 'worker', cwd: 'D:\\p\\sc\\T-144', models: ['m-a'], startedAt: '2026-01-01T00:00:00.100Z', tokens: { input: 10, output: 5, cacheRead: 90, reportedTotal: 105 }, counts: { assistantMessages: 7 } },
  ]
  const runs = roleRunsForGoal({ tasks, sessions })
  assert.equal(runs.length, 1, '同一任务只产出一条 run')
  assert.equal(runs[0].sessionId, 'worker', '主会话是 token 更多的那条')
  assert.equal(runs[0].tokens.reportedTotal, 105)
  assert.deepEqual(runs[0].supersededSessions, [{ sessionId: 'foreman', reportedTotal: 0, durationMs: undefined }])
})

test('roleRunsForGoal：两条都想当主会话时取大的，且**合并顺序不影响**结果', () => {
  const tasks = [{ id: 'T-1', role: 'implementer', status: 'done' }]
  const mk = (id, total) => ({ sessionId: id, cwd: 'D:\\p\\sc\\T-1', models: ['m'], startedAt: '2026-01-01T00:00:00Z', tokens: { input: 0, output: 0, cacheRead: 0, reportedTotal: total }, counts: {} })
  const a = roleRunsForGoal({ tasks, sessions: [mk('small', 10), mk('big', 99)] })
  const b = roleRunsForGoal({ tasks, sessions: [mk('big', 99), mk('small', 10)] })
  assert.equal(a[0].sessionId, 'big')
  assert.equal(b[0].sessionId, 'big')
  // 用 `reportedTotal` 之外的口径会让「谁是主会话」依赖于读取顺序——那是不确定的证据。
  assert.deepEqual(a[0].supersededSessions, b[0].supersededSessions)
})

test('detectModelDrift：配置 pro 实际跑 flash 必须被点名（这是真实发生过的偏差）', () => {
  const runs = [
    { role: 'planner', taskId: 'T-144', sessionId: 's1', model: 'deepseek-v4-flash-openai' },
    { role: 'implementer', taskId: 'T-145', sessionId: 's2', model: 'deepseek-v4-flash-openai' }, // 与配置一致
    { role: 'reviewer', taskId: 'T-146', sessionId: 's3', model: 'deepseek-v4-pro-openai' },
    { role: null, taskId: 'T-138', sessionId: 's0', model: 'deepseek-v4-flash-openai' }, // 无岗位，不参与
  ]
  const drift = detectModelDrift(runs)
  assert.equal(drift.length, 1, '只有 planner 偏离（reviewer 按配置跑的是 pro）')
  assert.deepEqual(drift[0], {
    role: 'planner',
    taskId: 'T-144',
    sessionId: 's1',
    configured: 'custom-ds/deepseek-v4-pro-openai',
    actual: 'deepseek-v4-flash-openai',
  })
})

test('detectModelDrift：会话没记模型时如实报「未记录」，不得当成「一致」', () => {
  const drift = detectModelDrift([{ role: 'implementer', taskId: 'T-1', sessionId: 's', model: null }])
  assert.equal(drift.length, 1)
  assert.equal(drift[0].actual, '(会话未记录模型)')
})

test('goalLatencyMs / taskLatencyMs：缺时间戳返回 null，不返回 0', () => {
  // 返回 0 会让「没测到」看起来像「瞬时完成」，进而让阶段 3 的性能对比失真。
  assert.equal(goalLatencyMs({ createdAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z' }), 60_000)
  assert.equal(goalLatencyMs({ createdAt: '2026-01-01T00:00:00Z' }), null)
  assert.equal(goalLatencyMs(null), null)
  assert.equal(taskLatencyMs({ claimedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:30Z' }), 30_000)
  assert.equal(taskLatencyMs({ updatedAt: '2026-01-01T00:00:30Z' }), null)
})

// ---------------------------------------------------------------- ⑤ 测试执行

test('runDeclaredTest：夹具真实可跑，且报告 3 条通过', () => {
  const dir = fixtureDir()
  try {
    const r = runDeclaredTest(dir)
    assert.ok(r.ok, `夹具应可跑：${r.output.slice(0, 400)}`)
    assert.match(r.output, /pass 3/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runDeclaredTest：清掉 NODE_TEST_CONTEXT，否则在 node --test 内部拿不到可读输出', () => {
  // 这条用例本身就跑在 `node --test` 里：若 runner 不清该变量，
  // 子进程会切换到 child 上报模式，`ℹ pass 3` 不再输出，断言会拿到空串。
  // 也就是说这条用例的**存在**就是那个修复的回归测试。
  assert.ok(process.env.NODE_TEST_CONTEXT !== undefined, '本用例应在 node --test 内部运行才有意义')
  const dir = fixtureDir()
  try {
    const r = runDeclaredTest(dir)
    assert.ok(r.output.length > 0, '必须拿到可读输出，而不是空字符串')
    assert.doesNotMatch(r.output, /NODE_TEST_CONTEXT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runDeclaredTest：命令失败时返回 ok=false 并带上输出，不抛异常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gf001-fail-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'x', version: '1.0.0', type: 'module', scripts: { test: 'node -e "process.exit(1)"' },
    }), 'utf8')
    const r = runDeclaredTest(dir)
    assert.equal(r.ok, false)
    assert.equal(typeof r.output, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
