# 排查手册：hub 卡死 / CPU 打满 / 响应超时

> 适用：`team-hub`（8787）"端口在听但不回请求"、"CPU 打满"、"页面转圈"、经隧道 524。
> 本文的每条命令都在 2026-11-07 的两次真实故障里跑过，数字是当场的实测读数。

---

## 0. 先分清三种"卡"

| 现象 | 判别命令 | 含义 |
| --- | --- | --- |
| 端口不在听 | `Get-NetTCPConnection -LocalPort 8787 -State Listen` 为空 | 进程死了，等 supervisor 拉起或手动重启 |
| 端口在听、CPU≈0%、请求超时 | 见下方"CPU 采样" | I/O 等着（SQLite 锁、外部依赖） |
| **端口在听、CPU 100%** | 见下方"CPU 采样" | **纯 CPU 自旋**，本文主线 |

CPU 采样一条命令（Windows，无需管理员）：

```powershell
$pid0 = (Get-NetTCPConnection -LocalPort 8787 -State Listen).OwningProcess
$a=(Get-Process -Id $pid0).CPU; Start-Sleep -Seconds 4; $b=(Get-Process -Id $pid0).CPU
"CPU 增量: {0}s / 4s" -f [math]::Round($b-$a,2)     # >3.5 = 单核打满
```

`WAL` 同时看：`(Get-Item team-hub\team.db-wal).Length` 不变 ⇒ 不是写循环，是纯计算自旋。

---

## 1. 抓火焰图（本文最重要的能力）

Node 支持给**运行中的进程**动态挂 inspector —— 不重启、不改代码、不停服务。

```powershell
# ① 挂上（<pid> 换成 hub 的真实 pid）
node -e "process._debugProcess(<pid>)"

# ② 确认监听
Get-NetTCPConnection -LocalPort 9229 -State Listen
```

然后用 CDP 抓 3～4 秒采样（`scripts/diag/hub-profile.mjs`，见下）：

```powershell
node scripts/diag/hub-profile.mjs            # 自身耗时 Top 10
node scripts/diag/hub-profile.mjs --chains   # 调用栈 Top（找"谁在调它"）
```

判读要点：

- **自身耗时 Top**：谁在吃 CPU；
- **调用栈 Top**：这个热点是被谁触发的（业务路径 vs 定时任务）；
- `exec` / `prepare` / `get` / `run` 是 SQLite 原生调用，占比高 ⇒ 数据库层；
- `(garbage collector)` 高 ⇒ 大量临时对象（常见于"把大结果集读成对象"）。

---

## 2. 已知故障案例（照方抓药）

### 案例 A：`advanceCursor` 把订阅者的**全部**投递行读进内存（BUG-046）

火焰图：

```
57.6%  all             @ :0                        ← SQLite
36.6%  advanceCursor   @ team-hub/event-delivery.mjs:572
 2.6%  (garbage collector)
```

特征：`event_deliveries` 里单个订阅者累积 10 万行；该函数在**每条事件投递后**被调用，单次 106ms
⇒ 调用首尾相接，事件循环回不到处理 HTTP 请求。

修法：改成从已持久化的 `cursorSeq` 增量推进（`seq > cursor` + `LIMIT`），单次 106ms → 1.25ms。

### 案例 B：SSE 回放给新订阅者凭空造投递意图（BUG-047）

症状：`event_deliveries` 以约 5 万行/分钟增长，**只有这张表在涨**（`audit` 不涨）。

判别命令（哪张表在涨 = 谁在写）：

```powershell
node -e "
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('team-hub/team.db');
const ts=db.prepare(\"select name from sqlite_master where type='table'\").all().map(t=>t.name);
const c=()=>Object.fromEntries(ts.map(t=>[t,db.prepare('select count(*) c from \"'+t+'\"').get().c]));
const a=c();setTimeout(()=>{const b=c();for(const t of ts)if(b[t]>a[t])console.log(t,'+',b[t]-a[t]);},10000);"
```

火焰图（`--chains`）：

```
60.0%  exec <- withTx@server.mjs:3478 <- handle@server.mjs:8890   ← 请求触发的写事务
 4.1%  prepare <- subscriberOf <- advanceCursor <- markDelivered <- server.mjs:9187
```

特征：每次 SSE 重连都新建匿名订阅者（独立性是安全性质，见 `event-subscribers` 测试 ⑤），
随后回放 30 条，每条都走 `plan + takeUp + markDelivered` = 3 个写事务
⇒ **一次重连 = 30 行 + 90 个事务**。客户端一进重连风暴（如 401 触发的 EventSource 重试），
表就以每秒上千行膨胀。

修法：回放只在**该订阅者确实已有投递意图**时记账，否则直接写帧、不落行。

---

## 3. 数据面的三把量尺

```powershell
# ① 库体积与表体积排序
node -e "
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('team-hub/team.db');
const ts=db.prepare(\"select name from sqlite_master where type='table'\").all().map(t=>t.name);
for(const t of ts){try{const c=db.prepare('select count(*) c from \"'+t+'\"').get().c;if(c>2000)console.log(t,c)}catch{}}"

# ② 某表是否在持续增长（10 秒窗口）
# ③ 库归档：删除 + VACUUM
```

**注意**：`DELETE` 只释放页，**文件不会变小**；必须 `VACUUM`（需要短暂独占锁，`PRAGMA busy_timeout` 兜底）：

```sql
PRAGMA busy_timeout = 30000;
VACUUM;      -- 136MB → 69MB 实测 2.2 秒
```

保留期由 `server.mjs` 的 `EVENT_RETENTION_DAYS`（当前 **1 天**）控制，每小时清一批（上限 2 万行）。

---

## 4. 重启的正确姿势

hub 是 supervisor 托管的长驻进程（`@dsh-external/dsh-legion-services`），杀掉后约 1.6 秒自动拉起：

```powershell
$old=(Get-NetTCPConnection -LocalPort 8787 -State Listen).OwningProcess
Stop-Process -Id $old -Force
for($i=0;$i -lt 30;$i++){Start-Sleep -Milliseconds 500
  $c=Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1
  if($c -and $c.OwningProcess -ne $old){"restarted $($c.OwningProcess)";break}}
```

**重启前先看是否有长任务在跑**：正在执行的工作流阶段会因重启被标 `unknown` 并挂起（BUG-045），
产物可能已落盘但要人工核对。

---

## 5. 现场隔离（复现/压测时）

**不要**拿生产库做实验。复制一份再起第二个实例：

```powershell
mkdir .prof; Copy-Item team-hub\team.db,team-hub\team.db-wal .prof\
$env:TEAM_HUB_DB="$PWD\.prof\team.db"
node --cpu-prof --cpu-prof-dir=.prof team-hub/server.mjs --port 8788
```

`.prof/` 已在 `.gitignore` 里（含 133MB 库副本与 `.cpuprofile`）。

---

## 6. 一页速查

| 症状 | 首查 | 常见原因 |
| --- | --- | --- |
| CPU 100%、请求全超时 | 火焰图自身耗时 | 大结果集读进内存（案例 A） |
| 某张表疯涨、CPU 40–70% | 哪张表在涨 + `--chains` | 重连风暴 × 逐条写事务（案例 B） |
| 库反复长回 100MB+ | 表行数排序 | 无保留期 / 保留期太长 |
| 页面转圈但端口正常 | 采样 CPU | 上面两类；偶发可用"重启后立刻请求"确认 |
| 经隧道 524、本地正常 | 本地直连对比 | 隧道没问题，是源站慢 |
