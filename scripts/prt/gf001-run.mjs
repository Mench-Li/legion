#!/usr/bin/env node
// scripts/prt/gf001-run.mjs
// ============================================================================
// 黄金流程 GF-001 执行台（PRT-005 / PRT-009 / 阶段 0 完成标准）
//
// ## 为什么是一条脚本而不是一串手工命令
//
// 阶段 0 的完成标准是「**稳定**复现一次端到端软件交付」。手敲一遍 API 只能证明
// 「当时敲对了」；而且中间任何一步（空间、流水线、编队、模型、守护实例）敲错，
// 都要在烧掉几十分钟真实模型调用之后才暴露。所以把准备动作写成一个幂等脚本：
// 可以重复跑、可以复核、可以贴进证据。
//
// ## 隔离
//
// 全程只碰**专用命名空间** gf001 与专用 scratch 仓库，不读写 software / ozon
// 两个生产空间的任何任务。夹具仓库只含 golden-flow.mjs 生成的 4 个文件。
//
// ## 验收是独立校验，不是采信 agent 自述
//
// `GOLDEN_TASK.acceptance.schema` 要 filesChanged / testCommand / testPassed /
// readmeUpdated 四项。**这四项由 verify 子命令在结果仓库上重新计算**——
// 真跑 `npm test`、真读 README、真看 git diff。
// 采信 worker 自己填的 `testPassed: true` 等于没有验收：那正是「看起来做完了」。
//
// 用法：
//   node scripts/prt/gf001-run.mjs setup      # 建 scratch 仓库 + 空间 + 流水线 + 编队 + 模型
//   node scripts/prt/gf001-run.mjs status     # 看空间/目标/任务/守护认领情况
//   node scripts/prt/gf001-run.mjs verify     # 在结果仓库上独立计算验收四项
//   node scripts/prt/gf001-run.mjs report     # 产出证据 JSON
//   node scripts/prt/gf001-run.mjs teardown   # 取消目标（不删数据，保留证据）
// ============================================================================
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FIXTURE_FILES, GOLDEN_TASK, fixtureHash, materializeFixture } from './golden-flow.mjs'

export const SPACE_ID = 'gf001'
export const SPACE_NAME = 'GF-001 黄金流程'
/** 专用 scratch 仓库。放在 legion 仓库**外**，避免碰主仓库工作区。 */
export const SCRATCH_DIR = 'D:/project/DSH/gf001-scratch'
export const HUB = process.env.GF001_HUB ?? 'http://127.0.0.1:8787'

/**
 * 模型分工。来源：将军下达的原则「方案需求用 pro，代码+测试用 flash」，
 * plus GF-001 的 reviewer 判定——评审是判断类且是质量闸门，归 pro 档。
 */
export const ROLE_MODELS = Object.freeze({
  planner: { provider: 'custom-ds', model: 'deepseek-v4-pro-openai' },
  implementer: { provider: 'custom-ds', model: 'deepseek-v4-flash-openai' },
  reviewer: { provider: 'custom-ds', model: 'deepseek-v4-pro-openai' },
})

/**
 * 三环流水线：planner → implementer → reviewer。
 *
 * `gate:1` + `artifact` 表示该环必须先登记产物才算完成（team-hub 的写入期校验
 * 要求 gate 必须有 artifact）。planner 设闸门是为了逼出「改动文件清单 + 验收步骤」
 * 这份交接物——否则 planner 可以直接空手把任务推给 implementer，
 * 黄金流程要检验的「计划→实现」交接就退化成一次转发。
 */
export const STAGES = Object.freeze([
  {
    role: 'planner',
    label: '计划',
    prompt:
      '你是「计划士兵」。职责：读懂目标与现有代码，产出**实施计划**并写入 docs/PLAN.md。'
      + '内容必须包含：(1) 需要改动的文件清单（逐条给出仓库相对路径）；(2) 每个文件改什么；'
      + '(3) 验收步骤（可直接执行的命令 + 期望输出）。不要在本环写业务代码。',
    next: 'implementer',
    gate: 1,
    artifact: 'docs/PLAN.md',
    docs: ['docs/PLAN.md'],
    sort: 0,
    enabled: 1,
  },
  {
    role: 'implementer',
    label: '实现',
    prompt:
      '你是「实现士兵」。职责：严格按 docs/PLAN.md 落地代码改动，并补充单元测试与文档。'
      + '改完必须自己先跑一遍测试，把真实命令与真实输出记进 evidence（不要只写「已通过」）。',
    next: 'reviewer',
    gate: 0,
    artifact: null,
    docs: null,
    sort: 1,
    enabled: 1,
  },
  {
    role: 'reviewer',
    label: '评审',
    prompt:
      '你是「评审士兵」。职责：审查实现阶段的改动，逐项核对是否满足目标与验收契约，'
      + '写出评审结论到 docs/REVIEW.md：明确给出「通过」或「打回」，打回时必须写明理由与需要修的点。'
      + '评审结论必须能被证据支撑——引用具体文件与具体命令输出，不要只给印象分。',
    next: null,
    gate: 0,
    artifact: null,
    docs: ['docs/REVIEW.md'],
    sort: 2,
    enabled: 1,
  },
])

