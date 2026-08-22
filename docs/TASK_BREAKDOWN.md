# T-011 任务拆解：多人实时协作白板 Web 应用

> 角色：breaker（任务拆解）｜阶段：任务拆解
> 上游：T-009（docs/REQUIREMENTS.md，需求澄清）→ T-010（docs/RESEARCH.md，方案搜索）
> 下游：test-designer（docs/TEST_CASES.md）→ coder → reviewer（docs/REVIEW.md）→ tester（docs/TEST_REPORT.md）→ devops（docs/DEPLOY.md）
> 依据：LEGION.md 纪律、roles.json 流水线、REQUIREMENTS §4 定稿基线 / §5 待裁决 / §6.2 测量口径、RESEARCH 选型结论。

## 0. 结论速览

- 拆解产物：1 个「决策闸门（Phase 0）」+ 14 个实施子任务（S1～S14），按 5 个阶段 + 依赖拓扑排序；每个子任务含独立验收点与可运行验证命令。
- 工作假设（将军未否决即按此拆解，默认取多数方）：
  1. 渲染 = Canvas 2D 单画布（形状+笔迹统一）+ 独立透明 presence overlay + Renderer 接口（7/8）。
  2. 持久化 = SQLite(WAL) 单文件 + StorageProvider 抽象（7/8）。
  3. redo 语义 = 撤销后远端并发操作落到本人历史前 → 清空本地 redo 栈（6/8）。
  4. 断线重连恢复 = 10s 门槛 + 5s 目标（双档）；陈旧光标 TTL = 10s。
- 硬性不变量（任何子任务不得违反）：presence 绝不入 Y.Doc / undo / 持久化；每用户局部撤销；单实例不横向扩展。
- 交付形态：monorepo（apps/web 静态前端 + apps/server 单进程 Node/ws + packages/shared 共享契约），Docker 单容器自托管。
- 若将军对 §2 任一裁决翻案，仅影响「裁决影响映射」列出的子任务，其余子任务不受牵连（见 §2.2）。

## 1. 拆解原则与范围

- 原子可验收：每个子任务有独立「验收点（AC）」+「验证命令/方式」，不依赖「整体做完才算数」。
- 依赖排序：严格按契约/数据流排序（契约 → 同步 → 渲染 → 撤销/持久化 → 健壮性 → 部署）。
- 每子任务标注：实施角色（coder）、需求追溯（FR/NFR）、ADR/量化指标锚点、下游测试锚点（供 test-designer 直接转用例）。
- v2 明确排除（不做，除非将军加回）：多选、图片、旋转、编组、橡皮擦、压感、富文本、账号体系、多实例横向扩展、完全离线编辑、多房间管理、导入导出、深色主题。

## 2. 决策闸门（Phase 0）与裁决影响映射

### 2.1 闸门清单（G-0，无代码，先于一切实施子任务）

将军须在开工前逐项裁决并落 ADR + 测量口径；本拆解已按「建议默认值」展开，故裁决翻转只改对应子任务，不推翻整体拓扑。

| 闸门项 | 工作假设（默认） | 对立主张 | 落 ADR |
| --- | --- | --- | --- |
| G-0.1 渲染方案 | Canvas 2D 单画布 + overlay + Renderer 接口（7/8） | coder：SVG(形状)+Canvas2D(笔迹)+overlay 三层 | ADR-0002 |
| G-0.2 持久化介质 | SQLite(WAL) 单文件 + StorageProvider（7/8） | coder：y-leveldb | ADR-0004 |
| G-0.3 redo 语义 | 撤销后远端并发 op 落本人历史前 → 清空 redo（6/8） | breaker/coder：保留 redo、仅重放本人 op、CRDT 独立收敛 | ADR-0006 |
| G-0.4 断线重连恢复 | 10s 门槛 + 5s 目标（双档） | 5s 或 10s 单一值 | 并入量化口径 |
| G-0.5 陈旧光标 TTL | 10s | 5s | 并入量化口径 |
| G-0.6 7 份 ADR 签发 | ADR-0001 同步引擎 / 0002 渲染 / 0003 元素清单 / 0004 持久化 / 0005 部署 / 0006 撤销语义 / 0007 状态分层，每份含决策+理由+被否方案+代价 | — | docs/adr/ |
| G-0.7 量化测量口径定稿 | 采用 REQUIREMENTS §6.2 表，每个指标绑定唯一 PASS/FAIL 线 | — | docs/adr/ 或 REQUIREMENTS 附录 |

