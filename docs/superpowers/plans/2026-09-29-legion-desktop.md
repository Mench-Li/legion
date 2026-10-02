# Legion 桌面端实施计划

> 创建于 2026-09-29。2026-09-30 检查官方 Harness 桌面端提交 `639ed015397290b3745d163aafe02ffee4aa3f84` 后修订。在现有隔离工作区的 `codex/legion-desktop` 分支中，按顺序实施以下任务并记录验证证据。

**目标：**交付 Windows x64、按当前用户安装的 Legion 桌面应用。应用负责启动和管理 Product Launcher，首次使用时初始化随包固定版本的 DSH 生产载荷，在安全窗口中显示 Workbench；安装和首次启动都不依赖开发环境或 npm 下载。

**架构：**Electron 管理窗口、托盘和一份私有凭据。受限的 NDJSON 子进程负责连接 Electron 与现有 Product Launcher；只有 Launcher 管理准备流程、服务和 DataDir 锁。产品数据保存在安装目录之外。Workbench 和 Team Hub 执行桌面端鉴权边界。发行包将固定版本的 Node/npm、DSH、Legion 和补丁绑定为一个经过校验的发行版本。核心依赖在构建时准备好，首次启动时从本地载荷导入。CLI/开发模式仍可显式使用现有 npm 安装器。

**技术栈：**Electron、Node.js ESM、Node 测试运行器、现有 Vite/React Workbench、electron-builder/NSIS、PowerShell Windows 验收脚本。

**方案：**[Legion 桌面端设计](../specs/2026-09-27-legion-desktop-design.md)。运行时行为以方案文档为准；本计划用于安排实施。

## 全局约束

- 只在隔离工作区中操作；不得改动原始检出目录及其中的本地修改。
- 保留现有 Launcher CLI 和 DSH Desktop 服务插件路径。桌面模式使用 Launcher API，不再启动第二个托盘，也不单独启动产品服务。
- 行为改动按 RED → GREEN 流程验证；记录失败断言和通过的命令。每项任务单独提交。
- 不能仅凭窗口打开、进程已启动或端口被占用就报告产品就绪。必须通过 Launcher 身份和运行时契约检查。
- 只有在不含 Node、DSH 或源代码检出的干净 Windows x64 普通用户虚拟机上通过验收矩阵后，才能称安装器可正式发布。
- 密钥不得进入 argv、URL、事件、诊断、渲染器状态或日志。桌面令牌只通过私有 stdio 和可信请求头传递。
- 2026-09-29 基线：隔离工作区中执行 `node --test product/launcher/cli.test.mjs product/launcher/launcher.test.mjs product/launcher/supervisor.test.mjs`，106/106 项通过。
- 在单独的兼容性检查批准新的 DSH/补丁精确版本组合之前，保留已选定的 DSH `0.1.5-rc.2`。参考官方桌面端的 `0.2.0-rc.2` 代码不代表升级本项目运行时。
- 当前物理文件布局仅作为基线。性能优化可在专项原型证明运行时和原生资源路径正确后采用经过校验的归档/ASAR 感知后端或 Electron Node 模式；任何配置或依赖都不得从原开发检出目录解析。
- 主进程注入凭据时，必须同时绑定自有窗口/会话和经过验证的 Workbench 来源。仅允许所属窗口的主框架调用本地 IPC。

## 进度与执行顺序

任务 1 已提交为 `8e5e4f31`；桥接/协议与现有 Launcher 测试共 114/114 项通过。任务 2 已提交为 `f1ccd0e`；桌面专项测试 5/5 项通过。Windows 上的真实 Electron 启动验证了第二次启动时窗口聚焦、关闭到托盘、重新打开，以及两轮正常退出/重启且没有遗留桥接进程。这些是源码模式检查，不能证明完整产品启动或安装器已经就绪。

任务 4 已实现：桥接凭据握手、服务凭据隔离、Hub/Workbench API 保护及所属会话请求注入。桌面专项测试 14/14 项通过，Launcher/静态服务回归测试 122/122 项通过。真实 Electron 会话验证了所属可信来源的授权请求，并确认凭据不会发送给外部来源。源码模式下的正常退出/重启也再次通过。任务 3、5、6、7 尚待完成。

更新后的顺序：**任务 4 → 任务 1 后续改动 → 准备任务 5 的载荷 → 任务 4 后续审批通道 → 任务 3 本机初始化与向导 → 完成任务 5 安装器 → 任务 6 → 任务 7**。先提交官方参考方案更新，再继续实现。任务 1 的后续改动单独提交，保留原任务的已完成证据。