export const ROSTER = Object.freeze([
  { role: 'planner', name: '计划工程师', kind: '方案与改动清单', avatar: '📋' },
  { role: 'implementer', name: '实现工程师', kind: '编码与自测', avatar: '💻' },
  { role: 'reviewer', name: '评审工程师', kind: '质量审查与结论', avatar: '🔎' },
])

// ------------------------------------------------------------------ HTTP

/** 统一写请求。team-hub 的写接口要求 body.by / body.scope。 */
export async function post(hub, path, body) {
  const res = await fetch(`${hub}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'general', scope: SPACE_ID, ...body }),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 保留原文 */ }
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${parsed?.error ?? text.slice(0, 200)}`)
  return parsed
}

export async function getJson(hub, path) {
  const res = await fetch(`${hub}${path}`)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return res.json()
}

// ------------------------------------------------------------------ 夹具仓库

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * 建或重置 scratch 仓库，把夹具物化并提交。
 *
 * 幂等：已存在且 HEAD 的夹具哈希一致时**不动它**（重复跑 setup 不该抹掉上一次的
 * 交付结果——那会让「跑过一次」和「跑过两次」的证据混在一起）。
 * 传 `--reset` 才强制回到夹具初始状态。
 */
export function ensureScratchRepo({ reset = false, log = console.log } = {}) {
  const dir = SCRATCH_DIR
  const isRepo = existsSync(join(dir, '.git'))

  if (isRepo && !reset) {
    const status = git(['status', '--porcelain'], dir)
    log(`scratch 仓库已存在：${dir}（工作区${status ? '有改动' : '干净'}，保持原样）`)
    return { dir, created: false }
  }
  if (isRepo && reset) {
    // 只删工作区内容与 git 元数据，不删目录本身（避免占用/权限噪音）
    for (const name of readdirSync(dir)) {
      if (name === '.legion-worktrees') continue
      rmSync(join(dir, name), { recursive: true, force: true })
    }
    rmSync(join(dir, '.git'), { recursive: true, force: true })
    log(`已重置 scratch 仓库：${dir}`)
  }

  mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'main'], dir)
  // 提交身份是仓库本地的，不依赖机器全局配置（换机器也能复现）
  git(['config', 'user.name', 'legion-gf001'], dir)
  git(['config', 'user.email', 'gf001@legion.local'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)

  materializeFixture((path, content) => {
    const abs = join(dir, path)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  })
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'chore: initial GF-001 fixture (golden-flow.mjs)'], dir)

  const head = git(['rev-parse', 'HEAD'], dir)
  log(`已建 scratch 仓库：${dir}`)
  log(`  夹具哈希（代码侧）: ${fixtureHash()}`)
  log(`  初始提交: ${head.slice(0, 12)}`)
  return { dir, created: true, head }
}

// ------------------------------------------------------------------ setup

