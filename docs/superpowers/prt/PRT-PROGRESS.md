# PRT 任务进度表（全 145 项）

> **本文件是「PRT 实施到哪一步」的唯一入口。** spec
> [`2026-09-11-legion-product-runtime-design.md`](../specs/2026-09-11-legion-product-runtime-design.md)
> §12 的 145 个任务是权威清单；本表只记录**状态、证据指针与未交付项**，
> 不重复任务描述。与 spec 冲突时以 spec 为准。
>
> 状态口径：
> - ✅ **已完成**：有代码/文档交付物 + 可复跑的用例或实测证据
> - 🟡 **部分**：交付物已落地但完成标准未全部满足（下表必须写明缺哪一条）
> - ⬜ **未开始**
> - ⏸ **需外部输入**（真实用户、裁决、机器或凭证），代码侧无法单独关闭
>
> ⚠️ 「有用例」不等于「已生效」。带生产调用方的任务在证据栏注明调用方；
> 只有自己的用例驱动的原语一律标 🟡。

**最近更新**：PRT-251 / PRT-701~704 最小 Product Launcher（阶段 7 由 0 完成 → 4 完成）

---

## 阶段 0：冻结基线（11/11）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-001 进程/端口/组件/数据拓扑 | ✅ | `PRT-001-topology-inventory.md`、`prt-001-003-inventory.json`、套件 `prt-topology` |
| PRT-002 DSH/Cordis 依赖清单与静态扫描规则 | ✅ | `PRT-002-dsh-boundary-inventory.md`、`scripts/ci/dsh-boundary.mjs` + 基线 JSON |
| PRT-003 配置/环境变量/密钥/路径来源清单 | ✅ | `PRT-003-config-secret-inventory.md`（声明缺口 0；4 处目录越界写入） |
| PRT-004 软件交付黄金流程与固定输入仓库 | ✅ | `PRT-004-golden-flow.md`（夹具哈希 `9d4d958c…`）、套件 `prt-golden-flow` |
| PRT-005 旧路径任务状态/执行事件/产物/审计证据 | ✅ | `docs/PRT-005-evidence/verify-evidence.md`、套件 `prt-old-path` |
| PRT-006 team-hub 备份与恢复验证 | ✅ | `docs/PRT-006-evidence/backup-restore-evidence.md`（陈旧 WAL 危害实测）、套件 `prt-backup` |
| PRT-007 旧系统功能/HTTP/数据库/执行行为基线 | ✅ | `prt-007-baseline.json`（85 路由 / 22 表 / 7 状态 / 20 迁移边）、套件 `prt-baseline` |
| PRT-008 术语冻结 | ✅ | `prt-010-composition-baseline.json` 内术语表 + 反例表 |
| PRT-009 成功率/人工介入/token/费用/耗时/资源基线 | 🟡 | token 与端到端耗时**已采**；**费用缺有来源单价、峰值资源未采**（阻塞原因见 `docs/PRT-009-evidence/verify-evidence.md` §4） |
| PRT-010 DSH 组合层/profile/bundle/patch 锚点基线 | ✅ | `PRT-010-dsh-composition-baseline.md`、`prt-010-composition-baseline.json` |
| PRT-011 确定 DSH 分发形态 | ✅ | `PRT-011-dsh-distribution-decision.md`（**已裁决：路线 C**） |

## 阶段 1：Runtime Contract（9/9）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-101 RuntimeAdapter / RuntimeCapabilities | ✅ | `runtime/contracts/adapter.mjs`、`index.d.mts` |
| PRT-102 ModelProfile / ModelDescriptor / 验证结果 | ✅ | `runtime/contracts/model.mjs`（含明文密钥结构化拒绝） |
| PRT-103 RunRequest / RunEvent / RunResult | ✅ | `runtime/contracts/run.mjs` |
| PRT-104 标准错误码 / 重试等级 / 用户可见错误 | ✅ | `runtime/contracts/errors.mjs`（16 码版本化映射） |
| PRT-105 取消 / 超时 / 恢复 / UnknownOutcome 语义 | ✅ | `runtime/contracts/contract.test.mjs`（终态唯一、cancel 幂等） |
| PRT-106 Runtime Contract 契约测试 | ✅ | 套件 `runtime-contract`（43 例） |
| PRT-107 内存 FakeRuntimeAdapter | ✅ | `runtime/contracts/fake-adapter.mjs` + 19 例（六条编排路径） |
| PRT-108 禁止新增直接 DSH 调用的静态边界检查 | ✅ | `dsh-boundary` 阶段（秒级门禁），基线 3 文件 / 26 处 |
| PRT-109 精确主版本校验与 capabilities 协商 | ✅ | `runtime/contracts/adapter.mjs`（必需能力缺失 → `UNSUPPORTED_CAPABILITY`） |

