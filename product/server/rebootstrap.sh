#!/usr/bin/env bash
# product/server/rebootstrap.sh
# ============================================================================
# 清库重建第一个账号（**换口令的唯一途径**）
#
# ## 为什么不是"改口令"
#
# Hub **没有改口令的接口**——这是多用户身份层的第 N 个未接功能，不是遗漏。
# 在它做出来之前，换口令只有一条路：把身份数据清掉、重新引导。
#
# ## 为什么清**整库**而不是只删 hub_users
#
# 只删用户表会留下一批**悬挂引用**：`hub_devices.user_id`、
# `hub_space_roles.user_id`、`hub_invites.created_by` 都指向那个不再存在的 user id。
# 它们不会报错（`deviceStore.authenticate` 只查令牌哈希，不查用户还在不在），
# 于是表现为"一切正常"，直到某天有人问"这台设备是谁的"。
#
#   > 一个"删得干净"的重建，与一个"留下悬挂引用但不报错"的重建，
#   > 在只看能不能登录的时候是同一个东西。
#
# 所以本脚本**整库换掉**：旧库改名留档（不是删除），新库从零引导。
#
# ## 旧库留在哪
#
# `/var/lib/legion-hub/team.db.pre-rebootstrap-<时间戳>`。**不删**——
# "反正只是测试数据"这句话在真出事的那天不成立，而留一份的成本是一个文件。
# 确认新库没问题之后再手工删。
#
# 用法：bash product/server/rebootstrap.sh <新口令文件> [用户名]
# ============================================================================
set -euo pipefail

PW_FILE="${1:-}"
ADMIN_NAME="${2:-legion}"
APP_DIR="${LEGION_APP_DIR:-/srv/legion-hub/app}"
DATA_DIR="${LEGION_DATA_DIR:-/var/lib/legion-hub}"
ENV_FILE="${LEGION_ENV_FILE:-/etc/legion-hub.env}"

test "$(id -u)" -eq 0 || { echo "需要 root" >&2; exit 1; }
test -n "$PW_FILE" || { echo "用法：rebootstrap.sh <新口令文件> [用户名]" >&2; exit 1; }
test -f "$PW_FILE" || { echo "口令文件不存在：$PW_FILE" >&2; exit 1; }

PW="$(tr -d '\r\n' < "$PW_FILE")"
test "${#PW}" -ge 8 || { echo "口令至少 8 个字符（当前 ${#PW}）" >&2; exit 1; }

set -a; . "$ENV_FILE"; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "① 停 Hub"
systemctl stop legion-hub
sleep 2

echo "② 旧库改名留档（**不删**）"
for suffix in '' '-wal' '-shm'; do
  if [ -f "$DATA_DIR/team.db$suffix" ]; then
    mv "$DATA_DIR/team.db$suffix" "$DATA_DIR/team.db.pre-rebootstrap-$STAMP$suffix"
    echo "   → team.db.pre-rebootstrap-$STAMP$suffix"
  fi
done

echo "③ 起 Hub（空库，schema 自建）"
systemctl start legion-hub
for i in $(seq 1 20); do
  sleep 1
  curl -fsS --max-time 3 "$HUB/api/identity/status" >/dev/null 2>&1 && break
done
curl -fsS --max-time 5 "$HUB/api/identity/status" | sed 's/^/   /'

echo "④ 引导新账号（口令从文件读，不进 shell 历史、不进日志）"
# 口令经 stdin 交给 node 拼 JSON，避免出现在 argv（`ps` 能看到 argv）。
RESP="$(PW="$PW" NAME="$ADMIN_NAME" TOKEN="$TEAM_HUB_TOKEN" HUB="$HUB" node -e '
  const body = JSON.stringify({ name: process.env.NAME, password: process.env.PW })
  fetch(process.env.HUB + "/api/identity/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + process.env.TOKEN },
    body,
  }).then(async (r) => { const t = await r.text(); process.stdout.write(`${r.status} ${t}`) })
')"
echo "   $RESP"
case "$RESP" in 200*) ;; *) echo "引导失败，中止" >&2; exit 1 ;; esac

echo "⑤ 装最小可用流程包（否则手机端 Agent 列表是空的）"
# ★ 用**文件**而不是内联 `node -e`。
#
# 内联那版把 `require()` 与顶层 `await` 放在同一个 `-e` 脚本里，Node 抛
# `ERR_AMBIGUOUS_MODULE_SYNTAX`（无法判断按 CJS 还是 ESM 解析）——
# 而调用方的 `|| echo` 把它报成了"登录环节失败"，于是**真实的模块格式错误
# 被伪装成口令问题**，排查方向直接跑偏。脚本要能如实报出是哪一步坏的。
if node "$APP_DIR/product/server/install-first-pack.mjs" "$HUB" /srv/legion-hub/first-space.pack.json /etc/legion-hub/first-admin-password.txt; then
  echo "   流程包已装"
else
  echo "   ⚠ 流程包**未装成功**（见上方原话）：手机端会看到空的 Agent 列表。" >&2
  echo "     重跑：node $APP_DIR/product/server/install-first-pack.mjs" >&2
fi

echo "⑥ 把新口令写回**规范位置**（服务器侧那份）"
#
# ★ 只写**一处**。曾经同时存在 `/etc/legion-hub/` 与数据目录两份，
#   于是重新引导之后 `/etc/legion-hub/` 那份是**旧口令**，而校验脚本读的是它——
#   表现为"口令不对"，实际是"同一条事实有两个副本，其中一个是过期的"。
#
#   规范位置选 `/etc/legion-hub/`：它是 0700 root，服务账号读不到。
#   （数据目录属于 `legion-hub`，那份是**备份口令**的位置，它需要被服务账号读到，
#     两件事的需求不同，因此不放在一起。）
umask 077
printf '%s\n' "$PW" > /etc/legion-hub/first-admin-password.txt
chmod 600 /etc/legion-hub/first-admin-password.txt
chown root:root /etc/legion-hub/first-admin-password.txt
rm -f "$DATA_DIR/first-admin-password.txt"   # 清掉可能存在的重复副本
echo "   → /etc/legion-hub/first-admin-password.txt（已清掉数据目录里的副本）"
echo
echo "完成。设备配对已失效（旧库留档），电脑上需重新 pair。"
echo "旧库留档：$DATA_DIR/team.db.pre-rebootstrap-$STAMP"
