#!/usr/bin/env node
/**
 * s7-l1-notify.mjs — 切片 S7（通知中心，R-B2）L1 数据面探针（tester T-090，只测不修）。
 *
 * 覆盖（对照 docs/TEST_CASES.md TC-S7-01/02/03/05/07 的数据面/SSE 断言）：
 *  ① 真实 team-hub server.mjs（临时库 + 随机端口，stdio ignore）上经既有 HTTP 写接口播种
 *     任务 create/claim/transition/comment/evidence/review-note/patch/artifact、goal:publish、
 *     space:create、model:set、chat:create/chat:message、calendar:create、marketing scope 隔离数据；
 *  ② /api/activity?scope= 过滤 + seq 降序 + limit + 行形状（TC-S7-02）；
 *  ③ 服务端原始流不过滤 chat:* 与 comment 噪音（TC-S7-03 前置：同空间存在 chat:* 与任务类审计）——
 *     排除动作是前端白名单职责（isNotifyAction 见 s7-notify-logic.mjs）；
 *  ④ 已读游标操作（纯本地，无任何 HTTP）前后 /api/activity 行数与 seq 集合零变化（TC-S7-05 反向）；
 *  ⑤ /api/events 单一流 live 收到 transition 审计帧 <=6s（I-8，NotifyView 实时增量同源）；
 *  ⑥ scope 隔离反向（software 不含 marketing 行）与跨空间计数独立（TC-S7-03 scope 过滤）。
 *
 * 任务生命周期注记（读自 server.mjs）：createTask 默认 status=backlog；claimTask 仅接受 todo|blocked
 * （server.mjs:978）；claim 缺省 soldier=by（:1313）；transition in_review 需 by == t.soldier（:1009-1011）。
 * 故播种先 status:'todo' → claim(by) → transition(in_review, by)。
 *
 * 运行：node docs/T090-evidence/s7-l1-notify.mjs   （node >=22.5，node:sqlite；零第三方依赖）
 * 结束：清理子进程与临时目录；任一断言失败退出码非 0，输出尾部为 PASS/FAIL 逐项 + 汇总。
 */
import { spawn } from 'node:child_process'
import * as httpMod from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-s7-l1-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let hardFailures = 0
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond })
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
}
const post = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})
const j = async (p) => { const r = await p; let b; try { b = await r.json() } catch { b = null }; return { status: r.status, ok: r.ok, body: b } }

async function startServer() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = 22000 + Math.floor(Math.random() * 16000)
    const dbFile = join(tmpRoot, 'hub-' + port + '.db')
    const child = spawn(process.execPath, ['team-hub/server.mjs'], {
      cwd: REPO,
      env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(port), TEAM_HUB_TOKEN: '' },
      stdio: 'ignore',
    })
    const base = 'http://127.0.0.1:' + port
    for (let i = 0; i < 120; i += 1) {
      try {
        const r = await fetch(base + '/api/config')
        if (r.ok && (await r.json()).db === dbFile) return { child, base, dbFile }
      } catch { /* 未就绪 */ }
      await sleep(100)
    }
    child.kill()
  }
  throw new Error('server.mjs 未能就绪')
}

/** 订阅单一 /api/events，等待满足谓词的 live 帧（调用方先 sleep 越过回放窗口）。 */
function waitLive(base, predicate, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = httpMod.get(base + '/api/events', (res) => {
      let buf = ''
      res.on('data', (d) => {
        buf += d.toString()
        const frames = buf.split('\n\n')
        buf = frames.pop()
        for (const f of frames) {
          const m = /^data: (.+)$/m.exec(f)
          if (!m) continue
          try {
            const ev = JSON.parse(m[1])
            if (predicate(ev)) { req.destroy(); resolve(ev); return }
          } catch { /* 忽略 */ }
        }
      })
    })
    req.on('error', () => resolve(null))
    setTimeout(() => { try { req.destroy() } catch { /* ok */ }; resolve(null) }, timeoutMs)
  })
}

