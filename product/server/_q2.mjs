import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('/var/lib/legion-hub/team.db')

console.log('=== 任务状态 ===')
for (const r of db.prepare('SELECT id,status,scheduling_state FROM tasks ORDER BY id').all()) {
  console.log('  ', r.id, '任务=', r.status, '调度=', r.scheduling_state ?? '-')
}

console.log('\n=== 尝试 ===')
for (const r of db.prepare('SELECT id,task_id,state,worker_id,lease_epoch FROM run_attempts ORDER BY id').all()) {
  console.log('  ', r.id, '|', r.state, '|', r.worker_id ?? '-')
}

console.log('\n=== 上下文快照（远端路径必须冻结它才能进 Running）===')
for (const r of db.prepare('SELECT attempt_id,scope,task_id,candidate_count,included_count,tokens_kind,snapshot_hash FROM run_context_snapshots ORDER BY recorded_at_ms').all()) {
  console.log('  ', r.attempt_id, '| 候选', r.candidate_count, '纳入', r.included_count, '|', r.tokens_kind, '|', String(r.snapshot_hash).slice(0, 22) + '…')
}

console.log('\n=== 远程通道审计 ===')
for (const r of db.prepare("SELECT ts,action,detail FROM audit WHERE action LIKE 'node:%' ORDER BY seq DESC LIMIT 12").all()) {
  console.log('  ', String(r.ts).slice(11, 19), r.action, String(r.detail ?? '').slice(0, 120))
}

console.log('\n=== 写入预约 ===')
for (const r of db.prepare('SELECT task_id,attempt_id,state FROM write_reservations ORDER BY id').all()) {
  console.log('  ', r.task_id, r.state)
}
