#!/usr/bin/env node
// team-hub/scripts/f1-guard-drill.mjs
// ============================================================================
// F1 · **真实守护**四态演练（隔离环境：临时库 + 临时仓库 + 临时 hub）
//
//   node team-hub/scripts/f1-guard-drill.mjs setup      # 建临时仓库/库/空间，起临时 hub，打印要装的 bundle
//   node team-hub/scripts/f1-guard-drill.mjs create     # 造一条 drill 任务（要求 worker 报 dropped）
//   node team-hub/scripts/f1-guard-drill.mjs observe    # 轮询到落定，打印 F1 判定
//   node team-hub/scripts/f1-guard-drill.mjs teardown   # 停 hub、删临时目录
//
// 为什么必须隔离：这个演练要真的派一个 agent 出去干活。让它跑在真实仓库上，
// 就等于为了验证"失败时不要打扰人"，先在你仓库里制造一次真实的失败。
//
// ★ 守护本身**不在这里启动**——它是 DSH 插件，只能在宿主进程里跑。
//   setup 会打印一段 bundle，装进 profile 后守护就来连这个临时 hub。
//
// ★ 两处口径（2026-11-09 实测修正，见 docs/design/2026-11-09-f1-live-drill-evidence.md）：
//   ① `activity()` 落**本地 JSONL**（`<scrumDir>/activity.jsonl`），不是 hub 的 audit 表；
//   ② "不打扰人"要排除**派工播报**（🟢 已派 AI worker…），那是开工通知不是报告。
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(tmpdir(), 'legion-f1')
const ENV_FILE = join(ROOT, 'env.json')
const HUB_PID_FILE = join(ROOT, 'hub.pid')
const SCOPE = 'drill'
const toPosix = (p) => String(p).replace(/\\/g, '/')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readEnv = () => JSON.parse(readFileSync(ENV_FILE, 'utf8'))

async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}

async function cmdSetup() {
  rmSync(ROOT, { recursive: true, force: true })
  const repo = join(ROOT, 'repo')
  const scrum = join(ROOT, 'scrum')
  mkdirSync(repo, { recursive: true })
  mkdirSync(scrum, { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# drill repo\n\n这个仓库只用于 F1 演练，agent 只会写这里。\n')
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=drill@local', '-c', 'user.name=drill', 'commit', '-qm', 'drill: init']]) {
    const p = spawn('git', args, { cwd: repo, stdio: 'ignore' })
    await new Promise((r) => p.on('exit', r))
  }

  const dbPath = join(ROOT, 'team.db')
  const port = 18600 + Math.floor(Math.random() * 300)
  const base = `http://127.0.0.1:${port}`
  const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, TEAM_HUB_DB: dbPath, TEAM_HUB_PORT: String(port) },
    stdio: 'ignore', detached: true,
  })
  child.unref()
  writeFileSync(HUB_PID_FILE, String(child.pid))

  let ready = false
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/config`); if (r.status < 500) { ready = true; break } } catch { /* 未就绪 */ }
    await sleep(200)
  }
  if (!ready) throw new Error(`临时 hub 未就绪（port=${port}）`)

  // 空间 = spaces（清单 + localDir → 守护把工作区绑到这里）+ space_runtime（开通执行）+ space_stages（流水线）
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('INSERT OR REPLACE INTO spaces (id, name, local_dir, remote_url, scene_preset) VALUES (?,?,?,?,?)')
      .run(SCOPE, 'F1 演练空间', repo, '', 'office')
    db.prepare('INSERT OR REPLACE INTO space_runtime (scope, enabled, maxWorkers, isolate) VALUES (?,?,?,?)')
      .run(SCOPE, 1, 1, 1)
    const stage = db.prepare('INSERT OR REPLACE INTO space_stages (scope, role, label, prompt, next, gate, enabled, sort) VALUES (?,?,?,?,?,?,?,?)')
    stage.run(SCOPE, 'coder', '编码', '', 'reviewer', 0, 1, 0)
    stage.run(SCOPE, 'reviewer', '复核', '', null, 0, 1, 1)
    db.prepare('INSERT OR REPLACE INTO roster (scope, role, name, kind, avatar) VALUES (?,?,?,?,?)')
      .run(SCOPE, 'coder', '演练编码兵', 'agent', '🤖')
  } finally { db.close() }

  writeFileSync(ENV_FILE, JSON.stringify({ port, base, dbPath, repo, scrum, scope: SCOPE }, null, 2))
  const spaces = await api(base, 'GET', '/api/spaces')
  const pipeline = await api(base, 'GET', `/api/pipeline?scope=${SCOPE}&include=active`)

  process.stdout.write(`临时 hub : ${base}\n`)
  process.stdout.write(`空间     : ${JSON.stringify((spaces.body?.spaces ?? []).map((s) => ({ id: s.id, localDir: s.localDir ?? s.local_dir })))}\n`)
  process.stdout.write(`执行开通 : ${pipeline.body?.runtime?.enabled}  阶段: ${JSON.stringify(pipeline.body?.activeRoles)}\n\n`)
  process.stdout.write('把这段装进 profile（本次演练唯一改环境的地方，装完用 remove_bundle 撤销）：\n\n')
  process.stdout.write(`- insert:
    - id: legion-scrum-worker-drill
      name: '@dsh-external/dsh-scrum-worker'
      config:
        role: 'soldier-auto'
        intervalMs: 5000
        maxWorkers: 1
        workerTimeoutMs: 600000
        staleMinutes: 15
        provider: 'spawn'
        agentPreset: 'ptc'
        scrumDir: '${toPosix(scrum)}'
        workspace: '${toPosix(ROOT)}'
        isolate: true
        repoRoot: '${toPosix(repo)}'
        worktreeRoot: ''
        denyTools: []
        rolesFile: ''
        logFile: '${toPosix(join(ROOT, 'drill-worker.log'))}'
        hubUrl: '${base}'
        hubToken: ''
        scope: '${SCOPE}'
        scopes: ['${SCOPE}']
        primaryScope: '${SCOPE}'
        mediateMergeFails: false