## 阶段 2：DshRuntimeAdapter（15/15）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-201 包装模型读取与 ModelProfile 转换 | ✅ | `runtime/adapters/dsh/*`，套件 `dsh-adapter`（85 例） |
| PRT-202 包装 `subagents.start` 与运行标识映射 | ✅ | 同上 |
| PRT-203 转换 DSH 流式事件与最终结果 | ✅ | `runtime/adapters/dsh/events.mjs` |
| PRT-204 结构化输出校验 | ✅ | `runtime/adapters/dsh/schema.mjs`（旧路径不校验，见 PRT-210 intended 差异） |
| PRT-205 取消、超时与生命周期清理 | ✅ | `runtime/adapters/dsh/adapter.test.mjs`（看门狗 / abort 无效用例） |
| PRT-206 异常标准化与重试分类 | ✅ | `runtime/adapters/dsh/errors.mjs` |
| PRT-207 采集模型 / token / 费用估算 / 耗时 | 🟡 | 采集已实现；**费用估算因单价缺失返回 `null`**（与 PRT-009 同一阻塞） |
| PRT-208 日志、异常与事件脱敏 | ✅ | `runtime/adapters/dsh/redact.mjs` |
| PRT-209 DSH 版本与能力探测 | ✅ | `runtime/adapters/dsh/probe.mjs` |
| PRT-210 旧调用与 Adapter 路径对拍测试 | ✅ | `parity.mjs` + 套件 `dsh-parity`（36 例，violations = 0，漂移检测 `drifted = false`） |
| PRT-211 continuable session 边界验证 | 🟡 | **接口面已验证**；运行时行为 `behavior-unverified`（需真实 parent/child 会话对，属阶段 3） |
| PRT-212 最小 DSH 强制面（Guard / pre-execute / answerer） | 🟡 | `runtime/dsh-composition/enforcement.mjs`（34 例）；**审批 answerer 尚未接 team-hub 审批箱**，无生产调用方 |
| PRT-213 探测 sandbox backend 与 enforcement | ✅ | `runtime/dsh-composition/selfcheck.mjs`（`full`/`partial` 判据） |
| PRT-214 Legion DSH 组合补丁层与员工 agent preset | 🟡 | 声明 + 生成物 `legion-host.patch.yml` 已就绪；**补丁层未落盘应用**（profile 层 `patchReload: live`，写入会立刻改变运行中的强制面） |
| PRT-215 补丁层应用与强制面生效启动自检 | 🟡 | 自检门禁已实现（`incompatible` 判定）；因未落盘，**自检目前没有真实调用方** |

## 阶段 2.5：商业薄垂直切片（1/8）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-251 最小 Product Launcher | ✅ | `product/launcher/*`、套件 `product-launcher`（57 例，含 3 例真实进程）、`PRT-251-product-launcher.md`；`--check` 如实报出两个入口缺口 |
| PRT-252 Workbench 模型配置产品化校验 | ⬜ | |
| PRT-253 单员工黄金任务迁移到 RuntimeAdapter | ⬜ | |
| PRT-254 per-user 数据目录 + Secret Store 最小闭环 | 🟡 | **目录布局与密钥库都已冻结**（`product/paths.mjs`、`security/secrets/`）；**密钥库仍无生产调用方**（PRT-501/253 接线），写路径已由 Launcher 指到 DataDir |
| PRT-255 隔离测试空间安装/运行/取消/重启/诊断验证 | ⬜ | |
| PRT-256 设计伙伴独立完成真实低风险任务 | ⏸ | 需真实外部用户 |
| PRT-257 Launcher 负责 DSH 运行时与补丁层安装/自检/修复 | ⬜ | 分发形态路线 C 已裁决；Legion 自身四个 `file:` 包的分发方式待定 |
| PRT-258 冻结进程清单 / 目录布局 / 配置 Schema / Secret Store 接口 | ✅ | 四份契约全部有实现与用例：`PRT-258-product-contracts.md`（前三份）+ `PRT-505-secret-store.md`（第四份） |

