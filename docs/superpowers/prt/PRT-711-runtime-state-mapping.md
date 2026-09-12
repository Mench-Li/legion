# PRT-711 Runtime 健康状态 → 产品状态 → Orchestrator 行为

> spec §6.3 的表格有**三列**。`productStateOf`（在 `launcher.mjs` 里）已经做出了
> 前两列；本文记录的是第三列——`product/runtime-state.mjs`。
>
> 而第三列才是这张表真正要决定的事。

## 1. 「产品状态是 `unavailable`」这句话本身不改变任何行为

真正需要回答的是：

- 现在**能不能认领新任务**？
- 已经认领的怎么办——继续跑、进入恢复判断、还是等它收敛？
- lease 要不要继续延长？

不去回答它，结果是每个调用点各自解释一遍。而「各自的解释」里最省事、
也最危险的那一种是：**出错时不认领这件事没做，于是照常认领。**

所以 `CLAIM_POLICY` 是一张**全表**，六个状态一个都不能漏，
`assertClaimPolicyTotal()` 会把漏掉的、自相矛盾的都报出来；
`claimScope` 只有三档（`none` / `all` / `required-capabilities-only`），
`inFlight` 也只有三档（`unchanged` / `recovery-judgement` / `drain`）。

| 状态 | 认领 | 范围 | 在途 | lease | 禁自动执行 |
| --- | --- | --- | --- | --- | --- |
| `starting` | 否 | none | unchanged | **否** | 否 |
| `ready` | **是** | all | unchanged | 是 | 否 |
| `degraded` | 是 | **必需能力全满足** | unchanged | 是 | 否 |
| `unavailable` | 否 | none | **恢复判断** | 否 | 否 |
| `incompatible` | 否 | none | **恢复判断** | 否 | **是** |
| `upgrading` | 否 | none | **等收敛** | 否 | 否 |

两处需要说明的补充：

- `starting` 的 `renewLeasesIndefinitely: false` 是 spec 明写的
  「已有 lease 不延长为无限期」。一个无限延长的 lease 会让
  「引擎还在启动」变成一件无限期的事，而任务看起来一直在被处理。
- `incompatible` 的 `inFlight` spec 没写。我补成**恢复判断**：
  在不兼容的组件上，在途的 Attempt 不可能正常完成，所以它既不该
  「继续跑」，也不该「什么都没发生」。

## 2. 最危险的一处：认不出状态时默认可以干活

一个没见过的状态字符串——版本不匹配、有人手改了状态文件、以后新增了状态——
如果落到「默认可以认领」，那么产品的每一次「状态不明」都会变成一次
**在坏掉的产品上执行的自动化**。而执行是有代价的：它花用户的钱、
改用户的代码、发用户的消息。

> 一个在状态不明时「默认照常执行」的系统，与一个在状态不明时
> 随机执行一部分任务的系统，在「用户的钱会不会被乱花」上是同一个东西。

所以四条纪律：

1. **认不出 → `mayClaim: false`**，且连**自动执行**也禁止。
   为什么不用 `unavailable`：`unavailable` 只停认领，`incompatible`
   还额外禁止自动执行。状态不明时该选更严的那一个——
   *「我不知道出了什么事」不是「事情还可以继续」的理由。*
2. **标 `unrecognized: true`**，且文案里写明「**这不是一个已知的故障结论**」。
   不冒充：不把「组件不兼容」这个具体结论安到一个我们并不理解的输入上。
3. **不抛错。** 抛错会让调用方写 `try/catch`，然后 fallback 到「照常执行」——
   那正好绕过了这里全部的判断。
4. `RUNTIME_STATES` 的顺序与 spec §6.3 表格**逐字一致**，有用例钉住。

## 3. `degraded`：不给判据不等于判据都满足

`degraded` 的含义是「只认领其**必需能力全部满足**的任务」。
调用方必须把「这一批任务里哪些的能力满足了」告诉我们。

**不给判据时一个都不认领**，而不是「大概都行」：

> 不给判据不等于判据都满足。

同样地，空的能力清单也一个都不认领——「一个都不满足」不是「可以开始」。

## 4. 抬升：外部信号只能往**更保守**的方向抬

`liftProductState(processState, { selfCheck, upgrading })`：

