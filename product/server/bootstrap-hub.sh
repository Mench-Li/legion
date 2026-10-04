#!/usr/bin/env bash
# product/server/bootstrap-hub.sh
# ============================================================================
# Legion Hub 服务器部署（远程 Agent 通道 S-G）
#
# 在 **Ubuntu/Debian** 上以 root 执行。已实测：Ubuntu 24.04.2 / Node 24.21.0。
#
# ## 它做四件事，且每件都幂等
#
#   ① 建专用系统用户与数据目录（Hub 不以 root 跑）；
#   ② 生成/保留两份密钥（Hub 机器令牌 + 身份签名密钥），落 0600 的环境文件；
#   ③ 装 systemd 单元（**单一**监督者，不与 PM2 并存）；
#   ④ 只绑回环 —— 公网入口由 nginx + TLS 提供，Hub 自己不见公网。
#
# ## 为什么密钥是"生成一次就保留"
#
# 身份签名密钥一换，**全部用户会话与设备令牌立即失效**。一个每次跑都重新生成的
# 脚本会在"我只是重跑了一次部署"与"全部设备掉线"之间划等号。
# 所以这里只在**文件不存在**时生成。
#
# ## 不碰什么
#
# 不改既有 nginx 站点、不开防火墙端口、不动 SSH 配置。TLS 入口由
# `setup-tls.sh` 单独负责，两者可以分开回滚。
# ============================================================================
set -euo pipefail

APP_DIR="${LEGION_APP_DIR:-/srv/legion-hub/app}"
DATA_DIR="${LEGION_DATA_DIR:-/var/lib/legion-hub}"
ENV_FILE="${LEGION_ENV_FILE:-/etc/legion-hub.env}"
PORT="${LEGION_HUB_PORT:-8787}"
SERVICE_USER="${LEGION_SERVICE_USER:-legion-hub}"
SCOPE="${LEGION_CLAIM_SCOPE:-}"

test "$(id -u)" -eq 0 || { echo "需要 root" >&2; exit 1; }
test -f "$APP_DIR/team-hub/server.mjs" || { echo "找不到 $APP_DIR/team-hub/server.mjs；先把代码放上去" >&2; exit 1; }

# ── ① 用户与目录 ────────────────────────────────────────────────────────────
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "已创建系统用户 $SERVICE_USER"
fi
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"

# ── ② 密钥（只在缺失时生成）────────────────────────────────────────────────
if test -f "$ENV_FILE"; then
  echo "$ENV_FILE 已存在：保留现有密钥（换密钥会让全部会话与设备立即失效）"
  HUB_TOKEN="$(grep -E '^TEAM_HUB_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
  IDENTITY_KEY="$(grep -E '^LEGION_IDENTITY_KEY=' "$ENV_FILE" | cut -d= -f2-)"
else
  HUB_TOKEN="$(openssl rand -base64 36 | tr -d '/+=' | head -c 48)"
  IDENTITY_KEY="$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)"
  umask 077
  cat > "$ENV_FILE" <<ENV
# Legion Hub 环境（由 product/server/bootstrap-hub.sh 生成；chmod 600）
# 换掉 LEGION_IDENTITY_KEY 会让**全部**用户会话与设备令牌立即失效。
TEAM_HUB_HOST=127.0.0.1
TEAM_HUB_PORT=$PORT
TEAM_HUB_DB=$DATA_DIR/team.db
TEAM_HUB_TOKEN=$HUB_TOKEN
LEGION_IDENTITY_KEY=$IDENTITY_KEY
LEGION_REMOTE_AUTH=1
LEGION_DATA_DIR=$DATA_DIR
LEGION_NODE_CLAIM_SCOPE=$SCOPE
ENV
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE（0600）"
fi
chmod 600 "$ENV_FILE"

# ── ③ systemd 单元 ──────────────────────────────────────────────────────────
# 单一监督者：本单元存在时**不要**再用 PM2 / 手工 nohup 起第二个 Hub。
# 两个进程同时写同一个 SQLite 会以 UNIQUE 约束冲突的形式表现出来（audit.seq 撞号），
# 那是一个看起来像"功能坏了"、实际是"起了两份"的故障。
cat > /etc/systemd/system/legion-hub.service <<UNIT
[Unit]
Description=Legion Hub（远程 Agent 控制面）
Documentation=file://$APP_DIR/docs/superpowers/plans/2026-10-04-legion-server-pc-mobile-agent-implementation.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/team-hub/server.mjs
Restart=on-failure
RestartSec=3
# 数据目录之外不写：Hub 的全部持久状态都在 SQLite 里，
# 让它在别处可写只会制造"重启后某些东西不见了"的谜题。
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable legion-hub >/dev/null 2>&1
systemctl restart legion-hub
sleep 3
systemctl is-active legion-hub

# ── ④ 本机自检（绑回环，所以从服务器本机验）─────────────────────────────────
export HUB_TOKEN
HUB_TOKEN="$(grep -E '^TEAM_HUB_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 -H "Authorization: Bearer $HUB_TOKEN" "http://127.0.0.1:$PORT/api/identity/status" >/tmp/legion-status.json 2>/dev/null; then
    break
  fi
  sleep 2
done
echo "--- /api/identity/status ---"
cat /tmp/legion-status.json
echo
echo "--- 监听面（应只有 127.0.0.1）---"
ss -ltnp | grep ":$PORT" || true
echo "--- 无令牌的读端点应被远程门禁拒绝 ---"
curl -s -o /dev/null -w 'board(no token)=%{http_code}\n' --max-time 3 "http://127.0.0.1:$PORT/api/board?scope=software"
echo "--- 机器令牌放行 ---"
curl -s -o /dev/null -w 'board(hub token)=%{http_code}\n' --max-time 3 -H "Authorization: Bearer $HUB_TOKEN" "http://127.0.0.1:$PORT/api/board?scope=software"