2026-10-01 性能优化跟进：先更新权威设计，再按本计划执行，避免插入无关的发行工作。当前基线：安装器 **526,759 ms** / **222,542,124 字节** / **28,268 个资源**；首次启动至 Workbench **259,036 ms**；后续启动 **36,018 ms**（同一主机和内部构建，见验收记录）。设计将性能目标定为：在完整性和就绪检查相同的条件下，安装器和首次启动时间至少各缩短 50%。由于 Defender 状态和主机负载会显著影响大量文件的安装过程，必须在受控主机上重新测量。

2026-10-01 工作流包需求：场景以可独立版本化、可导入的包交付，不复制工作区。首版自动导入内置的软件协作包；后续 Ozon 等包复用本地 `.legionpack` 格式及预览、安装/升级流程。权威约定见设计文档 §6.6。保留用户选择的工作区和既有 Team Hub 状态；不得打包用户级 `.legion`、任务/历史记录、凭据或开发机检出路径。

## 评审重点

1. 计划端口被未知进程占用、PID 过期、桌面程序重复启动或桥接崩溃时，绝不静默接管或重复启动。
2. DSH 缺失、下载失败、清单无效或向导验证失败时，不得将状态标记为 `ready` 或启用自动任务。
3. 恶意网页、伪造 `Host`/`Origin`、页面跳转或渲染器遭入侵后，都不能访问本地 API 或获得凭据。
4. 安装/升级/卸载不得删除 DataDir、密钥、日志或用户选择的工作区；升级失败时必须有明确的恢复状态。
5. 打包后的运行时不能从开发检出目录解析 Node 模块、资源、符号链接或可执行文件。

---

## 任务 1：桌面控制协议与 Launcher 桥接

**涉及文件：**`product/launcher/desktop-protocol.mjs`、`product/launcher/desktop-protocol.test.mjs`、`product/launcher/desktop-bridge.mjs`、`product/launcher/desktop-bridge.test.mjs`。

**交付内容：**版本 1 控制协议，每行最多 64 KiB。`start`、`status`、`stop`、`restart` 都有请求 ID 和唯一的最终响应。桥接层调用 `launcherOptionsFrom` 与 `createLauncher`，串行处理生命周期变更，仅发送允许公开的状态字段，并在标准输入正常关闭时停止其管理的服务。遇到未知命令或格式错误的行时返回明确错误，但进程不退出。

- [x] 编写协议与桥接测试，覆盖不完整行、输入过长、版本/类型无效、请求关联、重复启动、停止/重启及事件不含密钥；记录预期失败。
- [x] 仅运行这些测试，确认缺失行为时得到 RED。
- [x] 实现解析、受限写入、生命周期状态和 Launcher 适配器。将 stdio 接线与可测的请求处理器分开。
- [x] 先运行专项测试至 GREEN，再运行现有 Launcher 测试。
- [x] 提交 `feat(desktop): add bounded launcher control bridge`。

### 任务 1 后续改动：吸收官方参考实现经验

**涉及文件：**`desktop/runtime.mjs`、`desktop/main.test.mjs`、`product/launcher/desktop-protocol.mjs`、`product/launcher/desktop-bridge.mjs`及专项测试。

- [x] 增加控制期限和待处理请求上限，并测试超时清理、迟到响应和桥接退出。桌面端重试去重；准备流程的取消在任务 3 实现。
- [x] 将耗时初始化放进受管理的工作进程，并报告进度/取消状态；准备期间仍可查询状态和停止服务。真实工作进程取消及 stdio 响应测试通过。
- [x] 桌面端退出必须同时收到停止确认并观察到桥接进程退出。仅发送 kill 信号不算进程退出；进程未能退出时保留 Launcher 所有权和证据。准备流程的取消在任务 3 实现。
- [ ] 任务 6 接入任务准入控制时，增加类型化的 `inspect-quit` 和 `begin-update` 请求。不要公开通用命令，也不要在状态事件中泄漏任务详情。
- [x] 提交 `feat(desktop): bound lifecycle requests and confirm shutdown`（`74513fd`）。

2026-10-01 验证记录：新增的 supervisor 断言起初失败，因为被发送信号的进程被误判为已退出，且强制终止在进程实际未退出时仍被报告为成功。修复后，桌面/桥接/supervisor/Launcher 验证共 **77/77** 项通过。真实 Electron 烟测使用新的 DataDir 完成两轮退出/重开，并正确报告缺少身份信息。这只验证了源码模式的生命周期行为，不等于完整产品或安装器验收。生产载荷准备随后单独进行，使用精确锁定的 DSH 全量依赖版本覆盖（含 peer dependencies）及固定版本的 Cordis/Schemastery。

## 任务 2：窗口、本地启动页与托盘

**涉及文件：**`desktop/package.json`、`desktop/main.mjs`、`desktop/preload.cjs`、`desktop/startup.html`、`desktop/startup.mjs`、`desktop/main.test.mjs`、`desktop/README.md`。

