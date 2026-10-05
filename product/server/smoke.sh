#!/usr/bin/env bash
# 最终部署 + 冒烟验收（一次调用内完成，避免 nohup 被进程组清理带走）。
set -uo pipefail
SSH="ssh -i /c/Users/11150/.ssh/legion.pem -o BatchMode=yes root@117.72.146.36"

echo "===== ① 部署新代码 ====="
$SSH 'set -e
rm -rf /srv/legion-hub/app.new && mkdir -p /srv/legion-hub/app.new
tar -xzf /tmp/legion-remote2.tar.gz -C /srv/legion-hub/app.new
test -f /srv/legion-hub/app.new/team-hub/node-gateway.mjs
test -f /srv/legion-hub/app.new/workbench/mobile/index.html
rm -rf /srv/legion-hub/app && mv /srv/legion-hub/app.new /srv/legion-hub/app
systemctl restart legion-hub
sleep 4
systemctl is-active legion-hub'

echo "===== ② 服务器侧自检（HTTPS 443）====="
$SSH 'for p in "/api/identity/status" "/mobile/" "/mobile/app.mjs" "/legion-ca.crt"; do
  printf "  %-24s " "$p"; curl -sk -o /dev/null -w "%{http_code}\n" --max-time 8 -H "Host: 117.72.146.36" "https://127.0.0.1$p"; done
printf "  %-24s " "/api/board(无令牌)"; curl -sk -o /dev/null -w "%{http_code}\n" --max-time 8 -H "Host: 117.72.146.36" "https://127.0.0.1/api/board?scope=software"
printf "  %-24s " "80口既有站点/healthz"; curl -s -o /dev/null -w "%{http_code}\n" --max-time 8 -H "Host: 117.72.146.36" http://127.0.0.1/healthz'

echo "===== ③ 公网自检 ====="
for p in "/api/identity/status" "/mobile/"; do
  printf "  %-24s " "$p"; curl -sk -o /dev/null -w "%{http_code}\n" --max-time 15 "https://117.72.146.36$p"; done
printf "  %-24s " "/api/board(无令牌)"; curl -sk -o /dev/null -w "%{http_code}\n" --max-time 15 "https://117.72.146.36/api/board?scope=software"

echo "===== ④ 起 Node 并跑一条端到端任务 ====="
NODE_DIR=/tmp/legion-node
ENTRY=/d/project/DSH/legion/.claude/worktrees/legion-remote-agent/product/node/entry.mjs
cd "$NODE_DIR" || exit 1
rm -f node.log
NODE_EXTRA_CA_CERTS=/tmp/legion-ca.crt node "$ENTRY" run --config node-config.json > node.log 2>&1 &
PID=$!
sleep 8
echo "  node.log:"; sed 's/^/    /' node.log | head -5

srv() { $SSH "set -a; . /etc/legion-hub.env; set +a; node /srv/legion-hub/_acceptance-helper.mjs $1" 2>&1; }
echo "  建任务:"; srv "create" | sed 's/^/    /'
echo "  等 45 秒…"; sleep 45
echo "  状态:"; srv "state" | sed 's/^/    /'
echo "  尝试:"; srv "attempts" | sed 's/^/    /' | tail -4

echo "  审计（node:*）:"
$SSH 'bash -s' <<'REMOTE' 2>&1 | tail -12
set -a; . /etc/legion-hub.env; set +a
curl -fsS --max-time 10 -H "Authorization: Bearer $TEAM_HUB_TOKEN" "http://127.0.0.1:${TEAM_HUB_PORT:-8787}/api/activity?limit=800" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);const rows=j.activity??j.rows??j;
    for(const r of (Array.isArray(rows)?rows:[]).filter(x=>String(x.action||"").startsWith("node:")).slice(-12))
      console.log("    ", String(r.ts||"").slice(11,19), r.action, JSON.stringify(r.detail??"").slice(0,120))})'
REMOTE

echo "  node.log 全文:"; sed 's/^/    /' node.log
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
echo "===== 完成 ====="
