# T-016 方案搜索与选型报告：离线优先分布式任务队列系统

> 角色：researcher（方案搜索）｜阶段：方案搜索｜输入：docs/REQUIREMENTS.md（T-014 需求澄清，6 项定稿基线 + 3+1 待决点）
> 结论一句话：**自建「原语组装型」队列——SQLite(WAL) 本地 outbox + 借用 NATS JetStream 幂等去重、CouchDB MVCC/changes-feed、etcd lease/fencing 三类成熟语义自研同步/栅栏胶水 + MQTT QoS1（或 NATS）做边缘传输 + TigerBeetle VOPR / FoundationDB flow / crashmonkey 做双 harness 验证。** 无单一成品满足合成需求；排除一切中心 broker 与 exactly-once 平台。

## 0. 结论速览（TL;DR）
- 存储/outbox：**SQLite（WAL，synchronous=FULL）+ UNIQUE/UPSERT**（public domain，崩溃安全，db-unique 信任根）。
- 幂等/去重：**借用 NATS JetStream Nats-Msg-Id 去重窗口 + TigerBeetle 幂等账本语义**，自实现幂等键 + 有限去重窗口（对应 ⚖️-2 的「窗口+溢出策略」）。
- 对等同步/版本序：**借用 CouchDB 多主复制 + MVCC 修订号 + changes feed 语义**（业务层版本序=CAS；L4 意图对账=changes feed 增量对账）；CRDT（Automerge/Yjs/Loro）仅备选。
- 边缘传输/断点续传：**MQTT QoS1 + persistent session（Mosquitto，EPL-2.0）**，或 **NATS leaf node**（若接受中继）；仅同步通道，非中心存储。
- lease/fencing：**借用 Chubby/etcd lease + fencing token 语义**，自实现单调 epoch + 持久 fence token；不引入 etcd 集群。
- 验证：**TigerBeetle VOPR + FoundationDB flow 方法学（协议层确定性模拟）+ crashmonkey / kill -9 / 掉电 / ENOSPC（耐久层）**。
- 待将军裁决：3+1 待决点给出 researcher 侧研究结论（§10），与 REQUIREMENTS.md §5 裁决口径对齐；§14 给出 7 份 ADR 建议清单。

## 1. 范围与方法
- 约束：边缘轻量、离线优先、对等（无中心 broker）、at-least-once + 幂等键 = effective-once、全网禁 exactly-once、放弃 per-key FIFO。见 REQUIREMENTS.md §2/§4。
- 评估维度（每决策域）：**适配度 / 成熟度 / 许可证 / 维护活跃度 / 迁移成本**。
- 候选来源：本地持久化（SQLite/LMDB/RocksDB/LevelDB/自研 append-WAL）、幂等去重（NATS JetStream/TigerBeetle/DB UNIQUE/对象存储 CAS）、对等同步（CouchDB/PouchDB/Automerge/Yjs/Loro/RxDB）、边缘传输（Mosquitto/EMQX/NATS leaf）、租约（etcd/hashicorp raft/Dragonboat）、验证（FoundationDB/TigerBeetle VOPR/crashmonkey/Jepsen/Antithesis）、对照排除（Temporal/Cadence/Hatchet/Restate/Inngest/Kafka/Pulsar/RabbitMQ/BullMQ/Asynq/Celery）。
- 数据限制声明：本阶段禁网，许可证与活跃度为基于既有知识的定性评估；不臆造精确数字（star/commit 频率）；需联网复核项统一标注「待核」，见 §15。

## 2. 决策域 A：本地持久化 / outbox 原语
requirement 定稿：本地 WAL/outbox 是唯一耐久根（§4.1）。候选：

