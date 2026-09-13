# PRT-405：上游员工交付有了读路径（走 `blockedBy` 前驱，不走 handoffs）

> `UNSERVED_SOURCE_FAMILIES` 里那条写得很清楚：hub 的 `/api/runtime/handoffs`
> 是 **worker 的移交状态**，不是上游员工的交付物；两者混用会把"某个 worker
> 交出了租约"读成"上游交付了一份成果"。
>
> 于是每次运行，模型都读不到上游做过什么、留下了什么。

本批给了它一条真的读路径：**沿链上的 `blockedBy` 读前驱任务**。

---

## 1. ★ 为什么 `blockedBy` 才是"上游员工交付"

`createGoalChain` 建的是一条阶段链，每个阶段 `blockedBy: [prev]`——

```js
blockedBy: prev ? [prev] : [],   // server.mjs:3541
```

也就是说 **`blockedBy` 就是"这个任务的输入来自哪个岗位"**。下游任务的输入
正是上游岗位的产出，这不是一个近似，而是链的定义。

而 `/api/runtime/handoffs` 说的是"某个 worker 交出了租约"——那是**调度事实**，
不是**成果**。两者的区别在模型眼里是实质性的：前者说"轮到你了"，
后者说"这是你上游做出来的东西"。

---

## 2. ★ 只有 `done` 的前驱才产出交付

`assertUnblocked` 会拦住"未完成依赖"，但：

- `force` 绕得过去（转派、人工托管、断链修复都用到它）；
- 前驱也可能是 `canceled`——**取消了就没有交付物**；
- 前驱可能被删了（`blockedBy` 指向一个不存在的 id）。

把这类前驱做成一条 `upstream-delivery` 来源，等于让模型读到一份**并不存在的交付**，
而它会照着那份（空）交付继续做下去：

> 一个"把没完成的上游也写成一条交付"的实现，
> 与一个"只写真的交付了的"的实现，在上游总是按时完成时是同一个东西——
> 只不过前者会让模型把"还没做"读成"做完了、只是内容是空的"。

### 2.1 ★ 被跳过的前驱**不静默**：`upstreamSkipped`

跳过的三种情形各带自己的原因：

| 情形 | `reason` |
| --- | --- |
| 依赖任务不存在 | `依赖任务不存在（读回来是空的）` |
| 状态不是 `done` | `上游任务状态是 <status>，不是 done —— 没有交付物` |
| 超过 `maxUpstream` | `依赖超过 maxUpstream=N，只读了前 N 个`（还有 `truncated: <剩下几个>`） |

第三种尤其重要：截断**要说出来**，否则"没读的那几个"与"不存在"在账上长得一样。

```js
blockedBy: prev ? [prev] : [],   // ← 语义锚点
```

> 一个"依赖超过上限就默默少读几个"的实现，
> 与一个"读了全部"的实现，在链上没有那么多前驱时是同一个东西——
> 只不过前者会让一份**不完整的**上游清单看起来是完整的。

**⚠️ 诚实边界：`upstreamSkipped` 现在到不了快照里。** `collectCandidates` 只认
它自己那几个键，本字段不会被消费。它现在的读者是**用例与调用方**
（`loadSources` 的返回值是对外契约），进快照要等 PRT-408 的来源清单
（"已读但为空 / 被过滤"的位置）。

> 一个"产出了但没人读"的诊断字段，
> 与一个"根本没记"的字段，在排障的人是**唯一读者**的时候是同一个东西——
> 只不过前者看起来像是已经解决了"上游没交付"这件事的可见性。

---

## 3. ★ 产物引用**投影成固定键序**，不原样透传

`upstreamDeliverySources` 用 `stableRecord` 序列化交付，而 `stableRecord`
对**嵌套值**用的是 `JSON.stringify`——它的键序取决于对象的**插入顺序**。

hub 写产物时是 `list.push({ by, at, kind, path, title })` 再**条件性**加 `digest`，
所以顺序恰好是确定的；但那是**写入代码路径**的性质，不是数据的性质：

> 一个"键序碰巧对得上"的内容哈希，
> 与一个"键序是数据的函数"的内容哈希，在写入路径不变的时候是同一个东西——
> 只不过前者会在有人调整了产物登记那段的对象字面量顺序之后，
> 让同一个世界算出两个快照哈希。

所以 `toUpstreamArtifacts` 把每条引用投影成
`{ kind, path, title, digest }`——**四个键一律出现**（缺的写 `null`）。
省略会让"这个字段从没被填过"与"填了空"得到同一个哈希
（与 `stableRecord` 自己的理由同源）。上限 `MAX_UPSTREAM_ARTIFACTS = 20`。

---

## 4. `summary` 一 个键，一个意思

```js
const report = dep?.testReport
const summary = (report && typeof report.summary === 'string' && report.summary.trim() !== '')
  ? report.summary.trim().slice(0, 2000)          // 结构化测试报告里的摘要就是交付摘要
  : `上游岗位 ${role} 完成了《${title}》，未留下结构化摘要`
```

没有结构化摘要时**如实说没有**，而不是编一个——编出来的摘要会被模型当成
"上游说了这句话"，而它其实是我们替上游说的。

---

## 5. `availability()` 新增 `upstreamSelection`

