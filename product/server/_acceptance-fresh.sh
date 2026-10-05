#!/usr/bin/env bash
# 一次性：建一条**全新**任务，推 todo，观察远程电脑跑完整条链。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
SCOPE="${LEGION_ACCEPT_SCOPE:-default}"
AUTH=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')
TITLE="远程验收-$(date +%H%M%S)"

echo "=== 建任务：$TITLE ==="
curl -fsS --max-time 10 -X POST "${AUTH[@]}" \
  -d "$(printf '{"by":"acceptance","scope":"%s","title":"%s","role":"general"}' "$SCOPE" "$TITLE")" \
  "$HUB/api/create" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("  建到:", j.task?.id ?? JSON.stringify(j).slice(0,120))})'

TID=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=$SCOPE" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
    const x=list.find(v=>v.title==='$TITLE');console.log(x?x.id:'')})")
test -n "$TID" || { echo "建任务失败" >&2; exit 1; }
VER=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=$SCOPE" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
    const x=list.find(v=>v.id==='$TID');console.log(x?x.version:1)})")
echo "  任务 $TID 版本 $VER"

echo "=== backlog → todo ==="
curl -fsS --max-time 10 -X POST "${AUTH[@]}" \
  -d "$(printf '{"by":"acceptance","scope":"%s","id":"%s","to":"todo","ifVersion":%s}' "$SCOPE" "$TID" "$VER")" \
  "$HUB/api/transition" >/dev/null
echo "  ok"

echo "=== 观察（每 2 秒，最多 60 秒）==="
for i in $(seq 1 30); do
  sleep 2
  st=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=$SCOPE" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
      const x=list.find(v=>v.id==='$TID');console.log(x?x.status:'(无)')})")
  att=$(curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/runtime/status" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      console.log(Object.entries(j.byState).filter(([,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(" ")||"全零")})')
  echo "  ${i}: 任务=$st  尝试=$att"
  case "$st" in in_review|done|blocked) break ;; esac
done

echo
echo "=== 这条任务的运行事件（远程回报的进展明细）==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/activity?limit=300" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const j=JSON.parse(s);const rows=j.activity??j.rows??j;
    for(const r of (Array.isArray(rows)?rows:[]).filter(x=>String(x.action||'').startsWith('node:')))
      console.log('  ', String(r.ts||'').slice(11,19), r.action, JSON.stringify(r.detail??'').slice(0,150))})"

echo
echo "=== 最终任务读数 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/board?scope=$SCOPE" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
    for(const x of list.filter(v=>v.title&&v.title.startsWith('远程验收')))
      console.log('  ', x.id, '状态=', x.status, '产物=', JSON.stringify(x.artifacts??[]).slice(0,120))})"
