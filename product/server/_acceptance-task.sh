#!/usr/bin/env bash
# 一次性：建一条任务，然后观察它是否被远程电脑领取、执行、回报。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
SCOPE="${LEGION_ACCEPT_SCOPE:-default}"

echo "=== 建任务（scope=$SCOPE）==="
curl -fsS --max-time 10 -X POST -H "Authorization: Bearer $TEAM_HUB_TOKEN" \
  -H 'content-type: application/json' \
  -d "$(printf '{"by":"acceptance","scope":"%s","title":"远程验收：跑一次示例任务","role":"general"}' "$SCOPE")" \
  "$HUB/api/create" | head -c 400
echo

echo "=== 等待远程电脑领取（最多 30 秒）==="
for i in $(seq 1 15); do
  sleep 2
  info=$(curl -fsS --max-time 10 -H "Authorization: Bearer $TEAM_HUB_TOKEN" \
    "$HUB/api/run-attempts?scope=$SCOPE" 2>/dev/null || echo '{}')
  # 用 events 面看 attempt 状态更直接；这里退回到任务列表 + 运行事件。
  tasks=$(curl -fsS --max-time 10 -H "Authorization: Bearer $TEAM_HUB_TOKEN" \
    "$HUB/api/board?scope=$SCOPE" 2>/dev/null || echo '[]')
  line=$(echo "$tasks" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);const x=list.find(v=>v.title&&v.title.startsWith("远程验收"));console.log(x?`${x.id} status=${x.status} soldier=${x.soldier??"-"}`:"(无)")}catch(e){console.log("(解析失败)")}
    })')
  echo "  第 ${i} 次：$line"
  case "$line" in
    *"status=todo"*) ;;
    *"status=in_progress"*|*"status=in_review"*|*"status=done"*) break ;;
  esac
done

echo
echo "=== 任务最终读数 ==="
curl -fsS --max-time 10 -H "Authorization: Bearer $TEAM_HUB_TOKEN" "$HUB/api/board?scope=$SCOPE" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s);const list=Array.isArray(t)?t:(t.tasks??[]);
    for(const x of list.filter(v=>v.title&&v.title.startsWith("远程验收")))
      console.log(`  ${x.id}  任务状态=${x.status}  执行方=${x.soldier??"-"}  版本=${x.version}`)
  })'

echo
echo "=== 运行事件（远程回报的进展）==="
curl -fsS --max-time 10 -H "Authorization: Bearer $TEAM_HUB_TOKEN" "$HUB/api/runtime/status" | head -c 300
echo
