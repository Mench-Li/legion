#!/usr/bin/env bash
# 一次性：把探测 claim 占住的租约还回去，然后观察真实的远程电脑跑完。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
AUTH=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')

echo "=== 释放探测 claim 占住的租约 ==="
curl -fsS --max-time 10 -X POST "${AUTH[@]}" \
  -d '{"attemptId":"att:T-003:1","leaseEpoch":1,"workerId":"probe-worker","reason":"acceptance-probe-release"}' \
  "$HUB/api/runtime/release" | head -c 200
echo

echo "=== 观察（每 3 秒，最多 90 秒）==="
for i in $(seq 1 30); do
  sleep 3
  board=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=default" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
      console.log(list.filter(v=>v.title&&v.title.startsWith("远程验收")).map(v=>`${v.id}=${v.status}`).join(" "))})')
  att=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/runtime/status" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      console.log(Object.entries(j.byState).filter(([,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(" ")||"全零")})')
  echo "  ${i}: $board   尝试=$att"
  case "$att" in *Validating*) break ;; esac
done

echo
echo "=== 远程节点在这段时间做的事 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/activity?limit=400" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);const rows=j.activity??j.rows??j;
    const list=(Array.isArray(rows)?rows:[]).filter(x=>String(x.action||"").startsWith("node:"));
    for(const r of list.slice(-16)) console.log("  ", String(r.ts||"").slice(11,19), r.action, JSON.stringify(r.detail??"").slice(0,140))})'

echo
echo "=== 最终任务读数 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=default" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
    for(const x of list.filter(v=>v.title&&v.title.startsWith("远程验收")))
      console.log("  ", x.id, "任务=", x.status, " 产物=", JSON.stringify(x.artifacts??[]).slice(0,140))})'
