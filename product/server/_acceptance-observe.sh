#!/usr/bin/env bash
# 一次性：释放探测 claim 占住的 att:T-004:1（租约已过期），然后**只观察**、不再探测。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
AUTH=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')

echo "=== 释放 att:T-004:1（worker=probe5, epoch=1）==="
curl -sS --max-time 10 -X POST "${AUTH[@]}" \
  -d '{"attemptId":"att:T-004:1","leaseEpoch":1,"workerId":"probe5","reason":"acceptance-probe-release"}' \
  "$HUB/api/runtime/release" | head -c 300
echo

sleep 2
echo "=== 尝试与预约现状 ==="
node -e "
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
for(const r of db.prepare('SELECT id,state,worker_id,lease_epoch FROM run_attempts ORDER BY id').all()) console.log('  ', JSON.stringify(r));
console.log('  预约:');
for(const r of db.prepare('SELECT task_id,state FROM write_reservations WHERE state IN (\'reserved\',\'reconciling\')').all()) console.log('   ', JSON.stringify(r));
"

echo
echo "=== 只观察（每 3 秒，最多 120 秒；不再探测 claim）==="
for i in $(seq 1 40); do
  sleep 3
  st=$(node -e "
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
const t=db.prepare(\"SELECT status FROM tasks WHERE id='T-004'\").get();
const a=db.prepare(\"SELECT state,worker_id FROM run_attempts WHERE task_id='T-004' ORDER BY attempt_no DESC LIMIT 1\").get();
console.log((t?t.status:'?')+' | '+(a?a.state+' by '+(a.worker_id??'-'):'-'));")
  echo "  ${i}: $st"
  case "$st" in *Validating*) break ;; esac
done

echo
echo "=== 远程节点做的事 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/activity?limit=600" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);const rows=j.activity??j.rows??j;
    const list=(Array.isArray(rows)?rows:[]).filter(x=>String(x.action||"").startsWith("node:"));
    for(const r of list.slice(-20)) console.log("  ", String(r.ts||"").slice(11,19), r.action, JSON.stringify(r.detail??"").slice(0,130))})'
