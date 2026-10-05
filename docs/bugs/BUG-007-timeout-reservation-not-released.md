# BUG-007：worker 超时后写入预约不释放 —— 守护的两套机制互锁，任务每 40 分钟卡死一次

- 发现时间：2026-10-05 12:35（本地）
- 发现者：将军（主 Agent）
- 严重度：高（**每一次 worker 超时都会复现**，且需要人工介入才能恢复派工）
- 影响面：所有空间的普通任务（非工作流阶段任务）
- 现场：T-178 与 T-179 同时卡在「待认领」，两个槽位空转

## 一、现象

守护每 30 秒刷同一行，任务却永远不动：

```
T-178 认领失败（可能已被他人认领）：Error: 上一轮执行尚未确认停止
T-179 认领失败（可能已被他人认领）：Error: 上一轮执行尚未确认停止
T-183 认领失败（可能已被他人认领）：Error: 文件被任务 T-178 占用：(whole repository)
```

任务看板状态是 `todo`（看起来"等着被认领"），但两条任务的写入预约都停在 `state=reconciling`：

```json
{"id":12,"task_id":"T-178","state":"reconciling","reason":null,"exclusive":0,"paths_json":"[…]"}
{"id":13,"task_id":"T-179","state":"reconciling","reason":null,"exclusive":0,"paths_json":"[…]"}
```

`reserve()`（team-hub/write-intent-store.mjs）对 `own.state === 'reconciling'` 一律返回
`RECONCILING / 上一轮执行尚未确认停止`，所以认领**永远**失败。

## 二、时间线（T-178 实测，T-179 形态逐字相同）

| 时刻 (Z) | 事件 | 出处 |
| --- | --- | --- |
| 03:35:41 | 守护派工，worker 认领，预约 `reserved` | 任务评论 |
| 04:00:42 | **worker 超时（25 分钟）→ 守护强制结算**，评论承诺「任务保留在 in_progress，下一轮自动重试（会复用 w/<id> 的 WIP 续做）」 | 任务评论 |
| 04:00:42 – 04:16:09 | 任务停在 `in_progress`，**承诺的重试没有发生**（日志里这 15.5 分钟无任何 T-178 派工行） | 守护日志 |
| 04:16:09 | **守护自己的 stale 回收器**判定「认领超过 40 分钟无进展」→ 任务回 `todo` + **写入资格冻结**成 `reconciling` | 任务评论 |
| 04:30 起 | 守护每 30 秒尝试认领该 `todo` 任务 → 全部被 `RECONCILING` 拒 | 守护日志 |
| 12:36 | 将军人工 `POST /api/tasks/:id/reservation/confirm-stopped` → 两条解锁 → 12:36:47/48 双双恢复运行 | 本次操作 |

## 三、根因：守护的两套机制互相打架

**机制 A（超时结算）**：`plugins/src/index.ts:2428-2457`。worker 跑满 `workerTimeoutMs`（当前 25 分钟）后
`controller.abort()` → 写评论「下一轮自动重试」→ `run.dispose()` → 返回。
★ 它**没有碰写入预约**，也没有改变任务状态。

**机制 B（stale 回收）**：`team-hub/server.mjs:6155-6165` 的 `releaseStaleTasks`（无 ids 的超龄分支）。
任务 `claimedAt` 超过 `staleMinutes`（当前 40 分钟）⇒ 任务回 `todo`，
并在同一事务里 `finishTaskReservationInTx(id, { cancelled: true })` ⇒ 预约冻结成 `reconciling`。

⇒ A 承诺"会自动重试"，B 在 15 分钟后把"能重试"这件事**永久关闭**。
★ 更关键的是：**A 承诺的那个重试本身也没有发生**（时间线里 04:00–04:16 完全静默）。
所以这条评论在当前实现下是**双重不成立**的。

## 四、为什么"超时就释放"不是显然正确的修法（这一节请勿跳过）

直觉的修法是"超时结算时顺手释放预约"。但**不能**这样做，理由在代码自己的注释里：

