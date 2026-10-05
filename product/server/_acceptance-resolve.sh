#!/usr/bin/env bash
# 一次性：用**人工对账**路径处置 T-001（本次验收里因缺陷卡住的那次尝试）。
#
# 事实：执行器**跑完了**（进展帧 seq 1..4 已入库），但它只向 stdout 打印 JSON，
# 没有触碰任何外部系统、没有写仓库、没有推送。所以诚实的决定是
# `external-effect-absent` —— 外部写未生效 → RetryableFailure → 允许重试。
#
# 这正是设计要求的路径：UnknownOutcome 只能由**人**给出结论，不能自动重跑。
set -euo pipefail

set -a; . /etc/legion-hub.env; set +a
HUB="http://127.0.0.1:${TEAM_HUB_PORT:-8787}"
AUTH=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')

echo "=== 待人工处置的清单 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/runtime/held" | head -c 600
echo

echo "=== 处置 att:T-001:1 → external-effect-absent ==="
curl -fsS --max-time 15 -X POST "${AUTH[@]}" \
  -d '{"attemptId":"att:T-001:1","decision":"external-effect-absent","actor":"acceptance","note":"执行器只向 stdout 打印 JSON，未写仓库、未调外部系统；进展帧 1..4 已入库为据"}' \
  "$HUB/api/runtime/resolve" | head -c 700
echo

echo "=== 处置后的运行面 ==="
curl -fsS --max-time 10 "${AUTH[@]}" "$HUB/api/runtime/status" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
    console.log("  ", Object.entries(j.byState).filter(([,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(" ")||"全零")})'

echo "=== 单写者占用是否已释放（再问一次 claim）==="
curl -fsS --max-time 10 -X POST "${AUTH[@]}" -d '{"workerId":"probe-worker"}' "$HUB/api/runtime/claim" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      console.log("  claimed=", j.claimed? j.claimed.taskId+" "+j.claimed.attemptId : null, " reason=", j.reason??"-");
      if(j.contention) console.log("  contention=", JSON.stringify(j.contention))})'
