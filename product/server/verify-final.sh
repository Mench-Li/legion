#!/usr/bin/env bash
# 最终验收（清场版）：
#   ① 验收所有 in_review；取消遗留的验收测试任务（只有最新一条留着跑）
#   ② 起 Node → 新任务跑到 in_review
#   ③ **等过租约 TTL（150s）**，确认它没有被改写成"结果待确认"
#
# 为什么需要 ③：这是本次修复的核心——`Validating` 语义是"执行已结束、等验收"，
# 它的租约过期**不代表**结果不明（runResult 早落库了）。曾经被回收器改写成
# UnknownOutcome，任务从 in_review 掉进 blocked。
set -uo pipefail
SSH="ssh -i /c/Users/11150/.ssh/legion.pem -o BatchMode=yes root@117.72.146.36"
srv() { $SSH "set -a; . /etc/legion-hub.env; set +a; node /srv/legion-hub/_acceptance-helper.mjs $1" 2>&1; }

echo "===== ① 清场 ====="
$SSH 'bash -s' <<'REMOTE' 2>&1 | tail -12
set -a; . /etc/legion-hub.env; set +a
H=http://127.0.0.1:${TEAM_HUB_PORT:-8787}
A=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')
# 验收所有 in_review（by=general：看板要求"只有将军能在用户接受后移到 done"）
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
for(const t of db.prepare(\"SELECT id,version FROM tasks WHERE status='in_review'\").all()) console.log(t.id+'\t'+t.version);" |
while IFS=$'\t' read -r id v; do
  [ -n "$id" ] || continue
  curl -sS --max-time 10 -X POST "${A[@]}" -d "{\"by\":\"general\",\"scope\":\"default\",\"id\":\"$id\",\"to\":\"done\",\"ifVersion\":$v}" "$H/api/transition" >/dev/null && echo "  已验收 $id"
done
# 取消遗留的 todo 验收任务——只留最后一条，避免逐个等人工验收
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
for(const t of db.prepare(\"SELECT id,version FROM tasks WHERE status='todo' AND title LIKE '端到端验收-%'\").all()) console.log(t.id+'\t'+t.version);" |
while IFS=$'\t' read -r id v; do
  [ -n "$id" ] || continue
  curl -sS --max-time 10 -X POST "${A[@]}" -d "{\"by\":\"general\",\"scope\":\"default\",\"id\":\"$id\",\"to\":\"canceled\",\"ifVersion\":$v}" "$H/api/transition" >/dev/null && echo "  已取消 $id"
done
echo "  剩余 todo：$(node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');console.log(db.prepare(\"SELECT COUNT(*) n FROM tasks WHERE status='todo'\").get().n)")"
REMOTE

echo
echo "===== ② 起 Node，建一条任务，等它跑到 in_review ====="
cd /tmp/legion-node || exit 1
rm -f node.log
NODE_EXTRA_CA_CERTS=/tmp/legion-ca.crt node /d/project/DSH/legion/.claude/worktrees/legion-remote-agent/product/node/entry.mjs run --config node-config.json > node.log 2>&1 &
PID=$!
sleep 8
srv "create" | sed 's/^/  建任务: /'

reached=""
for i in $(seq 1 30); do
  sleep 4
  st=$($SSH 'node -e "const {DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(\"/var/lib/legion-hub/team.db\");const r=db.prepare(\"SELECT id,status FROM tasks WHERE title LIKE \x27端到端验收-%\x27 ORDER BY id DESC LIMIT 1\").get();console.log(r.id+\"=\"+r.status)"')
  echo "    ${i}: $st"
  case "$st" in *=in_review*) reached="$st"; break ;; esac
done
[ -n "$reached" ] || { echo "  ✖ 没等到 in_review"; kill "$PID" 2>/dev/null; exit 1; }

TASK_ID=${reached%%=*}
echo
echo "===== ③ 关键：等过租约 TTL（150s），确认 $TASK_ID 没被改写成待确认 ====="
for i in $(seq 1 10); do
  sleep 15
  now=$($SSH "node -e \"const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');const t=db.prepare(\\\"SELECT status FROM tasks WHERE id='$TASK_ID'\\\").get();const a=db.prepare(\\\"SELECT state FROM run_attempts WHERE task_id='$TASK_ID' ORDER BY attempt_no DESC LIMIT 1\\\").get();console.log(t.status+' / 尝试='+a.state)\"")
  echo "    +$((i*15))s: $now"
done

echo
echo "  node.log:"; sed 's/^/    /' node.log
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
echo "===== 完成 ====="