**交付内容：**Electron 单实例窗口和系统托盘；本地页面显示桥接状态，并提供重试/停止操作。主进程使用随包 Node 启动唯一桥接进程、验证 IPC 发送方、等待 Workbench 来源通过校验，并在桥接退出时显示错误。页面只允许导航至启动页和已验证的本地 Workbench 来源；外链按协议白名单打开。关闭窗口时隐藏到托盘，“退出”操作会停止 Launcher。

- [x] 使用可控子进程流测试纯生命周期/窗口策略及桥接客户端，先确认 RED。
- [x] 实现最小 Electron 外壳和 preload 白名单，确认 GREEN。
- [x] 在 Windows 上手动检查重复启动、关闭到托盘、重新打开和退出，并记录进程树。
- [x] 提交 `feat(desktop): add Electron shell and tray`。

## 任务 3：首次安装与配置

**涉及文件：**`product/launcher/desktop-bridge.mjs`、`product/launcher/desktop-bridge.test.mjs`、新增的随包运行时导入器及测试、`desktop/startup.mjs`、`desktop/startup.html`、`desktop/startup.test.mjs`，以及所需的现有 runtime-install/wizard/ownership 模块。

**交付内容：**桥接请求 `prepare-runtime` 校验发行描述符，并通过暂存、验证、完成标记和原子指针切换导入随包生产目录。初始化和运行中的服务共用一个由 Launcher 管理的 DataDir 锁。界面提供工作区选择、明确的执行身份/范围、模型配置、真实验证以及继续/重试。模型密钥只通过私有 stdio 传递并存入受保护的密钥库。运行时契约和用户同意条件通过之前，Orchestrator 保持暂停准入。

- [x] 编写/维护测试，覆盖本机准备、文件哈希/平台/版本/补丁错误、复制中断、取消、孤儿恢复和向导续办。
- [x] 扩展 Product Launcher 对准备流程的所有权，服务启动前不释放同一把锁。准备期间和服务运行期间，真实并发获取 DataDir 都会被拒绝。
- [x] 实现本地导入器，共用路径规则、写入防护、拒绝符号链接、完成标记和原子 current 指针。正式打包后的准备流程不会使用 npm 或网络。
- [x] 将模型设置步骤接到真实的固定 profile 探测；验证失败不能启用自动任务。独立观察 Runtime Contract 是否就绪仍未完成。
- [ ] 在断网条件下使用全新临时 DataDir 验证；具备凭据和网络后，再单独验证模型设置及真实任务。
- [ ] 提交 `feat(desktop): connect first-run setup`。

2026-10-01 跟进记录：导入器/profile/所有权/运行时解析测试 **30/30** 项通过；桌面控制及发行验证专项测试 **35/35** 项通过。实际固定 Web profile 在输出 URL 后进行 HMR 挂载时失败。产品现会创建专用的 `legion-desktop` profile，并在启动时加载补丁；即使配置了外部 Runtime 命令，也使用已验证的随包指针；Node loader 参数会放在 DSH 入口之前。三个隔离后台服务达到就绪条件，并在 3 秒后仍保持就绪，之后桥接进程确认退出。此次范围明确不含任务调度，因此不据此声称完整产品、模型或任务验收通过。

### 任务 3 后续接入顺序

1. [x] 在启动页/preload 中增加仅主框架可调用的系统目录选择器和类型化设置命令。主进程提供所选绝对工作区路径；渲染器不能在确认调用中替换该路径。只将工作区路径保存在 Legion 私有数据目录；拒绝重定向或被篡改的已保存路径；打包模式下清除继承的工作区覆盖变量。
2. [x] 扩展产品桌面所有者，使工作区初始化和操作者设置使用它持有的 DataDir 租约，并保留现有产品配置。在 Legion 优先级最高的用户设置层保存 actor、scope、action、有人值守的审批模式及读写路径边界，避免项目本地配置扩大所选工作区。不得把模型密钥写入 JSON、命令参数、进度信息或日志。
3. [ ] 完成 `createWizard` 的 environment/init/start/model/verify 步骤流转。身份输入现在使用用户明确填写的 actor/scope/action、明确选择的工作区读写权限及有人值守的 `ask` 预设。不得臆造 actor，也不得把已保存的 API 密钥当作模型探测结果。必须通过真实模型/契约探测及范围化审批后，才可调度完整任务。
4. [x] 为固定的 DSH 默认值（`deepseek-official` / `deepseek-flash`）增加专用桌面模型步骤。保存密钥前探测官方 `/v1/models` 接口，使用受保护的 SecretStore，将不含密钥的验证回执绑定到已存凭据版本，并在自动启动前再次核对该版本。CLI 修改/删除密钥或受保护存储不可用时，重新打开设置流程。不含凭据的 HTTP/探测测试已通过；真实服务验证仍需要操作者 API 密钥。
5. [ ] 模型验证后独立观察 Runtime Contract 是否就绪。仅有连接的 socket 或凭据库 `has()` 结果不能通过此步骤。
6. [ ] 配置、用户同意、范围化审批通道及两项真实探测都通过后，启动完整服务范围并再次独立检查产品。只有这时向导才能返回现有的完成/就绪状态。失败时必须保持部分服务范围和准入关闭；不能用向导自行生成的 ready 结果替代 Launcher 的真实状态。
7. [ ] 验证工作区选择、密钥保存、部分启动和验证失败后的中断恢复。继续流程要保留用户输入/数据，但重新检查就绪状态。更新交付状态前，使用实际打包应用验证首次启动页和已保存设置后的重启。

