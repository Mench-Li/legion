#!/usr/bin/env bash
# 一次性：登录并生成一个设备配对码（打印出来供 PC 兑换）。
# 配对码一次性 + 10 分钟 + 限速，打印它是可接受的。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
NAME="${LEGION_ADMIN_NAME:-legion}"
PW="$(cat /etc/legion-hub/first-admin-password.txt)"

LOGIN=$(curl -fsS --max-time 10 -X POST -H 'content-type: application/json' \
  -d "$(printf '{"name":"%s","password":"%s","label":"acceptance"}' "$NAME" "$PW")" \
  "$HUB/api/identity/login")
TOKEN=$(echo "$LOGIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).accessToken))')

echo "--- 当前身份 ---"
curl -fsS --max-time 10 -H "Authorization: Bearer $TOKEN" "$HUB/api/identity/me"; echo

echo "--- 生成配对码 ---"
PAIR=$(curl -fsS --max-time 10 -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"nodeName":"开发电脑"}' "$HUB/api/devices/pairing")
echo "$PAIR"
echo "$PAIR" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("PAIRING_CODE="+j.code)})'
