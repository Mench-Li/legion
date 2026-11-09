#!/usr/bin/env node
// team-hub/scripts/acceptance-drill-b.mjs
// ============================================================================
// superagent 移植 · **B 类能力演练（不需要守护，但走真实服务链路）**
//
//   node team-hub/scripts/acceptance-drill-b.mjs [--keep] [--port=18950]
//
// A 类（acceptance-drill.mjs）证明"接口与台账对"；这里补一项目前只能靠人手工验的事：
//
//   **F2 回答闭环**：人回答未答问题 → 任务自动回 todo → 重新可认领。
//   这条链路横跨 agent-conversations 的 `send()`（回答分支）与 `resumeAfterAnswer`，
//   是"闸装上了但有没有放行开关"的唯一证据。
//
// ★ 为什么不算 A 类：它要真的建会话绑定、真的调回答分支；不是纯 HTTP 造数能覆盖的。
// ★ 为什么不需要守护：派工才需要 worker，**回答**只需要会话与问题。
// ============================================================================
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export function summarize(results) {
  const list = Array.isArray(results) ? results : []
  const passed = list.filter((r) => r.passed === true).length
  return { total: list.length, passed, failed: list.length - passed, ok: list.length - passed === 0 }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReady(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/config`)
      if (res.status < 500) return true
    } catch { /* 未就绪 */ }
    await sleep(200)
  }
  return false
}

/**
 * 跑 B 类演练：自建临时库 + 自起实例（in-process import，便于用服务 API 建会话）。
 */
export async function runDrillB({ keep = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-drill-b-'))
  const dbPath = join(dir, 'team.db')
  const results = []
  let error = null
  let mod = null

  try {
    process.env.TEAM_HUB_DB = dbPath
    // ★ Windows 上动态 import 绝对路径必须转成 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
    mod = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')).href)
    await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
    const base = 'http://127.0.0.1:' + mod.server.address().port
    const api = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let payload = null
      try { payload = await res.json() } catch { /* 无正文 */ }
      return { status: res.status, body: payload }
    }

    // ── 造一个岗位（roster → agent_registry），并建会话绑定 ──
    mod.db.prepare("INSERT OR REPLACE INTO roster (scope, role, name, kind, avatar) VALUES ('default','coder','演练编码兵','agent','🤖')").run()
    mod.agentConversations.syncRoster()
    const agentRow = mod.db.prepare("SELECT agent_id FROM agent_registry WHERE scope='default' AND role='coder'").get()

    // ── 步骤 ①：任务 → 上报 blocked + 结构化问题 ──
    const created = await api('POST', '/api/create', { title: 'drillB-answer-loop', by: 'general' })
    const taskId = created.body.task.id
    // 真实场景里问题是"某个岗位的执行者"提出的：给任务一个 role，
    // 否则 (scope, agent_id, task_id) 三元组无从确定是谁在问。
    mod.db.prepare("UPDATE tasks SET role='coder' WHERE id=?").run(taskId)
    await api('POST', '/api/transition', { id: taskId, to: 'blocked', by: 'general' })
    const reported = await api('POST', `/api/tasks/${taskId}/report`, {
      by: 'general', reportId: 'drillB-1', status: 'blocked',
      summary: '等人口径', question: { body: '验收口径 A 还是 B？' },
    })
    const question = reported.body?.question
    results.push({
      id: 'B1-report-question',
      name: '上报 blocked+question：问题落到 agent_questions，且任务停派',
      passed: reported.status === 200 && Boolean(question?.id) && String(question.agent_id) === String(agentRow?.agent_id),
      detail: { questionId: question?.id, agentId: question?.agent_id, expectAgent: agentRow?.agent_id },
    })

    const blockingBefore = await api('GET', `/api/tasks/${taskId}/blocking`)
    results.push({
      id: 'B2-gate-blocks',
      name: '派工闸：有未答问题时 reason=question（拦在 SQL 层）',
      passed: blockingBefore.body?.reason === 'question',
      detail: { reason: blockingBefore.body?.reason },
    })

    // ── 步骤 ②：人通过真实服务回答（路由 /api/agent-messages → send 的 answer 分支）──
    const conv = mod.agentConversations.conversation({ agentId: agentRow.agent_id, scope: 'default', taskId, by: 'general' })
    const answered = await api('POST', '/api/agent-messages', {
      by: 'general', scope: 'default', conv: conv.convId, target: taskId,
      intent: 'answer_question', questionId: question.id, questionVersion: question.version ?? 1,
      body: '按 A 口径做', clientRequestId: `drillB-answer-${Date.now()}`,
    })
    results.push({
      id: 'B3-answer-accepted',
      name: '回答被接受（走了 answer_question 分支，不是静默失败）',
      passed: answered.status === 200 && answered.body?.error === undefined,
      detail: { status: answered.status, body: answered.body },
    })

    // ── 步骤 ③：回答后任务自动回 todo（放行开关）──
    const afterRow = mod.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)
    const openLeft = mod.db.prepare("SELECT COUNT(*) AS c FROM agent_questions WHERE task_id=? AND status='open'").get(taskId).c
    results.push({
      id: 'B4-resume-to-todo',
      name: '回答后任务自动回 todo（否则闸装了却没有放行开关）',
      passed: afterRow?.status === 'todo' && Number(openLeft) === 0,
      detail: { status: afterRow?.status, openQuestions: Number(openLeft) },
    })

    // ── 步骤 ④：放行后重新可认领（用候选 SQL 直接判定）──
    const { buildClaimableTaskSql } = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'claim-policy.mjs')).href)
    const claimable = mod.db.prepare(buildClaimableTaskSql().replace('{scope}', '')).all().map((r) => r.id)
    results.push({
      id: 'B5-claimable-again',
      name: '放行后重新进入候选（闸与放行成对生效）',
      passed: claimable.includes(taskId),
      detail: { claimableSample: claimable.slice(0, 5) },
    })

    // ── 步骤 ⑤：回答也确实写进了任务时间线（人回话可被看见）──
    const inputs = await api('GET', `/api/tasks/${taskId}/inputs`)
    const hasAnswer = (inputs.body?.inputs ?? []).some((i) => String(i.body).includes('按 A 口径做'))
    results.push({
      id: 'B6-answer-in-timeline',
      name: '回答写进任务时间线（输入行，不是只留在会话里）',
      passed: hasAnswer,
      detail: { inputs: (inputs.body?.inputs ?? []).map((i) => i.kind) },
    })
  } catch (e) {
    error = String(e?.stack ?? e)
  } finally {
    try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
    try { mod?.server?.close?.() } catch { /* 已关闭 */ }
    try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  }

  const summary = summarize(results)
  const evidence = { at: new Date().toISOString(), dbPath, ok: summary.ok && error === null, error, summary, steps: results }
  if (keep) {
    try { writeFileSync(join(dir, 'acceptance-evidence-b.json'), JSON.stringify(evidence, null, 2)) } catch { /* 忽略 */ }
  } else {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
  return { evidence, dir, summary }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain) {
  const keep = process.argv.includes('--keep')
  const { evidence, dir, summary } = await runDrillB({ keep })
  process.stdout.write('\n=== B 类能力演练（回答闭环）===\n')
  for (const step of evidence.steps) {
    process.stdout.write(`${step.passed ? 'PASS' : 'FAIL'}  ${step.id.padEnd(22)} ${step.name}\n`)
    if (!step.passed) process.stdout.write(`        ↳ ${JSON.stringify(step.detail)}\n`)
  }
  process.stdout.write(`\n合计 ${summary.total} 项：通过 ${summary.passed}，失败 ${summary.failed}\n`)
  if (evidence.error) process.stdout.write(`运行错误：${evidence.error.split('\n')[0]}\n`)
  if (keep) process.stdout.write(`证据保留在：${dir}\n`)
  process.exitCode = summary.ok && evidence.error === null ? 0 : 1
}