## 阶段 3：Orchestrator Core（0/16）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-301 持久化运行状态机 | ⬜ | |
| PRT-302 task lease、租期与 heartbeat | ⬜ | |
| PRT-303 attempt 与不可覆盖历史 | ⬜ | |
| PRT-304 提取任务扫描与认领 | ⬜ | |
| PRT-305 提取岗位、流水线与团队快照 | ⬜ | |
| PRT-306 提取 workspace/worktree 管理 | ⬜ | |
| PRT-307 提取结构化结果与机器验收 | ⬜ | |
| PRT-308 提取打回、交接与完成 | ⬜ | |
| PRT-309 重试、退避与 Dead Letter | ⬜ | |
| PRT-310 恢复扫描与人工处置 | ⬜ | |
| PRT-311 外部副作用幂等与 Unknown Outcome | ⬜ | |
| PRT-312 状态迁移 / 并发 / 崩溃 / 恢复测试 | ⬜ | |
| PRT-313 lease 权威时间、`leaseEpoch`、过期拒写 | ⬜ | |
| PRT-314 WAL / `busy_timeout` / 原子领取并发语义 | ⬜ | |
| PRT-315 拆分 `plugins/src/index.ts` | ⬜ | 阶段 3 评审闸门已过（热点文件 1/40、2/40） |
| PRT-316 team-hub 模块提取 | ⬜ | 需排在启动期并发迁移加固沉淀一个发布周期之后 |

## 阶段 4：上下文边界（0/13）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-401 Context Source 与 RunContextSnapshot | ⬜ | |
| PRT-402 接入 TeamPlan 与 EmployeeManifest | ⬜ | |
| PRT-403 接入目标上下文与 `contextVersion` | ⬜ | |
| PRT-404 接入任务、评论与用户反馈 | ⬜ | |
| PRT-405 接入上游员工交付与产物 | ⬜ | |
| PRT-406 接入已发布 Skills 与显式文档 | ⬜ | |
| PRT-407 作用域、权限、预算与裁剪 | ⬜ | |
| PRT-408 脱敏、来源清单与内容哈希 | ⬜ | |
| PRT-409 持久化快照并支持查看导出 | ⬜ | |
| PRT-410 确定性 / 越权 / 超限 / 回放测试 | ⬜ | |
| PRT-411 冻结时点与运行中更新规则 | ⬜ | |
| PRT-412 标记不可信来源并验证不能扩权 | ⬜ | |
| PRT-413 canonical JSON、tokenizer 与保守估算降级 | ⬜ | |

## 阶段 5：模型和密钥配置（0/11）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-501 ModelProfile 数据模型与 API | ⬜ | 校验函数已在 `runtime/contracts/model.mjs` |
| PRT-502 岗位模型绑定与 fallback | ⬜ | 旧路径实测**按岗位模型未生效**（`gf001-run.mjs` 的 `modelDrift`） |
| PRT-503 单次运行与岗位预算策略 | ⬜ | |
| PRT-504 模型连通性与能力测试 | ⬜ | |
| PRT-505 Windows Secret Store | 🟡 | `security/secrets/`（DPAPI 往返实测 + fail-closed + 六条出口脱敏）、套件 `secret-store`；**尚无生产调用方**；与 `$DSH_HOME/.credentials.yaml` 的收敛属 PRT-257 |
| PRT-506 迁移现有非敏感模型配置 | ⬜ | |
| PRT-507 Workbench 模型设置页面 | ⬜ | |
| PRT-508 配置导入导出（排除密钥） | ⬜ | |
| PRT-509 密钥读取 / 轮换 / 删除 / 泄漏测试 | 🟡 | 读取/轮换/删除的泄漏断言已入 `secret-store` 套件；**跨账户与 ACL 加固未做** |
| PRT-510 预算原子预留、结算、取消与 Unknown Outcome 锁定 | ⬜ | |
| PRT-511 冻结价格表版本、币种、计价单位与生效时间 | ⬜ | |

