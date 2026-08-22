# T-012 测试用例 / 验收测试：多人实时协作白板 Web 应用

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计
> 上游：T-009（docs/REQUIREMENTS.md）→ T-010（docs/RESEARCH.md）→ T-011（docs/TASK_BREAKDOWN.md）
> 下游：coder（按 S1..S14 实现并跑 typecheck/build）→ reviewer → tester（执行并出 docs/TEST_REPORT.md）→ devops
> 依据：REQUIREMENTS §4 定稿基线 / §5 待裁决 / §6.2 测量口径、RESEARCH 选型结论、TASK_BREAKDOWN 的 S1..S14 验收点。

## 0. 结论速览

- 本阶段产出**两件**：① 本文件（用例目录 + 判定口径 + 追溯矩阵）；② `tests/contract/` 可执行契约测试（56 用例，`node --test` 全绿，覆盖 schema / 状态哈希 / 几何命中 / 视口变换 / 20Hz 节流 / redo 语义 / XSS / TTL 的纯逻辑部分）。
- 用例编号约定：`TC-S<子任务>-<序号>` 与 `TASK_BREAKDOWN` 的 S1..S14 一一对应；已落成代码的用例在「自动化」列标注 `tests/contract`，其余标注执行方式（L1 集成 / L2 冒烟 / L3 压测）。
- 类别标记：🟢正常 / 🟡边界 / 🔴异常；优先级 P0（验收门槛，必须过）/ P1（重要）/ P2（增强）。
- **裁决标记**：凡依赖将军 4 项待裁决（渲染 / 持久化 / redo 语义 / 两处数字）的用例，在「裁决依赖」列标 `⚖️`，正文 §5 给出双分支；默认按多数方（与 RESEARCH 推荐一致）书写，将军裁决翻转时只改对应用例的预期，不动其余。

## 1. 工作假设与硬性不变量

### 1.1 已收敛基线（直接作为判定依据）

1. 同步引擎 = Yjs(CRDT) + y-protocols/awareness + y-websocket（排除 OT/ShareDB）。
2. 撤销作用域 = 每用户局部撤销（仅撤本人操作），全局/协作撤销排除 v1。
3. 状态分层 = 持久态（元素，入 undo/持久化）与临态（光标/在线列表，走 awareness）物理分离。
4. v1 元素/操作清单 = rect/ellipse/line(含箭头)/freehand/单行文本 + 单选/移动/缩放/删除/改色/线宽 + 无限画布 pan/zoom；v2 = 多选/图片/旋转/编组/橡皮擦/压感/富文本/账号/横向扩展。
5. 部署 = 单容器 Docker + docker-compose + 静态前端 + 单进程 Node/ws + /healthz，显式单实例。

### 1.2 工作假设（裁决默认值，将军未否决即按此判定）

| 待裁决项 | 默认值（多数方） | 对立主张 | 翻转影响 |
| --- | --- | --- | --- |
| 渲染 | Canvas 2D 单画布 + presence overlay + Renderer 接口 | SVG(形状)+Canvas(笔迹)+overlay 三层 | TC-S5/S6/S7/S8/S12 的渲染类用例 |
| 持久化 | SQLite(WAL) 单文件 + StorageProvider 抽象 | y-leveldb | TC-S10/S13 的持久化类用例 |
| redo 语义 | 撤销后远端并发 op 落本人历史 → 清空 redo | 保留 redo 仅重放本人 op | TC-S9-05/06（契约已双分支固化） |
| 断线重连 | 门槛 10s + 目标 5s（双档） | 单一 5s 或 10s | TC-S11-01 |
| 陈旧光标 TTL | 10s | 5s | TC-S4-05 / TC-S11 |

### 1.3 硬性不变量（任何实现不得违反，均有可断言门禁用例）

- **I1 presence 隔离**：光标/在线列表绝不写入 Y.Doc、绝不进 undo 历史、绝不进持久化（TC-S4-06）。
- **I2 每用户局部撤销**：undo/redo 仅作用于本人操作（origin/clientID 过滤），绝不撤销他人 op（TC-S9-01/07）。
- **I3 单实例边界**：服务端单进程/单实例，文档显式声明不承诺横向扩展（TC-S13-03）。
- **I4 视口隔离**：pan/zoom 只影响本地渲染，不入文档、不进 undo、不进同步（TC-S8-06）。

