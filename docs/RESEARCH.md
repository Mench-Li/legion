# 多人实时协作白板（T-010）方案搜索与选型报告

> 角色：researcher（方案搜索）｜阶段：方案搜索｜输入：需求澄清已收敛基线 + 3 项待决分歧
> 结论一句话：**自建（基于 Yjs 原语）而非整体采用 tldraw/Excalidraw**——全栈许可证清洁（MIT）、范围可控、锁定成本最低。

## 0. 结论速览（TL;DR）
- 同步引擎：**Yjs (CRDT) + y-protocols/awareness + y-websocket**（MIT）。
- 渲染：**Canvas 2D 单画布（形状+笔迹统一）+ 独立透明 presence overlay**，Renderer 接口解耦；自由手绘用 **perfect-freehand**。
- 持久化：**SQLite(WAL) 单文件（better-sqlite3，备选 Node 24 内置 node:sqlite）+ StorageProvider 抽象**；拒绝 y-leveldb。
- 撤销：**Y.UndoManager（origin 过滤 + 手势级事务）实现每用户局部撤销**；redo 语义采纳 6/8 方案（撤销后远端并发 op 落到本人历史前即清空 redo）。
- 部署：**单容器 Docker + docker-compose + 静态前端 + 单进程 Node/ws + /healthz**，v1 显式单实例。
- 待将军裁决：3 项分歧已给出 researcher 倾向（与 7/8 多数一致）+ 7 份 ADR 清单。

## 1. 范围与方法
- 约束：单实例自托管、无外部 SaaS、本阶段禁网（不得下载依赖）、v1 范围已收敛。
- 评估维度（每决策域）：**适配度 / 成熟度 / 许可证 / 维护活跃度 / 迁移成本**。
- 候选来源：开源白板成品（tldraw、Excalidraw）、CRDT/同步库（Yjs、Automerge、ShareDB）、渲染库（原生 Canvas2D、Konva、Fabric、Paper、Pixi）、持久化（better-sqlite3、node:sqlite、y-leveldb、y-indexeddb）。
- 数据限制声明：本阶段禁网，许可证与活跃度为基于既有知识的定性评估；需联网复核项统一在 §9/§14 标注，不臆造精确数字（star 数 / commit 频率）。

## 2. 决策域 A：同步引擎（CRDT）
requirement 已一票排除 OT/ShareDB，本域聚焦 Yjs vs Automerge vs 托管替代，并确认 Yjs 落地要点。

| 候选 | 许可证 | 成熟度/维护 | 适配度 | 迁移成本 |
|---|---|---|---|---|
| **Yjs + y-protocols + y-websocket** | MIT | 高，CRDT 事实标准，API 稳定 | **高**：Y.UndoManager 局部撤销、awareness 独立通道、离线 y-indexeddb、二进制增量小、单进程 ws 自托管最简 | **低**（y-websocket 即官方参考单进程 ws 实现） |
| Automerge 2.x | MIT | 高，但网络/awareness 生态弱 | 中：语义好、自带历史，但无 awareness 标准、undo 无内置、无成熟 ws provider | 高（需自建 transport/presence/undo） |
| ShareDB(OT) | MIT | 成熟 | 已排除：OT 全局/协作撤销与「每用户局部撤销」语义冲突、离线重连复杂 | — |
| Liveblocks / PartyKit / y-sweet | 专有/托管 | — | 排除：Liveblocks 为 SaaS 非自托管；PartyKit/y-sweet 偏托管栈，单机自托管非主路径 | — |

**推荐：Yjs + y-protocols/awareness + y-websocket。** 理由：与已定基线完全一致；局部撤销、awareness 物理分离、离线/重连、单机自托管四项诉求均有官方原语；迁移成本最低。落地要点：y-websocket 原生持久化用 y-leveldb（决策域 E 替换为 SQLite）；presence 由 y-protocols/awareness 提供，绝不写进 Y.Doc。

## 3. 决策域 B：状态分层（已收敛，供 ADR）
持久态 = 元素（入 undo/持久化）；临态 = 光标/在线列表（走 awareness 独立通道），presence 绝不入文档/undo 历史。
- 验证：该分层即 y-protocols/awareness 的设计目的，是官方推荐模式；Excalidraw 房间式 JSON（无 CRDT）无法满足；tldraw 的 Yjs 绑定同样遵循该分层。
- 落地：v1 元素存于单一 Y.Doc 内的容器（Y.Map<elementId, 元素 Y.Map> 或 Y.Array）；presence 只走 awareness states（cursor(x,y)、selection、用户颜色/名）。

