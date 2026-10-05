#!/usr/bin/env bash
# 收尾验收：验收 T-004（释放写入位）→ 建一条新任务 → 看它自己跑完。
set -uo pipefail
SSH="ssh -i /c/Users/11150/.ssh/legion.pem -o BatchMode=yes root@117.72.146.36"
srv() { $SSH "set -a; . /etc/legion-hub.env; set +a; node /srv/legion-hub/_acceptance-helper.mjs $1" 2>&1; }

echo "===== ① 验收 T-004（in_review → done），结清它持有的写入位 ====="
$SSH 'bash -s' <<'REMOTE' 2>&1 | tail -8
set -a; . /etc/legion-hub.env; set +a
H=http://127.0.0.1:${TEAM_HUB_PORT:-8787}
V=$(node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');const t=db.prepare(\"SELECT version FROM tasks WHERE id='T-004'\").get();console.log(t?t.version:1)")
echo "  T-004 版本 $V"
curl -sS --max-time 10 -X POST -H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json' \
  -d "{\"by\":\"acceptance\",\"scope\":\"default\",\"id\":\"T-004\",\"to\":\"done\",\"ifVersion\":$V}" \
  "$H/api/transition" | head -c 200
echo
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
console.log('  T-004 任务=', db.prepare(\"SELECT status,scheduling_state FROM tasks WHERE id='T-004'\").get());
console.log('  预约:', db.prepare(\"SELECT task_id,state FROM write_reservations WHERE task_id='T-004'\").all());"
REMOTE

echo
echo "===== ② 起 Node，建一条全新任务，看它自己跑完 ====="
cd /tmp/legion-node || exit 1
rm -f node.log
NODE_EXTRA_CA_CERTS=/tmp/legion-ca.crt node /d/project/DSH/legion/.claude/worktrees/legion-remote-agent/product/node/entry.mjs run --config node-config.json > node.log 2>&1 &
PID=$!
sleep 8
echo "  建任务:"; srv "create" | sed 's/^/    /'

echo "  观察（每 4 秒，最多 100 秒）:"
for i in $(seq 1 25); do
  sleep 4
  line=$(srv "state")
  echo "    ${i}: $line"
  case "$line" in *Validating*|*in_review*) break ;; esac
done

echo
echo "  node.log:"; sed 's/^/    /' node.log
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
echo "===== 完成 ====="
