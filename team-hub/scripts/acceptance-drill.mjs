#!/usr/bin/env node
// team-hub/scripts/acceptance-drill.mjs
// ============================================================================
// superagent 移植 · **A 类能力演练**（不需要守护/模型，10 秒级）
//
//   node team-hub/scripts/acceptance-drill.mjs            # 跑一遍，全过退 0
//   node team-hub/scripts/acceptance-drill.mjs --keep     # 保留临时库与证据 JSON
//   node team-hub/scripts/acceptance-drill.mjs --port=18999
//
// 为什么要有它：单元判据证明"模块对"，但不能证明"接进真实 HTTP 面之后还对"。
// 这个脚本自建临时库、自起一个 team-hub（不碰你的生产库）、逐项断言、最后留证据。
//
// ★ 每一步都回答一个问题："如果这步坏了，用户会看到什么？"
//   所以断言尽量落在**对外可见的东西**上（响应体 / 台账 / 任务时间线），而不是内部实现。
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { checkGate, ensureBaselineSchema } from '../regression-gate.mjs'

/** 汇总（纯函数，便于单测）。 */
export function summarizeSteps(results) {
  const list = Array.isArray(results) ? results : []
  const passed = list.filter((r) => r.passed === true).length
  const failed = list.length - passed
  return { total: list.length, passed, failed, ok: failed === 0 }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 极简 HTTP 客户端：所有断言都基于它返回的 {status, body}。 */
function createClient(baseUrl) {
  return async function api(method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let payload = null
    try { payload = await res.json() } catch { /* 无正文 */ }
    return { status: res.status, body: payload }
  }
}

async function waitReady(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/api/config')
      if (res.status < 500) return true
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  return false
}

/**
 * 演练步骤表。每步：造数据 → 打接口 → 断言"对外可见的结果"。
 * `ctx` 提供 api / db / dbPath / base。
 */
function buildSteps() {
  const mkTask = async (api, title) => (await api('POST', '/api/create', { title, by: 'general' })).body.task.id

  return [
    {
      id: 'F0-input-row',
      name: 'F0 评论落成输入行，列 = 行投影（对账 0 差异）',
      async run({ api }) {
        const id = await mkTask(api, 'drill-F0')
        await api('POST', '/api/comment', { id, text: '第一条批注', by: 'general' })
        const inputs = await api('GET', `/api/tasks/${id}/inputs`)
        const reconcile = await api('GET', '/api/reconcile/inputs')
        const ok = inputs.status === 200
          && inputs.body.count === 1
          && inputs.body.inputs[0].kind === 'comment'
          && Array.isArray(reconcile.body.mismatched) && reconcile.body.mismatched.length === 0
        return { passed: ok, detail: { inputKind: inputs.body?.inputs?.[0]?.kind, mismatched: reconcile.body?.mismatched?.length } }
      },
    },
    {
      id: 'F1F2-report',
      name: 'F1+F2 四态回报：幂等重投 + 一任务一未答问题',
      async run({ api }) {
        const id = await mkTask(api, 'drill-report')
        const first = await api('POST', `/api/tasks/${id}/report`, {
          by: 'general', reportId: 'drill-1', status: 'blocked',
          summary: '卡在口径', question: { body: '验收口径 A 还是 B？' }, applyTransition: true,
        })
        const again = await api('POST', `/api/tasks/${id}/report`, {
          by: 'general', reportId: 'drill-1', status: 'blocked', question: { body: '口径' },
        })
        const second = await api('POST', `/api/tasks/${id}/report`, {
          by: 'general', reportId: 'drill-2', status: 'blocked', question: { body: '第二个问题' },
        })
        const ok = first.status === 200 && first.body.transition === 'blocked'
          && again.body.duplicated === true
          && second.status === 409 && second.body.code === 'REPORT_QUESTION_ALREADY_OPEN'
        return { passed: ok, detail: { transition: first.body?.transition, duplicated: again.body?.duplicated, second: second.body?.code } }
      },
    },
    {
      id: 'F2-gate',
      name: 'F2 派工闸：有未答问题 ⇒ blocking.reason=question',
      async run({ api, db }) {
        const id = (await api('GET', '/api/tasks?limit=200')).body?.tasks?.find((t) => String(t.title).includes('drill-report'))?.id
          ?? db.prepare("SELECT id FROM tasks WHERE title LIKE '%drill-report%' ORDER BY rowid DESC").get()?.id
        const r = await api('GET', `/api/tasks/${id}/blocking`)
        const ok = r.status === 200 && r.body.blocked === true && r.body.reason === 'question' && Boolean(r.body.blocker?.questionId)
        return { passed: ok, detail: { reason: r.body?.reason, questionId: r.body?.blocker?.questionId } }
      },
    },
    {
      id: 'F3-mentions',
      name: 'F3 @ 三语义：普通 / @成员=order / @general=escalate',
      async run({ api, db }) {
        const id = await mkTask(api, 'drill-mention')
        // `@` 只认 scope 成员：先让 coder 在编队里
        db.prepare(`INSERT OR IGNORE INTO agent_registry (agent_id, scope, role, name, archived)
          VALUES ('agent-drill-coder','default','coder','演练编码兵',0)`).run()
        await api('POST', '/api/comment', { id, text: '普通一句', by: 'general' })
        await api('POST', '/api/comment', { id, text: '@coder 顺手把日志加上', by: 'general' })
        await api('POST', '/api/comment', { id, text: '@general 这个取舍要您定', by: 'general' })
        const inputs = (await api('GET', `/api/tasks/${id}/inputs`)).body.inputs
        const effects = inputs.map((i) => i.meta?.effect ?? null)
        const ok = effects.includes(null) && effects.includes('order') && effects.includes('escalate')
        return { passed: ok, detail: { kinds: inputs.map((i) => i.kind), effects } }
      },
    },
    {
      id: 'F4-mandate',
      name: 'F4 台账：→todo 时自动写 mandate + decision',
      async run({ api }) {
        const id = await mkTask(api, 'drill-mandate')
        await api('POST', '/api/transition', { id, to: 'blocked', by: 'general' })
        const back = await api('POST', '/api/transition', { id, to: 'todo', by: 'general' })
        const mandate = await api('GET', `/api/tasks/${id}/mandate`)
        const decisions = await api('GET', `/api/decisions?subject=task:${id}`)
        const ok = back.status === 200
          && mandate.body.mandate?.manual === true
          && mandate.body.acceptMode === 'manual'
          && (decisions.body.decisions?.length ?? 0) >= 1
        return {
          passed: ok,
          detail: { manual: mandate.body?.mandate?.manual, acceptMode: mandate.body?.acceptMode, decisions: decisions.body?.decisions?.length },
        }
      },
    },
    {
      id: 'F4b-policy-version',
      name: 'F4 规则集：写入后 policyVersion 变化，且不动任务状态',
      async run({ api }) {
        const before = (await api('GET', '/api/policy-rules')).body.version
        const created = await api('POST', '/api/policy-rules', { by: 'general', id: 'R-DRILL', kind: 'always', text: '演练规则' })
        const after = (await api('GET', '/api/policy-rules')).body.version
        const ok = created.status === 200 && created.body.created === true && after !== before
        return { passed: ok, detail: { before, after, created: created.body?.created } }
      },
    },
    {
      id: 'F5-events-reconcile',
      name: 'F5 事件流：只读对账 0 差异 + 周报六个数齐全',
      async run({ api }) {
        const reconcile = await api('GET', '/api/reconcile')
        const weekly = await api('GET', '/api/report/weekly')
        const keys = Object.keys(weekly.body?.metrics ?? {}).sort()
        const expected = ['accepted', 'ignored', 'mandateMissingRatio', 'stopped', 'unavailable', 'wouldAccept']
        const ok = reconcile.status === 200 && reconcile.body.ok === true
          && JSON.stringify(keys) === JSON.stringify(expected)
        return { passed: ok, detail: { mismatched: reconcile.body?.mismatched?.length, metricKeys: keys } }
      },
    },
    {
      id: 'F6-goal-share',
      name: 'F6 目标配额：配置写入被归一化（份额夹 0..1、TTL 夹下限）',
      async run({ api }) {
        const wrote = await api('POST', '/api/spaces/default/goal-share', {
          by: 'general', config: { default: 3, weights: { 'G-1': 2.4, 'G-X': 'x' }, borrowTtlSec: 10 },
        })
        const cfg = wrote.body?.config ?? {}
        const ok = wrote.status === 200 && cfg.default === 1 && cfg.weights?.['G-1'] === 2
          && cfg.weights?.['G-X'] === undefined && cfg.borrowTtlSec === 60
        return { passed: ok, detail: cfg }
      },
    },
    {
      id: 'F6b-borrow-release',
      name: 'F6 借槽：造一笔 → 到期释放 + share_release 审计（幂等）',
      async run({ api, db }) {
        const created = await api('POST', '/api/goal-borrows', {
          by: 'general', goalId: 'G-drill', taskId: 'T-drill', grantedAt: '2026-11-03T00:00:00.000Z', ttlSec: 60,
        })
        const released = await api('POST', '/api/goal-borrows/release', { by: 'general', now: '2026-11-03T01:00:00.000Z' })
        const again = await api('POST', '/api/goal-borrows/release', { by: 'general', now: '2026-11-03T02:00:00.000Z' })
        const audits = db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action='share_release'").get().c
        const ok = created.status === 200 && released.body.released === 1 && again.body.released === 0 && Number(audits) === 1
        return { passed: ok, detail: { released: released.body?.released, again: again.body?.released, audits: Number(audits) } }
      },
    },
    {
      id: 'F7-preempt',
      name: 'F7 抢占：人+explicit 允许并真的让槽；bot 被拒',
      async run({ api, db }) {
        const id = await mkTask(api, 'drill-preempt')
        // 造"正在执行且已跑够时间"：演练脚本直接改临时库（独立库里允许）
        db.prepare("UPDATE tasks SET status='in_progress', soldier='soldier-coder', claimedAt='2026-11-03T00:00:00.000Z' WHERE id=?").run(id)
        const allowed = await api('POST', `/api/tasks/${id}/preempt`, {
          by: 'general', kind: 'general', strength: 'explicit', reason: '线上故障', now: '2026-11-03T00:10:00.000Z',
        })
        const statusNow = db.prepare('SELECT status FROM tasks WHERE id=?').get(id)?.status
        db.prepare("UPDATE tasks SET status='in_progress', claimedAt='2026-11-03T00:00:00.000Z' WHERE id=?").run(id)
        const denied = await api('POST', `/api/tasks/${id}/preempt`, {
          by: 'bot', kind: 'bot', strength: 'explicit', now: '2026-11-03T00:20:00.000Z',
        })
        const ok = allowed.status === 200 && allowed.body.transitioned === true && statusNow === 'todo'
          && denied.status === 422 && denied.body.code === 'PREEMPT_NOT_HUMAN'
        return { passed: ok, detail: { transitioned: allowed.body?.transitioned, statusNow, denied: denied.body?.code } }
      },
    },
    {
      id: 'F9-regression',
      name: 'F9 归纳：失败簇 → draft 用例；agent 不能晋升、人能晋升',
      async run({ api, db }) {
        // 造两条历史失败决策（演练专用：这一步本该由历史运行自然积累）
        for (const t of ['T-drill-f1', 'T-drill-f2']) {
          db.prepare(`INSERT INTO decisions (id, subject, kind, matched_rule_ids, would_accept, reason, by, at, policy_version)
            VALUES (?,?,?,?,0,?,?,?,?)`).run(`dec-${t}`, `task:${t}`, 'stop', '[]', '越域 team-hub/routes/', 'general', '2026-11-03T00:00:00.000Z', 'legion/policy@1')
        }
        const gen = await api('POST', '/api/regression-cases/candidates', { by: 'general', top: 5 })
        const drafts = (await api('GET', '/api/regression-cases?state=draft')).body.cases
        const caseId = drafts[0]?.id
        const agentTry = await api('POST', `/api/regression-cases/${caseId}/promote`, { by: 'agent:coder' })
        const humanTry = await api('POST', `/api/regression-cases/${caseId}/promote`, { by: 'general' })
        const ok = gen.status === 200 && (gen.body.drafts?.length ?? 0) >= 1
          && agentTry.status === 422 && humanTry.body?.case?.state === 'active'
        return { passed: ok, detail: { drafts: gen.body?.drafts?.length, agentTry: agentTry.body?.code, humanState: humanTry.body?.case?.state } }
      },
    },
    {
      id: 'F10-shadow',
      name: 'F10 影子验证：给出翻转率与 needsReview，且只读',
      async run({ api, db }) {
        const before = db.prepare('SELECT COUNT(*) AS c FROM decisions').get().c
        const r = await api('GET', '/api/shadow-report?candidateRuleId=R-DRILL')
        const after = db.prepare('SELECT COUNT(*) AS c FROM decisions').get().c
        const ok = r.status === 200 && typeof r.body.flipRate === 'number'
          && typeof r.body.needsReview === 'boolean' && before === after
        return { passed: ok, detail: { n: r.body?.n, flipRate: r.body?.flipRate, needsReview: r.body?.needsReview, decisionsUnchanged: before === after } }
      },
    },
    {
      id: 'F11-baseline-gate',
      name: 'F11 不退化门：人可写基线、agent 被拒、指标变差即拦',
      async run({ api, db }) {
        const bad = await api('POST', '/api/metric-baseline', { by: 'agent:coder', metric: 'mandateMissingRatio', scope: 'default', value: 0 })
        const good = await api('POST', '/api/metric-baseline', { by: 'general', metric: 'mandateMissingRatio', scope: 'default', value: 0 })
        // 造一条"没有 mandate 的在途任务"，让比例 > 0
        db.prepare("INSERT INTO tasks (id, title, status, scope, updatedAt) VALUES ('T-drill-nomandate','无授权任务','todo','default','2026-11-03T00:00:00.000Z')").run()
        const weekly = await api('GET', '/api/report/weekly')
        ensureBaselineSchema(db)
        const gate = checkGate(db, { metrics: weekly.body.metrics, scope: 'default' })
        const ok = bad.status === 422 && bad.body.code === 'BASELINE_HUMAN_REQUIRED'
          && good.status === 200 && gate.ok === false
          && gate.violations.some((v) => v.metric === 'mandateMissingRatio')
        return { passed: ok, detail: { agentWrite: bad.body?.code, ratio: weekly.body?.metrics?.mandateMissingRatio, violations: gate.violations.map((v) => v.metric) } }
      },
    },
  ]
}

/** 起一个隔离实例，跑完 steps，返回结果（不打印、不退出）。 */
export async function runDrill({ port = null, keep = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-drill-'))
  const dbPath = join(dir, 'team.db')
  const chosenPort = port ?? 18000 + Math.floor(Math.random() * 900)
  const base = `http://127.0.0.1:${chosenPort}`
  // ★ 用脚本自身位置定位，不用 cwd：从 team-hub/ 里跑时 cwd 拼法会指向不存在的路径
  const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')

  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, TEAM_HUB_DB: dbPath, TEAM_HUB_PORT: String(chosenPort) },
    stdio: 'ignore',
  })

  const results = []
  let error = null
  try {
    const ready = await waitReady(base)
    if (!ready) throw new Error(`隔离实例未在超时内就绪（port=${chosenPort}）；可能端口被占用，用 --port= 指定别的端口`)
    const api = createClient(base)
    const db = new DatabaseSync(dbPath)
    try {
      for (const step of buildSteps()) {
        let result
        try {
          result = await step.run({ api, db, dbPath, base })
        } catch (e) {
          result = { passed: false, detail: { error: String(e?.message ?? e) } }
        }
        results.push({ id: step.id, name: step.name, ...result })
      }
    } finally {
      try { db.close() } catch { /* 已关闭 */ }
    }
  } catch (e) {
    error = String(e?.message ?? e)
  } finally {
    try { child.kill() } catch { /* 已退出 */ }
    await sleep(300)
  }

  const summary = summarizeSteps(results)
  const evidence = {
    at: new Date().toISOString(),
    port: chosenPort,
    dbPath,
    ok: summary.ok && error === null,
    error,
    summary,
    steps: results,
  }
  if (keep) {
    try { writeFileSync(join(dir, 'acceptance-evidence.json'), JSON.stringify(evidence, null, 2)) } catch { /* 忽略 */ }
  } else {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
  return { evidence, dir, summary }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain) {
  const portArg = process.argv.find((a) => a.startsWith('--port='))
  const keep = process.argv.includes('--keep')
  const { evidence, dir, summary } = await runDrill({ port: portArg ? Number(portArg.slice('--port='.length)) : null, keep })

  process.stdout.write('\n=== 能力演练 ===\n')
  for (const step of evidence.steps) {
    const mark = step.passed ? 'PASS' : 'FAIL'
    process.stdout.write(`${mark}  ${step.id.padEnd(20)} ${step.name}\n`)
    if (!step.passed) process.stdout.write(`        ↳ ${JSON.stringify(step.detail)}\n`)
  }
  process.stdout.write(`\n合计 ${summary.total} 项：通过 ${summary.passed}，失败 ${summary.failed}\n`)
  if (evidence.error) process.stdout.write(`运行错误：${evidence.error}\n`)
  if (keep) process.stdout.write(`证据与临时库保留在：${dir}\n`)
  process.exitCode = summary.ok && evidence.error === null ? 0 : 1
}