2026-10-01 首次设置检查点：系统目录选择及工作区确认通过主进程所有的 IPC；actor/scope/action 与明确的工作区读写边界保存在现有产品所有者维护、且优先级高于项目配置的设置层。根据实际配置是否存在，已保存的选择会从身份或模型步骤继续。有人值守的审批预设是明确配置的，范围外操作仍按 fail-closed 处理；范围化 Runtime 审批通道尚未实现，因此不会启用完整任务。设置/控制/所有权专项测试 **30/30** 项通过。真实 Electron 源码窗口验证了工作区选择（系统对话框返回值由测试替代）、身份提交、持久化、第二次启动继续至模型设置、拒绝第二个窗口的调用，以及观察到进程退出。当前安装器已包含此源码；预置隔离设置后验证了启动/服务链路，但完整交互向导和真实 API 密钥验证仍需在安装版中验收。

### 任务 3 后续改动：工作流包框架与首发包

**涉及文件：**`product/workflow-packs/`（包 schema、校验器、计划器和导入器）、`desktop/scripts/stage.mjs`、Team Hub 导入事务/API、Workbench 包管理界面及专项测试。

**交付内容：**统一、带版本号的 `legion/workflow-pack@1` 格式及本地 `.legionpack` 导入流程；内置首发软件协作包，新安装时自动导入一次；Workbench 提供后续 Ozon 等本地包的预览、确认和升级界面。工作流包在用户选择的既有工作区中配置空间、角色、阶段、技能和文本资料。不会复制或替换工作区、运行随包代码、重置 Team Hub 数据，也不会隐式开启任务调度。

- [x] Define strict `legion/workflow-pack@1` JSON schema with stable package id/version, target scope, role/stage references, explicit text asset types, normalized relative paths and package/content size limits. Canonical SHA-256 receipts detect changes. Reject unknown fields, executable content, absolute/traversal paths, credentials and unsupported types. Compatibility declarations, per-file digests and signatures are deferred.
- [x] Build the first `legion.software-collaboration` pack from generic `roles.json` plus the portable soldier prompt; exclude `roles-ozon.json`, user `.legion`, histories, credentials and host-specific paths. Generate the `.legionpack` as a staged release resource included in closure/hash verification.
- [x] Implement a preview planner for install/current/upgrade/conflict by stable package and scope. Existing spaces cannot be claimed; edited package-managed content blocks upgrade; updates require explicit confirmation.
- [x] Implement transactional Team Hub import, package receipts and idempotency. Desktop startup imports the built-in pack before Team Hub listens only when its space is new; existing spaces, locally edited packages and newer bundled versions are preserved without blocking startup. A failed transaction rolls back.
- [x] Add a Workbench “流程包” entry with installed package list, local `.legionpack` picker, server-side preview, explicit install/upgrade, conflict handling, package asset viewing and installed version state. The renderer calls authenticated loopback APIs; Team Hub revalidates and owns all database writes. Package content is never executed.
- [x] Test malformed manifests, executable/host-specific/traversal content, duplicate IDs, size/schema limits, conflict preview, user-edit preservation, transaction rollback, repeat import, confirmed package upgrade, startup no-overwrite/no-auto-upgrade, no automatic dispatch, package asset retrieval and an Ozon-shaped fixture without account data.
- [x] Build and install the internal NSIS package in an isolated user path. Verify first-run built-in import and current-workspace binding, all four service readiness signals, DSH migration, token redaction, uninstall and isolated-data retention. The isolated test verified a **114 s install** and **37 s first launch** on this host.