## 阶段 6：工具、权限和审批（0/20）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-601 工具能力描述与风险等级 | ⬜ | |
| PRT-602 DSH Enforcement Bridge 与统一 ToolRequest 投影 | ⬜ | |
| PRT-603 接入 EmployeeManifest 工具白名单 | ⬜ | |
| PRT-604 文件与工作目录范围限制 | ⬜ | |
| PRT-605 命令、网络与 MCP 权限控制 | ⬜ | |
| PRT-606 外部 API 读 / 写权限区分 | ⬜ | |
| PRT-607 审批箱与无人值守策略 | ⬜ | |
| PRT-608 审批绑定规范化操作哈希 | ⬜ | 哈希原语已在 `runtime/dsh-composition/enforcement.mjs` |
| PRT-609 字段变化后审批失效 | ⬜ | |
| PRT-610 持久化工具调用、决定来源、结果与幂等键 | ⬜ | |
| PRT-611 扩展 F-02 canonical operation | ⬜ | |
| PRT-612 Legion 权限语义到强制面的固定映射 | 🟡 | 映射表与 preset 声明已在 `runtime/dsh-composition/`；**无生产调用方** |
| PRT-613 审批/UI/审计/执行看到同一不可变参数 | ⬜ | |
| PRT-614 新强制面前禁用 legacy 高风险工具 + 发布门禁 | ⬜ | |
| PRT-615 审批 TTL 与 lease/heartbeat 交互 | ⬜ | |
| PRT-616 `allow-once` 原子 CAS 消费 | ⬜ | |
| PRT-617 策略门与 answerer 双段超时 + `unavailable` + 决定来源审计 | 🟡 | 双段超时与 fail-closed 原语已实现（`enforcement.mjs` + 34 例）；**未接真实 team-hub** |
| PRT-618 声明 `legion-attended` / `legion-unattended` preset 表 | ✅ | `runtime/dsh-composition/patch-layer.mjs`（`legion-unattended` 锁死 `workspace-write`） |
| PRT-619 Run 期间 policy/preset 冻结与改写审计 | ⬜ | |
| PRT-620 pre-execute 放行与 ToolGuard 拒绝的一致性不变量 | 🟡 | 用例已就位；**需真实组合面生效才成立**（依赖 PRT-214/215 落盘） |

## 阶段 7：Product Launcher（0/13）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-701 进程清单、启动依赖与健康协议 | ✅ | 清单/波次已冻结（`product/process-manifest.mjs`）；就绪判据含**身份断言**并由套件 `product-launcher` 在真实进程上**实测**（`readiness.mjs` + `measureReadiness`） |
| PRT-702 统一启动、停止与状态查询 | ✅ | `product/launcher/launcher.mjs`（start/stop/status/retry + 六态映射）+ `cli.mjs`；`--check` 体检与退出码契约例 |
| PRT-703 端口冲突 / 依赖缺失 / 配置错误诊断 | ✅ | `ports.mjs`（可绑性 vs 是否有人在听、同批端口重复申请）+ `readiness.mjs`（失败分类：可重试 vs 立刻失败）；真实进程用例证明**身份不符不等超时** |
| PRT-704 子进程监督、退避重启与熔断 | ✅ | `supervisor.mjs`（按存活时长重置退避 + 连续快速失败熔断 + 人工 reset）；原 `services-plugin` 无熔断，会以 30s 周期永远重启 |
| PRT-705 优雅关闭与僵尸进程清理 | 🟡 | 已做 SIGTERM→宽限→杀**进程树**（Windows `taskkill /T /F`）并在真实进程用例里断言停止后端口可绑；**日志轮转/托盘/僵尸兜底扫描未做** |
| PRT-706 产品目录与首次运行初始化 | 🟡 | 目录布局与不变量已冻结；**初始化动作未实现** |
| PRT-707 首次运行向导 | ⬜ | |
| PRT-708 系统托盘与打开 Workbench | ⬜ | |
| PRT-709 日志轮转与磁盘保护 | ⬜ | |
| PRT-710 脱敏诊断包导出 | ⬜ | |
| PRT-711 Runtime 健康状态到产品状态的映射 | 🟡 | `productStateOf` + `PRODUCT_STATE_TEXT` 已实现六态中的五态并有用例；**`incompatible`/`upgrading` 需版本清单（PRT-801）才有判据来源** |
| PRT-712 本地队列 / lease / 重试 / 死信 / 可用率指标 | ⬜ | |
| PRT-713 显式选择加入的脱敏健康心跳 | ⬜ | |

