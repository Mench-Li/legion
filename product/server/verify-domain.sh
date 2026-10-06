#!/usr/bin/env bash
# 走**可信域名**的完整闭环验收（Cloudflare 终止 TLS + 隧道 + nginx origin 别名）。
#
# 与 smoke.sh 的区别：smoke 走公网 IP + 自签证书（直连 nginx 443），
# 这里走 `https://legion-si.online` —— 即真实生产入口，可信证书、无需装 CA。
set -uo pipefail
SSH="ssh -i /c/Users/11150/.ssh/legion.pem -o BatchMode=yes root@117.72.146.36"
srv() { $SSH "set -a; . /etc/legion-hub.env; set +a; node /srv/legion-hub/_acceptance-helper.mjs $1" 2>&1; }

cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; }
trap cleanup EXIT

echo "===== ① 公网域名自检（可信证书，不加 -k）====="
for p in /api/identity/status /mobile/ /mobile/app.mjs /mobile/manifest.webmanifest /mobile/icon-192.png; do
  printf "  %-30s " "$p"
  curl -sS --max-time 25 -o /dev/null -w "%{http_code} %{content_type} tls=%{ssl_verify_result}\n" "https://legion-si.online$p"
done
printf "  %-30s " "/api/board(无令牌)"
curl -sS --max-time 25 -o /dev/null -w "%{http_code}\n" "https://legion-si.online/api/board?scope=software"

echo
echo "===== ② SSE 不被缓冲（手机的进展流靠它）====="
# 关缓冲时：连接后应立刻收到 `retry:` 行；被缓冲时这里会挂到超时。
head=$(curl -sS --max-time 8 -N -H "Authorization: Bearer $(ssh -i /c/Users/11150/.ssh/legion.pem -o BatchMode=yes root@117.72.146.36 'set -a; . /etc/legion-hub.env; set +a; echo $TEAM_HUB_TOKEN')" \
  "https://legion-si.online/api/events?scope=default&kind=mobile" 2>&1 | head -c 40)
echo "  首帧：$(printf '%s' "$head" | head -2 | tr '\n' ' ')"

echo
echo "===== ③ 起 Node（wss://legion-si.online/node）并跑一条任务 ====="
cd /tmp/legion-node || exit 1
rm -f node.log
node /d/project/DSH/legion/.claude/worktrees/legion-remote-agent/product/node/entry.mjs run --config node-config.json > node.log 2>&1 &
PID=$!
sleep 10
sed 's/^/  /' node.log

# 清掉挡路的已完成任务，让新任务能拿到写入位
$SSH 'bash -s' <<'REMOTE' >/dev/null 2>&1
set -a; . /etc/legion-hub.env; set +a
H=http://127.0.0.1:${TEAM_HUB_PORT:-8787}
A=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
for(const t of db.prepare(\"SELECT id,version FROM tasks WHERE status='in_review'\").all()) console.log(t.id+'\t'+t.version);" |
while IFS=$'\t' read -r id v; do [ -n "$id" ] && curl -sS --max-time 10 -X POST "${A[@]}" -d "{\"by\":\"general\",\"scope\":\"default\",\"id\":\"$id\",\"to\":\"done\",\"ifVersion\":$v}" "$H/api/transition" >/dev/null; done
REMOTE

echo "  建任务:"; srv "create" | sed 's/^/    /'

reached=""
for i in $(seq 1 25); do
  sleep 4
  st=$($SSH 'node -e "const {DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(\"/var/lib/legion-hub/team.db\");const r=db.prepare(\"SELECT id,status FROM tasks WHERE title LIKE \x27端到端验收-%\x27 ORDER BY id DESC LIMIT 1\").get();console.log(r.id+\"=\"+r.status)"')
  echo "    ${i}: $st"
  case "$st" in *=in_review*) reached="$st"; break ;; esac
done

echo
if [ -n "$reached" ]; then
  echo "  ✔ 走可信域名的闭环成功：$reached"
else
  echo "  ✖ 未在时限内到 in_review"; sed 's/^/    /' node.log
fi

echo
echo "  node.log:"; sed 's/^/    /' node.log
echo "  审计（最近 8 条 node:*）:"
$SSH 'bash -s' <<'REMOTE' 2>&1 | tail -8
set -a; . /etc/legion-hub.env; set +a
curl -fsS --max-time 10 -H "Authorization: Bearer $TEAM_HUB_TOKEN" "http://127.0.0.1:${TEAM_HUB_PORT:-8787}/api/activity?limit=600" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const j=JSON.parse(s);const rows=j.activity??j.rows??j;
    for(const r of (Array.isArray(rows)?rows:[]).filter(x=>String(x.action||"").startsWith("node:")).slice(-8))
      console.log("    ", String(r.ts||"").slice(11,19), r.action, JSON.stringify(r.detail??"").slice(0,110))})'
REMOTE
echo "===== 完成 ====="