闸门验收点：docs/adr/ 下 7 份 ADR 齐备且每份含「决策/理由/被否方案/代价」四要素；§6.2 每个指标有唯一可机器断言或可手测的 PASS/FAIL 线（含「断线重连」「陈旧光标 TTL」两处数字）。

### 2.2 裁决 → 子任务影响映射

| 裁决翻转 | 受影响子任务 | 假设成立路径 | 假设翻转后改动 |
| --- | --- | --- | --- |
| 渲染选 SVG+Canvas | S5/S6/S7/S8/S12 | Canvas2D 场景图 | 重写 Renderer 实现 + 命中检测改 DOM，拓扑不变（Renderer 接口兜底） |
| 持久化选 y-leveldb | S10/S13 | better-sqlite3 WAL | 换 StorageProvider 实现，S10 验收中「单文件/可查询」改为「目录文件」，其余不变 |
| redo 保留重放 | S9 | 清空 redo 栈 | 改 redo 实现为「仅重放本人 op」，测试契约反向 |
| 断线重连数字 | S11/S12 | 10s/5s 双档 | 改 S11/S12 的 PASS/FAIL 阈值 |
| TTL 数字 | S4/S11/S12 | 10s | 改 S4/S11/S12 阈值 |

## 3. 依赖关系总览（DAG）

阶段划分与依赖（箭头 = 必须先完成）：

- Phase 0（闸门）：G-0（无代码，先决条件）
- Phase 1 基础设施：S1 → S2 → S3 → S4（S4 依赖 S3；S2 依赖 S1）
- Phase 2 渲染与交互：S5（依赖 S2,S3）→ S6（依赖 S5）→ S7（依赖 S6）；S8（依赖 S5，可与 S6/S7 并行）
- Phase 3 撤销与持久化：S9（依赖 S7）∥ S10（依赖 S3，可与 S9 并行）
- Phase 4 健壮性与性能：S11（依赖 S4,S10）→ S12（依赖 S3..S11）
- Phase 5 部署与文档：S13（依赖 S10,S12）→ S14（依赖 S13）

并行关系：Phase 1 完成后，S8 与 S6/S7 可并行；S9 与 S10 可并行；其余串行。

## 4. 阶段与子任务清单

### Phase 1 基础设施

#### S1 工程脚手架与工具链

- 目标：建立 monorepo 结构：apps/web（Vite+TS 静态前端）、apps/server（Node+TS ws 服务）、packages/shared（共享类型/常量）；根 tsconfig、eslint、vitest、build 脚本；依赖清单锁定。
- 产出：apps/web/、apps/server/、packages/shared/、package.json、tsconfig*、vitest 配置、scripts/build。
- 依赖：G-0（闸门放行）。
- 验收点：
  - AC1 typecheck 全绿（tsc --noEmit 无错误）。
  - AC2 build 全绿，apps/web 产出纯静态产物（可被 server 静态托管）。
  - AC3 vitest 最小用例可跑（示例测试通过）。
  - AC4 无联网下载依赖；依赖清单显式声明，缺失项（yjs/y-protocols/y-websocket/ws/better-sqlite3/perfect-freehand/vite 等）在 evidence 中列为 blocker，不擅自安装。
- 追溯：NFR-3（零外部依赖）、NFR-4 前置。
- 测试锚点：脚手架冒烟（test-designer 写 CI 冒烟用例）。

#### S2 数据契约与共享 schema