| 候选 | 许可证 | 成熟度/维护 | 适配度 | 迁移成本 |
|---|---|---|---|---|
| **SQLite（WAL, synchronous=FULL）** | public domain | 极高，业界最全 crash 测试之一，持续活跃 | **高**：单文件、崩溃安全 WAL、事务（append+commit 原子）、UNIQUE/UPSERT 直接当 db-unique 信任根、单写者与「每节点本地 outbox」正好匹配 | **极低** |
| LMDB（mmap B+树） | OpenLDAP Public License | 高，稳定 | 中：崩溃安全、单写者、mmap 快；但无 SQL 查询、无事务外 UNIQUE 语义、调试/对账可读性弱 | 中 |
| RocksDB | Apache-2.0（或 GPL 双许可） | 高 | 低：LSM 面向 KV/批量写，无事务/UNIQUE，compaction 与队列出队语义相悖 | 中 |
| LevelDB | BSD-3-Clause | 中（维护趋缓） | 低：同上，且单进程、生态老 | 中 |
| 自研 append-only WAL | — | — | 中：可控但需自证崩溃安全（group commit/fsync/CRC/恢复），重复造轮子 | 高 |

**推荐：SQLite（WAL, synchronous=FULL）+ UNIQUE/UPSERT。** 理由：崩溃安全语义久经考验且零运维；ON CONFLICT 提供原子幂等插入（对应 L2 硬吸收的 B2 token 条件写落点之一）；单写者限制与「无中心 broker、每节点本地写、跨节点走复制」的架构天然对齐。取舍：LMDB 更快但不可查询、无 UNIQUE 语义（需自建索引判重）；RocksDB/LevelDB 是 KV 引擎而非「outbox + 账本」引擎，判重/对账要自建。

## 3. 决策域 B：幂等键 / 去重窗口 / CAS 原语
requirement 定稿：at-least-once + 幂等键 = effective-once；B2 token 条件写 = 唯一硬吸收层，仅可版本化写（CAS/idempotent-key）（§4.3）。候选：

| 候选 | 许可证 | 成熟度/维护 | 适配度 | 迁移成本 |
|---|---|---|---|---|
| **SQLite UNIQUE + UPSERT（ON CONFLICT DO NOTHING）** | public domain | 极高 | **高**：db-unique 信任根，幂等插入 = effective-once 的最小原子原语 | **极低** |
| **NATS JetStream 去重窗口（Nats-Msg-Id + DuplicateWindow）** | Apache-2.0 | 高，活跃 | **高**：有限去重窗口 + 显式溢出策略的现成先例（直接回答 ⚖️-2「窗口+溢出」） | 中（若引入 NATS） |
| **TigerBeetle（幂等账本/transfer）** | Apache-2.0 | 高，非常活跃 | **高（语义参考）**：幂等键 + 双相记账 + CAS 的标杆实现与测试哲学 | 中（借语义非代码） |
| 对象存储 CAS（S3/OSS If-Match） | 平台侧 | 高 | 中：object-cas 信任根（REQUIREMENTS.md §6.2 kind），适合大 blob 副作用，不适合高频队列元数据 | 中 |

**推荐：SQLite UNIQUE/UPSERT 为默认信任根（db-unique），语义参考 NATS 去重窗口 + TigerBeetle 幂等账本。** 理由：NATS 的 DuplicateWindow（可配置 TTL 窗口 + 窗口溢出即放弃去重保证）是「幂等保证有界、溢出显式」的诚实先例，正好把 ⚖️-2 的「无限递归」变成「有限窗口 + 显式降级」；TigerBeetle 证明「幂等键 + CAS + 双存储校验」可被确定性模拟覆盖（对应 ⚖️-3 oracle 住测试侧）。

## 4. 决策域 C：对等同步 / 版本序 / 意图对账
requirement 定稿：对等同步、无中心 broker；最终一致 + 业务层版本序（§4.4）；L4 意图对账 = 条件观测，P(未检测|intent durable)=0（§4.3）。候选：

