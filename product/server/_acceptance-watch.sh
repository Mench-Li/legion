#!/usr/bin/env bash
# 一次性：把探测 claim 的租约还回去，然后观察真实远程电脑跑完整条链。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
AUTH=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')

echo "=== 释放探测租约（若有）==="
for spec in "$(node -e "
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
const r=db.prepare(\"SELECT id,worker_id,lease_epoch FROM run_attempts WHERE state='Leased' AND worker_id LIKE 'probe%'\").all();
console.log(r.map(x=>x.id+':'+x.worker_id+':'+x.lease_epoch).join(' '))")"; do
  for item in $spec; do
    [ -n "$item" ] || continue
    aid=${item%%:*}; rest=${item#*:}; wid=${rest%%:*}; ep=${rest##*:}
    echo "  释放 $aid（worker=$wid epoch=$ep）"
    curl -sS --max-time 10 -X POST "${AUTH[@]}" \
      -d "$(printf '{"attemptId":"%s","leaseEpoch":%s,"workerId":"%s","reason":"acceptance-probe-release"}' "$aid" "$ep" "$wid")" \
      "$HUB/api/runtime/release" | head -c 160
    echo
  done
done

echo
echo "=== 观察真实节点（每 3 秒，最多 90 秒）==="
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
echo "=== 远程节点做的事（最近 18 条）==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/activity?limit=500" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);const rows=j.activity??j.rows??j;
    const list=(Array.isArray(rows)?rows:[]).filter(x=>String(x.action||"").startsWith("node:"));
    for(const r of list.slice(-18)) console.log("  ", String(r.ts||"").slice(11,19), r.action, JSON.stringify(r.detail??"").slice(0,130))})'
