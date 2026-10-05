#!/usr/bin/env bash
# 一次性：读网关运行时读数（诊断"连上了但不派发"）。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
PW="$(cat /etc/legion-hub/first-admin-password.txt)"
TOKEN=$(curl -fsS --max-time 10 -X POST -H 'content-type: application/json' \
  -d "$(printf '{"name":"legion","password":"%s","label":"diag"}' "$PW")" \
  "$HUB/api/identity/login" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).accessToken))')

echo "=== 网关读数 ==="
curl -fsS --max-time 10 -H "Authorization: Bearer $TOKEN" "$HUB/api/devices/gateway"
