// orchestrator/worker/workspace-wiring.test.mjs
// ============================================================================
// 工作区阶段接入 worker 进程（PRT-306）的用例
//
// `orchestrator/workspace/workspace.test.mjs` 验的是工作区模块本身；
// 这一组验的是**接线**：worker 拿不拿得到工作区阶段、拿不到时会不会静默降级、
// 「没有隔离」这件事在外部的状态文件里看不看得见。
//
// 这三件事各自的失败形态都不报错：
//   - 拿不到阶段却照常认领 → 认领后立刻失败，把重试额度烧光（"任务都在跑但全都失败"）；
//   - 静默降级成原地执行 → Attempt 证据写着有隔离而实际没有；
//   - 状态文件里看不出隔离模式 → 两条任务撞上同一个文件时才发现，而那时已经晚了。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorker, REQUIRED_STAGE_KEYS, inPlaceStages } from './main.mjs'
import { readWorkerEnv, resolveWorkspaceStages, WORKER_ENV } from './run.mjs'
import { WORKSPACE_ERRORS } from '../workspace/index.mjs'

const GIT = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const skipIfNoGit = GIT ? false : '本机没有 git'

let root = ''
let repoDir = ''
let dataDir = ''

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'README.md'), '# r\n', 'utf8')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

test.before(() => {
  root = mkdtempSync(join(tmpdir(), 'legion-ws-wire-'))
  repoDir = join(root, 'repo')
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  makeRepo(repoDir)
})

test.after(() => { rmSync(root, { recursive: true, force: true }) })

test('① 环境里多了 LEGION_WORKSPACE_DIR，且逐字读取（scan 能枚举到）', () => {
  assert.equal(WORKER_ENV.WORKSPACE_DIR, 'LEGION_WORKSPACE_DIR')
  const cfg = readWorkerEnv({ LEGION_WORKSPACE_DIR: '/w' })
  assert.equal(cfg.workspaceDir, '/w')
  assert.equal(readWorkerEnv({}).workspaceDir, null)
})

test('① resolveWorkspaceStages：配了仓库就给出真的阶段；没配就给出**理由**', () => {
  const missing = resolveWorkspaceStages({ workspaceDir: null, dataDir })
  assert.equal(missing.stages, null)
  assert.match(missing.reason, /不自动退回原地执行/)
  assert.match(missing.reason, /inPlaceStages/)

  const ok = resolveWorkspaceStages({ workspaceDir: repoDir, dataDir })
  assert.notEqual(ok.stages, null)
  assert.equal(ok.repoDir, repoDir)
  assert.equal(ok.worktreeBaseDir, join(dataDir, 'worktrees'))
  assert.equal(typeof ok.stages.prepareWorkspace, 'function')
  assert.equal(typeof ok.stages.reclaimAll, 'function')
})

test('① 布局有问题（worktree 基准落在仓库内部）在**解析阶段**就抛错', () => {
  // 提前暴露：不要等到认领了任务、准备到一半才发现布局不合法。
  assert.throws(
    () => resolveWorkspaceStages({ workspaceDir: dataDir, dataDir: join(dataDir, 'inner') }),
    (e) => e.code === WORKSPACE_ERRORS.REF_OVERLAP || e.code === WORKSPACE_ERRORS.REF_NOT_CONFIGURED)
})

test('② 只有 execute 的引擎 + 工作区阶段 → 阶段齐备，可以认领', { skip: skipIfNoGit }, () => {
  // 这是接线要达成的效果：执行引擎只实现 `execute`（那是它的事），
  // 工作区与上下文由 `stages` 补上。
  const resolved = resolveWorkspaceStages({ workspaceDir: repoDir, dataDir })
  const stages = { ...resolved.stages, buildContext: async () => ({ kind: 'minimal' }) }
  const worker = createWorker({
    dataDir, hub: null,
    executor: { execute: async () => ({ outcome: 'completed' }) },
    stages,
  })
  const status = worker.status()
  assert.deepEqual(status.missingStages, [])
  assert.equal(status.stageMode, 'full', '阶段齐备时不得报 incomplete')
  assert.equal(status.workspaceMode, 'enabled')
})

test('② 只有 execute、没有任何工作区阶段 → 明确报缺阶段，**不**认领', () => {
  // 若这里悄悄放行，worker 认领后必然失败（`Leased → Validating` 非法），
  // 表现为"任务都在跑但全都失败"，而重试额度会被烧光。
  const worker = createWorker({ dataDir, hub: null, executor: { execute: async () => ({ outcome: 'completed' }) } })
  const status = worker.status()
  assert.deepEqual(status.missingStages, ['prepareWorkspace', 'buildContext'])
  assert.equal(status.stageMode, 'incomplete')
  assert.notEqual(status.state, 'idle')
})