2026-10-01 工作流包实施记录：便携的软件协作包随发行资源放在 `resources/legion/workflow-packs/software-collaboration.legionpack`，也会导出到安装器旁作为制作样例。全新的私有 Team Hub 会在开始监听前导入该包，并把 `software` 空间关联到所选工作区。Workbench 包管理器可预览和安装本地 `.legionpack`，查看包内资源，并拒绝不安全或有冲突的升级。无账号数据的 Ozon 形状样例通过验证。包/进程/配置专项测试 **31/31** 项通过，Workbench 的 `tsc`/Vite 构建通过，桌面外壳测试 **12/12** 项通过。真实隔离 NSIS 安装启动了 DSH 和 Legion 服务，并确认 8 个角色、8 个阶段关联到所选工作区。最近一次测试安装耗时 **92,507 ms**，首次启动到所有服务就绪耗时 **31,543 ms**。详见[验收证据](../../release/legion-desktop-acceptance.md)。在线目录、包删除/回滚、含代码插件和干净虚拟机验收仍是后续门槛。

2026-10-01 实施检查点：桌面准备/描述符/所有权/控制测试 **30/30** 项通过；桌面自有 DSH profile 和真实鉴权的 Hub/Workbench 检查 **2/2** 项通过。导入器测试覆盖内容字节变化、取消与重试、完整孤儿恢复、越界目录联接，以及真实准备工作进程和取消流程。向导界面/模型设置和真实范围化执行仍待完成。已准备的生产输入包括 Node `24.19.0`、DSH `0.1.5-rc.2`（231 个精确版本的家族包；已安装 517 个生产包）和私有 MinGit `2.56.0.windows.1`。Workbench 使用已提交的 pnpm lockfile 构建。本检查点已由下文的安装版验收取代；干净虚拟机验收仍未完成。

2026-10-01 模型设置检查点：模型设置页使用密码输入框，提交只能通过所属 Electron 主框架和私有桥接。API 密钥写入受保护存储前，先用真实 HTTP 探测验证固定默认模型（`GET /v1/models`，硬超时 15 秒）。与凭据版本绑定的不含密钥回执用于解锁启动；每次全新启动时，桥接都会用当前密钥元数据再次核对回执。鉴权/网络/模型验证失败时，不保存候选密钥，也不将设置标记为完成。桌面/探测测试 **79/79** 项通过；真实 Electron 源码烟测验证了首次模型设置界面、无持久化副作用的重启及可观察的进程退出。真实 DeepSeek 验证、Runtime Contract 观察、范围化审批、真实任务执行及干净虚拟机验收仍待完成。

## 任务 4：桌面本地 API 鉴权

**涉及文件：**`product/local-auth.mjs`、`workbench/scripts/serve.mjs`、`workbench/scripts/desktop-auth.test.mjs`、`team-hub/server.mjs`、相关配置 schema、`product/process-manifest.mjs`、`product/launcher/launcher.mjs`、`product/launcher/desktop-security.test.mjs`、`product/launcher/desktop-bridge.mjs`、`desktop/main.mjs`及专项测试。

**交付内容：**每次启动生成非空 Workbench 令牌，由主进程经桥接传至 Workbench；另一枚私有 Hub 令牌只交给 Team Hub、其代理和获准的工作进程。桌面 API 与 `/hub` 代理验证令牌、精确的回环 `Host` 和预期 `Origin`；Hub 读请求也受保护。主进程只为所属主框架/会话和已验证的 Workbench 来源注入凭据。就绪探测必须鉴权，并持续验证浏览器/开发模式兼容性。

- [x] 编写测试，验证未鉴权读写、恶意 Host/Origin 和直接代理请求都会失败，可信请求可以成功；先确认 RED。
- [x] 实现鉴权和令牌传递，并确保凭据不进入日志；确认 GREEN。
- [x] 验证开发模式兼容性，并检查日志/诊断中是否泄漏令牌。
- [x] 提交 `feat(desktop): enforce local API credentials`。

### 任务 4 后续改动：Runtime 审批通道

**设计：**§7.1。当前 `team-hub/approval-registrar-row.mjs` 在 Runtime 中使用不带 Hub 凭据的通用 Hub 客户端；因此开启令牌保护的 Hub 会拒绝它的检查/收件箱请求。上述 API 边界已实现，但完整的审批执行链路还需要此连接。

**文件：**由 Launcher 管理的审批通道及测试、`team-hub/approval-registrar-row.mjs`、Runtime 端口配置/白名单、Run/attempt 租约接入及相关 schema。

- [ ] 对真实鉴权 Hub 测试：Runtime 可以提交范围化请求并只查看自己的请求状态；不能决定审批、读取整个收件箱或写入其他 Hub 路由。
- [ ] 将通道授权绑定到活动 Run/attempt、actor/scope、规范化调用哈希和 cwd；测试撤销的租约、过期凭据和跨范围请求。
- [ ] Hub 凭据保留在控制面。只向 Runtime 传递范围狭窄、有效期短的通道凭据，且不得经过 argv、模型上下文或日志。
- [ ] 桌面模式下用范围化端口替换 registrar 直接使用的通用 Hub 传输；通道出错时继续 fail-closed。
- [ ] 验证一个真实请求、一次明确的人工审批及一次完全匹配的工具执行后，才能将桌面完整执行链路标记为可用。
- [ ] 完成上述验证后，提交 `feat(desktop): add scoped runtime approval transport`。