| 候选 | 许可证 | 成熟度/维护 | 适配度 | 迁移成本 |
|---|---|---|---|---|
| **CouchDB（多主复制 + MVCC 修订号 + changes feed）** | Apache-2.0 | 极高，成熟 | **高（语义来源）**：MVCC 修订号=版本序/CAS；changes feed=L4 增量对账；多主=对等 | 中（本体偏重，借语义自实现轻量版） |
| PouchDB | Apache-2.0 | 高，活跃 | 中：可嵌入的 CouchDB 协议实现，适合 Node/浏览器内嵌 | 中 |
| Automerge | MIT | 高 | 中：CRDT 自动合并，但无 lease/fence/权威语义，表达 task_gate 派生/栅栏弱 | 中 |
| Yjs | MIT | 高 | 低：协同文档 CRDT，非任务语义，无权威/租约概念 | 中 |
| Loro | MIT/Apache（待核） | 中，新但活跃 | 中：新 CRDT，性能好，语义同 Automerge 局限 | 中 |
| RxDB | Apache-2.0 | 高 | 中：离线优先 DB+复制插件，偏前端/文档，非队列 | 中 |

**推荐：自研轻量同步，语义照搬 CouchDB 的「MVCC 修订号 + changes feed + 多主冲突按业务版本序收敛」。** 理由：已定「业务层版本序」就是 MVCC 修订号的同构物；changes feed 天然支撑 L4 意图对账的「增量拉取对端变更→逐条比对 intent」；CRDT（Automerge/Yjs/Loro）解决「收敛」，但解决不了「谁持有 lease、栅栏在哪、task_gate 谁派生」这类权威问题——而 T-016 的核心难点恰恰是权威/栅栏而非收敛，故 CRDT 只作备选、不作主同步层。取舍：CouchDB 本体含集群管理/视图等边缘不需要的部件，故「借语义自实现轻量复制」优于「整机引入」。

## 5. 决策域 D：边缘传输 / 断点续传通道
requirement 定稿：无中心 broker（§4.1）；但「断点续传」需要 at-least-once 通道语义。本域把传输层与队列存储层解耦：队列=本地 outbox，传输=把 outbox 变更带到对端。

| 候选 | 许可证 | 成熟度/维护 | 适配度 | 迁移成本 |
|---|---|---|---|---|
| **Mosquitto（MQTT QoS1 + persistent session）** | EPL-2.0 | 极高 | **高**：QoS1=at-least-once、persistent session=断线重连续传、轻量、可嵌入/单机运行 | **低** |
| EMQX | Apache-2.0 | 高，活跃 | 中：边缘集群更强，但更重 | 中 |
| NATS leaf node + JetStream | Apache-2.0 | 高，非常活跃 | **高（备选）**：leaf 边缘→中心流 + 去重，与 §3 去重原语一体 | 中 |

**推荐：Mosquitto（MQTT QoS1 + persistent session）作默认传输；NATS leaf node 作「接受中继」场景的备选。** 理由：MQTT QoS1 + persistent session 是「离线/断点续传」最轻最成熟的现成语义；Mosquitto 可嵌入式单机运行、不强制中心集群，不违反「无中心 broker」。取舍：EMQX 需要更重边缘集群时才选；NATS 与 §3 幂等去重一体、运维统一，但引入 NATS 运行时。**关键边界：三者只作「传输/同步通道」，不承担队列状态权威——本地 outbox 仍是唯一耐久根，避免中心化复发。**

## 6. 决策域 E：lease / fencing / 双活窗口
requirement 定稿：W = lease_TTL + takeover_latency + max_declared_side_effect_duration（§4.6）；lease 数值整列置空、由假死分布 × 双活代价标定（⚖️-1）。候选：

