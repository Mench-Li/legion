# 本轮交付报告 —— F-01～F-25 在 Legion→DSH 架构上的落地

> 日期：2026-09-17 ｜ 依据：[`MULTI-AGENT-FEATURE-OPTIMIZATION.md`](../../MULTI-AGENT-FEATURE-OPTIMIZATION.md) 的 §5 执行顺序
> 对照表：[`MULTI-AGENT-FEATURE-STATUS.md`](../../MULTI-AGENT-FEATURE-STATUS.md) ｜ 权威台账：[`superpowers/prt/PRT-PROGRESS.md`](./PRT-PROGRESS.md)
>
> **结论先说**：优化清单里**可以在代码侧单独完成的部分已经做完了**；
> 剩下的每一条都指向一个**代码之外的决定**（产品裁决、另一台机器、真实用户、排期日期），
> 或指向另一个 agent 进程**当轮正持着未提交改动**的文件。
> 详见 §5 的 14 条人工介入清单。

---

## 1. 本轮交付（提交）

| 提交 | 内容 | 判据 |
|---|---|---|
| `933365c` | **F-19** Employee / Role Pack | 75 例（`role-pack` 40 + `role-pack-store` 25 + `role-pack-http` 10） |
| `b1800af` | **F-18** 经验图谱 / 摩擦学习 | 75 例（`friction` 23 + `graph` 15 + `experience-store` 23 + `experience-http` 14） |
| `747de46` | **F-20** 能力包回滚 / 账持久化 / 安装事实 | `store` + `pack-facts` + HTTP |
| `8c8ee84` | **PRT-509 B2** `inspectSecretsAcl` 从死代码变成唯一读取点 | `secrets.test.mjs` ⑧ |
| `6bdf4fc` | **F-21** Connector / MCP 注册表 | **64 例** + **30 处变异** |
| `7336ab1` | **docs(F-04)** 手抄台账合计对不上 → 补 3 条门禁 | `progress-check` 15/15 |
| `a2fc2df` | **docs(F-21)** 如实从 ✅ 改回 🟡 + 门禁锚点纠错 | 同上 |
| `7ad5c8b` | **PRT-604/605/606** 三道范围检查在生产里从未跑过 → 变成读数 | **5 例** + **5 处变异** |

新增生产/测试文件 **18 个**（`git diff --name-status`）：

```text
runtime/connectors/{registry,registry.test}.mjs
runtime/employee/{role-pack,role-pack.test}.mjs
runtime/experience/{friction,friction.test,graph,graph.test}.mjs
runtime/dsh-composition/production-scope-wiring.test.mjs
team-hub/{connector-store,connector-store.test,connector-http.test}.mjs
team-hub/{experience-store,experience-store.test,experience-http.test}.mjs
team-hub/{role-pack-store,role-pack-store.test,role-pack-http.test}.mjs
```

## 2. 按文档 §5 执行顺序的进度

| 顺序 | 内容 | 状态 |
|---|---|---|
| ① | Runtime Contract / DshRuntimeAdapter 边界 | ✅（PRT-101～107、PRT-213/214/253 主体） |
| ② | 阶段 2.5 最小商业闭环 | 🟡 PRT-253（`canRead` 需改 wire 契约 ⇒ 人裁决）；PRT-256 ⏸（需真实用户） |
| ③ | Orchestrator 切片 | ✅ PRT-301～315；⬜ PRT-316 **排期未到**（最早 2026-09-24） |
| ④ | 用量/自动化/连接器/多 Harness/多用户 ACL | F-15 🟡（缺 `peak-resource`，阻塞于人）、F-16 ✅、F-17 ✅、**F-21 本轮落地**、F-23/F-25 ⏸、F-22/F-24 按 §9 按需 |

F-01～F-25 的逐条状态与依据见对照表；台账 145 条今天读数是 **138 ✅ / 4 🟡 / 1 ⬜ / 2 ⏸**。

## 3. 三个功能任务的判据与"它防的是哪种坏写法"

### 3.1 F-19 Employee / Role Pack（`933365c`）

