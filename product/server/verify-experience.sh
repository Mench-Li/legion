#!/usr/bin/env bash
# 设计文档 §1 的**核心体验**端到端验收：
#
#   在**同一个 Agent 详情**里汇合三类信息——
#   用户与 Agent 的对话、Agent 正在做的任务、可追溯的进展和结果。
#
# 走**手机那条路**：手机发一条 intent=create_task 的消息 →
# Hub 建任务 → 派给电脑 Node → 电脑执行 → 进展与终态回到**同一条时间线**。
#
# 与之前几次验收的分工：之前是"Hub 直接建任务 + 看 Node 执行"，
# 这次多了**手机消息那一段**——它才是用户真正会做的动作。
# 关键断言不是"任务完成了"，而是**Agent 的进展出现在手机正在读的那条会话里**。
set -uo pipefail

SSH="ssh -i /c/Users/11150/.ssh/legion.pem -o BatchMode=yes root@117.72.146.36"
NODE_DIR=/tmp/legion-node
ENTRY=/d/project/DSH/legion/.claude/worktrees/legion-remote-agent/product/node/entry.mjs
phone() { $SSH "set -a; . /etc/legion-hub.env; set +a; node /srv/legion-hub/_phone-act.mjs $*" 2>&1; }

cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; }
trap cleanup EXIT

echo "===== ① 起电脑 Node（出站 WSS 到可信域名）====="
cd "$NODE_DIR" || exit 1
rm -f node.log
node "$ENTRY" run --config node-config.json > node.log 2>&1 &
PID=$!
sleep 12
sed 's/^/  /' node.log

echo
echo "===== ② 先腾出写入位：验收上一次留下的已完成任务 ====="
# ★ 队列**按验收串行**：一条交付在 `in_review` 期间一直持有单写者位
#   （`write_reservations`），下一个任务领不到。这是设计（"单写者 + 交付需验收"），
#   不是排队坏了——但它意味着**每一次验收演示都要先结清上一次**。
#   `by` 必须是 `general`：看板规则要求"只有将军能在用户接受后把任务移到 done"。
$SSH 'bash -s' <<'REMOTE' 2>&1 | tail -6
set -a; . /etc/legion-hub.env; set +a
H=http://127.0.0.1:${TEAM_HUB_PORT:-8787}
A=(-H "Authorization: Bearer $TEAM_HUB_TOKEN" -H 'content-type: application/json')
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
for(const t of db.prepare(\"SELECT id,version FROM tasks WHERE status='in_review'\").all()) console.log(t.id+'\t'+t.version);" |
while IFS=$'\t' read -r id v; do
  [ -n "$id" ] || continue
  curl -sS --max-time 10 -X POST "${A[@]}" -d "{\"by\":\"general\",\"scope\":\"default\",\"id\":\"$id\",\"to\":\"done\",\"ifVersion\":$v}" "$H/api/transition" >/dev/null
  echo "  已验收 $id（写入位释放）"
done
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/legion-hub/team.db');
const n=db.prepare(\"SELECT COUNT(*) c FROM write_reservations WHERE state IN ('reserved','reconciling')\").get().c;
console.log('  剩余活跃写入预约：'+n)"
REMOTE

echo
echo "===== ③ 手机发一条「创建任务」消息（intent=create_task）====="
OUT="$(phone create "端到端验收：请写一个 greet 函数并跑一次测试")"
echo "$OUT" | sed 's/^/  /'

echo
echo "===== ③ 观察（每 4 秒，最多 100 秒）====="
reached=""
for i in $(seq 1 25); do
  sleep 4
  line=$(phone timeline | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const a=JSON.parse(s);const last=a[a.length-1];
        console.log(`${a.length} 条 | 末条 source=${last?.source} type=${last?.semanticType} body=${String(last?.body??"").slice(0,60)}`)
      }catch(e){console.log("(解析失败)")}})')
  echo "    ${i}: $line"
  case "$line" in *"progress"*) reached=1 ;; esac
  case "$line" in *"task_status"*) break ;; esac
done

echo
echo "===== ④ 手机读到的**完整时间线** ====="
phone timeline | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const a=JSON.parse(s)
    for (const m of a) {
      console.log(`   #${String(m.id).padStart(3)} [${m.source ?? "?"}/${m.semanticType ?? "-"}]${m.taskId ? " ("+m.taskId+")" : ""} ${m.body}`)
    }
    const sources = [...new Set(a.map((x)=>x.source))]
    console.log()
    console.log("   来源分布:", sources.join(", "))
    console.log("   含任务关联的消息:", a.filter((x)=>x.taskId).length, "条")
  })'

echo
echo "===== ⑤ 任务与尝试的最终状态 ====="
# ★ 取**最新**那个带任务关联的消息，不是第一个：本脚本用同一会话重复跑，
#   会话里会累积历史任务（T-001、T-002…），取第一个会读到上一轮的对象，
#   表现为"这次任务怎么没动"——而它其实早就跑完了。
TID=$(phone timeline | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const a=JSON.parse(s);const withTask=a.filter((x)=>x.taskId)
    console.log(withTask.length?withTask[withTask.length-1].taskId:"")})')
if [ -n "$TID" ]; then
  echo "  （时间线里最新的任务：$TID）"
  phone task "$TID" | sed 's/^/  /'
else
  echo "  （时间线里没有带任务关联的消息）"
fi

echo
echo "===== ⑥ Agent 的**结构化进展**是否进了时间线 ====="
# 设计文档 §6.1 第 6 步要求 Agent 的进展经 Hub 持久化后手机能看到。
# 只看到"本轮状态：Running"是不够的——那是状态变迁，不是"它做了什么"。
phone timeline | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const a=JSON.parse(s)
    const steps=a.filter(x=>x.semanticType==="progress" && /第 |正在|已拦下|工作区|处理/.test(x.body))
    if (steps.length===0) { console.log("  ✖ 时间线里看不到 Agent 的步骤级进展（只有状态变迁）"); process.exit(0) }
    for (const m of steps) console.log("   · "+m.body.slice(0,90))
  })'

echo
echo "  node.log 全文:"
sed 's/^/  /' node.log
echo "===== 完成 ====="
