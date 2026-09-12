# PRT-305 / PRT-308：岗位与流水线、打回与交接

**对应 spec**：§5（`Task` / `TeamPlan` 术语）、§6.4（`HandingOff`）、第 333 行、第 872/875 行
**交付物**：
- `orchestrator/pipeline/index.mjs` —— 岗位索引、流水线结构读法、`resolveNextPost`、`buildHandoffTask`
- `team-hub/run-store.mjs` —— `run_handoffs` 只追加表、`handoff`、`handoffsOf`、`handoff` 证据检查
- `team-hub/server.mjs` —— `POST /api/runtime/handoff`、`GET /api/runtime/handoffs`、`GET /api/runtime/next-post`、`createTaskInTx`
- 套件 `prt-pipeline`（16 例）、`handoff-store`（12 例）、`handoff-routes`（8 例）

---

## 1. spec 要的是「原子创建」，不是「状态走到 Completed」

spec 第 333 行对 `HandingOff` 的定义：

```
| `HandingOff` | `in_progress` | 当前 Task 收口并原子创建/释放下一岗位任务 |
```

这句话有两个分句，而它们各自都能独立地失败：

| 分句 | 失败的样子 |
| --- | --- |
| 当前 Task 收口 | 状态停在 `HandingOff`，没人知道它到底交没交出去 |
| 原子创建下一岗位任务 | 上一环收口了，下一岗位的任务**不存在**——整条链断在这里 |

第二种失败最坏：库里看起来一切正常（上一环 `Completed`、没有报错），
而任务链已经断了，要等到整个目标停住才被发现。

因此这一步不是"改个状态"，它要**建出一条真任务**。

---

## 2. 「链断」与「链尾」在数据上长得一模一样

这是本批最核心的一个判定。

`space_stages.next` 是一个**没有外键约束的字符串**。查"下一岗位是谁"时：

```js
const nextStage = byRole.get(stage.next)
if (nextStage === undefined) { /* ← 到这里，说明什么？ */ }
```

`undefined` 有两种完全不同的成因：

1. **链尾**：这一环就是最后一环（`next` 为空）——正常；
2. **链断**：`next` 拼错了一个字母、或那个岗位被停用了——**配置坏了**。

两者的表现形式完全一致。把它们混成一个"没有下一岗位"，
后果是**静默掐断任务链**：任务在 `Completed` 收口，而后面本来还有活。

真实的三种成因都要能区分：

| 情况 | 该怎么办 |
| --- | --- |
| `next === null` | 链尾，正常收口 |
| `next` 指向不存在的岗位 | 报错——配置坏了 |
| `next` 指向**已停用**的岗位 | 报错——停用的后果与拼错一样 |
| 任务上记的 `role` 已改名/停用 | 报错——**不默认成链尾** |

因此 `resolveNextPost` 返回的 `ok: false` 与 `hasNext: false` 是**两件不同的事**，
且刻意不复用同一个字段：

```js
{ ok: true,  hasNext: false, reason: '…是链尾' }        // 正常
{ ok: false, code: 'UNKNOWN_ROLE', message: '…链断了' }  // 配置错误
```

`pipelineView` 把这份区分做成一个可读的结构，供界面/告警用：

```js
{ roles: [...], tailRoles: ['tester'], brokenEdges: [{ from: 'orphan', to: 'ghost' }] }
```

`tailRoles` 是**故意**的链尾，`brokenEdges` 是坏的。前者是正常的
（链总得有尾），后者必须能被告警出来。

还有一条同样重要的边界：**读不出流水线时抛错，不当成"没有岗位"**。
`indexStages` 拿到非数组时抛 `NO_SUCH_SCOPE`——因为当成空流水线时，
**所有**任务都会被判成链尾，一次读失败会静默掐断所有链：

```
stages 必须是数组（收到 null）：把读不出流水线当成"没有岗位"，会让所有任务都被判成链尾
```

---

## 3. 自我循环：一条永不收敛的链

`next` 指回自己时（`a → a`），每一环都再建一次，链永不收敛——
这是一个**无限增长的任务链**，而它不会报任何错。

`buildHandoffTask` 直接抛错：

```
流水线把岗位「a」的 next 指回它自己：交接会建出一条永不收敛的自我繁殖链。
这是配置错误，不是"再跑一遍"
```

---

## 4. `parent` 是交接的幂等键

交接要建的那条任务，字段与 `POST /api/create` 对齐。其中：

```js
parent: prevTask.id
```

选 `parent` 而不是标题、不是 `blockedBy`、不是创建时间，理由是
**重放时它不变**：

| 触发重放的情形 | 为什么 `parent` 仍然一样 |
| --- | --- |
| worker 交接完就崩，重扫重放 | 上一环任务 id 是它写进库里的事实 |
| 租约过期，另一个 worker 回收后重放 | 同上 |
| 人工重放同一次交接 | 同上 |