`)
}

async function cmdCreate() {
  const env = readEnv()
  const variant = process.argv[3] === 'waiting' ? 'waiting' : 'dropped'
  const brief = variant === 'waiting'
    // waiting：要它明确"在等人工决定"，不要它自己猜着往下做
    ? '这是一次能力演练，不需要改任何代码。请直接上报 status=waiting、wait_for=human-decision，summary 写"演练：等待人工决定"。不要调用任何写入工具。'
    : '这是一次能力演练，不需要改任何代码。请直接上报 status=dropped（无需处理），summary 写"演练：超出范围"。不要调用任何写入工具。'
  const created = await api(env.base, 'POST', '/api/create', {
    title: `drill-F1-${variant}`, by: 'general', scope: env.scope, body: brief,
  })
  if (created.status !== 200) { process.stdout.write(`建任务失败：${JSON.stringify(created.body)}\n`); process.exitCode = 1; return }
  const id = created.body.task.id
  // 流水线模式下没有 role 的任务不会被派工（stageOf undefined 直接跳过）
  const dbw = new DatabaseSync(env.dbPath)
  try { dbw.prepare("UPDATE tasks SET role='coder' WHERE id=?").run(id) } finally { dbw.close() }
  await api(env.base, 'POST', '/api/transition', { id, to: 'todo', by: 'general', scope: env.scope })
  writeFileSync(ENV_FILE, JSON.stringify({ ...env, taskId: id, variant }, null, 2))
  process.stdout.write(`已建任务 ${id}（role=coder）并置 todo，空间 ${env.scope}\n`)
}

/** 读守护的本地活动流（`activity()` 的落点）。 */
function readActivity(env, taskId) {
  const file = join(env.scrum, 'activity.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { const row = JSON.parse(line); return row && row.taskId === taskId ? [row] : [] } catch { return [] }
  })
}

async function cmdObserve({ timeoutMs = 12 * 60 * 1000 } = {}) {
  const env = readEnv()
  const id = env.taskId
  if (!id) throw new Error('先跑 create')
  const deadline = Date.now() + timeoutMs
  let last = null
  const db = new DatabaseSync(env.dbPath, { readOnly: true })
  try {
    while (Date.now() < deadline) {
      const t = db.prepare('SELECT status, soldier, claimedAt FROM tasks WHERE id=?').get(id)
      const allComments = db.prepare("SELECT COUNT(*) AS c FROM task_input WHERE task_id=? AND kind='comment'").get(id)?.c
      const reportComments = db.prepare(`SELECT COUNT(*) AS c FROM task_input
        WHERE task_id=? AND kind='comment' AND (body LIKE '%无需处理%' OR body LIKE '%canceled%')`).get(id)?.c
      const transitions = db.prepare("SELECT ts, detail FROM audit WHERE taskId=? AND action='transition' ORDER BY seq").all(id)
      const activity = readActivity(env, id)
      last = {
        status: t?.status,
        comments: Number(allComments ?? 0),
        reportComments: Number(reportComments ?? 0),
        dropActivity: activity.filter((a) => a.kind === 'drop').map((a) => a.text),
        reportActivity: activity.filter((a) => a.kind === 'report').map((a) => a.text),
        transitions,
        claimAt: activity.find((a) => a.kind === 'claim')?.ts ?? null,
        dropAt: activity.find((a) => a.kind === 'drop')?.ts ?? null,
      }
      const terminal = ['canceled', 'in_review', 'done', 'blocked'].includes(String(t?.status))
      // waiting 不产生终态，等到 report 痕迹就算落定；dropped 要等终态 + drop 痕迹
      const waitingSettled = last.reportActivity.length > 0
      if ((terminal && last.dropActivity.length > 0) || waitingSettled) break
      await sleep(2000)
    }
  } finally { db.close() }

  const variant = env.variant === 'waiting' ? 'waiting' : 'dropped'
  const noComment = last?.reportComments === 0
  // dropped ⇒ 终态 canceled + drop 痕迹；waiting ⇒ **留在 in_progress、不迁移** + report 痕迹
  // waiting 的关键不是「多久之后还停在 in_progress」（stale 回收会把它放回 todo），
  // 而是**报告那一刻没有引发迁移**：claim 之后不应出现任何 transition。
  const claimAt = last?.claimAt ?? null
  const movedAfterClaim = (last?.transitions ?? []).filter((row) => claimAt === null || String(row.ts) >= String(claimAt))
  const pass = variant === 'waiting'
    ? ((last?.reportActivity?.length ?? 0) > 0 && noComment && movedAfterClaim.length === 0)
    : (last?.status === 'canceled' && (last?.dropActivity?.length ?? 0) > 0 && noComment)
  process.stdout.write('\n=== F1 判定 ===\n')
  process.stdout.write(`落定状态     : ${last?.status}（期望 ${variant === 'waiting' ? 'in_progress（不迁移）' : 'canceled（无需处理）'}）\n`)
  process.stdout.write(`报告评论     : ${last?.reportComments} 条（期望 0 = 不打扰人；另有 ${last?.comments} 条含派工播报）\n`)
  process.stdout.write(`report 活动痕迹: ${JSON.stringify(last?.reportActivity ?? [])}（本地活动流）\n`)
  process.stdout.write(`时间线       : claim ${last?.claimAt ?? '—'} → drop ${last?.dropAt ?? '—'}\n`)
  process.stdout.write(`\n${pass ? 'PASS' : 'FAIL'}  ${variant === 'waiting' ? 'waiting ⇒ 留在 in_progress、零报告评论、有 report 痕迹' : 'dropped ⇒ 落 canceled、零报告评论、有 drop 痕迹'}\n`)
  if (!pass) process.stdout.write('（状态一直不动：守护没接管该空间，先看临时 drill-worker.log）\n')
  process.exitCode = pass ? 0 : 1
}

function cmdTeardown() {
  try {
    const pid = Number(readFileSync(HUB_PID_FILE, 'utf8').trim())
    if (Number.isFinite(pid) && pid > 0) { try { process.kill(pid) } catch { /* 已退出 */ } }
  } catch { /* 没起过 */ }
  try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* 文件被占用时留给人看 */ }
  process.stdout.write(`已清理临时环境（${ROOT} 存在=${existsSync(ROOT)}）\n`)
}

const table = { setup: cmdSetup, create: cmdCreate, observe: cmdObserve, teardown: cmdTeardown }
const sub = process.argv[2]
if (!table[sub]) {
  process.stdout.write('用法: node team-hub/scripts/f1-guard-drill.mjs <setup|create|observe|teardown>\n')
  process.exitCode = 2
} else await table[sub]()