export async function setup({ hub = HUB, reset = false, log = console.log } = {}) {
  const steps = []

  // 1) scratch 仓库
  const repo = ensureScratchRepo({ reset, log })
  steps.push({ step: 'scratch-repo', ok: true, dir: repo.dir, created: repo.created })

  // 2) 空间（幂等 upsert）
  const space = await post(hub, '/api/spaces', {
    id: SPACE_ID,
    name: SPACE_NAME,
    localDir: repo.dir.replace(/\//g, '\\'),
    remoteUrl: '',
  })
  steps.push({ step: 'space', ok: true, id: space.task?.id ?? SPACE_ID })
  log(`空间就绪：${SPACE_ID} → ${repo.dir}`)

  // 3) 流水线（整批 upsert，会删掉未提交的旧阶段）
  const pipeline = await post(hub, '/api/pipeline', {
    scope: SPACE_ID,
    stages: STAGES.map((s) => ({ ...s })),
  })
  steps.push({ step: 'pipeline', ok: true, stages: STAGES.map((s) => s.role) })
  log(`流水线就绪：${STAGES.map((s) => s.role).join(' → ')}`)
  void pipeline

  // 4) 编队
  for (const member of ROSTER) {
    await post(hub, '/api/agents', { scope: SPACE_ID, ...member })
  }
  steps.push({ step: 'roster', ok: true, roles: ROSTER.map((r) => r.role) })
  log(`编队就绪：${ROSTER.map((r) => r.role).join(', ')}`)

  // 5) 模型分工
  for (const [role, m] of Object.entries(ROLE_MODELS)) {
    await post(hub, '/api/models', { scope: SPACE_ID, role, provider: m.provider, model: m.model })
  }
  steps.push({ step: 'models', ok: true, models: ROLE_MODELS })
  log('模型分工：')
  for (const [role, m] of Object.entries(ROLE_MODELS)) log(`  ${role} → ${m.provider}/${m.model}`)

  return { space: SPACE_ID, dir: repo.dir, steps }
}

// ------------------------------------------------------------------ status

export async function status({ hub = HUB } = {}) {
  const goal = await getJson(hub, `/api/goal?scope=${SPACE_ID}`)
  const tasks = await getJson(hub, `/api/board?scope=${SPACE_ID}`)
  const pipeline = await getJson(hub, `/api/pipeline?scope=${SPACE_ID}`)
  const models = await getJson(hub, '/api/models?scope=' + SPACE_ID)
  const roster = await getJson(hub, `/api/roster?scope=${SPACE_ID}`)
  return { goal, tasks, pipeline, models, roster }
}

// ------------------------------------------------------------------ verify

/** 递归列文件（相对路径，posix 分隔），跳过 .git 与隔离目录。 */
export function listFiles(root, sub = '') {
  const out = []
  const base = join(root, sub)
  if (!existsSync(base)) return out
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.legion-worktrees' || entry.name === 'node_modules') continue
    const rel = sub ? `${sub}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(root, rel))
    else out.push(rel)
  }
  return out
}

/**
 * 执行夹具/结果仓库声明的测试命令，返回 `{ ok, output }`。
 *
 * 为什么用 `execSync` 而不是 `execFileSync('npm', …)`：
 * Windows 上 `npm` 是 `npm.cmd`，`execFileSync` 不会走 PATHEXT 解析，
 * 直接 `spawnSync npm ENOENT`；`execFileSync('npm.cmd', …)` 又报 `EINVAL`。
 * 只有经由 shell 才能起来。用 `execSync('npm test --silent')` 传整条命令字符串，
 * 既避开了 `shell:true` + 参数数组的转义告警（DEP0190），也是用户手敲时走的同一条路径。
 *
 * 关键：命令与参数都是**本文件写死的常量**，不含任何外部输入，
 * 因此不存在命令注入面。
 *
 * ## 必须清掉 NODE_TEST_CONTEXT
 *
 * 当本函数**在 `node --test` 内部被调用**时（golden-flow.test.mjs 就是这么用的），
 * 外层 runner 会把 `NODE_TEST_CONTEXT` 放进环境变量，子进程一继承它就切换到
 * 「child 上报模式」——把结构化结果投向 stdout，而**不再输出人能读的
 * `ℹ pass 3` 那几行**。于是断言「应报告 3 条通过」会拿到空字符串而失败，
 * 看起来像夹具坏了，其实是采集方式串了台。
 * 清掉它，子进程就按普通 CLI 模式输出。
 */
export function runDeclaredTest(repoDir, { timeoutMs = 120_000 } = {}) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  try {
    const output = execSync('npm test --silent', {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env,
    })
    return { ok: true, output }
  } catch (e) {
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() }
  }
}

/**
 * 在结果仓库上**独立**计算验收契约的四项。
 *
 * 这是本文件的核心：不采信 worker 自述，全部重新测量。
 *   · filesChanged —— 与夹具初始 4 文件对账，列出新增/修改/仍是原样的
 *   · testCommand  —— 固定为 `npm test`（夹具的约定），真实执行
 *   · testPassed   —— 取真实退出码
 *   · readmeUpdated—— README 是否真的写了 greet 用法（大小写不敏感）
 */
export function verifyAcceptance(repoDir, { runTests = true } = {}) {
  const present = listFiles(repoDir)
  const fixturePaths = Object.keys(FIXTURE_FILES).sort()

  const added = present.filter((p) => !fixturePaths.includes(p)).sort()
  const modified = []
  const unchanged = []
  for (const p of fixturePaths) {
    if (!present.includes(p)) { modified.push(`${p} (被删除)`); continue }
    const now = readFileSync(join(repoDir, p), 'utf8')
    if (now.replace(/\r\n/g, '\n') === FIXTURE_FILES[p].replace(/\r\n/g, '\n')) unchanged.push(p)
    else modified.push(p)
  }

  const readmePath = join(repoDir, 'README.md')
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : ''
  const readmeUpdated = /greet/i.test(readme)

  let testPassed = null
  let testOutput = null
  if (runTests) {
    const run = runDeclaredTest(repoDir)
    testPassed = run.ok
    testOutput = run.output
  }

  const filesChanged = [...added, ...modified].sort()
  return {
    filesChanged,
    testCommand: 'npm test',
    testPassed,
    readmeUpdated,
    detail: { added, modified, unchanged, testOutput: testOutput?.slice(0, 2000) ?? null },
    // 四项齐备才算验收通过；testPassed 为 null（未跑）不算通过
    accepted: filesChanged.length > 0 && testPassed === true && readmeUpdated === true,
  }
}

// ------------------------------------------------------------------ report

export async function report({ hub = HUB, repoDir = SCRATCH_DIR } = {}) {
  const st = await status({ hub })
  const acceptance = verifyAcceptance(repoDir)
  return {
    space: SPACE_ID,
    goldenFlow: { id: 'GF-001', task: GOLDEN_TASK.id, title: GOLDEN_TASK.title },
    fixtureHash: fixtureHash(),
    roleModels: ROLE_MODELS,
    pipeline: (st.pipeline?.stages ?? st.pipeline ?? []).map?.((s) => s.role) ?? null,
    goal: st.goal,
    tasks: st.tasks,
    acceptance,
  }
}

// ------------------------------------------------------------------ teardown

export async function teardown({ hub = HUB, log = console.log } = {}) {
  const st = await status({ hub })
  const goals = Array.isArray(st.goal) ? st.goal : (st.goal?.goals ?? [])
  const canceled = []
  for (const g of goals) {
    if (g.status === 'active') {
      await post(hub, '/api/goal/status', { id: g.id, status: 'canceled' })
      canceled.push(g.id)
    }
  }
  log(`已取消目标：${canceled.join(', ') || '（无 active 目标）'}`)
  return { canceled }
}

// ------------------------------------------------------------------ CLI

function usage() {
  console.log('gf001-run.mjs — 黄金流程 GF-001 执行台')
  console.log('  setup [--reset]   建 scratch 仓库 + 空间 + 流水线 + 编队 + 模型')
  console.log('  status            空间/目标/任务/流水线/模型/编队')
  console.log('  verify [--no-test] 独立计算验收四项')
  console.log('  report            证据 JSON')
  console.log('  teardown          取消 active 目标（保留数据）')
  console.log('  publish           发布 GF-001 目标（真实派工入口）')
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const hub = HUB
  if (!cmd || cmd === '--help') return usage()
  if (cmd === 'setup') {
    const out = await setup({ hub, reset: rest.includes('--reset') })
    console.log('\n' + JSON.stringify(out, null, 2))
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await status({ hub }), null, 2))
  } else if (cmd === 'verify') {
    console.log(JSON.stringify(verifyAcceptance(SCRATCH_DIR, { runTests: !rest.includes('--no-test') }), null, 2))
  } else if (cmd === 'report') {
    console.log(JSON.stringify(await report({ hub }), null, 2))
  } else if (cmd === 'teardown') {
    await teardown({ hub })
  } else if (cmd === 'publish') {
    const goal = await post(hub, '/api/goal', {
      scope: SPACE_ID,
      objective: `${GOLDEN_TASK.title}。${GOLDEN_TASK.goal}`,
    })
    console.log(JSON.stringify(goal, null, 2))
  } else {
    console.error(`未知子命令：${cmd}`)
    usage()
    process.exit(2)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
}