| 候选 | 许可证 | 成熟度/维护 | 适配度 | 迁移成本 |
|---|---|---|---|---|
| **etcd lease + fencing token（Chubby 模式，语义借用）** | Apache-2.0 | 极高 | **高（语义）**：lease=失效检测上限、fencing token=单调 epoch 写，正是 B2/B3 需要的 | 高（若整机引入集群，重） |
| hashicorp/raft | MPL-2.0 | 高 | 中：可嵌入 Raft 强一致，但 T-016 已定「对等同步」非全 Raft | 中 |
| Dragonboat | Apache-2.0 | 高 | 中：同上 | 中 |

**推荐：借 Chubby/etcd 的「lease + fencing token」语义自实现：单调 epoch + 持久 fence token + lease TTL；不引入 etcd 集群。** 理由：已定「对等同步」不需要 Raft 全序，但「双活防护」必须借用 fencing 语义——「lease 到期前服务器保证不把所有权交给别人，持有者持单调 fence token 写」。对 ⚖️-1 的研究结论：**Chubby/etcd 中 lease 的量纲从来是时间（失效检测延迟上限），与磁盘预算正交**，故「存储预算反推 lease」无先例可依，成熟实现均以「假死/分区时长分布」为 lease 标定输入。取舍：整机引入 etcd 集群过重且与对等同步冲突，语义借用成本低。

## 7. 决策域 F：验证载体（协议层模拟 + 耐久层注入）
requirement 定稿：协议层确定性模拟 + 耐久层真实二进制 kill -9/掉电/ENOSPC，两套 harness 互相校验（§4.5）。候选：

| 候选 | 许可证 | 成熟度/维护 | 适配度 | 迁移成本 |
|---|---|---|---|---|
| **FoundationDB flow 确定性模拟** | Apache-2.0 | 极高 | **高（方法学）**：把网络/磁盘/时钟注入为可调度 actor，确定性模拟鼻祖 | 高（借方法非代码） |
| **TigerBeetle VOPR** | Apache-2.0 | 高，非常活跃 | **高（方法学 + 幂等/CAS 测试哲学）**：真实故障注入 + 状态机比对，其幂等去重与 T-016 同构 | 中（借方法非代码） |
| crashmonkey | MIT（待核） | 中 | 高：文件系统崩溃一致性注入（掉电/ENOSPC） | 低 |
| Jepsen | EPL（待核） | 极高 | 中：黑盒 kill -9/分区注入，适合最终一致校验 | 中 |
| Antithesis | 商业闭源 | 高 | 高但付费：确定性 hypervisor 故障注入 | 高（采购） |

**推荐：协议层自建 VOPR 式确定性模拟（借 FoundationDB/TigerBeetle 方法学），耐久层用 crashmonkey + kill -9/掉电/ENOSPC 真实二进制注入；DSH 插件仅作协议内循环（如 requirement 已定）。** 理由：TigerBeetle 已证明「幂等键 + CAS + 双存储校验」能用 VOPR 覆盖到静默损坏；crashmonkey 专门注入文件系统崩溃一致性故障，匹配「耐久层真实二进制」。对 ⚖️-3 的研究结论：**oracle 住在模拟器/测试侧，不驻生产路径**——生产只留可检测信号（WAL CRC、fence 单调、幂等命中计数），静默损坏由「注入 ground-truth 交错 → 断言静默交错集合=∅」的可数性质覆盖。

## 8. 对照排除（整体成品 vs 中心 broker vs 重平台）
requirement 已排除「中心 broker / exactly-once 平台」，本节记录对照与排除理由，防止复发。

| 候选 | 类别 | 排除理由 |
|---|---|---|
| Temporal / Cadence | durable execution | MIT；语义标杆（workflow-id 幂等 + event-sourced WAL + at-least-once），但中心服务 + 外部 DB，与「边缘本地 WAL」冲突；仅作语义参照 |
| Hatchet | durable execution | Apache-2.0（待核）；Postgres 中心，边缘不现实；参考其 transactional outbox |
| Restate | durable execution | BSL 源码可得（待核，非 OSI）；内嵌合规风险 |
| Inngest | durable execution | source-available（待核）；非自托管，排除 |
| Kafka / Pulsar | 中心 log | Apache-2.0；JVM 重、中心 log；其 exactly-once 是「有界+事务」，与「全网禁 exactly-once」相悖 |
| RabbitMQ | 中心 broker | MPL-2.0；at-least-once 成熟但中心化、离线队列弱 |
| BullMQ / Asynq / Celery | Redis/中心 broker | MIT/BSD；内存优先（Redis）、断电离线弱、中心依赖 |

