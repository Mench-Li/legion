#!/usr/bin/env bash
# product/server/restore-drill.sh
# ============================================================================
# 恢复演练：把备份**真的恢复到一个干净位置并读出来**。
#
# ## 为什么必须演练，而不是"备份脚本跑通了"
#
# "备份任务每天成功"与"出事那天能恢复"是两件事。它们之间的差距只有演练能发现：
#   · 口令丢了 / 记错了；
#   · 备份里少了某张表（写完没验）；
#   · 恢复出来的库能打开但关联断了（任务在、消息不在）。
#
# 所以本脚本刻意在**另一个目录**恢复，并且**用真实的 server.mjs 起一次 Hub**
# 去读它——那才是"恢复"的定义，不是"文件能打开"。
#
# 用法：bash product/server/restore-drill.sh [备份文件] [口令文件]
# ============================================================================
set -euo pipefail

BACKUP="${1:-}"
PASS_FILE="${2:-/etc/legion-hub/backup.passphrase}"
APP_DIR="${LEGION_APP_DIR:-/srv/legion-hub/app}"
DRILL_DIR="$(mktemp -d /tmp/legion-restore-XXXXXX)"
PORT="${DRILL_PORT:-18787}"

cleanup() {
  [ -n "${HUB_PID:-}" ] && kill "$HUB_PID" 2>/dev/null || true
  rm -rf "$DRILL_DIR"
}
trap cleanup EXIT

# 没给备份文件就挑最近的一份。
if [ -z "$BACKUP" ]; then
  BACKUP="$(ls -1t /var/lib/legion-hub/backups/team-*.db /var/lib/legion-hub/backups/team-*.db.gpg 2>/dev/null | head -1 || true)"
fi
test -n "$BACKUP" || { echo "找不到备份文件（也没给参数）" >&2; exit 1; }
test -f "$BACKUP" || { echo "备份不存在：$BACKUP" >&2; exit 1; }
echo "备份：$BACKUP（$(du -h "$BACKUP" | cut -f1)）"

DB="$DRILL_DIR/restored.db"

if [ "${BACKUP%.gpg}" != "$BACKUP" ]; then
  test -f "$PASS_FILE" || { echo "加密备份需要口令文件：$PASS_FILE" >&2; exit 1; }
  echo "① 解密…"
  gpg --batch --yes --quiet --decrypt --passphrase-file "$PASS_FILE" --output "$DB" "$BACKUP"
else
  echo "① 未加密，直接拷贝…"
  cp "$BACKUP" "$DB"
fi
echo "   恢复出 $(du -h "$DB" | cut -f1)"

echo "② 结构与数据核对（用备份脚本自己的检查器）"
node "$APP_DIR/product/server/backup.mjs" --verify "$DB"

echo
echo "③ 用**真实 server.mjs** 在干净目录上把它跑起来（这才是"恢复"的定义）"
cd "$APP_DIR"
TEAM_HUB_DB="$DB" \
TEAM_HUB_PORT="$PORT" \
TEAM_HUB_HOST=127.0.0.1 \
TEAM_HUB_TOKEN="drill-token-$(date +%s)" \
LEGION_IDENTITY_KEY="drill-identity-key-0123456789abcdef" \
node team-hub/server.mjs > "$DRILL_DIR/hub.log" 2>&1 &
HUB_PID=$!

for i in $(seq 1 20); do
  sleep 1
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/identity/status" >/dev/null 2>&1; then break; fi
done

echo "   能力发现：$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/identity/status")"
echo

echo "④ 恢复后的**关联**是否还在（任务在、消息不在等于没恢复）"
TOKEN="$(grep -o 'token=[^ ]*' "$DRILL_DIR/hub.log" | head -1 | cut -d= -f2 || true)"
node -e '
const {DatabaseSync}=require("node:sqlite")
const db=new DatabaseSync(process.argv[1],{readOnly:true})
const q=(s)=>{try{return db.prepare(s).get().n}catch(e){return "ERR:"+e.message.slice(0,40)}}
console.log("   任务",q("SELECT COUNT(*) n FROM tasks"),
            "| 会话",q("SELECT COUNT(*) n FROM conversations"),
            "| 消息",q("SELECT COUNT(*) n FROM messages"))
console.log("   尝试",q("SELECT COUNT(*) n FROM run_attempts"),
            "| 运行事件",q("SELECT COUNT(*) n FROM run_events"),
            "| 上下文快照",q("SELECT COUNT(*) n FROM run_context_snapshots"))
console.log("   用户",q("SELECT COUNT(*) n FROM hub_users"),
            "| 设备",q("SELECT COUNT(*) n FROM hub_devices"),
            "| 审计",q("SELECT COUNT(*) n FROM audit"))
// 关联：每条 agent 会话绑定都应指向一个真实存在的会话
const orphanBindings = db.prepare("SELECT COUNT(*) n FROM agent_conversation_bindings b WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id=b.conv_id)").get().n
const orphanMessages = db.prepare("SELECT COUNT(*) n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id=m.conv_id)").get().n
console.log("   断链：会话绑定", orphanBindings, "条 | 消息挂在不存在会话下", orphanMessages, "条")
process.exit(orphanBindings===0 && orphanMessages===0 ? 0 : 1)
' "$DB" && echo "   ✔ 关联完整" || { echo "   ✖ 关联断了——这份备份不能算可用"; exit 1; }

echo
echo "⑤ 恢复出来的 Hub 能读到真实业务数据（不只是在文件层面"能打开"）"
curl -fsS --max-time 5 -H "Authorization: Bearer $(grep -o 'token=[^ ]*' "$DRILL_DIR/hub.log" | head -1 | cut -d= -f2)" \
  "http://127.0.0.1:$PORT/api/board?scope=default" | head -c 200
echo
echo
echo "✔ 恢复演练通过：备份可解密、结构完整、关联未断、真实 Hub 能起来并读到数据。"
echo "  本次恢复目录 $DRILL_DIR 结束即清理（演练不该留下第二份生产数据）。"