用标题做键，重放时会各建一条（标题在交接时会被改写）；
用创建时间做键，重放必然不同。

---

## 5. 一个事务里做完三件事

`handoff` 一次事务里做完：

1. 建后继任务（`createTask`）；
2. 记 `run_handoffs`；
3. 收口本尝试（`HandingOff → Completed`）。

分成两步（先建任务、再改状态）时，崩在中间会留下**孤儿后继**：
本任务还在 `HandingOff`，而下一岗位已经在跑了——重扫时会**再建一条**。

原子性的**可验证形态**写在用例里：让 `createTask` 插一条真任务、
然后返回一个**已被占用**的 `successor_id`，撞 `run_handoffs` 上的唯一索引：

```js
assert.throws(() => colliding.handoff(...), /UNIQUE|constraint/)
assert.equal(env.tasksIn().find(t => t.id === orphanId), undefined, '刚建出来的孤儿任务必须一起回滚')
```

这条用例同时验了两件事：唯一索引真的会挡，且它挡住时先前插进去的任务**也被回滚**。

---

## 6. 幂等靠两处，且都在同一个事务里

```
① 先查 run_handoffs 有没有这条尝试的记录 → 有就直接返回它的 successorId
② run_handoffs.successor_id 上有唯一索引
```

第 ② 条不是冗余。只在应用层查重时，两个并发进程会各查一次、各建一条
——这与 `ensureColumn` 那次的失败模式**一样**（两个进程并发启动各 `ALTER` 一次
创建了同一个列）。数据库层面的唯一约束是唯一能挡住并发的形式。

重放返回 `action: 'already-handed-off'` 并带上**同一条** `successorId`。
重放是**正常路径**：崩后重扫一定会重放同一次交接，因此它必须成功，
而不是报"已经交接过了"。

---

## 7. 收口要证据：没有后继就收不了口

`run_handoffs` 同时是 `HandingOff → Completed` 要的**证据**：

```js
EVIDENCE_CHECKS.handoff = (db, attemptId) =>
  db.prepare('SELECT COUNT(*) AS n FROM run_handoffs WHERE attempt_id = ?').get(attemptId).n > 0
```

这是 PRT-307 那套 `requiresPersist` 闸门的第一条**新增**实现
（此前只有 `attempt` 与 `validation`）。它把顶上的那句话钉住了：

> 没有交接记录就收口 → `409 EVIDENCE_MISSING`

也就是说「交接发生了」的证据是**后继任务真的被创建了**，
而不是调用方说"我交接了"。

这条闸门上线时**弄红了一条老用例**（`acceptance-store.test.mjs` 的用例③）：
它原来断言"打完验收之后就能推进到 `Completed`"。那条断言写的是**较弱的契约**
（只要求有验收记录），而闸门要求的是正确的契约（还要有后继）。
修法不是放松闸门，而是把那条用例改成断言"没有交接记录时会被拒绝，且状态原地不动"。

---

## 8. `readPipeline` 的坏消息：两处判定必须用同一个函数

`/api/runtime/next-post` 与 `handoff` 都要回答"后面还有没有岗位"。
两处各写一遍判定时，迟早会出现**接口说有下一岗位、交接时却按链尾收口**
——而这两个答案都会被如实报出来，于是没有任何一处看起来是错的。

因此 server 与 run-store 都用 `orchestrator/pipeline/index.mjs` 的
**同一个** `resolveNextPost`。

`handoff` 里还有一条针对不一致的守卫：走到了 `HandingOff`
而流水线说这是链尾时，**不自动收口**：

```
这条任务在 HandingOff，但流水线说岗位「x」是链尾（…）。
两处判断不一致：不自动收口，否则这条不一致永远不会有人看见
```

自动收口会把这份不一致藏掉。而藏掉之后，没人会去查到底是验收时判错了，
还是流水线在这中间被改过。

---

## 9. 这条路抓到的真实缺陷：两个 `withTx` 各记各的账

第一次跑 `handoff-routes` 时三条用例红了，其中一条是：

```
{"error":"cannot start a transaction within a transaction","code":"ERR_SQLITE_ERROR"}
```

根因：`server.mjs` 与 `run-store.mjs` **各有一个** `withTx`，
两个闭包各自维护自己的 `txDepth`。server 的 `createTask` 进到运行仓储
已开启的事务里时，它认为自己在最外层，于是又发一次 `BEGIN IMMEDIATE`。

这条错误看起来像"夹具写错了"，实际是"两处各自记账"的必然结果——
而它的后果不只是报错：如果 `createTask` 选择"检测到已在事务里就跳过 BEGIN"，
那建任务就不会被回滚，伪原子的交接会在崩后留下孤儿后继。

修法是把函数体拆出来，由调用方声明自己已经在事务里：