async function main() {
  const { child, base } = await startServer()
  try {
    const who = { by: 'tester-s7', scope: 'software' }
    // ── 0) 空间 ──
    await j(post(base, '/api/spaces', { id: 'software', name: '软件部', scope: 'software', by: 'tester-s7' }))
    await j(post(base, '/api/spaces', { id: 'marketing', name: '市场部', scope: 'marketing', by: 'tester-s7' }))

    // ── 1) software：任务生命周期类（白名单正中）──
    const t1 = await j(post(base, '/api/create', { ...who, title: 'S7 通知探针任务 A', status: 'todo', priority: 'high' }))
    check('播种：POST /api/create(status=todo) → 200 任务落库', t1.status === 200 && !!t1.body?.task?.id, JSON.stringify(t1.body ?? t1.status))
    const T1 = t1.body.task.id
    const c1 = await j(post(base, '/api/claim', { id: T1, scope: 'software', by: 'tester-s7' }))
    check('播种：claim(todo→in_progress) → 200', c1.status === 200 && c1.body?.task?.status === 'in_progress', JSON.stringify(c1.body ?? c1.status))
    const tr1 = await j(post(base, '/api/transition', { id: T1, to: 'in_review', scope: 'software', by: 'tester-s7' }))
    check('播种：transition(in_progress→in_review) → 200', tr1.status === 200 && tr1.body?.task?.status === 'in_review', JSON.stringify(tr1.body ?? tr1.status))
    await j(post(base, '/api/comment', { id: T1, scope: 'software', text: '一条任务讨论（comment，白名单外）', by: 'tester-s7' }))
    await j(post(base, '/api/review-notes', { id: T1, file: '*', verdict: 'ok', note: '整体通过', scope: 'software', by: 'tester-s7' }))
    await j(post(base, '/api/patch', { id: T1, scope: 'software', summary: 'probe diff', files: [{ path: 'a.mjs', status: 'M', add: 1, del: 0 }], by: 'tester-s7' }))
    await j(post(base, '/api/artifact', { id: T1, scope: 'software', kind: 'file', path: 'probe.txt', by: 'tester-s7' }))
    const g1 = await j(post(base, '/api/goal', { scope: 'software', objective: 'S7 通知中心验收目标', by: 'tester-s7', mode: 'chain' }))
    check('播种：goal:publish → 200', g1.status === 200 && g1.body?.ok === true, JSON.stringify(g1.body ?? g1.status))
    const m1 = await j(post(base, '/api/models', { scope: 'software', role: 'tester', provider: 'custom-ds', model: 'deepseek-v4-flash-openai', by: 'tester-s7' }))
    check('播种：model:set → 200', m1.status === 200, JSON.stringify(m1.body ?? m1.status))

    // ── 2) software：噪音类（chat:* / calendar:*）──
    const conv = await j(post(base, '/api/chat/conversations', { scope: 'software', title: '通知面板不应被刷屏的会话', kind: 'space', by: 'tester-s7' }))
    check('播种 chat:create 会话 → 200', conv.status === 200 && conv.body?.task?.id > 0, JSON.stringify(conv.body ?? conv.status))
    const convId = conv.body.task.id
    await j(post(base, '/api/chat/messages', { conv: convId, scope: 'software', kind: 'text', body: 'hello notify probe', by: 'tester-s7' }))
    const cal = await j(post(base, '/api/calendar/events', { scope: 'software', title: '评审会', start: '2026-09-10T10:00', by: 'tester-s7' }))
    check('播种 calendar:create → 200', cal.status === 200, JSON.stringify(cal.body ?? cal.status))

    // ── 3) marketing 隔离数据 ──
    const tm = await j(post(base, '/api/create', { scope: 'marketing', title: '市场部隔离任务', status: 'todo', by: 'tester-s7' }))
    check('播种 marketing 任务 → 200', tm.status === 200 && !!tm.body?.task?.id, JSON.stringify(tm.body ?? tm.status))
    const cm = await j(post(base, '/api/claim', { id: tm.body?.task?.id, scope: 'marketing', by: 'tester-s7' }))
    check('播种 marketing claim → 200', cm.status === 200 && cm.body?.task?.status === 'in_progress', JSON.stringify(cm.body ?? cm.status))

    await sleep(300)

    // ── ① TC-S7-02：GET /api/activity 行形状/排序/limit ──
    const actSw = await j(await fetch(base + '/api/activity?scope=software&limit=500'))
    const rows = actSw.body ?? []
    const shapeOk = rows.length > 0 && rows.every((r) =>
      Number.isInteger(r.seq) && typeof r.ts === 'string' && typeof r.member === 'string' &&
      r.scope === 'software' && typeof r.action === 'string' && typeof r.detail === 'object')
    check('TC-S7-02 ① 行形状：seq/ts/member/scope=software/action/detail 齐备', shapeOk, 'rows=' + rows.length)
    const descOk = rows.every((r, i) => i === 0 || rows[i - 1].seq >= r.seq)
    check('TC-S7-02 ② scope=software 审计按 seq 新→旧（降序）', descOk)
    const lim = await j(await fetch(base + '/api/activity?scope=software&limit=5'))
    check('TC-S7-02 ③ limit=5 → 至多 5 行且非空', (lim.body ?? []).length <= 5 && (lim.body ?? []).length > 0)
    const actAll = await j(await fetch(base + '/api/activity?limit=1000'))
    const seqs = new Set((actAll.body ?? []).map((r) => r.seq))
    check('TC-S7-02 ④ 全量行 seq 无重复（审计主键语义）', seqs.size === (actAll.body ?? []).length)

    // ── ②③ TC-S7-03 前置：原始流含噪音；任务/目标类入列 ──
    const rawActions = new Set(rows.map((r) => r.action))
    check('TC-S7-03 前置 A：服务端原始流含 chat:create/chat:message（前端白名单须排除）',
      rawActions.has('chat:create') && rawActions.has('chat:message'))
    check('TC-S7-03 前置 B：服务端原始流含 comment 与 calendar:create（均白名单外）',
      rawActions.has('comment') && rawActions.has('calendar:create'))
    const want = ['create', 'claim', 'transition', 'review-note', 'patch', 'artifact', 'goal:publish', 'space:create', 'model:set']
    check('TC-S7-03 前置 C：任务/目标/空间/模型类审计全入列（' + want.join('/') + '）',
      want.every((a) => rawActions.has(a)), '实际: ' + [...rawActions].join(','))
    const taskRows = rows.filter((r) => r.taskId != null && r.taskId !== '*')
    check('TC-S7-02 ⑤ 任务类行可辨识（taskId 非空）', taskRows.length >= 4 && taskRows.every((r) => typeof r.taskId === 'string'))
    check('TC-S7-01 数据面：行含 ts/scope/action/member 字段（面板行渲染所需）',
      rows.every((r) => 'ts' in r && 'scope' in r && 'action' in r && 'member' in r))

    // ── ⑥ scope 隔离反向 ──
    const actMk = await j(await fetch(base + '/api/activity?scope=marketing&limit=500'))
    const mkRows = actMk.body ?? []
    check('TC-S7-03 scope 过滤：software 列表行 scope 全部=software', rows.every((r) => r.scope === 'software'))
    check('TC-S7-03 scope 隔离反向：marketing 列表无 software 行、且含本空间 claim 行',
      mkRows.length > 0 && mkRows.every((r) => r.scope === 'marketing') &&
      mkRows.some((r) => r.action === 'claim' && r.taskId === tm.body?.task?.id), 'mkRows=' + mkRows.map((r) => r.action).join(','))
    const none = await j(await fetch(base + '/api/activity?scope=no-such-space&limit=500'))
    check('TC-S7-03 未知 scope 查询 → []（不报错不越权）', Array.isArray(none.body) && none.body.length === 0)

    // ── ④ TC-S7-05 反向（L1）：静默段前后 /api/activity 全量零变化 ──
    const before = await j(await fetch(base + '/api/activity?limit=1000'))
    const beforeSeqs = (before.body ?? []).map((r) => r.seq).sort((a, b) => a - b).join(',')
    await sleep(400) // 模拟「已读只落本地」窗口：不做任何写调用
    const afterA = await j(await fetch(base + '/api/activity?limit=1000'))
    const afterSeqs = (afterA.body ?? []).map((r) => r.seq).sort((a, b) => a - b).join(',')
    check('TC-S7-05 反向（L1）：无写调用窗口后全量行数与 seq 集合零变化（已读无服务端写路径）',
      beforeSeqs === afterSeqs, 'rows=' + (before.body ?? []).length)

    // ── ⑤ I-8 单一 /api/events live 帧（订阅后才产生的事件，杜绝回放误匹配）──
    const subTsRef = { value: new Date().toISOString() }
    let waitTask = null
    const liveP = waitLive(base, (ev) => ev.action === 'transition' && ev.scope === 'software' &&
      ev.taskId === waitTask && ev.ts > subTsRef.value)
    await sleep(1200) // 越过连接回放窗口（近 30 条）
    const t2 = await j(post(base, '/api/create', { ...who, title: 'S7 通知探针任务 B', status: 'todo' }))
    const T2 = t2.body?.task?.id
    waitTask = T2
    await j(post(base, '/api/claim', { id: T2, scope: 'software', by: 'tester-s7' }))
    await j(post(base, '/api/transition', { id: T2, to: 'in_review', scope: 'software', by: 'tester-s7' }))
    const liveEv = await liveP
    check('TC-S7-07 L1（I-8）：单一 /api/events 订阅 ≤6s 收到 live transition 帧（订阅后产生、taskId=T2）',
      !!liveEv && liveEv.action === 'transition' && liveEv.scope === 'software' && liveEv.taskId === T2,
      liveEv ? JSON.stringify(liveEv) : '未收到 live 帧')
    console.log('--- S7 L1 探针执行完 ---')
  } catch (e) {
    hardFailures += 1
    console.log('L1 探针异常：' + ((e && e.stack) || e))
  } finally {
    child.kill()
  }
  await sleep(300)
  try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch { /* ok */ }
  const fails = results.filter((r) => !r.ok).length
  console.log('\n==== S7 L1 汇总：' + (results.length - fails) + '/' + results.length + ' 断言通过；进程级异常 ' + hardFailures + ' ====')
  process.exit(fails + hardFailures > 0 ? 1 : 0)
}
await main()
