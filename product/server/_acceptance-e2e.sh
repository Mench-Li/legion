#!/usr/bin/env bash
# 端到端验收（自包含）：起 Node、建任务、看它跑完。
set -uo pipefail

NODE_DIR=/tmp/legion-node
ENTRY=/d/project/DSH/legion/.claude/worktrees/legion-remote-agent/product/node/entry.mjs
SSH="ssh -i /c/Users/11150/.ssh/legion.pem -o BatchMode=yes root@117.72.146.36"
SRV='bash -lc "set -a; . /etc/legion-hub.env; set +a; node /srv/legion-hub/_acceptance-helper.mjs'

srv() { $SSH "set -a; . /etc/legion-hub.env; set +a; node /srv/legion-hub/_acceptance-helper.mjs $1" 2>&1; }

echo "----- ① 起 Node -----"
cd "$NODE_DIR" || exit 1
rm -f node.log
NODE_EXTRA_CA_CERTS=/tmp/legion-ca.crt node "$ENTRY" run --config node-config.json > node.log 2>&1 &
NODE_PID=$!
echo "  pid=$NODE_PID"

echo "----- ② 等注册 -----"
for i in $(seq 1 15); do
  sleep 2
  online=$($SSH 'bash -s' <<'REMOTE' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s.replace(/^[^{]*/,"")).online??-1)}catch{console.log(-1)}})'
set -a; . /etc/legion-hub.env; set +a
PW=$(cat /etc/legion-hub/first-admin-password.txt)
T=$(curl -fsS --max-time 10 -X POST -H 'content-type: application/json' -d "$(printf '{"name":"legion","password":"%s","label":"diag"}' "$PW")" "http://127.0.0.1:${TEAM_HUB_PORT:-8787}/api/identity/login" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).accessToken))')
curl -fsS --max-time 10 -H "Authorization: Bearer $T" "http://127.0.0.1:${TEAM_HUB_PORT:-8787}/api/devices/gateway"
REMOTE
)
  echo "  第 ${i} 次：online=$online"
  [ "$online" = "1" ] && break
done

echo "----- ③ 建任务并推 todo（服务器侧 JS，无嵌套引号）-----"
srv "create" | sed 's/^/  /'

echo "----- ④ 观察（每 3 秒，最多 120 秒）-----"
for i in $(seq 1 40); do
  sleep 3
  line=$(srv "state")
  echo "  ${i}: $line"
  case "$line" in *Validating*|*in_review*) break ;; esac
done

echo "----- ⑤ 审计：远程节点做的事 -----"
$SSH 'bash -s' <<'REMOTE' 2>&1 | tail -16
set -a; . /etc/legion-hub.env; set +a
curl -fsS --max-time 10 -H "Authorization: Bearer $TEAM_HUB_TOKEN" "http://127.0.0.1:${TEAM_HUB_PORT:-8787}/api/activity?limit=600" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);const rows=j.activity??j.rows??j;
    for(const r of (Array.isArray(rows)?rows:[]).filter(x=>String(x.action||"").startsWith("node:")).slice(-16))
      console.log("  ", String(r.ts||"").slice(11,19), r.action, JSON.stringify(r.detail??"").slice(0,120))})'
REMOTE

echo "----- ⑥ 尝试与预约 -----"
srv "attempts" | sed 's/^/  /'

echo "----- ⑦ 收尾 -----"
kill "$NODE_PID" 2>/dev/null && echo "  已停 Node"
wait "$NODE_PID" 2>/dev/null
echo "  完成"