```
plugins/src/index.ts:2419   // 看门狗：subagent 可能挂死且 run.result 永不结算（abort 不保证杀死子代理）。
```

`abort()` **不保证** worker 进程已经死掉。而 T-170 的整套写入预约就是为了防"两个写者"：

- 若在 worker 可能还活着时释放预约并让下一个 worker 认领，**两个 worker 会同时写**；
- 且实测重派会**复用同一个 worktree**（守护日志：`T-178 复用既有 worktree：…\.legion-worktrees\T-178`），
  即两个写者落在**同一个目录**里——这比写两个不同目录更糟。

反过来说，**现有语义里已经有一个诚实的出口**（server.mjs:5991-5997）：

```js
if (t.status === 'in_progress' && (to === 'todo' || to === 'blocked')) {
  if (confirmedStopped && by !== t.soldier) throw ... // 403
  finishTaskReservationInTx(id, { cancelled: !confirmedStopped })
}
```

⇒ **执行者自己**（`by === t.soldier`）以 `confirmedStopped: true` 走 `in_progress → todo`，预约是**释放**（不是冻结）。
这条路径今天就可用，但守护从不调用它——它宁可把任务留在 `in_progress` 等一个不会到来的重试。

## 五、建议修法（供裁决，三选一或组合）

1. **让超时结算走诚实出口**：守护在超时结算时，先**证实**该 worker 已停止
   （它自己 spawn 的会话/进程，`run.dispose()` 之后应能查证），证实后以
   `by = t.soldier` + `confirmedStopped: true` 把任务 `in_progress → todo`。
   这会让评论里"下一轮自动重试"第一次成为真话。
   ★ 不能证实时**保持现状（冻结）**——安全方向不许为了自动化而放弃。
2. **修掉"承诺了却不做"的评论**（无论选哪条修法都要做）：现在的文案既说"保留在 in_progress"，
   又说"下一轮自动重试"，而实际两条都不成立。文案必须与实现一致——这正是 BUG-008 类
   "读数与事实不一致"的同一种病（见 §六）。
3. **让 stale 回收器知道"执行者已被守护结算"**：任务在超时结算时打一个持久标记
   （如评论 `⚠ worker 超时（守护强制结算）` 已存在，且这是**可判定**的），
   回收器读到该标记即可判"执行者已由守护终止"⇒ 释放而不是冻结。
   ★ 注意：这与 §四 的风险直接冲突（abort 不保证杀死），所以**只有**在能证实进程已死时才允许。

## 六、关联

- **BUG-007（本文）**：超时结算不释放预约 + 承诺的重试不发生。
- **BUG-006（T-183）**：`GET /api/tasks/:id/contention` 不看 `fileDomain`，与认领路径口径分叉。
- **已修的同族（提交 b5ce7ec8）**：守护**重启孤儿**路径曾用 `cancelled: true` 冻结，
  导致评论"自动重新认领续做"成为空话，任务永久卡死（T-173 线 / T-174 / T-177 共三次）。
  该处已改为 `cancelled: false` 真释放——**本文这条是同一个病的另一个入口**，
  且它的触发条件是"worker 超时"，比"守护重启"常见得多。

  > 同一个形态第三次出现：**"执行者已经不存在了"这个事实，在预约上没有被表达出来。**
  > 第一次在重启孤儿路径（已修），第二次在超龄路径（故意冻结但文案说实话），
  > 第三次在超时结算路径（本文，既没释放、也没说实话）。

## 七、复现

```powershell
# 1) 看守护刷的是哪一行（应为 RECONCILING）
Select-String -Path "$env:USERPROFILE\.dsh\super-injector\dsh-scrum-worker.log" -Pattern '认领失败' | Select-Object -Last 5

# 2) 看预约状态（应有一条 state=reconciling）
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('team-hub/team.db',{readOnly:true});console.log(db.prepare("SELECT id,task_id,state,reason FROM write_reservations WHERE state IN ('reserved','reconciling')").all())"

# 3) 人工解锁（现状下唯一出路）
#    POST /api/tasks/<id>/reservation/confirm-stopped  {by:'general',confirm:'stopped:<id>'}
```
