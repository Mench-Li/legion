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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { FIXTURE_FILES, GOLDEN_TASK, fixtureHash, materializeFixture } from './golden-flow.mjs'
import { collectUsage, defaultSessionsRoot } from './dsh-session-usage.mjs'

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
 * ## 契约文档路径一律用「已登记的槽位名」
 *
 * 目标链上的文档会被守护 `goalize` 到该目标自己的目录（`docs/<goalId>/X.md`），
 * 但 `GOAL_DOC_NAMES` 只认六个槽位名：
 *   REQUIREMENTS / RESEARCH / TASK_BREAKDOWN / TEST_CASES / TEST_REPORT / DEPLOY。
 *
 * 不在这个名单里的名字**不会被改写**。第一次真实执行时我用了 `docs/PLAN.md`，
 * 于是声明的契约路径是 `docs/PLAN.md`，而 planner 按工作空间纪律实际写到
 * `docs/<goalId>/PLAN.md` —— 两者不一致，靠守护的兜底逻辑才没卡住。
 *
 * 这是**我的配置缺陷**，不是工人写错了。改用槽位名（这里取 TASK_BREAKDOWN）
 * 让「声明路径」与「实际落位」由同一套规则推导，不再依赖兜底。
 *
 * ## 为什么 planner 不设人工闸门
 *
 * `gate: true` 的语义是「完成并合入后停在 in_review，等将军验收 done」，
 * 而 `transitionTask` 里 `to === 'done'` 硬性要求 `by === 'general'`——
 * 也就是说 gate 会把黄金流程变成「每一环都要人来点一下」。
 * 我起初设 gate 是想逼出计划书，但**留存计划书靠的是 artifact，不是 gate**；
 * 用 gate 会把一次受控的端到端执行变成人工接力，与「稳定复现」相悖。
 */