- **七类版本一个不少**，缺一类**不给默认空值**：`connectors: []`（显式"就是不用"）合法，
  **没写这一节**非法——"缺连接器就当没有"与"作者忘了写、于是静默地没有"在运行结果上同形。
- **版本号是标签、内容哈希才是身份**：对账把 `VERSION_DRIFT`（显眼）与
  `CONTENT_DRIFT`（阴险——按版本号比对会报"一致"）**分开报**。
- 岗位包属 **agent 平面**，强制面字段在**每一层嵌套**都被拒；连接器一节只许出现引用。
- 冻结**改不动**：主键 `(scope, role_pack_id, version)`；同版本换内容 **409**。

### 3.2 F-18 经验图谱 / 摩擦学习（`b1800af`）

- 与旧 `plugins/src/experience.ts` 最要紧的分歧：旧实现从**评论散文**里正则数信号，
  于是**改了措辞分数就变**——而"因为改词变成 0"与"这段时间确实没有摩擦"在报表上是同一个 0。
  新实现**只从结构化字段取值**，并有一条**结构级**用例禁止源码里出现正则字面量。
- **缺失的输入是"不知道"、不是 0**：缺任何一维 ⇒ `complete:false`、`score` **抛**。
- **草稿不是知识**：`draft → promoted | discarded`，两个终点都要人 + **封闭词表**的理由。
- **关系图只记不推断**：边不隐式创建节点、必须署名、**撤销是追加不是删除**、遍历带 visited。

### 3.3 F-21 Connector / MCP 注册表（`6bdf4fc`）—— 本轮唯一"从零到一"的功能

spec §4.4 要求四件事一起做（**服务/工具策略、风险分级、SecretStore、故障隔离**）。
此前 grep `connector`/`mcp` 在产品代码里**零命中**。判据照着**坏的写法**写：

| 坏写法 | 为什么它看起来能用 | 实情 |
|---|---|---|
| `if (declared === undefined) return 'allow'` | "没见过，交给下游判断" | = 任何人往 MCP server 上加一个工具就等于加一个后门 |
| 不认识的能力名兜底成 `critical` | "最安全" | 整个连接器莫名其妙全要人批，**没有一处**指出原因是名字拼错 |
| 只检查自己解构出来的三个字段 | 看起来在守着门 | `token: 'ghp_…'` 被解构丢掉、从未被检查 |
| `health = circuit === 'closed' ? 'healthy' : …` | 简洁 | **刚失败的连接器报 healthy**（熔断要连续三次才跳闸） |
| 路由收下 `version` 但不传给查询 | 不报错 | 问"1.0.0 放行了哪些工具"拿回 2.0.0 的清单，**响应里没有任何提示** |

★ 这四个真缺陷都是**跑出来的**，不是审出来的。判据：`registry` 31 + `connector-store` 22 +
`connector-http` 11 = **64 例**，**30 处变异全部咬住**。

### 3.4 两处"记账"工作（`7336ab1` / `a2fc2df` / `7ad5c8b`）

1. **F-04 那一行手抄的台账合计对不上**（写 143/19/1/2，实际 145 行 = 138/4/1/2），
   而且**没有任何门禁会去核对它**（`check-docs` 只管 README 与 `docs/FEATURES.md`）。
   → 改为不复制 + 补 `progress-check` 用例 ⑤⑥⑦（手抄合计 / 引用不存在的任务号 /
   状态标记不在图例）。**3/3 变异咬住**。
2. **F-21 从 ✅ 改回 🟡**：`createRegistry` 全仓**零生产调用方**——正是对照表 §2
   开场白那句"能力齐全、用例全绿、而生产调用方数为 0"。如实改回去，并写清接法与为什么本轮没接。