**现有仓库门槛：**全仓配置扫描仍有 97 项既有的 team-hub/workbench/plugins 集成问题，已确认与已提交源码中的基线相同。桌面改动的产品配置扫描通过。正式发布前须解决这些基线问题或单独给出适用范围说明；本计划不声称全仓 PASS。

## 任务 5：生产载荷闭包与安装器

**涉及文件：**`desktop/package.json`、`desktop/electron-builder.yml`、`desktop/scripts/stage.mjs`、`desktop/scripts/verify-closure.mjs`、载荷构建脚本和锁定输入、发行描述符模块/测试、`product/release/runtime-manifest.json`、`docs/superpowers/prt/PRT-011-dsh-distribution-decision.md`。

**交付内容：**在干净暂存目录中准备固定版本的 Electron/Node/npm、构建后的 Workbench、Legion 生产模块和锁定版本的 DSH 生产载荷。桌面发行描述符将各组件精确版本、桥接协议版本、目标平台和资源哈希与现有运行时清单绑定。闭包检查拒绝缺失导入、开发机根路径引用、越界链接和不可用的原生资源。NSIS 生成当前用户 x64 安装器和固定快捷方式。PRT-011 将桌面载荷方案与 CLI 路线 C 分开记录。

- [x] 编写闭包/描述符测试，覆盖模块/构建产物/原生资源缺失、外部链接、目标平台错误、文件哈希或组件版本不匹配。
- [x] 在隔离构建根目录中构建锁定版本的生产载荷；实体化依赖链接、保留所需许可证和平台资源，并测量实际载荷与暂存目录占用。
- [x] 使用随包 Node 验证载荷；后台模块和资源放在 ASAR 外。Koffi/Sharp/ConPTY/DPAPI 原生组件检查通过。
- [x] 实现 NSIS/安装暂存并通过解包版和安装版烟测。没有开发机路径的严格干净虚拟机仍是发行门槛。
- [x] 构建安装器并在含空格的当前用户路径中测试本地 DSH 首次准备、独立 Legion DSH home、全部服务就绪、卸载及测试数据保留。断网虚拟机和已安装操作者 DSH 的环境还需单独检查。
- [ ] 审查当前验收记录后，提交整合后的暂存和安装器修正。

2026-10-01 构建检查点：生产输入和 Workbench 均使用锁文件构建；物理暂存目录约 **28,275 个文件 / 436 MB**。265 个模块的静态闭包检查和随包 Node 对 Koffi/Sharp/ConPTY/Windows DPAPI 的实际探测通过。使用官方发行资源 API 和上游固定 SHA-256 恢复 NSIS 资源下载后，生成约 **225 MB** 的未签名内部安装器。打包窗口和离线运行时导入检查通过。首次当前用户安装烟测在 240 秒时超时；将超时上限延长至 900 秒后，安装在 543,687 ms 完成，随后真实安装窗口/退出及观察到的卸载都通过，隔离数据保留。干净虚拟机和快捷方式检查仍待完成。详见[验收证据](../../release/legion-desktop-acceptance.md)。

2026-10-01 安装服务验收：首次安装版烟测发现，延后生成的凭据 `--patch` 被追加到 DSH 应用参数之后，导致 DSH 以 `unknown option '--patch'` 退出。另一个打包不匹配问题是：NSIS 的 x64 安装会省略 4 个仅供 ARM64 使用的 node-pty 文件，但旧描述符仍要求这些文件。现在进程计划会携带 launcher/app argv 分界，并将凭据补丁插入应用参数之前；Windows x64 暂存仅在清单生成前移除未使用的 ARM64 node-pty 目录。后续安装日志审计又发现 DSH 启动 URL token 被写入运行时 stdout 日志；现按行缓冲、仅对日志中的 query token 脱敏，不影响 Launcher 内存中的就绪输入。测试通过：桌面 **12/12**、进程/Launcher/运行时/就绪/日志相关 **147/147**，新建 SecretStore 父目录回归 **20/20**。重建安装器为 **222,542,124 字节**，SHA-256 `18D52D2AB29E4F3FE9941C8A87C1ADAECEC7B10B5E802A9E4E823B87A7A76B8E`，未签名。当前用户安装到含空格的路径耗时 **526,759 ms**；安装后的 **28,268** 个资源文件全部与发行清单匹配。首次启动用约 **259,036 ms** 验证/导入 DSH 并打开 Workbench；安装日志中的 DSH URL token 只显示 `[REDACTED]`，DSH、Team Hub、Workbench 和白板均达到就绪。Orchestrator 安全地报告 `no-executor`，未领取任务。正常退出、耗时 **4,616 ms** 的卸载及用户数据保留均通过。这证明当前主机上的随包 DSH/服务启动路径，不代表通过了干净虚拟机、断网环境、真实模型请求、Runtime Contract 或授权任务执行验收。