## 9. 选型建议（一等 + 备选 + 取舍）

### 9.1 核心判断
**无单一现成项目同时满足「离线优先 + 对等同步 + 副作用级幂等分类 + 栅栏边界吸收 + 全网禁 exactly-once」的合成体。正确姿势是「借已验证原语、自研薄胶水」。**

### 9.2 一等选型（分层组合）

| 层 | 一等 | 借用的关键语义 | 对齐基线 |
|---|---|---|---|
| 本地 outbox/WAL | SQLite（WAL, synchronous=FULL, UNIQUE/UPSERT） | 崩溃安全 WAL、原子幂等插入（db-unique 信任根） | §4.1/§4.2 |
| 幂等/去重/CAS | 自研，语义借用 NATS 去重窗口 + TigerBeetle 幂等账本 | effective-once、有限去重窗口+溢出策略、CAS 版本写 | §4.3 B2 |
| 对等同步/版本序 | 自研，语义借用 CouchDB 多主 + MVCC 修订号 + changes feed | 版本序=CAS、L4 意图对账=增量对账 | §4.4/§4.3 L4 |
| 边缘传输 | Mosquitto（MQTT QoS1 + persistent session） | at-least-once、断线重连续传 | §4.1（仅作通道） |
| lease/fencing | 自研，语义借用 Chubby/etcd lease + fencing token | 单调 epoch、双活窗口 W | §4.6 |
| 验证 | TigerBeetle VOPR + FoundationDB flow 方法学 + crashmonkey | 协议确定性模拟 + 耐久真实注入 | §4.5 |

### 9.3 备选
- **备选 1（最小自研，接受中继传输）**：NATS JetStream（leaf node + stream 去重 + KV）统一承担「传输 + 幂等去重 + KV 版本序」三层，本地仍 SQLite outbox。适用：若「非中心 broker」放宽为「非中心存储/执行」。
- **备选 2（仅语义标尺）**：Temporal——不作为实现，仅作 durable execution 语义对齐标尺（幂等 workflow id、event-sourced、at-least-once）。
- **备选 3（同步层）**：Automerge/Loro CRDT——若后续把「对等状态复制」单独拆出且只需收敛不需权威，可替换 CouchDB 语义。

### 9.4 取舍理由
- 排除中心 broker/平台：违反 §4.1「无中心 broker」；exactly-once 平台违反「全网禁 exactly-once」。
- 排除整机引入 CouchDB/etcd：借语义足够，整机引入带入边缘不需要的集群/视图/权重。
- 排除 RocksDB/LevelDB：KV 引擎无 UNIQUE/CAS/对账查询，outbox+账本语义需自建。
- CRDT 不做主同步：解决收敛不解决权威（lease/栅栏/task_gate），与 T-016 难点错位。

## 10. 三条待决冲突的研究映射（researcher 侧结论）

### ⚖️-1 SLO/lease 推导链
研究结论：**Chubby/etcd 的 lease 量纲恒为时间（失效检测延迟上限 + fencing token 有效期），业界无「存储预算→lease」推导先例；lease 必须由「假死时长分布分位数 × takeover_latency × per-class 双活代价」标定。** 选型落点：借 etcd fencing 语义；用 VOPR 式确定性模拟把「假死分布」作为注入输入、lease 作为标定输出（实测回填），支持 REQUIREMENTS.md 的 lineage 门禁与「设计界 vs 实测值」两态拆分。明确否定任何「D/M/K 反推 lease」的断链结论。