| 信号 | 结果 | 为什么 |
| --- | --- | --- |
| `upgrading: true` | `upgrading`（**优先级最高**） | 升级期间即使所有进程都报 `ready` 也不能认领——那是「一边换零件一边开工」 |
| `selfCheck.state === 'incompatible'` | `incompatible` | 补丁层没生效时，进程全绿也不能报 `ready`：**进程都起来了不等于能力层生效了**（PRT-215 的接线点） |
| 都没有 | 原样返回 | `liftedFrom: null`，不制造一个假的「抬升过」 |

报告里 `processState` 与 `runtimeState` **分开给**，所以「抬升过」看得出来。
抬升一定伴随一条 `liftReason`：一个悄悄变了的、用户看不懂的状态，
会被当成「产品又抽风了」，而不是「有一个具体的原因」。

## 5. 「产品还能用」不能读成「数字员工在上班」

spec §6.3 末尾单独说明：只读 Workbench 和 team-hub 在 Runtime 不可用时
继续开放，用户仍可查看、导出和处理任务，**但不能伪装为数字员工在线**。

所以 `readOnlySurfacesOpen` **恒为 true**（一个在引擎挂掉时连任务列表都
看不了的产品，会让用户在最需要看一眼的时候什么也看不到），
而 `digitalWorkerOnline` **只在 `ready` 为真**。
两个字段放在一起就是为了这个区别，有用例逐个状态检查这一点。

## 6. 变红验证：20 处，20 处红

重点：★ 认不出时默认可以认领 / 不标 `unrecognized` / 退回 `unavailable`
（严的那一层没了）/ `degraded` 不给判据时当成都满足 / `incompatible` 不再
禁止自动执行 / 补丁层没生效仍报 `ready` / 升级中仍报 `ready` /
只读面在不可用时关掉。

### 三处"没咬"——其中两处暴露了**校验本身不可观测**

| 探针 | 为什么没红 | 处置 |
| --- | --- | --- |
| ㉒⑩ `incompatible.inFlight` 改成 `unchanged` | 用例只断言了 `mayClaim` 与 `blockAutoExecution`，**没断言在途处置** | 补断言（并写明这是我对 spec 的补充） |
| ㉒⑰ 自检不再报「状态缺失」 | 自检读的是**真表**，而真表当前是**完备的**——把检查改弱，结果依然「没问题」 | **让自检可注入**，改成测试直接喂一份故意做坏的表 |
| ㉒⑱ 自检不再查「可以认领 + 范围 none」 | 同上：真表里没有这种档，删掉那条检查也看不出来 | 同上，并重瞄为「判据盯错了范围」 |

> 一个只能对「当前恰好正确的那份输入」作答的校验，
> 与一个恒真的校验，在「它能不能发现错误」上同形。

这与 PRT-709 / PRT-705 里那几处是同一类判断（`logFilePath` 的抽出、
`assertClaimPolicyTotal` 的注入）：**当一道守卫的输入恰好总是正确的，
它是否有效就不可观测了；把它变成可喂坏输入的，才能证明它真的会拦。**

## 7. 本批**没有**解决的事

- **还没有调用方**：`mayClaimTasks` / `runtimeStatusReport` 已经可用且判据完整，
  但 Orchestrator 的扫描循环尚未改成调用它——它现在是「可供接入」而不是
  「已经接上」。这是本任务最诚实的边界。
- **`incompatible` 的真实来源还差一环**：`liftProductState` 接受
  `selfCheck.state === 'incompatible'`，而把 `runtime/dsh-composition/selfcheck.mjs`
  的结论接到 Launcher 上还缺一个「组合观测」的生产者
  （`COMPOSITION_UNOBSERVED`）。当前只能由调用方直接传入。
- **`upgrading` 没有升级协调器**：信号可以由外部传入，但产品里还没有
  一个真正会置位它的升级流程。
- **`renewLeasesIndefinitely` 没有消费者**：lease 续期由 Orchestrator 负责，
  那一侧还没读这个字段。
- **界面上没有这张表的展示**：`runtimeStatusReport` 有 `text` 与
  `digitalWorkerOnline`，但 Workbench 还没有把它渲染成一个状态条。