3. **★★★ 三道范围检查在生产里从来没有跑过**（PRT-603/604/605/606 与生产装配的落差）：
   `enforcementSurfaces()` 实测 `pathScope:false` / `whitelist:false`，
   `execution-scope`/`external-api-scope` **连端口都没有**。详见对照表 §5.2。
   → 新增 `production-scope-wiring.test.mjs`（5 例），**5/5 变异咬住**。完整链条（有行号）：

   | 环节 | 位置 | 读数 |
   |---|---|---|
   | 生产装配唯一入口 | `plugins/root-row.mjs:485-509` | `installEnforcementRoot({env, decide, createRequestApproval})`——只有三个键 |
   | 组合根透传 | `root.mjs:465-466` | `whitelist`/`pathScope` ⇒ `undefined` |
   | 装配默认值 | `assemble.mjs:135-136` | 均为 `null` |
   | 桥的行为 | `tool-request.mjs:638-651` | `null` ⇒ 返回 `undefined` ⇒ **放行** |

   ★ **本轮没有接线**，因为**接了就是编造**：范围表（读根/写根/平台）今天不在任何随请求
   到达的载荷里——与 PRT-253 论证 `canRead`「答案不在这边」是同一个形状，
   而凭空造一份范围表正是那篇 §3 明令禁止的"不发明任何默认值、替身或暂时放行"。

## 4. 阶段的总结

### 阶段 A：把"从零到一"的功能补齐（F-18 / F-19 / F-21）

这三条的共同点是**此前 grep 零命中**。它们都按同一条纪律落的地：
**先写"坏的写法长什么样"，再写判据**。三条合计 **214 例**、**54 处变异全部咬住**
（F-19 12 + F-18 24 + F-21 30 — 见各自文档）。

### 阶段 B：处理"用例全绿而生产调用方为 0"

这是本轮**更有价值**的一半，而且它**不在功能清单里**。三次同样的发现：

1. F-21 的判定面（`decide()`）零调用方；
2. PRT-603/604 的 `whitelist`/`pathScope` 端口生产不注入；
3. PRT-605/606 的检查器连端口都没有。

三者的**共同形状**是：**注入点让"没接"变成一个可选状态，而可选状态没有调用方。**
对应的处置统一为"**把它变成读数**"（PRT-253 自己立的标准）——
所以现在**接上了会红**，而不是靠人记得。

### 阶段 C：把"账"本身的缺陷修掉

本轮发现两处**账层面的**缺陷（都不是功能缺陷）：

- 一份手抄的合计数字**对不上**且**无人核对**；→ 去掉副本 + 补门禁。
- 三条 ✅ 的依据是"模块 + 自己的用例"，与台账 §0 那条告警
  「只有自己的用例驱动的原语一律 🟡」**口径不一致**。
  → **没有擅自改状态**（口径由项目方定），记进人工介入清单第 14 条。

## 5. 需人工介入清单（汇总）

完整的"需要谁 / 决定什么 / 不决定的后果"见
[`MULTI-AGENT-FEATURE-STATUS.md` §5](../../MULTI-AGENT-FEATURE-STATUS.md)（共 14 条）。摘要：

| # | 事项 | 需要谁 | 不做会怎样 |
|---|---|---|---|
| 1 | PRT-011 DSH 分发形态 | 项目主 | PRT-009 只能停在 🟡 |
| 2 | PRT-009 峰值资源采样 | **执行期外的机器** | 仓内无法测（会话转录不记进程资源） |
| 3–4 | PRT-214 G1 / G4 | 项目主 / 产品 | per-Run 身份只能到进程级；自检通过标准无权威定义 |
| 5 | PRT-253 G2/G3/G4/G6 | 产品 + 项目主 | 黄金任务只能"代码就绪" |
| 6 | PRT-509 C1～C4 | 产品 | 凭证轮换/多档案/失败姿态/运维出口 |
| 7 | 真实凭据 / 另一台机器 | 项目方 | 跨机器证据仍缺 |
| 8 | F-23 / F-25 是否要做 | 产品 | 现按**设计决定**归档 |
| 9 | PRT-316 开工资格 | 项目主（时间到点即可） | **无人需裁决**，最早 2026-09-24 |
| 10 | F-22 远程后端 / F-24 多用户写面 | 产品 | 长期 🟡（**设计决定，不是缺陷**） |
| 11 | PRT-509 剩余三条 | 环境 + 项目方 | 如实记 🟡，不冒充已闭合 |
| 12 | F-19 七类版本范围确认 | 产品 | 有真实包在库后再改就要处理兼容 |
| **13** | **F-21 判定面接线资格** | 项目主 | F-21 停 🟡："闸门写好了、还没装到门上" |
| **14** | ★★★ **三道范围检查的生产接线** | 产品 + 项目主 | **越界路径今天拦不住**（`pathScope === null` ⇒ 放行） |