### ⚖️-2 meta 递归终止
研究结论：结构性排除与幂等不动点**不是二选一**。业界先例（NATS DuplicateWindow）给出「有限去重窗口 + 显式溢出策略」：窗口内幂等键去重（自坍缩），窗口溢出显式降级（不假装保证）。递归终止条件 = **「有限窗口 + 吸收器自身 Class A 幂等（其幂等键由在册信任根保证）+ L4 意图对账」三者组合**。选型落点：信任根枚举映射到 REQUIREMENTS.md §6.2 kind——db-unique=SQLite UNIQUE、object-cas=S3/OSS If-Match、third-party-idempotency-key=支付/短信平台幂等键；吸收器副作用 class 必须 ≤ 所依赖信任根 class；「补偿=Class A」写为显式前置假设（声明依赖），而非可测终止证明。

### ⚖️-3 E[SilentDamage] 可测性
研究结论：**oracle 住在测试/模拟侧，不驻生产路径**（FoundationDB/TigerBeetle 的一致答案）。生产只留可检测信号（WAL CRC、fence 单调、幂等命中计数）；静默损坏由「注入 ground-truth 双活交错 → 穷举断言『静默交错集合=∅、每条交错留 absorbed ∨ audited 痕迹』」的可数性质覆盖。选型落点：采纳 REQUIREMENTS.md 方案 A（CI 签「已检测集 + 审计完整性」可数性质，不签概率期望值）；耐久层用 crashmonkey + kill -9/掉电/ENOSPC 与协议层模拟互相校验。

### ⚖️-4（schema 欠账）Class III 双窗口 Z
研究结论（researcher 倾向，与 requirement 默认一致）：**Z 入 v1 schema**。Z = self_fence_interval + in-flight duration 是 Class C 唯一能产生不可逆静默损坏的残漏窗口，Z 不入 schema 则 E[SilentDamage] 的 C 类项无定义。选型含义：Z 不引入新库，但要求本地 outbox 记录「自栅栏发起时刻 + 动作完成时刻」两枚单调时间戳（SQLite 表字段即可），供审计与对账断言。

## 11. 许可证与合规总表

| 候选 | 许可证 | 置信度 | 结论 |
|---|---|---|---|
| SQLite | public domain | 高 | 采纳 |
| NATS / JetStream | Apache-2.0 | 高 | 语义借用（备选运行时） |
| TigerBeetle | Apache-2.0 | 高 | 语义 + 方法学借用 |
| CouchDB / PouchDB | Apache-2.0 | 高 | 语义借用（PouchDB 备选内嵌） |
| Mosquitto | EPL-2.0 | 高 | 采纳（传输） |
| EMQX | Apache-2.0 | 高 | 备选 |
| etcd | Apache-2.0 | 高 | 语义借用 |
| hashicorp/raft | MPL-2.0 | 高 | 备选（若需强一致） |
| Dragonboat | Apache-2.0 | 高 | 备选 |
| FoundationDB | Apache-2.0 | 高 | 方法学借用 |
| crashmonkey | MIT（待核） | 中 | 耐久层工具 |
| Jepsen | EPL（待核） | 中 | 可选黑盒 |
| Automerge / Yjs | MIT | 高 | 备选（CRDT） |
| Loro | MIT/Apache（待核） | 低 | 备选（待核） |
| Temporal / Cadence | MIT | 高 | 仅语义参照 |
| Hatchet | Apache-2.0（待核） | 中 | 仅参考 outbox |
| Restate | BSL（待核，非 OSI） | 中 | 排除 |
| Inngest | source-available（待核） | 中 | 排除 |
| Kafka / Pulsar | Apache-2.0 | 高 | 排除 |
| RabbitMQ | MPL-2.0 | 高 | 排除 |
| BullMQ | MIT | 高 | 排除 |
| Asynq | MIT（待核） | 中 | 排除 |
| Celery | BSD-3-Clause | 高 | 排除 |

