#!/usr/bin/env bash
# 一次性：用设计好的**人工释放**路径清掉残留的写入预约。
#
# `write_reservations` 停在 `reconciling` 是**正确的**设计（"进程是否真的停了"
# 需要人来确认），而确认入口就是 `POST /api/tasks/:id/reservation/release`。
# 本次验收里那些预约之所以残留，是因为远端 Node 目前**没有参与预约生命周期**
# （见实施计划 §6.1 的"已知缺口"），而不是这条路不存在。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
AUTH=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')

echo "=== 当前活跃预约 ==="
rows=$(node -e "
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
const r=db.prepare(\"SELECT task_id,attempt_id,lease_epoch,state FROM write_reservations WHERE state IN ('reserved','reconciling') ORDER BY id\").all();
console.log(JSON.stringify(r));")
echo "  $rows"

echo "$rows" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    for(const r of JSON.parse(s)) console.log(`${r.task_id}\t${r.attempt_id}\t${r.lease_epoch}`)})' | while IFS=$'\t' read -r task attempt epoch; do
  [ -n "$task" ] || continue
  echo "=== 释放 $task（attempt=$attempt epoch=$epoch）==="
  curl -sS --max-time 10 -X POST "${AUTH[@]}" \
    -d "$(printf '{"by":"acceptance","scope":"default","epoch":%s,"attemptId":"%s"}' "$epoch" "$attempt")" \
    "$HUB/api/tasks/$task/reservation/release" | head -c 300
  echo
done

echo
echo "=== 释放后能否领取 ==="
curl -fsS --max-time 10 -X POST "${AUTH[@]}" -d '{"workerId":"probe5"}' "$HUB/api/runtime/claim" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      console.log("  claimed=", j.claimed? j.claimed.taskId+" "+j.claimed.attemptId : null, "reason=", j.reason??"-", j.contention?JSON.stringify(j.contention):"")})'