## 阶段 8：安装、升级和回滚（0/13）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-801 产品版本清单 | ⬜ | |
| PRT-802 锁定 DSH 与依赖精确版本 | ⬜ | |
| PRT-803 可签名安装包 | ⬜ | |
| PRT-804 升级包、清单签名与完整性校验 | ⬜ | |
| PRT-805 升级前兼容性 / 磁盘 / 在途任务检查 | ⬜ | |
| PRT-806 数据库与配置自动备份 | 🟡 | 备份/恢复路线已验证（PRT-006）；**自动备份未实现** |
| PRT-807 幂等数据库迁移框架 | ⬜ | |
| PRT-808 原子程序切换与升级健康检查 | ⬜ | |
| PRT-809 安全回滚或向前修复 | ⬜ | PRT-006 已定「恢复前必须删 `-wal`/`-shm`」 |
| PRT-810 internal / canary / stable 通道 | ⬜ | |
| PRT-811 升级审计、发布说明与用户通知 | ⬜ | |
| PRT-812 N-1 升级窗口、备份保留与恢复演练 | ⬜ | |
| PRT-813 Windows 文件占用 / Defender 延迟 / 长路径 / 子进程树退出 | ⬜ | |

## 阶段 9：商业 Alpha 发布保障（0/10）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-901 第三方许可证清单与 SBOM | ⬜ | PRT-011 已确认 DSH 为 MIT |
| PRT-902 DSH / 供应商 / 依赖商业分发条件 | ⬜ | |
| PRT-903 隐私、数据处理与模型调用说明 | ⬜ | |
| PRT-904 日志、执行事件与产物保留策略 | ⬜ | |
| PRT-905 备份、恢复与数据导出入口 | ⬜ | |
| PRT-906 崩溃报告授权与脱敏策略 | ⬜ | |
| PRT-907 支持诊断与故障处置手册 | ⬜ | |
| PRT-908 卸载数据保留与彻底删除选择 | ⬜ | |
| PRT-909 产品发布检查清单 | ⬜ | |
| PRT-910 内部与金丝雀真实项目验证 | ⏸ | 需真实用户项目 |

## 阶段 10：能力包协议（0/6）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-1001 PackManifest / 类型 / 语义版本 / 协议版本 | ⬜ | |
| PRT-1002 内容哈希、签名/来源、依赖与兼容性预检 | ⬜ | |
| PRT-1003 安装、启用、停用与升级记录 | ⬜ | |
| PRT-1004 不可变 CompiledTeamPlan 与运行中版本固定 | ⬜ | |
| PRT-1005 能力包不得携带密钥 / 扩权 / 绕过强制面 | ⬜ | 判据可复用 `findPlaintextSecrets` |
| PRT-1006 软件交付团队整理为首个内置能力包 | ⬜ | |

---

## 汇总

| 阶段 | 已完成 | 部分 | 未开始 | 需外部输入 | 合计 |
| --- | --- | --- | --- | --- | --- |
| 0 冻结基线 | 10 | 1 | 0 | 0 | 11 |
| 1 Runtime Contract | 9 | 0 | 0 | 0 | 9 |
| 2 DshRuntimeAdapter | 10 | 5 | 0 | 0 | 15 |
| 2.5 商业薄切片 | 2 | 1 | 4 | 1 | 8 |
| 3 Orchestrator Core | 0 | 0 | 16 | 0 | 16 |
| 4 上下文边界 | 0 | 0 | 13 | 0 | 13 |
| 5 模型与密钥 | 0 | 2 | 9 | 0 | 11 |
| 6 工具、权限和审批 | 1 | 3 | 16 | 0 | 20 |
| 7 Product Launcher | 4 | 3 | 6 | 0 | 13 |
| 8 安装、升级和回滚 | 0 | 1 | 12 | 0 | 13 |
| 9 商业 Alpha 保障 | 0 | 0 | 9 | 1 | 10 |
| 10 能力包协议 | 0 | 0 | 6 | 0 | 6 |
| **合计** | **36** | **16** | **91** | **2** | **145** |

> 计数口径：**部分**计入「已有交付物但完成标准未全部满足」，
> 因此不能与「已完成」相加后宣称完成度。真实完成度按**完成标准**判定：
> 阶段 0～2 的完成标准已满足或已写明未满足项，阶段 2.5 及其后均未达标。