风险提示：EPL-2.0（Mosquitto）为弱 copyleft，静态链接/内嵌需评估衍生作品条款，建议进程隔离或动态链接；BSL/source-available 项（Restate/Inngest）不作为依赖。带「待核」项落地前逐条复核（§15）。

## 12. 迁移成本 & 自建 vs 采用总评
- 整体采用 Temporal/Cadence/Hatchet：语义成熟但中心服务 + 外部 DB，违反「边缘本地 WAL/无中心 broker」；排除（仅参照）。
- 整体采用 Kafka/Pulsar/RabbitMQ/BullMQ：中心 broker/内存优先，违反定位；排除。
- 整体采用 CouchDB/PouchDB：多主复制 + MVCC 契合，但队列权威（lease/栅栏/task_gate）不在其语义内，仍需自研，且整机引入偏重；**借语义自实现优于整机引入**。
- **自建（SQLite outbox + 借 NATS/CouchDB/etcd 语义 + MQTT 传输 + VOPR 验证）**：每层有公开/成熟先例，自研量集中在「轻量复制协议 + fence/lease 胶水 + 确定性模拟器骨架」三块（各约数百行），锁定与合规风险最低。
- 结论：**自建（原语组装型）**，逐域按 §9.2；3+1 待决点 researcher 倾向已给（§10），请将军按 REQUIREMENTS.md §5 裁决口径 + §14 ADR 落定后转拆解。

## 13. 本阶段验收标准（researcher 自定，因原验收标准留空）
- AC1 docs/RESEARCH.md 存在且已重写为 T-016（离线优先分布式任务队列），覆盖 6 项定稿基线 + 3+1 待决点。
- AC2 每个决策域 ≥2 候选，逐项给适配度/成熟度/许可证/维护/迁移成本。
- AC3 给出一等分层选型 + ≥2 备选 + 取舍理由，且与「无中心 broker、全网禁 exactly-once、放弃 per-key FIFO」基线对齐。
- AC4 3+1 待决点各给「研究结论 → 借用先例/库 → 如何帮助闭合」映射。
- AC5 许可证表准确，不确定项标注「待核」。
- AC6 未下载任何外部依赖；验证为本地命令（文件写盘 + 读回 + 结构/关键词检查）。

## 14. ADR 建议清单（7 份，交将军）
- ADR-1001 存储/outbox = SQLite(WAL) + UNIQUE/UPSERT（排除 LMDB/RocksDB/自研 WAL）
- ADR-1002 幂等/去重 = 有限去重窗口 + 溢出显式降级（借 NATS/TigerBeetle 语义）
- ADR-1003 对等同步 = CouchDB 语义（MVCC + changes feed），CRDT 仅备选
- ADR-1004 边缘传输 = MQTT QoS1 + persistent session（Mosquitto），仅作通道非权威
- ADR-1005 lease/fencing = Chubby/etcd 语义（单调 epoch + fence token），不引入 etcd
- ADR-1006 验证载体 = VOPR 式确定性模拟 + crashmonkey/kill -9/掉电/ENOSPC
- ADR-1007 trust-root registry 落地（db-unique/object-cas/third-party-idempotency-key 三类信任根）

## 15. 风险与未知（联网后需复核）
- 各「待核」许可证逐条 SPDX 核对（Hatchet/Restate/Inngest/Asynq/Loro/crashmonkey/Jepsen）。
- NATS JetStream DuplicateWindow 默认值/上限与 leaf node 去重行为。
- Mosquitto EPL-2.0 静态链接/内嵌合规结论。
- TigerBeetle VOPR 模拟器是否可外部复用（通常内嵌于 TB 仓库，作方法学借用）。
- CouchDB MVCC/changes feed 无中心多主下的冲突上限与 tombstone 行为。
- 各库 star/commit/最近 release（本阶段禁网，凭知识定性）。