- 目标：实现 packages/shared 的 Element 类型（rect/ellipse/line/freehand/text）与字段契约（id/type/geom/stroke/fill/strokeWidth，按 REQUIREMENTS §3.2）、ID 生成（crypto.randomUUID）、schema 校验、确定性状态哈希工具（供收敛断言用）。
- 产出：packages/shared/src/types.ts、schema.ts、hash.ts + 单测。
- 依赖：S1。
- 验收点：
  - AC1 类型与 §3.2 字段一一对应（5 类元素几何形态齐全，含 line.arrow、freehand.points、text.text）。
  - AC2 schema 校验单测：非法字段/缺失字段被拒绝；合法样例通过。
  - AC3 状态哈希确定性：相同文档状态（同元素集+同字段）产生相同哈希；不同状态哈希不同。
- 追溯：ADR-0003、FR-2。
- 测试锚点：schema 正常/边界/异常用例。

#### S3 同步内核（最小可跑纵向切片）

- 目标：服务端 ws relay（y-protocols 编解码 + y-websocket 语义：广播 update + awareness 透传）；客户端 Y.Doc + WebsocketProvider；服务端挂 StorageProvider 接口（先内存实现）。
- 产出：apps/server/src/sync/*、apps/server/src/storage/StorageProvider.ts（接口+内存实现）、apps/web/src/sync/* + 单测/集成测试。
- 依赖：S1、S2。
- 验收点：
  - AC1 两个 ws 客户端连同一房间，A 向 Y.Doc 插入元素 → B 的 Y.Doc 出现同元素（双浏览器或脚本冒烟）。
  - AC2 乱序/重复 update 注入后各副本仍强最终一致（收敛，单测断言状态哈希一致）。
  - AC3 StorageProvider 接口已定义，服务端先用内存实现，后续可被 SQLite 实现替换（S10）。
- 追溯：ADR-0001、FR-5、NFR-4。
- 测试锚点：同步收敛/乱序/重复/丢包用例。

#### S4 awareness：协同光标 + 在线列表

- 目标：身份引导（进入即分配随机昵称+颜色，存 localStorage 复用）＋ presence 走 awareness 独立通道；光标 {x,y,color,name}（世界坐标）20Hz 节流；在线列表聚合；断开即移除；presence 绝不入文档/undo/持久化（断言门禁）。
- 产出：apps/web/src/presence/*、apps/server awareness 透传 + 单测。
- 依赖：S3。
- 验收点：
  - AC1 双端互见光标（位置/颜色/昵称正确）。
  - AC2 单客户端 1s 内 awareness 更新 ≤20 条（首帧即时一次除外，脚本断言）。
  - AC3 正常断开立即从他人在线列表移除；非正常断开按 TTL（默认 10s）移除。
  - AC4 门禁断言：presence 写入不产生 Y.Doc 变更、不进 undo 历史、不进持久化（可机器断言）。
- 追溯：FR-1（身份引导）、ADR-0007、FR-6、NFR-6、量化「光标节流 20Hz」「陈旧光标 TTL」。
- 测试锚点：presence 隔离门禁、节流、TTL 用例。

### Phase 2 渲染与交互

#### S5 渲染器接口 + Canvas 2D 场景图

- 目标：Renderer 接口（挂载/渲染/命中/销毁）+ Canvas 2D 实现；独立透明 presence overlay；渲染 rect/ellipse/line(含箭头)/freehand(perfect-freehand)/text；文档驱动重绘，1000/5000 元素下交互 ≥30fps。
- 产出：apps/web/src/render/Renderer.ts、CanvasRenderer.ts、overlay、perfect-freehand 接入 + 单测。
- 依赖：S2、S3。
- 验收点：
  - AC1 5 类元素在画布正确渲染（几何/颜色/线宽/箭头/文本）。
  - AC2 文本纯文本渲染 + 转义，恶意 HTML/脚本不执行（防 XSS 单测）。
  - AC3 5000 元素加载后交互帧率 ≥30fps 或命中检测单次 <1ms（脚本测量）。
  - AC4 Renderer 接口可替换：同接口换用 stub 实现，上层（S6/S7）不感知。
- 追溯：ADR-0002、FR-2、FR-11、NFR-2、量化「单板 1000/5000 元素」。
- 测试锚点：渲染正确性、XSS、帧率/命中性能用例。

#### S6 元素绘制与选择/命中检测

- 目标：工具栏 5 类工具；鼠标拖拽绘制；几何命中检测（rect/ellipse/line 距离容差、freehand 折线近似、text 包围盒）；单选高亮选中态。
- 产出：apps/web/src/interaction/tools/*、hitTest.ts + 单测。
- 依赖：S5。
- 验收点：
  - AC1 5 类工具均能拖拽绘制且几何/样式正确。
  - AC2 点选命中准确（含线宽/距离容差），1000 元素下单次命中检测 <1ms。
  - AC3 单选高亮选中态正确（再次点选切换选中）。
- 追溯：FR-2、FR-3（单选）。
- 测试锚点：绘制/命中/选中边界用例（空点击、重叠、线宽容差）。

#### S7 元素编辑（移动/缩放/删除/改色/线宽）

- 目标：选中后移动（pan 与拖拽手势区分）、8 向缩放手柄、删除、颜色/线宽修改；每手势 = 一个 Y.UndoManager 事务（stopCapturing）；改色/线宽为局部字段更新（利于 CRDT 合并）。
- 产出：apps/web/src/interaction/edit/*、gesture/transaction 封装 + 单测。
- 依赖：S6。
- 验收点：
  - AC1 移动/缩放/删除/改色/线宽均即时生效并同步远端。
  - AC2 删除 = map.delete(id)（CRDT 墓碑），重连后不复活。
  - AC3 改色/线宽为字段级局部更新（非整元素重写）。
  - AC4 手势事务边界正确：一次拖拽/一次缩放 = 1 步 undo。
- 追溯：FR-3、ADR-0006。
- 测试锚点：编辑同步/墓碑/事务边界用例。

#### S8 无限画布 pan/zoom

- 目标：视口变换（translate/scale）独立于文档；wheel 缩放、space/中键 pan；presence 光标随视口逆变换渲染；世界坐标 ↔ 屏幕坐标变换统一。
- 产出：apps/web/src/viewport/* + 单测。
- 依赖：S5（可与 S6/S7 并行）。
- 验收点：
  - AC1 pan/zoom 不产生 Y.Doc 变更、不进 undo、不进同步（断言）。
  - AC2 缩放后命中检测与光标坐标正确（坐标变换单测）。
  - AC3 平移/缩放与拖拽/绘制手势不冲突（状态机区分）。
- 追溯：FR-4、ADR-0002。
- 测试锚点：视口隔离断言、坐标变换、手势冲突用例。

### Phase 3 撤销与持久化

#### S9 撤销/重做（每用户局部 + redo 语义）

- 目标：Y.UndoManager + origin/clientID 过滤 + trackedOrigins 隔离；undo 深度 ≥100；redo 按裁决语义（默认：撤销后远端并发 op 落本人历史前 → 清空 redo）。
- 产出：apps/web/src/history/* + 单测。
- 依赖：S7（手势事务）。
- 验收点：
  - AC1 A 连续撤销 100+ 步回到基线，且不撤销 B 的任何 op（origin 过滤断言）。
  - AC2 undo 步数与手势一一对应（一次手势 = 一步）。
  - AC3 redo 单测按裁决契约断言（默认清空：撤销后远端并发插入 → 本地 redo 栈清空）。
  - AC4 undo 深度 ≥100 步可验证（脚本连发 100+ 手势后全量 undo 回基线）。
- 追溯：ADR-0006、FR-7、量化「undo ≥100」。
- 测试锚点：局部撤销隔离、redo 并发语义、undo 深度用例。

#### S10 持久化（SQLite WAL + StorageProvider）

- 目标：StorageProvider 接口（快照 + 增量 update 日志、去重/压缩）；better-sqlite3(WAL) 实现（备选 node:sqlite）；服务端定期快照 + 增量日志；启动回放；/healthz 探活含存储可写读。
- 产出：apps/server/src/storage/*、SQLiteProvider.ts + 单测/崩溃测试。
- 依赖：S3（挂接点；可与 S9 并行）。
- 验收点：
  - AC1 刷新页面/重启服务后元素完整恢复（回放正确）。
  - AC2 kill -9 后存储文件可打开、不损坏、回放完整（无半条记录）。
  - AC3 RPO ≤1s：崩溃最多丢 ≤1s 已提交写；RTO 有上限（建议 ≤5s，含进程拉起）。
  - AC4 StorageProvider 接口可换实现（内存 ↔ SQLite 互换，上层不感知）。
- 追溯：ADR-0004、FR-8、NFR-5、RPO/RTO。
- 测试锚点：持久化恢复、kill -9 崩溃安全、RPO/RTO 用例。

### Phase 4 健壮性与性能

#### S11 断线重连与健壮性

- 目标：网络抖动恢复后自动重连 + 状态对齐（y-websocket 重连 + presence 恢复）；陈旧光标 TTL 清理；ws 异常/关闭/并发竞态处理。
- 产出：apps/web/src/net/*、重连/对齐逻辑 + 单测/集成测试。
- 依赖：S4、S10。
- 验收点：
  - AC1 断网→恢复后 Y.Doc 全量对齐耗时满足裁决值（gate 10s / 目标 5s）。
  - AC2 非正常断开光标在 TTL（默认 10s）内消失；正常断开立即消失。
  - AC3 反复断连不产生重复元素/状态回退（幂等收敛）。
- 追溯：FR-9、NFR-1、量化「断线重连」「陈旧光标 TTL」。
- 测试锚点：重连对齐、TTL、幂等用例。

#### S12 性能基线与埋点

- 目标：按 REQUIREMENTS §6.2 落埋点：op 携带 clientTs、渲染完成戳、收敛状态哈希轮询、awareness 节流计数、undo 深度脚本；压测脚本（N 个 ws client 互发 op）。
- 产出：scripts/bench/*、埋点工具 + 压测脚本 + 报告。
- 依赖：S3..S11 全量。
- 验收点：
  - AC1 并发 20（gate）下：op→远端可见 P95 ≤200ms、收敛 ≤1s。
  - AC2 并发 50（soak）下同上指标通过。
  - AC3 undo ≥100、元素 1000（gate）/5000（soak）、光标 20Hz 全部可测量且有唯一 PASS/FAIL 线。
  - AC4 每个指标有埋点数据可回溯（不是拍脑袋数字）。
- 追溯：NFR-1、REQUIREMENTS §6.2 全表。
- 测试锚点：性能/压测用例（tester 执行，devops 纳入 CI gate）。

### Phase 5 部署与文档

#### S13 部署与 CI/CD

- 目标：Dockerfile 多阶段（构建前端 → Node 单进程）、docker-compose（挂 SQLite 卷 + /healthz）、CI 流水线（typecheck/build/test + gate 压测）、DEPLOY 说明。
- 产出：Dockerfile、docker-compose.yml、.github/workflows/*（或等价 CI）、docs/DEPLOY.md。
- 依赖：S10、S12。
- 验收点：
  - AC1 docker compose up 起服，/healthz 返回 200，浏览器可访问并可用。
  - AC2 CI 绿：typecheck/build/test + gate 压测全通过。
  - AC3 文档显式声明单实例、不承诺横向扩展。
- 追溯：ADR-0005、FR-10、NFR-4。
- 测试锚点：部署冒烟、healthz、CI gate 用例。

#### S14 文档与收尾

- 目标：README（本地自托管运行步骤、架构图、ADR 索引、单实例声明）、更新受影响 JSDoc/文档。
- 产出：README.md、docs/adr/ 索引。
- 依赖：S13。
- 验收点：
  - AC1 README 含 docker compose 自托管步骤 + 架构图 + 7 份 ADR 索引。
  - AC2 文档与实际实现一致（命令可复现）。
  - AC3 JSDoc/注释随行为更新。
- 追溯：全部 FR/NFR 汇总说明。
- 测试锚点：文档复核。

## 5. 需求追溯矩阵（子任务 → 需求）

| 子任务 | FR | NFR | 量化指标 | ADR |
| --- | --- | --- | --- | --- |
| S1 | — | NFR-3、NFR-4(前置) | — | — |
| S2 | FR-2 | — | — | ADR-0003 |
| S3 | FR-5 | NFR-4 | 收敛(基础) | ADR-0001 |
| S4 | FR-1、FR-6 | NFR-6 | 光标节流 20Hz、TTL | ADR-0007 |
| S5 | FR-2、FR-11 | NFR-2 | 元素数 1000/5000 | ADR-0002 |
| S6 | FR-2、FR-3 | — | 命中 <1ms | ADR-0002 |
| S7 | FR-3 | — | — | ADR-0006 |
| S8 | FR-4 | — | — | ADR-0002 |
| S9 | FR-7 | — | undo ≥100 | ADR-0006 |
| S10 | FR-8 | NFR-5 | RPO ≤1s、RTO | ADR-0004 |
| S11 | FR-9 | NFR-1 | 断线重连、TTL | — |
| S12 | — | NFR-1 | §6.2 全表 | — |
| S13 | FR-10 | NFR-4 | — | ADR-0005 |
| S14 | — | — | — | 全部 ADR 索引 |

## 6. 流水线衔接（下游消费点）

- test-designer：以每个子任务的「验收点」+「测试锚点」为输入，转写正常/边界/异常用例（docs/TEST_CASES.md）；重点覆盖 §2.1 裁决后的确定性契约（redo 语义、TTL、双档数字）。
- coder：按 §3 拓扑顺序实施 S1→S14；每完成一个子任务跑其验证命令并在 evidence 给出输出要点；依赖缺失列 blocker。
- reviewer：审查 diff 重点 = presence 隔离不变量、undo origin 过滤、StorageProvider 抽象边界、XSS 转义、手势事务边界、单实例边界。
- tester：执行 S12 压测 + 全部用例，输出 docs/TEST_REPORT.md（通过/失败/原因）。
- devops：S13/S14 + CI gate（typecheck/build/test + gate 压测）落地。

## 7. 风险与依赖缺口

- 禁网约束：本环境禁止联网下载依赖；实施前须盘点 yjs / y-protocols / y-websocket / ws / better-sqlite3 / perfect-freehand / vite 等是否已在本地可用；缺失则在 evidence 列 blocker，不擅自安装。
- better-sqlite3 原生二进制：容器镜像（Debian slim 更稳 / Alpine 需 musl 预编译）需确认；备选 node:sqlite（零原生依赖，需固定 Node ≥22.5）。
- 决策未定风险：Phase 0 未放行前，S5/S6/S7/S8（渲染）、S9（redo）、S10（持久化）、S11/S12（数字）存在返工风险（见 §2.2）。
- 单实例边界：v1 明确不横向扩展，压力集中在单进程 ws + SQLite；50 并发 soak 作为上限验证，超限即明确为 v2。

## 8. 本阶段验收标准（breaker 自拟）

> 因任务 acceptance 未填写，自拟 7 条。本阶段为文档产出、无代码，验证方式 = 文件存在 + 结构/覆盖度检查 + 依赖图无环校验（真实命令见 evidence）。

- AC-1：docs/TASK_BREAKDOWN.md 存在，覆盖原始描述全部要点（多用户实时画板 / 图形元素 / 协同光标 / 撤销重做 / 本地自托管）。
- AC-2：拆解清单有序（Phase 0 闸门 + 5 阶段 + 14 子任务），依赖顺序明确（串行/并行标注）。
- AC-3：每个子任务含独立验收点（AC）+ 可运行验证命令/方式，可被 test-designer/coder 直接消费。
- AC-4：明确标注决策闸门（4 项分歧裁决 + 7 份 ADR + 量化测量口径）+ 建议默认值 + 裁决影响映射（哪些子任务受影响）。
- AC-5：每个子任务可追溯到需求（FR/NFR/量化指标/ADR）。
- AC-6：依赖关系无环，可并行/串行关系明确。
- AC-7：无代码改动；验证 = 文件读回 + 结构检查（子任务 ID 齐全、依赖无环、验收点非空），在 evidence 给出核对结果。
