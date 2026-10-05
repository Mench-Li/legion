#!/usr/bin/env bash
# 一次性：把验收任务推到 todo，然后观察远程电脑领取、执行、回报的全过程。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
SCOPE="${LEGION_ACCEPT_SCOPE:-default}"
AUTH=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')

TID=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=$SCOPE" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
    const x=list.find(v=>v.title&&v.title.startsWith("远程验收"));console.log(x?x.id:"")})')
test -n "$TID" || { echo "找不到验收任务" >&2; exit 1; }
echo "任务：$TID"

VER=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=$SCOPE" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
    const x=list.find(v=>v.id==='$TID');console.log(x?x.version:1)})")
echo "版本：$VER"

echo "=== backlog → todo（认领的资格闸门要求 todo）==="
curl -fsS --max-time 10 -X POST "${AUTH[@]}" \
  -d "$(printf '{"by":"acceptance","scope":"%s","id":"%s","to":"todo","ifVersion":%s}' "$SCOPE" "$TID" "$VER")" \
  "$HUB/api/transition" | head -c 200
echo

echo "=== 观察（每 2 秒，最多 40 秒）==="
for i in $(seq 1 20); do
  sleep 2
  line=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=$SCOPE" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
      const x=list.find(v=>v.id==='$TID');console.log(x?\`\${x.status} soldier=\${x.soldier??'-'}\`:'(无)')})")
  echo "  ${i}: $line"
  case "$line" in
    in_review*|done*|blocked*) break ;;
  esac
done

echo
echo "=== 运行面读数 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/runtime/status" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    console.log("  各状态：", JSON.stringify(j.byState));console.log("  过期租约：", j.expiredLeases)})'

echo
echo "=== 审计里与远程节点有关的行 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/activity?limit=200" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);const rows=j.activity??j.rows??j;
    for(const r of (Array.isArray(rows)?rows:[]).filter(x=>String(x.action||"").startsWith("node:")).slice(-14))
      console.log("  ", r.ts||"", r.action, JSON.stringify(r.detail??"").slice(0,120))})'