export const STAGES = Object.freeze([
  {
    role: 'planner',
    label: '计划',
    prompt:
      '你是「计划士兵」。职责：读懂目标与现有代码，产出**实施计划**，'
      // 必须写**字面量** docs/TASK_BREAKDOWN.md：守护会把提示词里出现的槽位路径
      // 改写成该目标自己的文档目录（docs/<goalId>/TASK_BREAKDOWN.md），
      // 工人据此落位，与契约声明路径由同一套规则推导。
      // 我第一版写的是「写入任务文档目录」而不点名文件，工人自行选了 PLAN.md，
      // 于是契约校验正确地判「docs/<goalId>/TASK_BREAKDOWN.md 缺失」并停在 in_review。
      + '写入 worktree 的 docs/TASK_BREAKDOWN.md（文件名必须就是这个）。'
      + '内容必须包含：(1) 需要改动的文件清单（逐条给出仓库相对路径）；(2) 每个文件改什么；'
      + '(3) 验收步骤（可直接执行的命令 + 期望输出）。不要在本环写业务代码。',
    next: 'implementer',
    gate: 0,
    artifact: 'docs/TASK_BREAKDOWN.md',
    docs: ['docs/TASK_BREAKDOWN.md'],
    sort: 0,
    enabled: 1,
  },
  {
    role: 'implementer',
    label: '实现',
    prompt:
      '你是「实现士兵」。职责：严格按计划书落地代码改动，并补充单元测试与文档。'
      + '改完必须自己先跑一遍测试，把真实命令与真实输出记进 evidence（不要只写「已通过」）。'
      + '注意：验收不只看单元测试，还会把 CLI 当**命令**真的执行一次——'
      + '只加函数而不接通命令行入口的改动会被判为未完成。',
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
      // {taskId} 由守护按任务展开成真实 id，但提示词里必须给出可照抄的例子：
      // 只写占位符时工人有可能把 `{taskId}` 原样当文件名写出去。
      + '写出评审结论到 docs/review/<你的任务ID>-REVIEW.md'
      + '（例如你的任务是 T-143，就写 docs/review/T-143-REVIEW.md）。'
      + '明确给出「通过」或「打回」，打回时必须写明理由与需要修的点。'
      + '评审结论必须能被证据支撑——引用具体文件与具体命令输出，不要只给印象分。',
    next: null,
    gate: 0,
    artifact: 'docs/review/{taskId}-REVIEW.md',
    docs: ['docs/review/{taskId}-REVIEW.md'],
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

export async function getJson(hub, path, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${hub}${path}`)
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
    // 连同 `.legion-worktrees` 一起删。第一版把它们留着，结果新建的 worktree 里
    // 又嵌了一份上一轮的旧 worktree（`T-141/.legion-worktrees/T-138/…`）——
    // 那是上一轮的执行残骸，会让「这次改了什么」无法归因。
    // `.git` 一并删除后，git 的 worktree 元数据也随之一空，不会留下悬空登记。
    for (const name of readdirSync(dir)) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
    log(`已重置 scratch 仓库：${dir}（含 .legion-worktrees）`)
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

// ------------------------------------------------------------------ 会话残骸

/**
 * 把 `homedir`（cwd）在 `$DSH_HOME/sessions` 下的会话目录名还原出来。
 *
 * 目录命名规则（实测）：把路径里**连续的非字母数字字符整体**换成单个 `-`，
 * 两侧再各加 `--`。
 *   `D:\project\DSH\gf001-scratch` → `--D-project-DSH-gf001-scratch--`
 *
 * 注意是「连续的一段换一个 `-`」而不是「每个字符换一个 `-`」：后者会得到
 * `--D---project--DSH--gf001-scratch--`（`:` 与 `\` 各算一次），对不上真实目录名。
 * 这个差别一开始就被我写错了，靠对照真实目录名才发现——所以下面有单测钉住它。
 */
export function sessionDirName(cwd) {
  return `--${String(cwd).replace(/[^A-Za-z0-9]+/g, '-')}--`
}

/**
 * 清理本空间（及其 worktree）遗留的 foreman 会话目录，移到备份区而非删除。
 *
 * ## 为什么必须做这件事：这是一个已知的生产缺陷的绕行
 *
 * 守护的 `ensureForeman(cwd)` 用 `hashStr(cwd)` 生成**固定** sessionId，而创建子会话时，
 * 磁盘上已存在同 id 会话会让它抛 `SessionAlreadyExistsError`。
 * 进程重启后内存 Map 清零，磁盘上的旧会话却还在 → 该 cwd 的 foreman
 * **永远建不起来**，而调用点的处置是「本轮跳过派工」→ 整个守护永久停摆。
 *
 * 实证两次：2026-09-11 `software` 空间因此停摆 3 小时 18 分（324 次连续失败）；
 * 本次黄金流程第二次 setup 时 `gf001-scratch` 根目录再现同一现象。
 *
 * 根因在 `plugins/src/index.ts` 的 `ensureForeman`（缺少「已存在则复用/清理」分支），
 * 属于插件缺陷，**不在本工具职责内**。本工具只做自己空间内的清理，
 * 让重复 setup 可幂等——并且**移到备份目录而不是删掉**，
 * 因为「残骸本身」正是上面那条结论的证据。
 *
 * @returns {{moved: string[], dirs: string[]}}
 */
export function clearStaleForemanSessions({ cwd = SCRATCH_DIR, home = process.env.DSH_HOME ?? join(homedir(), '.dsh'), log = console.log } = {}) {
  const sessionsRoot = join(home, 'sessions')
  if (!existsSync(sessionsRoot)) return { moved: [], dirs: [] }

  // 目标是本空间根目录 + 它下面的每个 worktree，各自都可能留下 foreman 会话
  const dirs = readdirSync(sessionsRoot).filter((name) => {
    const base = sessionDirName(cwd)
    return name === base || name.startsWith(`${base.slice(0, -2)}-`)
  })

  const backup = join(home, '.stale-session-backup', `gf001-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const moved = []
  for (const dir of dirs) {
    const full = join(sessionsRoot, dir)
    for (const entry of readdirSync(full)) {
      if (!/^scrum-(worker|mediator)-foreman-/.test(entry)) continue
      const dest = join(backup, dir)
      mkdirSync(dest, { recursive: true })
      try {
        renameSync(join(full, entry), join(dest, entry))
        moved.push(`${dir}/${entry}`)
      } catch (err) {
        log(`  ⚠ 无法移出会话残骸 ${dir}/${entry}：${err.message}（不影响本次 setup）`)
      }
    }
  }
  if (moved.length > 0) {
    log(`已移出 ${moved.length} 个遗留 foreman 会话（备份于 ${backup}）`)
    for (const m of moved) log(`  · ${m}`)
  }
  return { moved, dirs }
}

// ------------------------------------------------------------------ setup

export async function setup({ hub = HUB, reset = false, log = console.log } = {}) {
  const steps = []

  // 0) 清掉本空间遗留的 foreman 会话（见 clearStaleForemanSessions 的说明：
  //    守护无法自行从磁盘残骸中恢复，重复 setup 前必须由我们移开）
  const cleared = clearStaleForemanSessions({ log })
  steps.push({ step: 'stale-sessions', ok: true, moved: cleared.moved.length })

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

export async function status({ hub = HUB, fetchImpl = fetch } = {}) {
  const goal = await getJson(hub, `/api/goal?scope=${SPACE_ID}`, { fetchImpl })
  const tasks = await getJson(hub, `/api/board?scope=${SPACE_ID}`, { fetchImpl })
  const pipeline = await getJson(hub, `/api/pipeline?scope=${SPACE_ID}`, { fetchImpl })
  const models = await getJson(hub, '/api/models?scope=' + SPACE_ID, { fetchImpl })
  const roster = await getJson(hub, `/api/roster?scope=${SPACE_ID}`, { fetchImpl })
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
 * 把 CLI 当**命令**跑一次（而不是 import 它的函数），返回 `{ ok, out, code }`。
 *
 * 为什么必须有这一条：夹具曾经有一个入口判据缺陷——
 *   if (import.meta.url === `file://${argv[1]}`)
 * 在 Windows 上恒不成立（`file:///D:/…` vs `file://D:\…`），于是
 * `node src/cli.mjs --version` **退出码 0 且没有任何输出**。
 *
 * 而单元测试是 `import { main }` 直接调函数，**完全看不到**这个问题；
 * 验收四项（filesChanged / testCommand / testPassed / readmeUpdated）
 * 也全部能被「只加函数、不改入口」的改动满足。
 * 结果就是：验收全绿，而用户真正敲的那个命令什么都不打印——
 * 正是 spec 禁止的「看起来做完了」。
 *
 * 所以验收必须包含一次**用户视角**的调用。命令与参数写死在本文件，
 * 不含外部输入。
 */
export function runCli(repoDir, args, { timeoutMs = 30_000 } = {}) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  try {
    const out = execFileSync(process.execPath, ['src/cli.mjs', ...args], {
      cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env,
    })
    return { ok: true, out, code: 0 }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? null }
  }
}

/**
 * 独立验收：CLI 真实可用的四项检查。
 *
 * 全部是**用户视角**的机器可判定项：
 *   · greet 正常路径真的打印 `Hello, <name>!` 且退出码 0
 *   · 缺名字时退出码非 0（不能静默成功）
 *   · 既有 `--version` 未被破坏（回归）
 *   · `help` 输出里出现了新子命令（用户能发现它）
 */
export function verifyCliBehavior(repoDir) {
  const cases = []

  const greet = runCli(repoDir, ['greet', 'World'])
  cases.push({
    name: 'greet 打印 Hello, World! 且退出码 0',
    ok: greet.ok && greet.out.trim() === 'Hello, World!',
    actual: { code: greet.code, out: greet.out.trim() },
    expected: { code: 0, out: 'Hello, World!' },
  })

  const noName = runCli(repoDir, ['greet'])
  cases.push({
    name: 'greet 缺少 <name> 时以非 0 退出（不得静默成功）',
    ok: !noName.ok && noName.code !== 0,
    actual: { code: noName.code, out: noName.out.trim() },
    expected: { code: '非 0', out: '（任意提示）' },
  })

  const version = runCli(repoDir, ['--version'])
  cases.push({
    name: '既有 --version 未被破坏（回归）',
    ok: version.ok && version.out.trim() === '1.0.0',
    actual: { code: version.code, out: version.out.trim() },
    expected: { code: 0, out: '1.0.0' },
  })

  const help = runCli(repoDir, ['help'])
  cases.push({
    name: 'help 输出里能发现 greet（用户可发现性）',
    ok: help.ok && /greet/i.test(help.out),
    actual: { code: help.code, out: help.out.trim().slice(0, 200) },
    expected: { code: 0, out: '含 greet' },
  })

  return { cases, allPassed: cases.every((c) => c.ok) }
}

/**
 * 在结果仓库上**独立**计算验收契约的四项。
 *
 * 这是本文件的核心：不采信 worker 自述，全部重新测量。
 *   · filesChanged —— 与夹具初始 4 文件对账，列出新增/修改/仍是原样的
 *   · testCommand  —— 固定为 `npm test`（夹具的约定），真实执行
 *   · testPassed   —— 取真实退出码
 *   · readmeUpdated—— README 是否真的写了 greet 用法（大小写不敏感）
 *
 * 另附 `cli` 段：用户视角的 CLI 行为检查。它不是锦上添花——
 * 只有单元测试通过这一层，是**看不出入口根本没被执行**的（见 runCli 注释）。
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

  // CLI 行为检查只在真的跑了测试时做（它是「验收入口」的一部分，
  // 与 testPassed 同一次测量里取值，避免 --no-test 变成「跳过一切验证」）。
  const cli = runTests ? verifyCliBehavior(repoDir) : null

  const filesChanged = [...added, ...modified].sort()
  return {
    filesChanged,
    testCommand: 'npm test',
    testPassed,
    readmeUpdated,
    cli,
    detail: { added, modified, unchanged, testOutput: testOutput?.slice(0, 2000) ?? null },
    // 五项齐备才算验收通过；testPassed 为 null（未跑）不算通过。
    // cli 项是本轮补上的：少了它，「函数对了但命令没输出」这种交付会全绿放行。
    accepted: filesChanged.length > 0 && testPassed === true && readmeUpdated === true
      && cli !== null && cli.allPassed,
  }
}

// ------------------------------------------------------------------ 执行证据（PRT-009）

/**
 * 把 DSH 会话挂到本目标的岗位上。
 *
 * 归属靠**会话的 cwd 末段 = 任务 id**（隔离模式下每个任务一个 worktree，实测成立）。
 * 不用会话目录名推断：目录名是 cwd 折叠出来的、有损，且不携带任务 id。
 *
 * ## 为什么每个任务会有**两个**会话
 *
 * 实测：每个岗位任务下同时存在两条会话转录——
 *
 *   · `scrum-worker-foreman-<n>`：派工用的**工头**会话，存活约 200ms，**0 token**；
 *   · 一条 UUID 会话：真正干活的 worker，带全部 token。
 *
 * 若按任务分组后不过滤，同一份用量会被算两遍（工头那份是 0，加 0 不影响总和，
 * 但 `runs` 会翻倍、`attachedToRole` 会虚高，读的人会以为跑了六轮）。
 * 这里按 `tokens.reportedTotal` 取**最大的一条**作为该任务的主会话，
 * 其余保留在 `supersededSessions` 里——**丢弃与隐藏是两回事**：
 * 万一哪天工头也开始计费，这个字段就是发现它的地方。
 */
export function roleRunsForGoal({ tasks, sessions }) {
  const byId = new Map((tasks ?? []).map((t) => [String(t.id), t]))

  const unassigned = []
  const byTask = new Map()
  for (const s of sessions ?? []) {
    const taskId = String(s.cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? null
    const task = taskId === null ? null : byId.get(taskId) ?? null
    const entry = {
      taskId,
      role: task?.role ?? null,
      taskStatus: task?.status ?? null,
      sessionId: s.sessionId,
      // 会话里可能记到多个模型（重试/降级），逐个列出而不是只取第一个。
      models: s.models,
      model: s.models[0] ?? null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      tokens: s.tokens,
      sandboxMode: s.sandboxMode,
      approvalPolicy: s.approvalPolicy,
      assistantMessages: s.counts?.assistantMessages ?? null,
      steps: s.counts?.steps ?? null,
    }
    if (task === null) { unassigned.push(entry); continue }
    if (!byTask.has(taskId)) byTask.set(taskId, [])
    byTask.get(taskId).push(entry)
  }

  const runs = [...byTask.values()].map((group) => {
    const sorted = [...group].sort((a, b) => (b.tokens.reportedTotal ?? 0) - (a.tokens.reportedTotal ?? 0))
    const [primary, ...rest] = sorted
    primary.supersededSessions = rest.map((r) => ({
      sessionId: r.sessionId,
      reportedTotal: r.tokens.reportedTotal,
      durationMs: r.durationMs,
    }))
    return primary
  })

  // 挂不上任务的会话不丢弃，但排到后面并保留 role=null，便于发现「多出来的会话」
  return [...runs, ...unassigned]
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
}

/**
 * 配置的岗位模型 vs 实际执行模型。
 *
 * ## 为什么要专门查这件事
 *
 * 流水线阶段声明 planner/reviewer 用 pro、implementer 用 flash，但**声明不等于生效**：
 * 2026-09-11 的黄金流程里守护派工走的是**全局默认模型服务**（`agentDefaultModel`），
 * `agent_models` 表里的按岗位模型只在聊天回帖路径上被读。
 * 结果三轮全部落在 `deepseek-v4-flash-openai` 上——**配置写着 pro，实际跑的是 flash**。
 *
 * （这里刻意不写 `ctx` 点号访问的原文：`scripts/ci/dsh-boundary.mjs` 的执行面棘轮
 * 是**纯文本**匹配，注释里出现那个记号也会被记成一处违规。本文件是 Tier-0 脚本，
 * 不该为了说明一句话而在基线里开口子。）
 *
 * 这类偏差不会报错、不会失败，只会让「按岗位分配模型」这件事看起来已经做好了。
 * 所以把它做成机器可判定的对拍，而不是靠人去比对配置文件。
 */
export function detectModelDrift(runs, roleModels = ROLE_MODELS) {
  const drift = []
  for (const run of runs ?? []) {
    if (run.role === null || run.role === undefined) continue
    const configured = roleModels[run.role]
    if (configured === undefined) continue
    if (run.model !== configured.model) {
      drift.push({
        role: run.role,
        taskId: run.taskId,
        sessionId: run.sessionId,
        configured: `${configured.provider}/${configured.model}`,
        actual: run.model === null ? '(会话未记录模型)' : run.model,
      })
    }
  }
  return drift
}

/** 目标级端到端耗时：createdAt → endedAt（未结束则为 null，不猜）。 */
export function goalLatencyMs(goal) {
  const a = Date.parse(goal?.createdAt ?? '')
  const b = Date.parse(goal?.endedAt ?? '')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.max(0, b - a)
}

/** 任务级耗时的来源：看板的 claimedAt → updatedAt（与 audit 的 claim→advance 同源）。 */
export function taskLatencyMs(task) {
  const a = Date.parse(task?.claimedAt ?? '')
  const b = Date.parse(task?.updatedAt ?? '')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.max(0, b - a)
}

/**
 * 组装本次真实执行的证据（PRT-009 的成本 / 延迟 / 资源三项里，前两项在这里落地）。
 *
 * 口径与边界：
 *   · token 来自 provider 上报的 usage，**不是估算**；
 *   · 费用**不在这里算**——单价未定（见 baseline-measure.mjs 的 PRICING），
 *     在这里凭空换算等于把「没有单价」这件事掩盖成「成本已知」；
 *   · 资源（峰值内存/CPU）**不在会话转录里**，因此不在这里编：
 *     它仍是 PRT-009 的未采集项（理由见证据文档）。
 */
export async function executionEvidence({ hub = HUB, goalId = null, sessionsRoot = defaultSessionsRoot(), fetchImpl = fetch } = {}) {
  const st = await status({ hub, fetchImpl })
  const goals = Array.isArray(st.goal) ? st.goal : (st.goal?.goals ?? [])
  const allTasks = Array.isArray(st.tasks) ? st.tasks : (st.tasks?.tasks ?? [])

  // 默认取最近一个**已完成**的目标：待采集的是「一次跑通了的执行」。
  const sorted = [...goals].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  const goal = goalId !== null
    ? sorted.find((g) => g.id === goalId) ?? null
    : sorted.find((g) => g.status === 'done') ?? sorted[0] ?? null

  const tasks = goal === null ? [] : allTasks.filter((t) => t.goalId === goal.id)
  const taskIds = new Set(tasks.map((t) => String(t.id)))

  // `requireUsage: false` —— 把 **0 token 的工头会话也读进来**，这样它们会以
  // `supersededSessions` 的形式出现在证据里。用默认值（只收有 usage 的会话）会让
  // 「每个任务有两条会话」这个事实在证据中完全消失，而它正是「别把用量算两遍」的依据。
  const usage = collectUsage({ sessionsRoot, cwdPrefix: SCRATCH_DIR, requireUsage: false })
  // 只保留属于本目标的会话：同一空间可能跑过多次（含失败的），混在一起会污染基线。
  const sessions = usage.sessions.filter((s) => {
    const taskId = String(s.cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
    return taskIds.has(taskId)
  })

  const runs = roleRunsForGoal({ tasks, sessions })
  const totals = runs.reduce(
    (acc, r) => {
      acc.input += r.tokens.input
      acc.output += r.tokens.output
      acc.cacheRead += r.tokens.cacheRead
      acc.reportedTotal += r.tokens.reportedTotal
      acc.durationMs += r.durationMs ?? 0
      return acc
    },
    { input: 0, output: 0, cacheRead: 0, reportedTotal: 0, durationMs: 0 },
  )

  return {
    $comment: '黄金流程真实执行证据（由 scripts/prt/gf001-run.mjs report 生成）。token 为 provider 上报值，非估算。',
    generatedAt: new Date().toISOString(),
    goal: goal === null
      ? null
      : {
        id: goal.id,
        status: goal.status,
        createdAt: goal.createdAt ?? null,
        endedAt: goal.endedAt ?? null,
        latencyMs: goalLatencyMs(goal),
        done: goal.done ?? null,
        total: goal.total ?? null,
      },
    // 分开报而不是合成一个 `sessions` 总数：本空间跑过几次、其中几次属于本目标、
    // 几次真挂上了岗位、又有几次因为同任务已有主会话而被合并——合成一个数会让人
    // 以为「同一空间的所有会话都是本轮证据」。
    sessions: {
      scannedFiles: usage.scannedFiles,
      inSpace: usage.sessions.length,
      inGoal: sessions.length,
      attachedToRole: runs.filter((r) => r.role !== null).length,
      // 同一任务下被主会话覆盖的次会话（实测是 0 token 的派工工头会话）。
      superseded: runs.reduce((n, r) => n + (r.supersededSessions?.length ?? 0), 0),
      // 挂不上本目标任何任务的会话：不丢，作为「空间里还有别的轮次」的痕迹。
      unattached: runs.filter((r) => r.role === null).length,
    },
    runs,
    totals,
    taskLatencies: tasks.map((t) => ({ taskId: t.id, role: t.role, status: t.status, latencyMs: taskLatencyMs(t) })),
    modelDrift: detectModelDrift(runs),
    notRecorded: [
      {
        key: 'peak-resource',
        why: 'DSH 会话转录不记录进程内存/CPU；需要执行期外部采样，见 docs/PRT-009-evidence/verify-evidence.md',
      },
      {
        key: 'estimated-cost',
        why: 'token 已采集，但无**有来源**的单价（PRICING.asOf = UNSET）；估算公式在 baseline-measure.mjs::estimateCost',
      },
    ],
  }
}

// ------------------------------------------------------------------ report

export async function report({ hub = HUB, repoDir = SCRATCH_DIR, goalId = null, sessionsRoot = defaultSessionsRoot(), runTests = true, fetchImpl = fetch } = {}) {
  const st = await status({ hub, fetchImpl })
  const acceptance = verifyAcceptance(repoDir, { runTests })
  const execution = await executionEvidence({ hub, goalId, sessionsRoot, fetchImpl })
  return {
    space: SPACE_ID,
    goldenFlow: { id: 'GF-001', task: GOLDEN_TASK.id, title: GOLDEN_TASK.title },
    fixtureHash: fixtureHash(),
    roleModelsConfigured: ROLE_MODELS,
    pipeline: (st.pipeline?.stages ?? st.pipeline ?? []).map?.((s) => s.role) ?? null,
    // 只留**本次目标**的投影。整块看板里有别的目标、别的轮次与大量运行时字段，
    // 抄进证据文件只会让它变成一份「当时看板长什么样」的噪音快照。
    goal: execution.goal,
    tasks: execution.taskLatencies,
    acceptance,
    execution,
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

// ------------------------------------------------------------------ wait

/**
 * 轮询到**当前目标**的任务链全部进入终态（done / canceled）为止。
 *
 * 刻意**不**把采样写进文件：证据已经在 team-hub 的 `audit` 表里（带 seq 与时间戳，
 * 由生产进程自己写），再抄一份出来只会多一份可能与源不一致的副本。
 * 本函数只负责「什么时候可以开始分析」，不负责「记录」。
 *
 * ## 为什么必须按目标过滤，而不是看全部任务
 *
 * 第一版判定的是「本空间所有任务都终态」。这在重复执行时**永不返回**：
 * 上一轮被中断的链会留下一条停在 `in_review` 的任务（如 T-141），
 * 于是即使本轮三环全部 `done`，整体条件依然为假 —— 等待器会一直转到超时。
 * 这个错误只在「跑过第二次」时才出现，第一次执行看不出问题。
 */
export async function waitForCompletion({ hub = HUB, timeoutMs = 7_200_000, intervalMs = 60_000, log = console.log, fetchImpl = fetch } = {}) {
  const start = Date.now()
  for (;;) {
    // 取本空间**最新**的目标（按 createdAt），只看属于它的任务。
    // 目标被取消（canceled）时它的任务不会继续流转，转而取上一个。
    const goalsRes = await getJson(hub, `/api/goal?scope=${SPACE_ID}`, { fetchImpl })
    const goals = (Array.isArray(goalsRes) ? goalsRes : (goalsRes.goals ?? []))
      .filter((g) => g.status !== 'canceled')
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    const goal = goals[0] ?? null

    const st = await status({ hub, fetchImpl })
    const all = Array.isArray(st.tasks) ? st.tasks : (st.tasks?.tasks ?? [])
    const tasks = goal ? all.filter((t) => t.goalId === goal.id) : all

    const line = tasks.map((t) => `${t.id}=${t.status}`).join(' ')
    const terminal = tasks.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'canceled')
    const mins = ((Date.now() - start) / 60_000).toFixed(1)
    log(`[+${mins}min] ${goal?.id ?? '(无目标)'} ${line}${terminal ? '  ← 全部终态' : ''}`)
    if (terminal) return { goalId: goal.id, tasks, elapsedMs: Date.now() - start, terminal: true }
    if (Date.now() - start > timeoutMs) return { goalId: goal?.id ?? null, tasks, elapsedMs: Date.now() - start, timedOut: true }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// ------------------------------------------------------------------ CLI

function usage() {
  console.log('gf001-run.mjs — 黄金流程 GF-001 执行台')
  console.log('  setup [--reset]   建 scratch 仓库 + 空间 + 流水线 + 编队 + 模型')
  console.log('  status            空间/目标/任务/流水线/模型/编队')
  console.log('  verify [--no-test] 独立计算验收四项（+ CLI 行为）')
  console.log('  report [--out=<path>] [--goal=<id>] [--no-test]')
  console.log('                    证据 JSON：独立验收 + 真实执行用量/耗时（PRT-009）')
  console.log('  teardown          取消 active 目标（保留数据）')
  console.log('  publish           发布 GF-001 目标（真实派工入口）')
  console.log('  wait              轮询到任务链全部终态')
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const arg = (name, fallback = null) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
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
    const out = await report({
      hub,
      goalId: arg('goal'),
      sessionsRoot: arg('sessions-root', defaultSessionsRoot()),
      runTests: !rest.includes('--no-test'),
    })
    const text = JSON.stringify(out, null, 2)
    const outPath = arg('out')
    if (outPath) {
      writeFileSync(outPath, `${text}\n`, 'utf8')
      console.log(`已写入 ${outPath}`)
    } else {
      console.log(text)
    }
  } else if (cmd === 'teardown') {
    await teardown({ hub })
  } else if (cmd === 'publish') {
    const goal = await post(hub, '/api/goal', {
      scope: SPACE_ID,
      objective: `${GOLDEN_TASK.title}。${GOLDEN_TASK.goal}`,
    })
    console.log(JSON.stringify(goal, null, 2))
  } else if (cmd === 'wait') {
    const out = await waitForCompletion({ hub })
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.error(`未知子命令：${cmd}`)
    usage()
    process.exit(2)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
}
