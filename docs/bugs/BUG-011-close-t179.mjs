// docs/bugs/BUG-011-close-t179.mjs — 按 BUG-011 §4 的一次性处置收尾 T-179（**写入生产中枢**，手动运行）
//
// 用法：node docs/bugs/BUG-011-close-t179.mjs [--dry-run]
//
// 为什么是 canceled 而不是 done（详细理由见 docs/bugs/BUG-011-pipeline-assumes-deployable-artifact.md）：
//   T-179（tester）的判定报告已由将军搬运到被跟踪路径 docs/bugs/T-179-12-red-suites-judgment.md，
//   源文在 scratch/t179/JUDGMENT.md，而 scratch/ 被 .gitignore ⇒ 分支 w/T-179 永远 0 提交
//   ⇒ **本任务没有可部署物**。而 advancePipeline（plugins/src/handoff.ts:181）只按角色链建后继，
//   不看前序交付了什么：tester.next = devops ⇒ 推 done 会建出一个【部署与 CI/CD】环，
//   而该环的 prompt 要求它产出 Dockerfile / workflow / docs/DEPLOY.md
//   —— 让一个 agent 为不存在的交付物造部署物，比少跑一环更坏。
//   canceled 不进「4. 流水线 done 补流转」那道扫单（它只取 status === 'done'），故不会派下游。
//
// 三步：① 留一条评论说明处置与依据（人看得到）；② 推进 canceled；③ 自查：状态已 canceled、
//       且**确实没有** devops 后继被建出来（否则本脚本做的事与它宣称的不一致）。

import { DatabaseSync } from 'node:sqlite'

const DRY = process.argv.includes('--dry-run')
const HUB = process.env.BUG011_HUB ?? 'http://127.0.0.1:8787'
const DB = process.env.BUG011_DB ?? 'team-hub/team.db'
const ACTOR = 'general'
const TASK = 'T-179'

const post = async (path, body) => {
  const r = await fetch(HUB + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed = null
  try { parsed = await r.json() } catch { /* 空体 */ }
  return { status: r.status, body: parsed }
}

const COMMENT = [
  '⛔ 本条以 **canceled** 收尾（不是 done）—— 依据 BUG-011。',
  '',
  '判定报告已由将军搬运到被跟踪路径 `docs/bugs/T-179-12-red-suites-judgment.md`',
  '（源文 `scratch/t179/JUDGMENT.md`；`scratch/` 被 `.gitignore` ⇒ 本任务分支 `w/T-179` 永远 0 提交），',
  '所以**本任务没有可部署物**。',
  '',
  '**为什么不推 done**：`advancePipeline`（`plugins/src/handoff.ts:181`）只按角色链建后继，',
  '不看前序交付了什么 —— `tester.next = devops` ⇒ 推 done 会建出一个【部署与 CI/CD】环，',
  '而该环的 prompt 要求它产出 Dockerfile / workflow / `docs/DEPLOY.md`。',
  '让一个 agent 为不存在的交付物造部署物，比少跑一环更坏。',
  '`canceled` 不进「4. 流水线 done 补流转」扫单（那只取 `status === \'done\'`），所以不会派下游。',
  '',
  '记账：`docs/bugs/BUG-011-pipeline-assumes-deployable-artifact.md`（**未修**，含三个选项与推荐）。',
].join('\n')

let bad = 0
// 只读连接先开着：①/② 都要用它对账，且在 dry-run 下也要能读。
const db = new DatabaseSync(DB, { readOnly: true })
const MARK = '⛔ 本条以 **canceled** 收尾'

// ── ① 评论（幂等：同一标记已有就不再追加） ──────────────────────────────────────
const already = db.prepare('SELECT comments FROM tasks WHERE id = ?').get(TASK)
const hasMark = typeof already?.comments === 'string' && already.comments.includes(MARK)
if (hasMark) console.log('① 评论 → 跳过（已有一条同标记的处置说明）')
else if (DRY) console.log('① [dry] 将给 T-179 留一条处置说明')
else {
  const r = await post('/api/comment', { id: TASK, by: ACTOR, text: COMMENT })
  const ok = r.status === 200 && r.body?.ok === true
  if (!ok) bad += 1
  console.log(`① 评论 → ${r.status} ${ok ? 'OK' : JSON.stringify(r.body).slice(0, 200)}`)
}

// ── ② 推进 canceled（幂等：已经是 canceled 就不再迁 —— 中枢对 canceled→canceled 回 400） ──
const cur = db.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK)?.status
if (cur === 'canceled') console.log('② transition → 跳过（已是 canceled）')
else if (DRY) console.log('② [dry] 将 POST /api/transition {to:"canceled"}')
else {
  const r = await post('/api/transition', { id: TASK, to: 'canceled', by: ACTOR })
  const ok = r.status === 200 && r.body?.task?.status === 'canceled'
  if (!ok) bad += 1
  console.log(`② transition → ${r.status} status=${r.body?.task?.status ?? JSON.stringify(r.body).slice(0, 200)}`)
}

// ── ③ 自查：状态对了，而且**真的没有** devops 后继 ──────────────────────────────
const t = db.prepare('SELECT id, role, status FROM tasks WHERE id = ?').get(TASK)
console.log(`③ T-179 状态 = ${t?.status}（role=${t?.role}）`)
if (DRY) console.log('   [dry] 跳过"必须是 canceled"这一条（dry 不改状态）')
else if (t?.status !== 'canceled') { bad += 1; console.log('   ✗ 没到 canceled') }

// 后继 = parent 指向 T-179 的任何任务（advancePipeline 就是拿 parent 认后继的）
const succ = db.prepare('SELECT id, role, status FROM tasks WHERE parent = ?').all(TASK)
console.log(`③ T-179 的后继任务 = ${succ.length === 0 ? '（无）' : JSON.stringify(succ)}`)
if (succ.some(s => s.role === 'devops')) { bad += 1; console.log('   ✗ 竟然建出了 devops 环 —— 本脚本的前提不成立') }
// 更强的判据：全库不许有把 T-179 列进 blockedBy 的 devops 任务
const viaBlocked = db.prepare("SELECT id, role FROM tasks WHERE role = 'devops' AND blockedBy LIKE ?").all(`%${TASK}%`)
if (viaBlocked.length > 0) { bad += 1; console.log(`   ✗ 有 devops 任务以 blockedBy 挂着 T-179：${JSON.stringify(viaBlocked)}`) }
else console.log('③ 以 blockedBy 挂 T-179 的 devops 任务 = （无）')

console.log(bad === 0 ? '\nBUG-011 T-179 处置：PASS（3/3）' : `\nBUG-011 T-179 处置：FAIL（${bad} 项）`)
// 先关连接再退出：开着 SQLite 句柄调 process.exit 会触发 libuv 的
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` —— 那会让一个 PASS 的脚本退出码为 1
//（"判据绿了、退出码红了"，与 BUG-009-a 那次"单元测试全绿、生产 200"同形的坑）。
db.close()
process.exitCode = bad === 0 ? 0 : 1