## 6. 诚实边界（本轮**没有**证明的东西）

写在这里以免下一个人把绿色摘要读成超出它范围的结论：

| 事项 | 已证明 | **未**证明 |
|---|---|---|
| F-18 摩擦分 | 只从结构化字段取值、缺输入是"不知道" | 上游数据（`run_validations`/attempt）在真实运行里写得够不够全 |
| F-18 图 | 只记不推断、撤销是追加、带环遍历不挂死 | **没有任何真实调用方**在跑它 |
| F-19 岗位包 | 七节齐全、两种漂移分开、冻结改不动 | 包里的引用是否指向**世界里真实存在**的东西 |
| F-21 连接器 | 未声明即拒绝、风险只上抬、密钥只许引用、熔断有截止时间 | **没有连过任何一个真的 MCP server**；判定面零调用方；`resolveSecretRef` 未接 `SecretStore` |
| PRT-604/605/606 | 三道检查器本身写得很硬（尤其 `path-scope` 那 22 例） | **生产里一次都没跑**（§3.4） |
| PRT-509 | 同机"真进程读到了值"（DSH 提供方从 Legion 材料化的文件里读到） | win32 `0600` 不可证；跨机器证据缺 |

## 7. 复跑方法

```bash
# 全量门禁
node scripts/ci/run-ci.mjs

# 本轮新增/相关的四组（合计 219 例）
node --test runtime/employee/role-pack.test.mjs team-hub/role-pack-store.test.mjs team-hub/role-pack-http.test.mjs
node --test runtime/experience/friction.test.mjs runtime/experience/graph.test.mjs team-hub/experience-store.test.mjs team-hub/experience-http.test.mjs
node --test runtime/connectors/registry.test.mjs team-hub/connector-store.test.mjs team-hub/connector-http.test.mjs
node --test runtime/dsh-composition/production-scope-wiring.test.mjs

# 账与门禁自身
node --test scripts/prt/progress-check.test.mjs

# 契约基线 / 拓扑清单（新增表或路由后必须刷新）
node scripts/prt/baseline-snapshot.mjs --diff
node scripts/prt/topology-inventory.mjs --diff
node scripts/config/scan.mjs --check
```

★ **`--only test` 今天整体仍是 FAIL，唯一失败的是 `config` 组，且与本轮无关**：
它报的未处理字面量恰好是**同一工作树上另一个 agent 进程**正在改的文件的
（`RUNTIME_HOST_REGISTRAR_IDENTITY_UNREADABLE` 等，落点 `runtime/dsh-composition/plugins/`、
`product/launcher/*`、`runtime/{contracts,dsh-composition}/run-identity.mjs`，均为该进程未提交/未跟踪的文件）。
把本轮的文件 `git add` 之后重跑 `scan --check`，输出为「✔ 全部读取点、字面量与动态读取已在 schema 中处理」。

## 8. 结论

**"任务全部完成"这句话需要限定，而限定本身就是本轮最重要的交付之一。**

- 清单里**可以在代码侧单独关闭**的：已关闭（F-18 / F-19 / F-21 落地；F-16/F-17/F-20 等前序批次已在）。
- 清单里**代码侧关不掉的**：14 条，全部指向人、机器、时间或真实用户（§5）。
- 以及一条**不在清单里**的真实缺口：三道范围检查在生产里从未跑过（§3.4）——
  它的修法需要先回答"范围数据从哪来"，那是一个产品决定。

> 一份把"有用例"读成"已生效"的进度表，
> 与一份把未完成读成完成的进度表，是同一个东西。
> 本轮的每一次改动都尽量落在同一侧：**宁可记 🟡 并写清缺哪一条，也不让读数比事实好看。**