```js
function createTaskInTx(input) { /* …函数体… */ }          // 已在事务内
function createTask(input) { return withTx(() => createTaskInTx(input)) }  // 唯一对外入口
```

注入给运行仓储的是 `createTaskInTx`：

```js
createTask: (payload) => createTaskInTx(payload),
```

另外两条红：

- **`getTask` 抛异常而不是返回 `undefined`**：`GET /api/runtime/next-post`
  里用 `getTask(taskId)` 判空时，任务不存在会变成 **500**，
  而它明明是 **404**（调用方给错了 id）。用异常做正常流程控制
  会让状态码失去意义。改成直接查需要的两列。
- 夹具的 `claim` 抢先领走了第一次交接建出的后继——夹具的问题，
  把那条后继收掉即可。

---

## 10. 交接任务的内容

`buildHandoffTask` 拼出的任务：

```js
{
  title:       '【开发】做一件事',                       // 换掉阶段标签
  description: '目标描述\n\n[前序阶段] 分析（analyst）已完成：✓ 分析完了\n\n[本阶段] 开发（coder）',
  role:        'coder',
  parent:      'T-1',                                   // 幂等键
  priority:    'high',                                   // 继承
  status:      'todo',                                   // 下一岗位要能被领走
  scope:       'sp1',                                    // 继承
  goalId:      'G-1',                                    // 继承
}
```

三个细节：

**① 描述基于原始目标重写，不叠加。** 从 `[前序阶段]` 起整段砍掉再重新生成。
只砍 `[本阶段]` 是不够的——`[前序阶段]` 在它前面，于是每转一手就会多留
一条上一手的交接记录，描述越来越长，最后没人看得懂要做什么。
用例断言两处标记各只有一个，且原始目标仍在最前面。

**② 上一环没有收口结论时明说**，而不是省略整行：

```
(上一阶段未留下收口结论)
```

省略会让下一岗位以为交接没发生过，于是它不会去问"上一环到底做完了什么"。

**③ 标题没有阶段前缀时补一个**，而不是原样沿用——否则下一岗位的任务标题里
写的是**上一个**岗位的名字，派工的人看到标题就分不清这一环该谁做。

`goalId` 的继承尤其重要：不继承时，下一环的任务不属于同一个目标，
于是 per-goal 的统计与上下文注入都会漏掉它。

---

## 11. 交接只对 `HandingOff` 有意义

从别处交接等于**跳过"验收通过"这一步**——下一岗位会在上一环还没被接受时
就开始做。因此 `not HandingOff` 一律 `409 NOT_HANDING_OFF`。

同理锁：

- 过期 `leaseEpoch` 不得交接（`LEASE_EPOCH_STALE`，带**真实 epoch**）；
- 缺 `actor` 不得交接（`WORKER_REQUIRED`）——谁做的交接决定必须留痕；
- `createTask` 没返回 id 一律拒绝：没有 id 就没有后继可指，
  而记一条空的交接等于把"下一岗位已建好"写成事实。

没注入 `createTask`/`readPipeline` 时报 **500** `HANDOFF_NOT_WIRED`，
**不降级**成"没有下一岗位"——降级会让交接在静默中变成收口，
任务链断在第一环而库里看起来一切正常。

---

## 12. 未交付

- **交接后的链式推进**：交接建出了下一岗位的任务，但"目标链整体完成"
  （最后一环收口后聚合出目标级结论、关闭 goal）未交付。
- **团队快照（`TeamPlan` 冻结）**：spec 说 `TeamPlan` 是"目标创建时**冻结**"的
  团队/岗位/流水线/能力包组合快照。目前流水线是**实时读** `space_stages` 的——
  于是运行中改流水线会改变未走完目标的走向，这正是 spec 要避免的。
  PRT-305 只交付了"从当前流水线读岗位"这半句，冻结快照属 PRT-402（接入 TeamPlan）。
- **`blockedBy` 预建的全链识别**：`plugins/src/index.ts` 的 `advancePipeline`
  用「同 scope 同 role 且 `blockedBy` 含已完成任务」识别 `createGoalChain`
  预建的全链任务（`parent` 为空的那些）。运行面的交接只认 `parent`，
  因此对预建链会重复建任务。这属于 PRT-316 的提取范围。
- **worktree / workspace（PRT-306）**：交接隐含"下一岗位在哪个工作区干活"，
  本批没有触碰 `workspace/worktree` 管理。

---

## 13. 复跑方式

```bash
node --test orchestrator/pipeline/pipeline.test.mjs   # 16 例，纯函数
node --test team-hub/handoff-store.test.mjs           # 12 例，事务语义
node --test team-hub/handoff-routes.test.mjs          # 8 例，真 HTTP + 真 createTask 接线
node scripts/ci/run-ci.mjs --only test                # 全套
```
