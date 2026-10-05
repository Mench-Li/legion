#!/usr/bin/env bash
# 一次性：回收过期租约（上一次因缺陷卡住的尝试），然后跑完整验收。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
SCOPE="${LEGION_ACCEPT_SCOPE:-default}"
AUTH=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')

echo "=== 回收前 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/runtime/status" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    console.log("  ", JSON.stringify(j.byState), "过期=", j.expiredLeases)})'

echo
echo "=== 回收过期租约（externalEffectPossibleStates 必须显式给：判成可重试会重跑，判成未知会挂起）==="
curl -fsS --max-time 15 -X POST "${AUTH[@]}" \
  -d '{"externalEffectPossibleStates":["Leased","PreparingWorkspace","BuildingContext","Running"],"limit":50}' \
  "$HUB/api/runtime/recover" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    console.log("  扫描:", j.scanned, " 回收:", (j.recovered??[]).length);
    for(const r of (j.recovered??[])) console.log("   -", r.attemptId, "→", r.to ?? r.state ?? JSON.stringify(r))})'

echo
echo "=== 回收后 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/runtime/status" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    console.log("  ", JSON.stringify(j.byState), "过期=", j.expiredLeases)})'

echo
echo "=== 观察任务推进（每 2 秒，最多 60 秒）==="
for i in $(seq 1 30); do
  sleep 2
  st=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=$SCOPE" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
      const x=list.find(v=>v.title&&v.title.startsWith("远程验收"));console.log(x?x.status:"(无)")})')
  att=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/runtime/status" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      const nz=Object.entries(j.byState).filter(([,v])=>v>0).map(([k,v])=>`${k}:${v}`);console.log(nz.join(" ")||"全零")})')
  echo "  ${i}: 任务=$st  尝试=$att"
  case "$st" in in_review|done|blocked) break ;; esac
done
