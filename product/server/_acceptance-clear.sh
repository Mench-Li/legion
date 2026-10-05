#!/usr/bin/env bash
# 一次性：清掉因停住的尝试而残留的写入预约，然后跑一条**全新**任务到底。
#
# 残留的原因（本次验收发现的接线缺口）：
# 写入预约由 `finishTaskReservationInTx` 结清，而它只在**看板迁移**
# （`to='in_review'|'done'|'canceled'`）时被调用。run-store 的 `projectToTask`
# 是**直接 UPDATE tasks.status**，不走那条路径——于是当一次远端尝试走到终态、
# 看板状态被投影成 `in_review` 时，预约没有被结清，下一条任务会一直看到
# `SINGLE_WRITER_REQUIRED`。
#
# 这里用 `canceled` 结清两条旧任务（它们本来就是卡住的验收残留物）。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
AUTH=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')

cancel_by_title() {
  local title="$1"
  local id ver
  id=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=default" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
      const x=list.find(v=>v.title==='$title');console.log(x?x.id:'')})")
  [ -n "$id" ] || return 0
  ver=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=default" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
      const x=list.find(v=>v.id==='$id');console.log(x?x.version:1)})")
  echo "  取消 $id（v$ver）以结清预约"
  curl -fsS --max-time 10 -X POST "${AUTH[@]}" \
    -d "$(printf '{"by":"acceptance","scope":"default","id":"%s","to":"canceled","ifVersion":%s}' "$id" "$ver")" \
    "$HUB/api/transition" >/dev/null || echo "    (取消失败，可能状态不允许)"
}

echo "=== 结清旧任务 ==="
cancel_by_title "远程验收：跑一次示例任务"
cancel_by_title "远程验收-092618"
cancel_by_title "远程验收-092639"

echo
echo "=== 预约是否已清空 ==="
curl -fsS --max-time 10 -X POST "${AUTH[@]}" -d '{"workerId":"probe3"}' "$HUB/api/runtime/claim" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      console.log("  claimed=", j.claimed? j.claimed.taskId : null, "reason=", j.reason??"-", j.contention?JSON.stringify(j.contention):"")})'