## 4. 决策域 C：渲染（待裁决项 1）
多数（7/8）：Canvas 2D 单画布 + 独立透明 overlay + Renderer 接口；coder：SVG(形状)+Canvas2D(笔迹)+overlay 三层。

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **Canvas 2D 单画布 + overlay（多数）** | 单渲染路径、1000–5000 元素轻松 ≥30fps、笔迹与形状渲染一致、代码量小 | 无 DOM 级命中、无障碍/文本选中 | **v1 推荐** |
| SVG 形状 + Canvas 笔迹 + overlay（coder） | 元素级 DOM 命中、矢量清晰、无障碍/文本选中、调试直观 | 两套渲染路径需统一坐标/命中/选中；大量元素 DOM 节点开销；与「笔迹+形状统一渲染」目标相悖 | 备选；v2 若要求文本选中/无障碍再评估 |

渲染库选型（若不用裸 Canvas）：

| 库 | 许可证 | 说明 | 结论 |
|---|---|---|---|
| **原生 Canvas2D + 自研场景图** | — | 零依赖、完全可控、命中测试自实现 | **v1 首选**（配合 Renderer 接口） |
| Konva | MIT | 成熟场景图+命中+变换/选择器，开发快 | 备选（大量元素节点开销需压测验证） |
| **perfect-freehand** | MIT | tldraw 同源，自由手绘平滑轮廓 | **手绘必选** |
| Fabric.js / Paper.js | MIT | 偏对象模型/矢量编辑，功能过重 | 不选（v1 范围外） |
| Pixi.js | MIT | WebGL，万级元素更稳但复杂度高 | v2 若超 1 万元素再评估 |

**推荐：Canvas 2D 单画布（原生 API）+ perfect-freehand + 独立透明 overlay；Renderer 接口解耦。** 取舍：v1 元素 1000/5000、无富文本/图片/多选，Canvas2D 单路径最简且满足性能基线；SVG 混合的收益（无障碍/文本选中）在 v1 非需求，留待 v2。

## 5. 决策域 D：v1 元素/操作清单（已收敛，供 ADR）
- 元素：矩形 / 椭圆 / 直线(含箭头) / 自由手绘 / 单行纯文本。
- 属性：位置、尺寸、颜色、线宽、文本内容（仅单行纯文本元素）、箭头标志。
- 操作：单选、移动、元素缩放、删除、改色、线宽。
- 视口：无限画布 pan/zoom 为视图变换，不入文档。
- v2（明确排除）：多选、图片、旋转、编组、橡皮擦、压感、富文本、账号体系、多实例横向扩展。
- 推荐 schema：每元素一个 Y.Map（type/id/x/y/w/h/color/strokeWidth/…；手绘=points[]；文本=text），容器用 Y.Map<elementId, Y.Map>。理由：按元素粒度 map 便于按 id 删除/局部更新，与 Y.UndoManager 的 origin 过滤天然配合。

## 6. 决策域 E：持久化（待裁决项 2）
多数（7/8）：SQLite(WAL) 单文件 + StorageProvider 抽象；coder：y-leveldb。

| 候选 | 许可证 | 单文件 | 可查询 | 迁移/运维成本 | 结论 |
|---|---|---|---|---|---|
| **better-sqlite3** | MIT | 是 | 是（SQL：board 列表/元素数/healthz/导出） | 低（WAL、同步 API、预编译二进制） | **v1 首选** |
| node:sqlite（Node 22.5+/24 内置） | MIT(Node) | 是 | 是 | 最低（零原生依赖，需固定 Node≥22.5） | 备选（Docker 固定 Node 24 时） |
| y-leveldb（Yjs 官方持久化） | MIT | 否（目录） | 否（不透明二进制） | 中（原生依赖、目录文件、不可查询） | **拒绝** |
| y-indexeddb（客户端离线） | MIT | — | — | 低 | 客户端离线/重连缓冲配套使用 |