## 2. 测试分层与运行方式

| 层 | 名称 | 运行 | 覆盖 | 依赖 |
| --- | --- | --- | --- | --- |
| L0 | 契约单测 | `node --test tests/contract/` | schema/hash/命中/变换/节流/redo/XSS/TTL | 零（Node 内置） |
| L1 | 集成测试 | `vitest run`（apps/* + packages/shared） | 同步收敛、presence 门禁、undo 隔离、持久化恢复、崩溃安全 | yjs/y-protocols/ws/better-sqlite3 |
| L2 | e2e 冒烟 | 双浏览器 / 脚本 ws client 冒烟 | 端到端互画、健康检查、部署 | 构建产物 + 浏览器 |
| L3 | 性能 soak | `scripts/bench/*` 压测脚本 | §6.2 全表量化指标 | 压测脚本 + 埋点 |

> L1/L3 依赖的第三方包在**禁网环境不可下载**；S1/S3/S10 阶段 coder 须先盘点本机是否已有 yjs/y-protocols/y-websocket/ws/better-sqlite3/perfect-freehand/vite，缺失即在 evidence 列 blocker（TC-S1-04），不擅自安装。

## 3. 量化指标判定口径（PASS/FAIL 唯一线）

> 每个数字绑定唯一通过线；无测量方法的数字等于不可验证。埋点/测量方法沿用 REQUIREMENTS §6.2。

| 指标 | 门槛（gate=CI 必须过） | soak | PASS 判定 |
| --- | --- | --- | --- |
| 并发连接数 | 20 | 50 | N 个 ws client 持续互发 op，下述延迟/收敛全部满足 |
| op→远端可见 | P95 ≤ 200ms | 同 | 采样 N≥200 条 op，`t_B − (t_A + δ)` P95 ≤ 200ms（先 ping/pong 估时钟偏移 δ） |
| 收敛 | 停止操作后 ≤ 1s | 同 | 停注入后每 100ms 取全副本 stateHash，≤1s 内全副本哈希一致 |
| undo 深度 | ≥ 100 步 | 同 | 连发 150 次本人手势后全量 undo 回基线，且无他人 op 被撤销 |
| 单板元素数 | 1000 | 5000 | 载入 N 元素后交互 ≥30fps 且命中检测单次 <1ms |
| 光标节流 | 20Hz | 同 | 单客户端 1s 内 awareness 更新 ≤20 条（首帧即时一次除外） |
| 断线重连 ⚖️ | ≤ 10s | 目标 ≤ 5s | 恢复连接 → Y.Doc 全量同步完成 + presence 可见 耗时 ≤ 阈值 |
| 陈旧光标 TTL ⚖️ | 10s | 同 | 非正常断开后该光标在 ≤TTL 内从他人 overlay 消失；正常断开立即消失 |
| RPO | ≤ 1s | 同 | `kill -9` 后重启，比对崩溃前最后可见态与回放态，丢失 ≤1s 已提交写 |
| RTO | ≤ 5s（含进程拉起） | 同 | `kill -9` 后计时至 /healthz 200 + 数据可读 ≤5s |

## 4. 用例目录

> 图例：类别 🟢正常/🟡边界/🔴异常；自动化 = 已落代码（`tests/contract`）或 L1/L2/L3 执行方式；⚖️ = 依赖待裁决。

### Phase 1 基础设施

#### S1 工程脚手架与工具链

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 | P0 | `tsc --noEmit`（全仓） | 无类型错误 | CI | NFR-3 前置 |
| TC-S1-02 | 🟢 | P0 | `npm run build` | apps/web 产出纯静态产物，可被 server 静态托管 | CI | FR-10 |
| TC-S1-03 | 🟢 | P1 | vitest 最小冒烟用例 | 通过 | vitest | — |
| TC-S1-04 | 🔴 | P1 | 盘点依赖清单（yjs/ws/better-sqlite3/perfect-freehand/vite…） | 清单显式声明；缺失项列 blocker，不联网下载 | 人工核对 | NFR-3 |

#### S2 数据契约与共享 schema（已落 L0 代码）

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 | P0 | 5 类元素合法样例校验 | 全部通过 | tests/contract | FR-2, ADR-0003 |
| TC-S2-02 | 🟡 | P1 | w/h=0、负坐标、空文本、单点 freehand、空 fill | 全部合法（见契约口径） | tests/contract | FR-2 |
| TC-S2-03 | 🔴 | P0 | 非法 type（如 circle） | 拒绝并报 type 错误 | tests/contract | FR-2 |
| TC-S2-04 | 🔴 | P0 | 缺失 id/geom/stroke/strokeWidth；非对象 | 拒绝并报对应错误 | tests/contract | FR-2 |
| TC-S2-05 | 🔴 | P0 | NaN/Infinity/字符串坐标、负线宽、非法色值、坏 points、非布尔 arrow | 逐项拒绝 | tests/contract | FR-2 |
| TC-S2-06 | 🟡 | P2 | 未知额外字段 | 忽略（lenient），不失败不抛异常 | tests/contract | — |
| TC-S2-07 | 🟢 | P1 | 两元素 id；生成器 `crypto.randomUUID()` | 格式合法且同板内唯一（Y.Map 键唯一性） | L1 | FR-2 |
| TC-S2-08 | 🟢 | P0 | 相同元素集不同插入顺序求 stateHash | 哈希相同（顺序无关） | tests/contract | §6.2 收敛 |
| TC-S2-09 | 🟢 | P0 | 任一字段差异 / points 顺序差异求 hash | 哈希不同（敏感） | tests/contract | §6.2 收敛 |

#### S3 同步内核（L1）

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🟢 | P0 | 两个 ws client 同房间，A 向 Y.Doc 插元素 | B 的 Y.Doc 出现同元素（stateHash 一致） | L1 | FR-5, ADR-0001 |
| TC-S3-02 | 🟢 | P0 | 乱序注入 update | 各副本最终收敛（stateHash 一致） | L1 | FR-5 |
| TC-S3-03 | 🟢 | P0 | 重复注入同一 update | 幂等，状态不重复（无重复元素） | L1 | FR-5 |
| TC-S3-04 | 🔴 | P1 | 丢包后经重传补齐 | 最终收敛，无回退 | L1 | FR-5 |
| TC-S3-05 | 🔴 | P1 | 畸形/恶意 update 字节流 | 服务端拒绝或忽略，不崩溃、不污染其他副本 | L1 | NFR-5 |
| TC-S3-06 | 🔴 | P2 | 超大 payload update | 拒绝或限流，连接不挂死 | L1 | NFR-5 |
| TC-S3-07 | 🟢 | P1 | StorageProvider 接口以内存实现挂接，后换 SQLite | 上层不感知，行为一致 | L1 | ADR-0004 |

#### S4 awareness：协同光标 + 在线列表

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 | P0 | 双端移动鼠标 | 互见光标：位置/颜色/昵称正确 | L2 | FR-1, FR-6 |
| TC-S4-02 | 🟢 | P0 | 多端在线列表聚合/离开 | 计数正确、断开即更新 | tests/contract | FR-6 |
| TC-S4-03 | 🟡 | P1 | 单客户端 1s 内 awareness 更新 | ≤20 条（首帧即时一次除外） | tests/contract | NFR-6, §6.2 节流 |
| TC-S4-04 | 🟢 | P0 | 正常断开（send leave） | 立即从他人在线列表/overlay 移除 | tests/contract | FR-6 |
| TC-S4-05 | 🔴 | P0 | 非正常断开（不 send leave） | 在 TTL（默认 10s，⚖️）内消失，TTL 边界内保留 | tests/contract | FR-6, §6.2 TTL |
| TC-S4-06 | 🔴 | P0 | 门禁：presence 更新后断言 Y.Doc/undo/持久化 | 均无变化（物理隔离，I1） | L1 | NFR-6, ADR-0007 |
| TC-S4-07 | 🟡 | P1 | 刷新页面 | 昵称/颜色从 localStorage 复用，会话身份稳定 | L2 | FR-1 |

### Phase 2 渲染与交互

#### S5 渲染器 + Canvas 场景图

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 | P0 | 渲染 5 类元素（含箭头/文本/笔迹） | 几何/颜色/线宽/箭头/文本正确（⚖️ 渲染方案） | L2 | FR-2, ADR-0002 |
| TC-S5-02 | 🔴 | P0 | 文本为 `<img onerror>` 等恶意串 | 纯文本渲染/转义，不执行 HTML/脚本 | tests/contract | FR-11 |
| TC-S5-03 | 🟢 | P1 | 5000 元素载入后交互 | ≥30fps 或命中 <1ms（soak 档） | L3 | NFR-2, §6.2 元素数 |
| TC-S5-04 | 🟢 | P1 | 同接口换 stub 实现 Renderer | 上层（S6/S7）不感知，行为一致 | L1 | ADR-0002 |

#### S6 元素绘制与选择/命中检测（已落 L0 代码）

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S6-01 | 🟢 | P0 | rect/ellipse 命中（内部/边界/外部/容差） | 判定正确 | tests/contract | FR-2, FR-3 |
| TC-S6-02 | 🟢 | P0 | 5 类工具拖拽绘制 | 几何/样式正确落 Y.Doc | L2 | FR-2 |
| TC-S6-03 | 🟢 | P0 | line 命中（线上/容差内/端点外） | 判定正确（线段非射线） | tests/contract | FR-2 |
| TC-S6-04 | 🟢 | P0 | freehand 折线/单点命中 | 判定正确 | tests/contract | FR-2 |
| TC-S6-05 | 🟢 | P0 | text 包围盒命中（显式度量） | 判定正确 | tests/contract | FR-2 |
| TC-S6-06 | 🟡 | P1 | 空点击 / 空白区点击 | 返回 null，不选中 | tests/contract | FR-3 |
| TC-S6-07 | 🟡 | P0 | 重叠元素点选 | 命中最上层（Z 序=数组末尾） | tests/contract | FR-3 |
| TC-S6-08 | 🟡 | P1 | 线宽容差恰在阈值上/外 | 阈值上命中、阈值外未命中 | tests/contract | FR-3 |
| TC-S6-09 | 🟡 | P2 | 仅描边（无 fill）的 rect/ellipse 边界 | 命中轮廓而非内部（渲染层补充，见契约口径） | L1 | FR-3 |
| TC-S6-10 | 🟢 | P1 | 1000 元素单次命中检测 | <1ms（gate） | L3 | NFR-1 |

#### S7 元素编辑（移动/缩放/删除/改色/线宽）

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S7-01 | 🟢 | P0 | 5 类工具拖拽绘制 | 均能绘制且几何/样式正确 | L2 | FR-2 |
| TC-S7-02 | 🟢 | P0 | 点选切换 | 单选高亮，再点他元素切换选中 | L2 | FR-3 |
| TC-S7-03 | 🟢 | P0 | 选中后拖动 | 即时生效并同步远端 | L2 | FR-3 |
| TC-S7-04 | 🟢 | P0 | 8 向缩放手柄 | 即时生效并同步远端 | L2 | FR-3 |
| TC-S7-05 | 🟢 | P0 | 删除元素 | `map.delete(id)` 墓碑；重连/刷新不复活 | L1 | FR-3 |
| TC-S7-06 | 🟢 | P0 | 改色/改线宽 | 字段级局部更新（非整元素重写），可被 CRDT 合并 | L1 | FR-3 |
| TC-S7-07 | 🟡 | P0 | 一次拖拽/一次缩放 | = 1 步 undo（手势事务 stopCapturing） | L1 | ADR-0006 |
| TC-S7-08 | 🟡 | P2 | 拖到 w/h≈0 | 生成退化元素或拒绝（不产生 NaN/负尺寸） | L2 | FR-3 |
| TC-S7-09 | 🔴 | P2 | 拖到画布外 / 极端坐标 | 允许（无限画布）且数值有限，不崩 | L2 | FR-4 |
| TC-S7-10 | 🟡 | P0 | space/中键 pan 与拖拽绘制手势 | 状态机区分，不误触 | L2 | FR-4 |

#### S8 无限画布 pan/zoom（已落 L0 代码）

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S8-01 | 🟢 | P0 | world↔screen 往返 | 一致（含平移+缩放） | tests/contract | FR-4 |
| TC-S8-02 | 🟢 | P0 | 缩放后命中/光标坐标 | 坐标变换正确 | tests/contract | FR-4 |
| TC-S8-03 | 🟡 | P1 | 极端缩放 0.01x/100x | 往返一致，无精度崩坏 | tests/contract | FR-4 |
| TC-S8-04 | 🔴 | P1 | scale=0/负数/NaN、tx/ty 非数 | 抛错拒绝 | tests/contract | FR-4 |
| TC-S8-05 | 🟢 | P1 | presence 光标随视口逆变换渲染 | 光标贴准世界坐标 | tests/contract | FR-6 |
| TC-S8-06 | 🔴 | P0 | pan/zoom 后断言 Y.Doc/undo/同步 | 无变化（视口隔离，I4） | L1 | FR-4, ADR-0002 |

### Phase 3 撤销与持久化

#### S9 撤销/重做（每用户局部 + redo 语义）

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S9-01 | 🟢 | P0 | A 连撤 N 步，B 同时操作 | A 只撤自己，B 的 op 不受影响（origin 过滤，I2） | L1 | FR-7, ADR-0006 |
| TC-S9-02 | 🟢 | P0 | 连发 150 次手势后全量 undo | 回基线，undo 深度 ≥100 | L1 | FR-7, §6.2 undo |
| TC-S9-03 | 🟢 | P0 | undo 后 redo | 恢复被撤操作 | L1 | FR-7 |
| TC-S9-04 | 🟡 | P1 | undo 到底后继续 undo | 无效果，不破坏 redo | tests/contract | FR-7 |
| TC-S9-05 | ⚖️🟢 | P0 | 撤销后远端并发 op 落本人历史 → redo | 默认：redo 栈清空（6/8） | tests/contract | ADR-0006, §5.3 |
| TC-S9-06 | ⚖️🟢 | P1 | 同上，keep-replay 变体 | 保留 redo，仅重放本人 op（备选） | tests/contract | §5.3 |
| TC-S9-07 | 🔴 | P0 | A 尝试撤销 B 的 op | 不撤销（origin/clientID 隔离） | L1 | FR-7, I2 |

#### S10 持久化（SQLite WAL + StorageProvider，⚖️）

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S10-01 | 🟢 | P0 | 刷新页面 / 重启服务 | 元素完整恢复（回放正确） | L1 | FR-8, ADR-0004 |
| TC-S10-02 | 🔴 | P0 | `kill -9` 后打开存储 | 文件可打开、不损坏、回放完整（无半条记录） | L1 | NFR-5 |
| TC-S10-03 | 🟢 | P0 | 崩溃恢复比对 | RPO ≤1s（丢 ≤1s 已提交写） | L1 | NFR-5 |
| TC-S10-04 | 🟢 | P1 | `kill -9` 后计时 | RTO ≤5s（/healthz 200 + 数据可读） | L1 | NFR-5 |
| TC-S10-05 | 🟢 | P1 | StorageProvider 内存↔SQLite 互换 | 上层不感知 | L1 | ADR-0004 |
| TC-S10-06 | 🟡 | P1 | 空库首次启动 | 无报错，出空白板 | L1 | FR-8 |
| TC-S10-07 | 🟡 | P1 | 5000 元素大文档启动回放 | 完整恢复（soak 档） | L1 | §6.2 元素数 |

### Phase 4 健壮性与性能

#### S11 断线重连与健壮性

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S11-01 | ⚖️🟢 | P0 | 断网→恢复 | 自动重连，Y.Doc 全量对齐耗时 ≤10s（目标 ≤5s） | L2 | FR-9, §6.2 重连 |
| TC-S11-02 | 🟢 | P0 | 反复断连 | 幂等收敛：无重复元素、无状态回退 | L1 | FR-9, NFR-1 |
| TC-S11-03 | 🔴 | P1 | 服务端关闭 | 客户端按退避重试，不崩溃 | L1 | FR-9 |
| TC-S11-04 | 🔴 | P2 | ws 消息乱序/竞态 | 状态机处理，不产生脏状态 | L1 | FR-9 |

#### S12 性能基线与埋点（L3）

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S12-01 | 🟢 | P0 | 20 client 互发 op | op→远端 P95 ≤200ms，收敛 ≤1s | L3 | NFR-1 |
| TC-S12-02 | 🟢 | P1 | 50 client（soak）互发 op | 同上指标通过 | L3 | NFR-1 |
| TC-S12-03 | 🟢 | P0 | 停止注入后轮询 stateHash | ≤1s 全副本收敛 | L3 | §6.2 收敛 |
| TC-S12-04 | 🟢 | P0 | 每指标埋点数据可回溯 | undo≥100、元素 1000/5000、光标 20Hz 均有可测数据 + 唯一 PASS/FAIL 线 | L3 | §6.2 全表 |

### Phase 5 部署与文档

#### S13 部署与 CI/CD

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S13-01 | 🟢 | P0 | `docker compose up` | /healthz 返回 200，浏览器可用 | L2 | FR-10, ADR-0005 |
| TC-S13-02 | 🟢 | P1 | CI 流水线 | typecheck/build/test + gate 压测全绿 | CI | NFR-1 |
| TC-S13-03 | 🟢 | P1 | 文档声明单实例 | 显式声明不承诺横向扩展（I3） | 人工核对 | NFR-4, ADR-0005 |

#### S14 文档与收尾

| ID | 类别 | 优先级 | 步骤/输入 | 预期 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S14-01 | 🟢 | P1 | 按 README 步骤自托管 | 命令可复现、与实现一致、含 7 份 ADR 索引 | 人工核对 | FR-10 |

## 5. 待裁决双分支用例（将军裁决后只改此处）

### 5.1 渲染（⚖️，默认 Canvas 2D 单画布）

- **分支 A（默认）**：TC-S5-01/03 用 Canvas 2D 单画布 + overlay 判定；命中检测为标准几何（TC-S6-* 已固化）。
- **分支 B（SVG 形状 + Canvas 笔迹 + overlay）**：TC-S5-01 改为「形状走 SVG DOM 命中 + 笔迹走 Canvas」，TC-S6-07 Z 序判定改为 DOM 层序；TC-S6-10 命中性能改为 DOM `elementFromPoint` 路径复测。其余用例不变（Renderer 接口兜底）。

### 5.2 持久化（⚖️，默认 SQLite WAL）

- **分支 A（默认）**：TC-S10-01/02/07 判定「单文件可打开、可查询、回放完整」。
- **分支 B（y-leveldb）**：TC-S10 验收中「单文件/可查询」改为「目录文件、不可查询」，/healthz 可写读探针改为「目录可写 + level 可 open」；RPO/RTO/崩溃安全口径不变。

### 5.3 redo 语义（⚖️，默认清空）

- TC-S9-05（默认清空）与 TC-S9-06（keep-replay）**双分支均已落成契约测试**；将军裁决后 coder 以对应分支为唯一实现，tester 只需执行对应分支用例，另一分支保留为回归对照。

### 5.4 两处数字（⚖️）

- 断线重连：默认「门槛 10s + 目标 5s」→ TC-S11-01 双档；若将军改单一值，CI gate 用该单一值。
- 陈旧光标 TTL：默认 10s → TC-S4-05；若改 5s，只改阈值常量。

## 6. 需求追溯矩阵（FR/NFR → 用例）

| 需求 | 覆盖用例 |
| --- | --- |
| FR-1 进入画板 | TC-S4-01, TC-S4-07 |
| FR-2 绘制元素 | TC-S2-01..09, TC-S5-01, TC-S6-01..05, TC-S7-01 |
| FR-3 编辑元素 | TC-S6-06..10, TC-S7-02..08 |
| FR-4 无限画布 pan/zoom | TC-S7-09/10, TC-S8-01..06 |
| FR-5 实时同步收敛 | TC-S3-01..04 |
| FR-6 协同光标+在线列表 | TC-S4-01..05, TC-S8-05 |
| FR-7 每用户局部撤销 | TC-S9-01..07, TC-S7-07 |
| FR-8 持久化恢复 | TC-S10-01/06/07 |
| FR-9 断线重连 | TC-S11-01..04 |
| FR-10 自托管部署 | TC-S1-02, TC-S13-01, TC-S14-01 |
| FR-11 渲染安全（XSS） | TC-S5-02 |
| NFR-1 量化性能基线 | TC-S6-10, TC-S12-01..04 |
| NFR-2 浏览器兼容 | TC-S5-03（Chrome/Edge/Firefox 近两版冒烟） |
| NFR-3 零外部依赖 | TC-S1-04 |
| NFR-4 单实例边界 | TC-S13-03 |
| NFR-5 崩溃安全 | TC-S3-05/06, TC-S10-02/03/04 |
| NFR-6 presence 隔离 | TC-S4-03/06 |

## 7. 关键路径用例详解（GIVEN/WHEN/THEN）

### 7.1 TC-S3-01/02/03 同步收敛（核心正确性）

- **GIVEN** 两个 ws client A、B 连同一房间，同一 Y.Doc。
- **WHEN** A 依次插入 3 个元素；随后人为把 update 乱序、重复、丢一包再重传注入给 B。
- **THEN** 停止注入后 ≤1s，A、B 的 `stateHash(doc)` 完全一致，且元素数 = 3（重复注入不产生第 4 个）。

### 7.2 TC-S4-06 presence 隔离门禁（不变量 I1）

- **GIVEN** 双端在线，A 的 awareness 状态含 `{x,y,color,name}`。
- **WHEN** A 高频更新光标 1s。
- **THEN** 断言：Y.Doc 的 update 流无新增；undo 历史无变化；服务端持久化字节无变化（presence 不入文档/undo/持久化）。

### 7.3 TC-S7-05 删除墓碑

- **GIVEN** 板上已有元素 E。
- **WHEN** A 删除 E（`map.delete(id)`），随后 B 刷新/断线重连。
- **THEN** E 不复活；`stateHash` 不含 E；undo 后 E 恢复（删除本身可撤销）。

### 7.4 TC-S7-07 手势事务边界

- **GIVEN** 一次拖拽 = mousedown → N 次 mousemove → mouseup。
- **WHEN** 完成一次拖拽。
- **THEN** undo 一次即回到拖拽前状态（N 次 move 合并为 1 步）；undo 后 redo 一次恢复拖拽结果。

### 7.5 TC-S9-05 redo 清空（裁决默认）

- **GIVEN** A 画元素 X 后 undo（redo 栈 = [X]）。
- **WHEN** 远端 B 的并发操作 Y 落到 A 的历史作用域。
- **THEN** A 的 redo 栈清空，redo 无操作；undo 栈不受影响（X 仍不可再撤销）。

### 7.6 TC-S10-02/03/04 kill -9 崩溃安全

- **GIVEN** 服务端持续写入（含 ≤1s 内的最新提交）。
- **WHEN** `kill -9` 服务端；重启进程。
- **THEN** 存储文件可打开、不损坏；回放后状态 = 崩溃前最后可见态（丢失 ≤1s 写，RPO≤1s）；从拉起计时至 /healthz 200 且数据可读 ≤5s（RTO）。

### 7.7 TC-S5-02 XSS 门禁

- **GIVEN** 文本元素内容 = `<img src=x onerror=alert(1)>`。
- **WHEN** 渲染到 Canvas 及任何可能落 DOM 的编辑态覆盖层。
- **THEN** 无任何 HTML/脚本执行；DOM 路径输出经 `escapeHtml` 转义后的纯文本。

### 7.8 TC-S8-06 视口隔离（不变量 I4）

- **GIVEN** 板上已有元素，本端任意 pan/zoom。
- **WHEN** 连续缩放/平移 10 次。
- **THEN** 断言：Y.Doc 无 update、undo 历史无变化、远端无任何同步流量（视口不入文档）。

## 8. 本阶段验收标准（test-designer 自拟，因原 acceptance 留空）

- **AC-1**：`docs/TEST_CASES.md` 存在，覆盖原始描述 5 要点（多用户实时画板 / 图形元素 / 协同光标 / 撤销重做 / 本地自托管）及全部 FR-1..11、NFR-1..6。
- **AC-2**：每个子任务 S1..S14 至少 1 个正常用例，关键子任务（S2/S3/S4/S7/S9/S10/S11/S12）含边界 + 异常用例。
- **AC-3**：§6.2 每个量化指标有唯一 PASS/FAIL 线（gate/soak 双档），含两处待裁决数字（断线重连 / TTL）。
- **AC-4**：4 项待裁决（渲染/持久化/redo/两数字）均有双分支用例，且标注默认值（多数方）。
- **AC-5**：4 条硬性不变量（presence 隔离/局部撤销/单实例/视口隔离）各有一个可断言门禁用例。
- **AC-6**：可落代码的纯逻辑契约已落成 `tests/contract/` 且 `node --test` 全绿（56/56），证据给出命令与输出要点。
- **AC-7**：本阶段无生产实现改动、无联网下载依赖；改动仅 `docs/TEST_CASES.md` + `tests/contract/*`。
