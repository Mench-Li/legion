#!/usr/bin/env bash
# 在服务器上生成一个设备配对码（一次性、10 分钟、限速），打印出来供 PC 兑换。
set -euo pipefail
set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
PW_FILE=/etc/legion-hub/first-admin-password.txt

PW="$(cat "$PW_FILE")"
HUB="$HUB" PW="$PW" node --input-type=module -e '
const login = await fetch(process.env.HUB + "/api/identity/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "legion", password: process.env.PW, label: "pairing" }),
}).then((r) => r.json())
if (typeof login.accessToken !== "string") { console.error("登录失败:", login.error ?? login); process.exit(1) }
const r = await fetch(process.env.HUB + "/api/devices/pairing", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " + login.accessToken },
  body: JSON.stringify({ nodeName: "开发电脑" }),
}).then((x) => x.json())
if (typeof r.code !== "string") { console.error("生成配对码失败:", r.error ?? r); process.exit(1) }
console.log(r.code)
'