`consumed` 只能说"读了 `/api/task`"，而 PRT-405 的全部内容恰恰是
"读的是**前驱**，不是随便什么任务"：

```js
upstreamSelection: { by: 'task.blockedBy', endpoint: '/api/task?id=',
                     maxUpstream: 20, onlyDone: true, skippedReportedAs: '…' }
```

> 一个"读了 /api/task 就算接上了上游交付"的覆盖账，
> 与一个"读的是 blockedBy 前驱"的覆盖账，在任务恰好没有前驱时是同一个东西——
> 只不过前者会让"上游交付"永远显示为已覆盖，而实际上它一个前驱都没读过。

★ `consumed` **不新增条目**：PRT-405 走的是**同一个** `/api/task`
（按 `blockedBy` 逐个读），多列一个端点会谎称多了一个端点。

`unserved` **2 → 1**（只剩 `workspaceState`）、`formerlyUnserved` **3 → 4**。

---

## 6. ★ 断验证 37/37（本批新增 7 个）

| # | 弄坏什么 | fail |
| --- | --- | --- |
| ㉜ | 上游交付**不筛 `done`** | 1 |
| ㉝ | 上游交付改读当前任务自己（不是前驱） | 3 |
| ㉞ | 前驱不存在时静默跳过（链断了读成链头） | 1 |
| ㉟ | `maxUpstream` 截断时不留痕 | 1 |
| ㊱ | `maxUpstream` 不做构造期校验 | 1 |
| ㊲ | 上游产物引用原样透传（嵌套键序变成写入路径的函数） | 1 |
| ㊳ | 把 `upstreamDeliveries` 塞回 `unserved` | 2 |

合计 **37/37 咬住，0 无效，0 没咬住，源码逐字节还原**。

### 6.1 ★★ 探针⑮ 的锚点**漂移了两次**——第二次逼出了结构性修法

- **第一次**：锚在 `key: 'userFeedback'` 上。PRT-404 把它从 `UNSERVED` 搬到
  `FORMERLY` 之后，那段文本**仍然存在于文件里**（只是换了一份清单），
  于是探针改对了文件、改错了地方。
- 我把它重锚到 `key: 'upstreamDeliveries'`——**然后 PRT-405 又把那一条搬走了**，
  完全相同的漂移发生了第二次。

> 一个"锚在某条**内容**上"的探针，与一个"锚在**那份清单本身**上"的探针，
> 在内容不动的时候是同一个东西——只不过前者会在内容被**搬到另一份清单**之后
> 改对文件、改错地方，而它看起来照样"咬住了"。

正确选择是**结构**而不是**内容**：现在锚在
`export const UNSERVED_SOURCE_FAMILIES = Object.freeze([` 这一行上——
"往这个数组里插一条"。内容会移动，结构不会。

**这个教训值得记下来**：一个会因为"被测试的代码正常演进"而静默失效的探针，
比一个不存在的探针更危险——因为它会把"没检查"报告成"检查过了"。

---

## 7. 验证读数

- `sources-loader` **43 → 48 例**，全绿。
- 端到端走**真实状态机**：建上游任务（coder）→ 登记产物 →
  下游任务（tester，`blockedBy: [上游]`）→ 上游未 done 时**零交付 + 一条 skip** →
  `todo → in_progress → in_review → done` → **一条交付**（带产物引用、`untrusted`）。
- `unserved` **2 → 1**、`formerlyUnserved` **3 → 4**、`consumed` 不变（6 条）。
- 七道门禁 + 编码门禁全 PASS。

---

## 8. ⚠️ 诚实边界

1. **`upstreamSkipped` 到不了快照**（见 §2.1）——要 PRT-408 的来源清单。
2. **只沿 `blockedBy` 读**。`slice` 模式下是微链（`coder_Si ← test-designer`），
   `fixOf` 的返工链（`fixOf` 指向前一轮的任务）**没有被当作上游**——
   而返工任务真正的输入恰恰是上一轮的产物。
3. **不读上游的补丁与差异**。上游登记的 `patches`、`files`、`boundaries`
   都不进交付（`upstreamDeliverySources` 的字段白名单里没有它们）。
   模型看到的是"上游交付了《…》，产物引用是这些"，不是"上游改了什么"。
4. **`maxUpstream: 20` 是预算决定**。链长的目标（切片 + 返工）会截断，
   而截断只记在 `upstreamSkipped` 里（见边界 1）。
5. **每个前驱一次请求**。20 个前驱 = 20 次 `/api/task`。顺序读（为了
   `lastReads` 的确定性），所以串行。hub 上没有"按一批 id 批量取任务"的读端点。
6. **只认 `done`，不认 `in_review`**。评审中的上游**可能**已经有产物，
   但"交付"这个词在这里的含义是"已被接受"。
7. **不校验上游与本任务同空间**。`blockedBy` 记的是 id；跨空间的依赖边
   会被照读，而装配是按空间做的。链本身不会产生跨空间边，
   但手改库或转派可能造出来——那时这里会读到别空间的上游。
8. **`summary` 优先取 `testReport.summary`，而只有 tester 任务能写 testReport**
   （路由里 `role !== 'tester'` 会被拒）。所以链上非 tester 的上游一律走
   "未留下结构化摘要"那条兜底——这是**路由的现实**，不是这里的取舍。