2026-10-01 重启检查：NSIS 安装成功并在保留数据的前提下卸载后，再次启动打包的 Electron 版本并使用保留的测试 DataDir。新应用报告 `app.isPackaged=true`，在 **36,018 ms** 内打开 Workbench；DSH、Team Hub、Workbench 和白板各自新增一条就绪记录（计数从 1 增至 2）。DSH 日志仍未出现明文 URL token。这确认每次全新应用启动都会在已准备好的 DataDir 上启动自己的服务集合；第二次检查复用了同一份 `win-unpacked` 打包版本，并非再次执行 NSIS 安装。

## 任务 5 后续改动：缩短安装和首次启动时间

**设计：**[§6.5 安装与首次启动性能](../specs/2026-09-27-legion-desktop-design.md#65-安装与首次启动性能)。将安装器解包和首次运行时准备分开测量。以当前安装验收为基线，再在同一 Windows 主机上用相同用户/安装路径、Defender 状态、数据目录状态和就绪检查重跑基线版与候选版。

**文件：**`desktop/scripts/stage.mjs`、`desktop/scripts/build.mjs`、`desktop/scripts/verify-closure.mjs`、`product/launcher/runtime-install.mjs`、`product/launcher/runtime-resolve.mjs`、相关测试、`desktop/scripts/acceptance.ps1`、`docs/release/legion-desktop-acceptance.md`。

**交付内容：**可复现的暂存、安装器、首次初始化和后续启动计时报告；经过测量的 A/B 打包原型；以及最安全的发行布局，减少可避免的小文件解包和/或首次启动复制，同时保留精确版本绑定、完整性验证、离线准备、原生模块加载、原子更新和回滚。

- [x] 增加隔离本机导入基准，报告来源校验、复制、目标校验、总耗时、字节数和文件数且不含密钥；增加暂存/构建耗时、物理与逻辑文件数及安装器大小输出。
- [x] Windows 首次导入到新暂存目录时使用有界 Robocopy `/MT:8`；复制前后仍按清单校验哈希，并保留取消和原子指针切换。导入器专项测试 **9/9** 项通过。
- [x] 在 Windows x64 暂存并生成描述符之前移除 DSH source map 和 `.d.ts` 声明文件；测试确认保留可执行代码和许可证。生产 DSH profile、Koffi、Sharp、ConPTY 与 DPAPI 检查通过。
- [ ] 更改打包方式之前，在受控主机上重新测量当前物理资源基线。若与安装 **526,759 ms** / 首次启动 **259,036 ms** 有明显差异，则以重测值为比较基线并说明原因。
- [x] 原型化 DSH ASAR 传输载荷和独立 Node 解包工作进程。Node/MinGit/Legion 服务仍是普通资源；DSH 解包到全新 DataDir 暂存目录，逐文件对照清单验证后再原子发布现有运行时指针。真实子进程取消会清理暂存目录且不发布指针。
- [x] Electron Node 上 Windows node-pty 的 `spawn()` 崩溃后，否决将 Electron Node 用作 DSH 运行时。继续采用私有 Node 进程模型；ASAR 仅作为分发格式，不作为实时执行文件系统。
- [x] 将解包并验证后的版本保存在 DataDir，使 Launcher 解析、可变 profile/home 隔离、指针回滚和数据所有权保持现有约定。传输布局达到两个实测目标后，无需从 InstallDir 直接执行。
- [x] 根据端到端证据作出选择。暂存逻辑清单 **16,805 项**，含 13,895 个 DSH 成员；物理 DSH 传输为一个 **143,201,284 字节**归档。安装器 **199,251,933 字节**。两次真实当前用户安装用时 **88,048 ms** 和 **66,232 ms**，旧参考值为 **526,759 ms**。完整安装版首次启动至解包、验证并使所有服务就绪用时 **87,989 ms**；第二次启动 **25,200 ms**。当前主机上的两项目标均已达到。
- [x] 将 NSIS 候选版安装并启动到含空格的隔离路径；验证归档大小/哈希、`app.isPackaged`、DSH/Team Hub/Workbench/白板就绪、DSH 日志令牌脱敏、正常退出、卸载及隔离数据保留。暂存闭包检查还会比较归档每个成员的清单哈希。
- [x] 保留从文件树转为裁剪后 ASAR 时的 DataDir 兼容性：只有同版本已有运行时的所有保留文件均匹配、额外项也都属于已知裁剪元数据/ARM64 载荷时才迁移；回归测试拒绝未知额外项。
- [ ] 在相同 Defender/负载条件下重新测量未优化安装器，以便精确计算 A/B 比例；现有基线来自此 Windows 主机更早的一次运行。干净虚拟机验收列于任务 7。
- [x] 专项测试和安装版验收通过后，将性能改动与无关发行工作分开提交。

2026-10-01 最终优化证据：裁剪 source map 与 `.d.ts` 文件后，将 DSH 放入哈希绑定的 ASAR 归档，使已安装 DSH 的物理资源从 **13,895 个文件**减为**一个归档**，描述符仍保留 13,895 个逻辑文件的哈希。候选安装器大小 **199,251,933 字节**。当前主机两次当前用户安装分别耗时 **88,048 ms** 和 **66,232 ms**；安装版首次启动时解包归档并使所有服务就绪耗时 **87,989 ms**，第二次启动 **25,200 ms**。安装版烟测确认 DSH、Team Hub、Workbench 和白板均就绪，DSH URL token 未以明文写入，正常退出、卸载和隔离用户数据保留通过。独立导入微基准耗时 **49,119 ms**。原型中 Electron Node + ASAR 的原生 ConPTY 启动发生崩溃，因此不用它执行 DSH。最终布局是在执行前将 DSH 实际解包到现有且已验证的 DataDir 运行时目录。

2026-10-01 启动回归跟进：优化包首次使用此前物理布局创建的 DataDir 时，因完成摘要仍包含已裁剪的 source map、声明文件和 ARM64 专用文件而报 `BUNDLE_EXISTING_VERSION_MISMATCH`。增加了严格受限的同版本迁移：对所有保留文件重新计算哈希，只删除已知旧额外文件，并原子更新标记；对被修改的保留文件或未知额外文件仍拒绝迁移。归档导入器专项测试 **13/13** 项通过。重建并安装修复版后，模拟旧 DataDir 在首次启动时成功迁移，四项服务全部就绪，令牌脱敏通过，卸载后测试数据保留。修复安装器 **199,252,431 字节**，SHA-256 `4335EB1D7861743E060F56D1CAFE0AB135F037C1972D86028601EE40F6774AF4`；较高负载下真实安装耗时 **164,647 ms**，到所有服务就绪耗时 **67,463 ms**。

## 任务 6：接入升级、恢复与卸载流程

**涉及文件：**`desktop/main.mjs`、`product/upgrade/*`专项模块/测试、`desktop/scripts/*`、NSIS 钩子。

**交付内容：**现有升级协调器是唯一的更新所有者。升级前检查退出影响、停止接收新任务并排空已接受请求；验证绑定的发行版本；收到正常拆除确认并观察到进程退出；切换指针并执行真实探测。强制终止或任务状态未知时不得交接给安装器。Host/Workbench 不可用时仍能独立恢复；有界脱敏报告最多保留十次失败记录。默认卸载保留产品数据和工作区。

- [ ] 编写失败测试，覆盖退出时仍有活动/未知任务、检查超时、准入竞争、缺少停止确认、文件锁定、签名/哈希错误、迁移/健康检查失败及保留数据的卸载。
- [ ] 增加有界崩溃报告和本机恢复；验证密钥脱敏与报告写入超时，并备份可选插件设置但不关闭强制策略。
- [ ] 接入升级和界面事件，然后通过专项及产品升级测试套件。
- [ ] 在 Windows 虚拟机中用真实安装版演练升级和回滚。
- [ ] 提交 `feat(desktop): wire upgrade and recovery`。

## 任务 7：验收与发行证据

**涉及文件：**`desktop/scripts/acceptance.ps1`、`docs/release/legion-desktop-acceptance.md`、许可证/SBOM 输出。

**交付内容：**可复现的 Windows x64 普通用户验收证据，覆盖安装、离线核心准备、真实模型/任务执行、第二次启动、崩溃/恢复、任务感知退出、升级、卸载、数据保留、许可证/SBOM、哈希与签名。所有未满足的门槛均应明确列为未完成；单元测试通过不代表内部构建已经稳定。

- [ ] 在不含开发工具的干净虚拟机上运行全仓测试门禁和安装版验收。
- [x] 记录最新安装器哈希与未签名状态、安装资源清单、DSH/Legion 服务就绪、正常退出/卸载和数据保留。进程树审计、任务/审计证据及恢复结果仍待补充。
- [ ] 对照本计划和方案审查完整 diff；对 Critical/Important 级发现用 RED → GREEN 测试修复。
- [ ] 所有门槛通过后，再提交验收证据并选择发行渠道。