**推荐：better-sqlite3（WAL）+ StorageProvider 接口**，服务端存 Yjs update 增量 + 定期快照压缩；客户端 y-indexeddb 做离线缓冲。拒绝 y-leveldb 理由：目录文件不符合「单文件嵌入式」、不可查询（无法做 /healthz、board 列表、导出、指标统计）。取舍：y-leveldb 与 Yjs 集成零成本（官方 provider），但被「单文件+可查询」目标否决；better-sqlite3 需自写约 100 行 provider（存 binary update + snapshot + 去重/压缩），一次性成本低。

## 7. 决策域 F：撤销/重做语义（待裁决项 3）
基线：每用户局部撤销（仅撤本人操作），全局/协作撤销排除 v1，undo 深度 ≥100。

实现候选：

| 方案 | 说明 | 取舍 |
|---|---|---|
| **Y.UndoManager + origin 过滤 + 手势事务** | 只捕获本人 op；每手势一个事务（stopCapturing）使「一次绘制/一次移动」=1 步；undo/redo 仅回放本人 op | **v1 首选**，零自研栈 |
| 命令模式（自研语义栈） | 语义级 add/move/setColor 命令栈，与 CRDT 解耦 | 更可控但需自维护一致性，v2 备选 |

redo 语义（分歧）：
- 6/8：撤销后，远端并发 op 落到本人历史前 → 清空本地 redo 栈。
- breaker/coder：保留 redo，仅重放本人 op，由 CRDT 独立收敛。

**推荐：采纳 6/8（清空 redo）。** 理由：①与「局部撤销、不承诺全局收敛语义」一致；②在并发插入后重放，Y.UndoManager 默认不保证结果直觉可预期，清空 redo 是最可预测、实现最简且无歧义；③「保留 redo 重放」在 CRDT 收敛理论上成立，但 UX 上「redo 出已被别人改动过的中间态」易困惑，且需额外跟踪本人 op 与远端交织，复杂度不值 v1。
实现细节：监听远端 update（origin 非本地）作用于被管 scope 时清空 redo。注意 Y.UndoManager.clear() 会同时清空 undo+redo，故需包装或单独维护 redo 栈（或在本地 undo 后置 redo 哨兵、收到远端插入即丢弃哨兵）。此项须在 ADR-0006 明确。

## 8. 决策域 G：部署形态（已收敛，供 ADR + 选型）
- 形态：单容器 Docker + docker-compose + 静态前端 + 单进程 Node/ws + /healthz；v1 显式单实例、不承诺横向扩展。

| 候选 | 许可证 | 说明 | 结论 |
|---|---|---|---|
| **y-websocket（扩展）** | MIT | 官方参考 ws server，含 awareness + y-leveldb 持久化钩子；替换持久化为 SQLite + 加 /healthz | **v1 首选** |
| Hocuspocus | MIT | 功能全（认证/扩展/持久化钩子）但重、面向富文本 | 不选（v1 过重） |
| 自写 ws provider | — | 完全可控，约 200 行（y-protocols 编解码 + awareness + 广播） | 备选（需深度定制时） |

推荐：以 y-websocket 为基座，替换持久化为 better-sqlite3、增加 /healthz（探活：ws 可达 + SQLite 可写读）。Dockerfile 多阶段（Node 构建前端 → 运行 Node 单进程）；compose 挂 SQLite 卷。## 9. 许可证与合规总表
| 候选 | 许可证 | 置信度 | 备注 |
|---|---|---|---|
| Yjs | MIT | 高 | 采纳 |
| y-protocols | MIT | 高 | 采纳 |
| y-websocket | MIT | 高 | 采纳 |
| y-indexeddb | MIT | 高 | 采纳（客户端离线） |
| Automerge | MIT | 高 | 不选 |
| ShareDB | MIT | 高 | 已排除 |
| better-sqlite3 | MIT | 高 | 采纳 |
| node:sqlite | MIT（Node 内置） | 高 | 备选 |
| perfect-freehand | MIT | 高 | 采纳 |
| Konva | MIT | 高 | 备选 |
| Fabric.js / Paper.js / Pixi.js | MIT | 高 | 不选（v1） |
| Excalidraw | MIT | 高 | 仅参考（无 CRDT，与基线冲突） |
| tldraw | 自定义源可用（商用需授权评估）* | 低 | 仅架构参考，不直接采用 |
| Hocuspocus | MIT | 高 | 不选（v1 过重） |
| Liveblocks | 专有 | 高 | 排除（SaaS） |