test('② 显式铺 inPlaceStages() 时阶段齐备，但状态文件里看得出**没有隔离**', async () => {
  // 显式降级是被允许的（它是一个具名的调用点），但"没有隔离"必须可见。
  const worker = createWorker({
    dataDir, hub: null,
    executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) },
  })
  const status = worker.status()
  assert.equal(status.stageMode, 'full')
  // `inPlaceStages()` **显式声明**自己没有隔离，因此这里是 `disabled` 而不是
  // `unknown`：知道的事情不要报成不知道。`unknown` 是给"提供了阶段但没声明"用的。
  assert.equal(status.workspaceMode, 'disabled')
  assert.equal(status.workspaceNote, null)
})

test('③ workspaceNote 被写进状态文件：运维能看到"这个 worker 没有隔离"', () => {
  const note = '未配置 LEGION_WORKSPACE_DIR：没有用户授权的项目目录可检出'
  const worker = createWorker({
    dataDir, hub: null,
    executor: { ...inPlaceStages(), execute: async () => ({ outcome: 'completed' }) },
    workspaceNote: note,
  })
  const status = worker.status()
  assert.equal(status.workspaceMode, 'disabled')
  assert.equal(status.workspaceNote, note)
})

test('③ 状态文件真的落到盘上，且含 workspaceMode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-ws-status-'))
  try {
    const worker = createWorker({
      dataDir: dir, hub: null,
      executor: { execute: async () => ({ outcome: 'completed' }) },
      stages: {
        workspaceIsolation: 'worktree',
        prepareWorkspace: async () => ({ kind: 'worktree' }),
        buildContext: async () => ({ kind: 'minimal' }),
      },
    })
    // tick() 在没有 hub 时会 publish（'hub-unreachable'），状态文件因此落盘。
    // 走真实写盘路径，而不是只断言内存里的对象：这一条问的正是"盘上有没有"。
    await worker.tick()
    const written = JSON.parse(readFileSync(join(dir, 'orchestrator', 'worker.status.json'), 'utf8'))
    assert.equal(written.workspaceMode, 'enabled')
    assert.equal(written.stageMode, 'full')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④ 端到端：认领 → 工作区阶段真的建出 worktree → 执行', { skip: skipIfNoGit }, async () => {
  // 这一条把整条链路走完：hub 是假的（只回答 claim/heartbeat/transition），
  // 工作区是真的。判据是**执行阶段真的跑到了**，而且工作区真的建在
  // dataDir/worktrees 下、意图文件真的落了盘。
  const seen = []
  const transitions = []
  const hub = {
    // 注意契约：`hub.claim()` 返回的是**拆过包**的 claim 本身，
    // 不是 `{ claimed }` 信封（拆包在 createHubClient 里做，见 run.mjs 的说明）。
    // 返回信封时 worker 会报 `claim-protocol-error`——那是对的，它不该猜。
    async claim() {
      return { attemptId: 'att:T-20:1', taskId: 'T-20', leaseEpoch: 1, scope: 'default' }
    },
    async heartbeat() { return { ok: true } },
    async release() { return { ok: true } },
    async transition(req) {
      // 最后的终态提交带的是 `outcome` 而不是 `to`（那是"报告结果"，
      // 不是"推进状态"）。两种都记下来，才能验完整的顺序。
      transitions.push(req.to ?? `outcome:${req.outcome}`)
      return { ok: true }
    },
  }
  const resolved = resolveWorkspaceStages({ workspaceDir: repoDir, dataDir })
  const worker = createWorker({
    dataDir, hub,
    executor: {
      ...resolved.stages,
      buildContext: async () => ({ kind: 'minimal' }),
      async execute(lease) {
        // 执行阶段必须看得到真的仓库内容与一个独立的目录
        seen.push({ taskId: lease.taskId, cwd: resolved.stages.lastSlot() })
        return { outcome: 'completed', detail: 'ok' }
      },
    },
  })
  const r = await worker.tick()
  assert.equal(r.acted, true, JSON.stringify(r))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].taskId, 'T-20')
  // 阶段顺序：先持久化意图（PreparingWorkspace）再做副作用，最后报告结果
  assert.deepEqual(transitions, ['PreparingWorkspace', 'BuildingContext', 'Running', 'outcome:completed'])
  // 工作区真的建出来了（在 dataDir/worktrees 下），并且留下意图文件
  const base = join(dataDir, 'worktrees')
  assert.ok(existsSync(base), 'worktree 基准目录应当存在')
  const intentPath = join(base, 'default', 'T-20', 'att%3AT-20%3A1.intent.json')
  assert.ok(existsSync(intentPath), `意图文件应当在 ${intentPath}`)
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'))
  assert.equal(intent.attemptId, 'att%3AT-20%3A1')
  assert.equal(intent.branch, 'legion/default/T-20/att%3AT-20%3A1')
  // 执行阶段看到的目录就是那个槽位，里面真的有仓库内容
  assert.equal(seen[0].cwd, join(base, 'default', 'T-20', 'att%3AT-20%3A1'))
  assert.ok(existsSync(join(seen[0].cwd, 'README.md')), '执行阶段的工作区里必须有仓库内容')
})
