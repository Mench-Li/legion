#!/usr/bin/env bash
# 一次性：在服务器上初始化第一个系统管理员，并把口令写进 0600 文件
# （刻意不打印到标准输出：它会进日志、进终端回滚缓冲区、进对话记录）。
set -euo pipefail

ENV_FILE=/etc/legion-hub.env
PW_FILE=/etc/legion-hub/first-admin-password.txt
ADMIN_NAME="${LEGION_ADMIN_NAME:-legion}"

set -a; . "$ENV_FILE"; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"

status=$(curl -fsS --max-time 5 "$HUB/api/identity/status")
echo "status: $status"

if echo "$status" | grep -q '"bootstrapped": true'; then
  echo "已经初始化过，不重复引导。"
else
  install -d -m 0700 /etc/legion-hub
  # 32 字节随机 → base64url，去掉易混淆字符。
  PW="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 24)"
  code=$(curl -s -o /tmp/boot.json -w '%{http_code}' --max-time 10 \
    -X POST -H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json' \
    -d "$(printf '{"name":"%s","password":"%s"}' "$ADMIN_NAME" "$PW")" \
    "$HUB/api/identity/bootstrap")
  echo "bootstrap http=$code"
  cat /tmp/boot.json; echo
  if [ "$code" = "200" ]; then
    printf '%s\n' "$PW" > "$PW_FILE"
    chmod 600 "$PW_FILE"
    echo "口令已写入 $PW_FILE（0600，只有 root 可读）"
  else
    echo "引导失败，未写口令文件" >&2
  fi
  rm -f /tmp/boot.json
fi

echo "--- 再查一次 ---"
curl -fsS --max-time 5 "$HUB/api/identity/status"