风险提示：tldraw 在 v2+ 转为自定义源可用许可（商用需授权评估），故「整体采用 tldraw」被排除在自建之外；仅引用其架构思路与 perfect-freehand（MIT）。带 * 项需联网复核。

## 10. 量化基线的埋点/测量方法
- 并发 20/50：k6 或自研 ws 客户端脚本模拟 N 个客户端同板操作；记录服务端 CPU/MEM、客户端 FPS/内存。
- op→远端可见 P95 ≤200ms：A 发 op 前打 performance.now 时间戳随 update 附带；B 收到并完成渲染后记录 B 侧时间；先一次性 ping/pong 交换估算时钟偏移 δ，端到端 = t_B − (t_A + δ)；含 A 本地应用、ws 上行、服务端广播、ws 下行、B 应用+渲染；全 session 采样输出 P95。
- 停止操作后 ≤1s 收敛：最后一条 op 后轮询各客户端 Y.Doc 的 state vector/状态摘要，直到全部相等，最大收敛时间 ≤1s。
- undo 深度 ≥100：单测连续 150 个手势，undo 150 次断言恢复基线；再 redo 150 次断言回到 150 步态。
- 单板 1000/5000 元素：种子脚本生成 N 元素；测加载（doc 载入→首帧渲染）与交互帧率（移动/缩放）≥30fps、内存预算；5000 为 soak。
- 光标节流 20Hz：客户端对 awareness 光标更新节流，单测断言每秒 awareness 更新 ≤20 次（允许首帧即时一次）。

## 11. 待签 ADR 清单（7 份）
- ADR-0001 同步引擎 = Yjs(CRDT) + y-protocols/awareness（排除 OT/ShareDB/Automerge）
- ADR-0002 渲染 = Canvas2D 单画布 + presence overlay + Renderer 接口（含 perfect-freehand）
- ADR-0003 v1 元素/操作清单与数据 schema
- ADR-0004 持久化 = SQLite(WAL) 单文件 + StorageProvider 抽象（拒绝 y-leveldb）
- ADR-0005 部署 = 单容器/单进程/单实例 + /healthz
- ADR-0006 撤销语义 = 每用户局部撤销 + redo 清空策略（6/8 方案）
- ADR-0007 状态分层 = 持久态/临态物理分离（presence 不入文档/undo）

## 12. 迁移成本 & 自建 vs 采用总评
- 整体采用 tldraw：功能最全但许可证风险 + 超大表面积 + v1 范围外功能多 → 排除（仅作参考）。
- 整体采用 Excalidraw：MIT 但 SVG+Canvas 混合、无 CRDT（房间 JSON 同步）、undo 为本地栈 → 与已定 Yjs 基线冲突 → 排除。
- **自建（Yjs + Canvas2D + SQLite）**：许可证全 MIT、每层有官方/成熟原语、迁移成本 = 自写约 100 行持久化 provider + 渲染场景图 + 手势 undo 封装；锁定最低。
- 结论：**自建**，逐域采用上表推荐；3 处待决分歧 researcher 倾向与 7/8 多数一致（渲染 Canvas2D、持久化 SQLite、redo 清空），请将军按 §11 落 ADR 后转 breaker。

## 13. 本阶段验收标准（researcher 自定，因原验收标准留空）
- AC1 docs/RESEARCH.md 存在且覆盖 6 个已收敛决策域 + 3 个待决分歧。
- AC2 每决策域 ≥2 候选，逐项给适配度/成熟度/许可证/维护/迁移成本。
- AC3 3 个待决分歧给出明确推荐 + 取舍理由。
- AC4 6 项量化基线各给测量方法。
- AC5 许可证表准确，不确定项标注「需复核」。
- AC6 7 份 ADR 清单枚举。
- AC7 未下载任何外部依赖；验证为本地命令（文件存在 + 结构检查）。

## 14. 风险与未知（联网后需复核）
- tldraw 精确许可证条款（若未来考虑采用）。
- 各库 star/commit 频率/最近 release（本阶段禁网，凭知识定性）。
- better-sqlite3 预编译二进制在目标容器镜像（Debian/Alpine）的可用性（Alpine 需 musl 预编译；Debian slim 更稳）。
- node:sqlite 在 Node 24 的稳定性（若选零原生依赖路线）。
- y-websocket 持久化替换点的 API 版本差异。
