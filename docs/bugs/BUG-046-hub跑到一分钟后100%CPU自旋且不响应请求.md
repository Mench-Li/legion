# BUG-046：hub 跑到约 1 分钟后 100% CPU 自旋、端口在听但不响应任何请求

## 现象

```
重启 hub → 前几十秒正常（/api/config 40ms、/mobile/ 10ms）
约 1 分钟后 → CPU 打满（100%，单核）
  · 所有请求超时（本地直连、经隧道都是 524）
  · 日志停止输出
  · WAL 不再增长（纯 CPU 自旋，不是 I/O 死锁）
  · 进程内存 ~500MB
```

2026-11-05 18:45 与 2026-11-07 14:07 两次独立复现，与两天之间的代码合并**无关**（合并前就发生过）。

## 定位方法

Node 支持给**运行中的进程**动态挂 inspector：

```powershell
node -e "process._debugProcess(<pid>)"
# 之后 http://127.0.0.1:9229/json/list 出现目标，用 CDP 启动 Profiler
```

抓 3 秒采样的结果（4792 个样本）：

```
57.6%  all             @ :0                             ← SQLite 原生调用
36.6%  advanceCursor   @ team-hub/event-delivery.mjs:572  ← 元凶
 2.6%  garbage collector
```

## 根因

`advanceCursor()` 每次把**该订阅者的全部投递行**读进内存，再从第一行开始逐条走：

```js
const rows = db.prepare('SELECT seq, state FROM event_deliveries WHERE subscriber_id = ? ORDER BY seq ASC').all(subscriberId)
```

而 `event_deliveries` 里单个订阅者已经累积 **104,297 行**（`anonymous:workbench:1`），实测：

```
旧实现：单次 106ms（10 万行读成对象 + 遍历）
```

它在**每条事件投递后**都会被调用 ⇒ 调用首尾相接，事件循环再也回不到处理 HTTP 请求 —— 表现为"端口在听、进程活着、谁都不理"。

## 修复

从**已持久化的 `cursorSeq`** 往后增量推进，而不是每次从头：

```js
const from = Number.isSafeInteger(current?.cursorSeq) ? current.cursorSeq : -1
const rows = db.prepare(
  'SELECT seq, state FROM event_deliveries WHERE subscriber_id = ? AND seq > ? ORDER BY seq ASC LIMIT 2000',
).all(subscriberId, from)
```

- 起点仍按"该订阅者**第一条被 plan 过的 seq**"计算（游标初值是 `0` 不是 `-1`，判据是 `cursor < rows[0].seq - 1`）；
- 每批最多 2000 行、最多 5 批追上，避免一次读爆；
- 语义不变：遇到洞或非终态就停在洞前，游标只增不减。

**实测：单次 106ms → 1.25ms（85 倍）。**

## 验证

- `event-delivery.test.mjs` + `event-delivery-wiring.test.mjs`：38/38 通过（含"游标单调：重算不会让它回退""遇到洞就停"两条关键判据）；
- 真机：修复后重启，CPU 峰在 20–70 秒后自行落到 0%，`/mobile/` 348ms、`/api/board` 11ms、`/api/identity/me` 4ms 全部正常响应；
- 修复前同一场景：重启 60 秒后永久 100%，直到进程被杀。

## 遗留（同一现场，尚未处理）

1. **`event_deliveries` 没有保留期**：566,407 行（2026-09-21 起），占库体积绝大部分（team.db 133MB）；
2. **订阅者 id 每次连接递增**：`anonymous:workbench:1/2/3…`、`anonymous:mobile:1/2/3…`，
   单个订阅者 10 万行，等于永久泄漏。应改为按会话/设备稳定标识；
3. 加保留期 + 修订阅者 id 之后，库应能从 133MB 显著回落，周期性 CPU 峰也会随之消失。
