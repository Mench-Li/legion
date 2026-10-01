# Legion 独立桌面应用设计

> 初稿：2026-09-27；修订：2026-10-01
> 状态：实施中；发行门禁尚未通过
> 范围：Windows x64、当前用户安装的 Legion 桌面入口、服务生命周期与安装发行
> 依赖设计：[Legion Product Runtime 产品化架构设计](2026-09-11-legion-product-runtime-design.md)

## 1. 摘要与目标

Legion 桌面版是一个以 Workbench 为主界面的本地应用。用户安装后双击 Legion，桌面壳显示启动进度，后台由 Product Launcher 拉起 team-hub、Workbench、受控 DSH Runtime 和 Legion Orchestrator；就绪后在应用窗口中打开 Workbench。退出 Legion 时停止自动认领并回收本次启动的服务。用户无需打开终端、安装 Node 或配置 DSH/Cordis。

2026-09-30 参考官方 Harness 桌面实现后，**桌面正式包改为携带固定版本 Node/npm、DSH 生产依赖与 Legion 组合补丁**。构建阶段获取和校验依赖；用户首次启动从安装资源初始化受控运行时，不运行 npm，也不下载核心 DSH。CLI 和开发环境继续支持 [PRT-011 路线 C](../prt/PRT-011-dsh-distribution-decision.md)。桌面版的新增决定及适用范围同步写入该决策文档。

官方桌面采用 Electron 执行后台 Host，并将核心依赖随包分发。Legion 借鉴它的发行绑定、隔离 profile、生命周期和恢复机制，继续由已有 Product Launcher 统一管理多服务。Legion 首发保留独立 Node，具体差异与源码依据见 §13。本修订是设计决定，不代表新的随包运行时或安装器已经完成。

目标是完成以下用户路径：

1. 在没有 Legion、DSH、Node、pnpm 或源码检出的干净 Windows x64 用户环境中安装 Legion。
2. 双击桌面或开始菜单图标，观察到真实的准备、启动与失败状态。
3. 首次运行完成随包 DSH 初始化、工作空间与执行身份配置、模型密钥配置和执行能力验证。
4. 在 Legion 窗口中发布目标、查看任务；受控执行引擎和 Orchestrator 可自动协作。
5. 关闭窗口、从托盘重新打开、彻底退出及再次启动，均保持明确的进程归属和任务状态。
6. 安全升级、失败恢复和卸载不损坏业务数据与用户工作空间。

首发不交付 macOS/Linux、局域网共享、多用户 Windows Service、独立的 DSH 桌面界面或第三方桌面插件市场。完整安装包的安装与核心运行时初始化可在断网下完成；远程模型配置验证、在线模型执行和更新仍需要相应网络。离线初始化通过不能替代真实模型执行验收。

## 2. 现状与设计约束

| 现有资产 | 可直接复用的职责 | 桌面版新增工作 |
| --- | --- | --- |
| `product/process-manifest.mjs` | 五进程清单、依赖和就绪契约 | 固定桌面发行所需的进程集合与资源闭包检查 |
| `product/launcher/` | 单实例数据锁、启动监督、就绪检查、退出、运行时安装、向导、日志与诊断 | 向桌面壳提供长期运行的控制与进度协议 |
| `product/paths.mjs` | InstallDir、DataDir、CacheDir、LogDir、Workspace 分离 | 把安装位置和可写位置落实到安装器 |
| `product/upgrade/` | 版本清单、签名/哈希、备份、迁移与回滚判定 | 接入真实安装产物、健康探针和系统级切换动作 |
| `services-plugin/` | 开发态随 DSH Desktop 启停 team-hub 和 Workbench | 独立桌面版禁止与 Launcher 同时托管相同服务 |
| `workbench/`、`team-hub/` | 用户界面、数据与 API | 桌面模式的本地鉴权和来源约束 |

当前独立工作区已实现 Electron 壳与 Launcher 控制桥，已在 Windows 验证重复启动、隐藏到托盘、重开与正常退出；首次向导、生产资源打包、升级及干净机器验收仍待完成。`PRT-803` 的签名与文件校验实现不能替代真实安装包、开始菜单入口及干净机器验收。本设计补桌面交付层，保留现有任务状态机、Runtime Contract、权限策略和数据库模型。

主要参考改为 [官方 Harness 桌面源码](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop)，固定研究提交为 `639ed015397290b3745d163aafe02ffee4aa3f84`。原 [anywhere-labs DSH Desktop](https://github.com/anywhere-labs/dsh-desktop) 保留为历史参考；两者是不同仓库，本设计不假定其版本或行为一致。

## 3. 路线比较与决策

| 路线 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- |
| 继续使用 DSH Desktop + Legion 插件 | 最快复用现有开发部署 | 产品名称、安装、主窗口和生命周期仍由 DSH Desktop 决定；Legion 发行不可独立验收 | 保留为开发与过渡路径 |
| Fork DSH Desktop | 可复用窗口与安装器代码 | 将 DSH Host 生命周期与 Legion 产品演进绑定，维护上游同步及品牌分叉 | 不作为首发路线 |
| 在官方 Harness 桌面中挂载 Legion | 复用官方窗口、插件管理和更新 | 主窗口与发行由 Harness 拥有；需要协调 Launcher 与官方 Host 对运行时的管理 | 可作为插件适配路径，独立桌面首发不采用 |
| 独立 Electron 壳 + Product Launcher | 与现有产品架构一致；Legion 拥有主界面、发行和数据边界 | 需实现桌面桥、安装器和真机验收 | **采用** |

Electron 只负责桌面能力。Product Launcher 是**唯一的后台服务所有者**。Electron 主进程不能直接分别 `spawn` team-hub、Workbench、DSH 和 Orchestrator，也不能以“端口已经能连”为由接管别的进程。

## 4. 组件与接口

```text
Legion.exe（Electron 主进程）
  ├─ 单实例窗口锁、原生窗口、托盘、通知、导航限制
  ├─ 启动页 / 首次运行页（随安装包分发的本地页面）
  └─ 桌面控制进程（随包 Node 运行 desktop bridge）
       └─ Product Launcher（唯一服务管理者）
            ├─ team-hub :8787          → 数据、API、审计
            ├─ Workbench :5173         → Legion 页面与 /hub 代理
            ├─ DSH Runtime :3080       → 受控 Agent 执行
            ├─ Orchestrator worker     → 认领、派工、交接
            └─ Whiteboard :8080        → 首发默认不启动，可选功能
```

### 4.1 桌面控制协议

新增 `desktop/` 应用与 `product/launcher/desktop-bridge.mjs`。桌面壳用随包 Node 启动一个长期存活的 bridge；bridge 调用现有 Launcher API，避免复制第二套启动逻辑。两者通过当前用户进程的标准输入/输出交换有界、逐行 JSON 消息；标准错误只承载脱敏日志。协议版本从 `1` 开始，消息包含 `version`、`id`、`type`、`payload`，长度超过上限或类型未知时拒绝，不执行任意命令。

| 方向 | 消息 | 内容 |
| --- | --- | --- |
| 桌面壳 → bridge | `start`、`status`、`stop`、`restart` | 启停及状态查询；重复请求幂等；`start` 握手可传本次工作台凭证 |
| 桌面壳 → bridge | `prepare-runtime` | 正式包从已验证载荷初始化 DSH；开发态可显式选择 npm 安装路径 |
| 桌面壳 → bridge | `wizard.submit` | 向导当前步骤的结构化输入；密钥只经该私有通道传递，不进 argv/URL/日志 |
| 桌面壳 → bridge | `inspect-quit`、`begin-update` | 检查在途工作；升级先停止认领并排空已接受请求；查询失败不得授权安装 |
| bridge → 桌面壳 | `progress`、`needs-input` | 阶段、具名错误码、可执行的下一步 |
| bridge → 桌面壳 | `ready`、`degraded`、`failed`、`stopped` | 已验证状态；`ready` 附 Workbench 本机地址与本次启动标识 |

bridge → 桌面壳的状态与进度消息不得包含模型密钥、team-hub token、DSH Runtime token 或完整环境变量。桌面壳 → bridge 的 `start` 握手和 `wizard.submit` 传递本次工作台凭证及用户输入的模型密钥；只走私有标准输入，不进入 argv、URL、输出事件或日志。桌面壳以一个请求 `id` 对应一份结果，bridge 在被异常终止时由主进程记录失败并展示恢复入口；不能悄悄再起第二个 Launcher。CLI 模式仍保留现有命令行入口和托盘实现；桌面模式由 Electron 独占物理托盘，bridge 不挂 PowerShell 托盘。

控制请求设有分类截止时间，并在超时、bridge 退出或通道关闭时清理等待项。安装初始化在受控 worker 内执行，使停止/取消仍可处理；不得在 bridge 主线程执行长时间同步安装。`stop` 返回停止结果后，Electron 还要等待 bridge 实际退出；升级额外要求优雅停止确认、受管进程树退出及任务结算成功。超时后的状态是失败或未知，不能视为停止成功。

### 4.2 窗口与页面

启动页和向导属于桌面壳，使用随安装包分发的页面。Workbench 仅在 `/hub/api/config` 身份及就绪判据通过后加载；不能依据计划端口直接加载。首次运行向导复用现有 `environment → initialize → start → configure-model → verify → heartbeat-consent → done` 状态机，但需要在桌面页呈现真实进度、错误和断点续跑。

Workbench 是唯一主工作窗口。DSH Web UI 不自动打开。默认关闭窗口后在托盘继续运行；托盘“退出 Legion”才停止受管进程。托盘至少提供“打开 Legion”“运行状态”“重新启动服务”“退出 Legion”。用户可在设置中改为关闭窗口即退出，该偏好保存在产品用户设置中。

首发继续从 Launcher 验证后的 Workbench HTTP origin 加载页面，复用现有静态服务与 `/hub` 代理。官方的本地协议方案作为后续选项：迁移至 `legion-app://app` 前必须单独验证流式响应、附件、WebSocket、缓存、取消、CSP 与来源校验，不在本次为外观改造而引入第二套传输。

## 5. 启动状态机与进程归属

### 5.1 首次启动

```text
双击 Legion
→ Electron 单实例锁；已有窗口则聚焦
→ 加载本地启动页
→ 启动 desktop bridge，校验产品清单和目录
→ 检查随包 Node、载荷完整性、DSH 当前指针、组合补丁与端口
→ Launcher 在任何 DataDir 写入前取得独占锁；运行期持续持有
→ 首次缺 DSH 时从随包载荷暂存、逐项校验、原子切换
→ 初始化产品目录；选择工作空间并确认执行身份与授权范围
→ 按进程清单启动并验证 team-hub、Workbench、DSH Runtime
→ 强制面/Runtime Contract 验证通过；首次配置期保持 Orchestrator 暂停认领
→ 通过受保护 API 配置模型，执行真实模型探测
→ 用户明确完成自动执行/heartbeat 设置，再开放认领并加载 Workbench
```

`spawn` 成功、TCP 可连和真实就绪是三种不同状态。team-hub 必须验证 `/api/config` 的产品/端口身份；Workbench 必须验证 `/hub/api/config` 确实代理到本次 team-hub；DSH 使用现有 Runtime 就绪发布和本次 PID/端口核对。Orchestrator 必须在 Runtime 凭证、强制面与执行契约通过后才开始认领。

向导不得伪造执行身份，也不得把“保存 API key”作为模型已验证。恢复向导只保留阶段与非敏感配置引用；模型密钥写入现有受保护 secrets 存储。退出向导后再次启动应继续未完成步骤，保留有效载荷和已有业务数据。

### 5.2 失败与恢复

| 情况 | 用户看到的状态 | 系统动作 |
| --- | --- | --- |
| 随包载荷缺失、损坏或初始化中断 | 执行引擎未就绪；显示重新初始化或重装入口 | 保留旧有效指针；不静默联网补装，不启动自动执行 |
| 端口被其他程序占用 | 点名端口和占用诊断 | 不接管未知进程，不随机换端口继续运行 |
| team-hub 或 Workbench 未就绪 | 启动失败及对应修复入口 | 停止依赖它们的进程；不显示空白工作台 |
| DSH 不可用，team-hub/Workbench 正常 | 工作台可查看数据，但醒目标记“AI 执行不可用” | Orchestrator 停止认领；任务不得记为成功 |
| DSH 运行中崩溃 | 工作台展示降级状态和正在恢复 | Launcher 按现有退避/熔断处理，失败的 Run 按 Runtime Contract 结算 |
| Electron 页面崩溃 | 显示恢复页，可重新打开窗口 | 不把页面崩溃当作服务退出；Launcher 仍持有进程 |
| bridge 崩溃 | 显示“服务控制已中断” | 禁止自动拉起第二个未核对所有权的实例；先检查锁和原进程状态 |
| 用户彻底退出 | 明确显示停止中 | 停止认领，按依赖反序优雅停止；超时后核对 PID 再清理整棵进程树 |

桌面应用不得以“窗口已经打开”报告产品就绪。允许 Workbench 在 DSH 降级时查看历史与诊断，但此状态不等于完整 `ready`，自动执行始终关闭。

## 6. 分发包与目录

### 6.1 安装产物

首发构建 Windows x64 当前用户完整安装包，使用 Electron Builder 生成应用目录，再由受控的 NSIS 流程制作安装程序。安装内容限定为：

- Electron 主进程、启动/向导页面、图标与托盘资源；
- 固定版本 Node/npm，含许可证和哈希清单；
- 固定版本的私有 MinGit，供 Legion 的 Git/worktree 操作使用；只加入本次服务进程的 PATH，不修改系统 Git 或全局 PATH。当前构建输入为 `2.56.0.windows.1`，发行资产及 SHA-256 来自 [Git for Windows 官方发行页](https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.1)；
- Legion 的生产代码、产品清单、DSH 组合补丁、运行时契约文件；
- 固定版本 `@deepseek-ai/dsh` 与生产依赖的已校验载荷，含 Legion 自有包的实际文件；
- 已构建的 `workbench/dist`、team-hub 与 Orchestrator 必要依赖；
- 第三方许可证清单、SBOM、诊断与恢复入口。

构建在未打包目录及真实安装目录分别执行运行时闭包检查：不得缺模块、引用开发机绝对路径、把 junction/symlink 指向源码检出，或把运行所需的物理文件留在不可执行的虚拟归档内。安装包必须能在路径含空格的非管理员账户下启动。核心 DSH 和 Legion 依赖在构建时联网准备，客户首次启动不执行包管理器。包体按真实生产闭包测量，不能沿用开发 checkout 含 dev 依赖的约 1.6 GB 估算。

### 6.2 随包载荷初始化

随包 Node、MinGit 与 Legion 服务资源放在 `resources/` 的实际目录，Electron 页面和壳代码放 ASAR。DSH 生产树在构建时压成经过 SHA-256 绑定的单个 `dsh.asar` 资源以减少安装器逐文件解包；首启由随包独立 Node 启动隔离的解包 worker，展开到 DataDir 暂存目录，再逐文件按发行清单校验，最后原子切换现役指针。运行中的 DSH、原生模块和需执行的资源仍从 DataDir 的普通文件系统读取，不依赖独立 Node 访问 ASAR。

桌面壳通过 Electron 的 `process.resourcesPath` 动态解析安装资源根，Launcher 与 DSH 入口都不依赖开发机 checkout 路径。项目工作区是独立的操作者选择；DSH 可执行文件从已校验的 DataDir 指针解析，DSH 进程的当前工作目录跟随所选工作区，因为 `LEGION_PATH_SCOPE` 会按 `process.cwd()` 收窄。这样既支持任意安装位置，也不把可写工作区放进会被升级替换的 InstallDir。

`prepare-runtime` 新增 `source=bundled` 分支，复用现有版本/补丁配对、写入边界与完成标记判据。在 DataDir 独占锁下，把包内生产树复制到 `DataDir/runtime/dsh/versions/` 的唯一暂存目录；根据发行文件清单验证路径、类型、大小及哈希，验证入口与目标平台原生依赖，再发布版本目录、写完成标记并原子切换 `current.json`。实际目录名以 `runtimePathsOf` 为准。任何失败都不得修改现役指针；已完成但未切换的目录先重新校验，允许继续切换，不能要求用户手动删除数据。

桌面载荷裁剪策略变化时，已安装的同版本 DataDir 运行时可能仍含旧版 source maps、`.d.ts` 声明文件或 x64 不使用的 ARM64 node-pty 资源。只在 DSH 与组合补丁版本相同、所有当前清单文件逐字节匹配且额外文件全部属于这些明确类别时，才自动删除额外文件并原子更新完成标记；任何必需文件哈希不同、未知额外文件或版本不同都继续 fail closed，不能切换现役指针。

现有 Launcher 主要在 `start()` 期间取得锁；实施时需补受同一所有者管理的准备阶段，使向导、载荷复制与服务启动共享一份锁。不得由 bridge 创建第二套独立锁或在初始化完成与启动之间释放所有权，让另一个实例插入写入。

2026-10-01 实现补充：产品层的 Desktop Launcher 负责准备阶段，完成后将同一个 DataDir 锁句柄交给现有 Launcher；bridge 不持有文件锁。载荷校验/复制在产品拥有的准备进程中执行，可取消并等待其真实退出。真实准备进程取消测试已通过；这部分完成不代表首次向导或完整桌面交付已完成。

安装资源保持只读；可写 profile、产品 home、配置与任务数据放在 DataDir。运行时复制是兼容现有 Launcher 布局的首发选择，会占用第二份生产载荷空间；磁盘预检与卸载保留策略须说明这一成本。后续直接使用安装目录内不可变依赖需要先扩展 Runtime Resolution 和升级回滚接口，不能靠指向源码的 junction 实现。

### 6.6 工作流包与首发软件协作包

Legion 的场景以**可导入的工作流包**交付，而不是把一个固定工作区副本塞进安装器。一个包可以定义空间信息、角色编队、工作流阶段与提示词，以及包内技能/文档/模板；导入后绑定到用户选定的项目工作区。软件协作流程和 Ozon 业务流程是两个独立包，分别安装；首版不复制整个开发 checkout，也不把两类流程混为一个默认工作区。

首版 `.legionpack` 是 UTF-8 JSON，格式标识为 `legion/workflow-pack@1`，携带稳定 `id`、语义版本、显示名称、目标 scope、角色、阶段和内嵌文本资源。整个包最大 2 MB，最多 32 个角色、32 个阶段和 128 个资源，单个资源最大 256 KB；资源类型限于 skill、document、template。导入器对规范化包计算 SHA-256，并记录包与已应用内容的摘要，用于检测本地编辑。首版尚无独立签名、外部兼容性声明或单资源摘要字段。拒绝未知字段、明文凭据、机器路径、绝对/越界资源路径以及任何可执行内容；不接受包内 JavaScript、shell、二进制或符号链接。后续代码/连接器扩展须走独立签名、权限和审核机制。

首发 `legion.software-collaboration` 包由通用 `roles.json` 与可复用的士兵提示词构建，随安装资源内置。Team Hub 启动时先校验并尝试导入八阶段流水线（需求澄清、方案搜索、任务拆解、测试设计、编码、审查、测试、部署）及岗位编队，再开始监听；新空间绑定 Launcher 当前选定的项目工作区，安装包不复制项目。目标 scope 已存在时保留现有空间并跳过自动导入；已安装包的更新也不在启动时静默应用。回执与内容摘要存于 Team Hub 产品数据库，首次成功后的后续启动幂等。工作流包安装不会创建或启用自动执行配置。

后续包以单文件 `.legionpack` 导入。Workbench 的“流程包”入口选择本地文件，先由 Team Hub 校验并预览名称、版本、目标空间和角色/阶段/资源数量；general 操作者确认后，Workbench 通过带本地认证的 Team Hub API 提交声明式 JSON。渲染器不直接写数据库、不解包文件，也不执行载荷。若稳定包 id 已安装，只有受管内容未被本地修改时才允许显式升级；冲突时阻止覆盖。已导入文档和模板可在流程包管理页查看。首版未实现包停用、删除、回滚、在线市场或自动更新；这些能力须单独定义任务历史、引用与权限的处理规则。

包来源先支持随包内置与用户选择本地 `.legionpack` 文件；下载目录、在线市场与自动更新属于后续能力。包不携带 API 密钥、访问令牌、私人任务/聊天记录或机器绝对路径；Ozon 包的数据访问凭据仍由 Legion 的密钥库单独管理。初始包/角色的存在不代表用户授权自动认领任务，既有 Runtime Contract、模型验证和审批门禁继续生效。

2026-10-01 实施约束：桌面使用产品私有的 `legion-desktop` profile，固定 `dsh-base` / `dsh-web-app` bundles，并采用 `patchReload=startup`。固定 DSH 版本的 live watcher 在打印服务 URL 后仍可能因 HMR 未装配而退出，故产品配置通过受控重启应用；现有 CLI profile 不随此决定改变。发行载荷实际启动验证必须等待服务判据并复查存活，不能以 URL 已打印作为完整桌面验收。Windows 内置 PowerShell 的路径加入私有启动环境，用于当前用户作用域 DPAPI，不要求安装宿主 pwsh。

正式包只接受发行清单中绑定的载荷，不从配置读取任意安装来源。开发态的 npm 路线显式启用，显示网络阶段与可取消状态，不能成为正式包缺失载荷时的自动回退。

### 6.5 安装与首次启动性能

2026-10-01 当前内部安装包基线：安装器为 **222,542,124 字节**；安装目录包含 **28,268 个资源文件 / 423,180,361 字节**。一次当前主机的普通用户安装耗时 **526,759 ms（约 8 分 47 秒）**。安装后首次启动把 DSH 导入 DataDir 并逐文件校验，到 Workbench 打开约 **259,036 ms（约 4 分 19 秒）**；同一数据目录后续启动约 **36,018 ms**。这些是当前主机/内部包数据，不是干净 VM 或可普遍复现的性能承诺。安装耗时与首次运行导入是两个独立阶段，性能报告必须分开记录。

当前已测载荷分布约为：DSH **211.9 MB / 25,457 文件**，私有 Node/npm **106.1 MB / 1,990 文件**，MinGit **95.8 MB / 373 文件**，Legion **9.4 MB / 448 文件**。因此体积由少数大组件主导，而 Windows 安装和启动导入都要处理大量小文件。现有方案先将真实目录交给 NSIS，再于首次启动把 DSH 复制到 DataDir 并逐项校验；这同时产生安装解包和首次导入两段工作。

**性能优化方向：**

1. 为 staging、NSIS 安装、首次准备、后续启动分别记录阶段耗时、字节数、文件数和校验耗时；同一 Windows 主机、相同数据目录状态与相同安全扫描条件下对照，不能把“安装器体积较小”当作完成标准。
2. 在 Windows x64 staging 中剔除不参与运行的 DSH source maps 与 `.d.ts` 声明文件（保留可执行 TypeScript 源、运行代码和许可文件），并在闭包、DSH profile、原生模块及实际服务测试中确认；不得按扩展名删除配置/模板资源。
3. 比较当前散文件布局与单一归档/ASAR 载荷布局，重点验证安装解包是否能减少文件系统操作，以及后台运行时能否直接读取不可变 DSH/Legion 代码，避免首次启动重复复制。Electron 官方桌面源码使用 Electron Node 模式运行 Host，并以 ASAR 与 `app.asar.unpacked` 分开放置代码和必须落地的资源；这可作为原型方向，不能直接推定适用于 Legion。
4. 只把确实需要由操作系统加载或写入的内容解包到普通文件：Node/Electron 可执行文件、原生 addon/DLL、ConPTY、需执行的工具及需变更的用户数据。归档读取方案必须在受控 DSH、Legion、Workbench、Koffi、Sharp、node-pty 和 Windows DPAPI 路径上真实验证。
5. 首选评估“安装目录内不可变、已校验的运行载荷直接供 Launcher 运行”，将可变 DSH home、profile、配置和产品状态保留在 DataDir。只有 Runtime Resolution、发行版本绑定、哈希验证、升级回滚与卸载保留均通过后，才可取消首次复制；不得使用 junction 指向开发 checkout 或略过当前安全校验。
6. 如独立 Node 不能通过归档读取，评估官方桌面采用的 Electron Node 模式或明确的归档适配器，并以隔离原型验证进程所有权、Cordis/原生模块 ABI、`--expose-internals`、私有 PATH、DPAPI 和关闭行为。架构选型以 A/B 实测为据；不得为压缩安装包而把首次启动时间或故障恢复复杂度转嫁给用户。

性能优化阶段的比较目标是：同等验收条件下，安装耗时和首次到 Workbench 耗时各自至少降低 **50%**（分别不超过约 **263 秒**及 **130 秒**），同时保持资源哈希验证、断网首次准备、全部必需服务就绪和退出/恢复语义。该目标用于优化验证，不构成尚未通过干净 VM 验收的发行承诺；若载荷布局原型不能同时满足目标，须先给出 A/B 数据和架构代价，再决定进一步方案。

2026-10-01 优化实现阶段基准：加入 Robocopy `/MT:8` 并行初始化，同时继续对来源和目标运行时逐文件哈希校验；DSH source maps 裁剪后 staging 从 **28,268 / 423,180,361 字节**降到 **23,607 / 385,579,768 字节**（减少 4,661 个文件、37,600,593 字节）。隔离临时 DataDir 导入 20,796 个 DSH 文件耗时 **122,846 ms**（来源校验 5,359 ms、复制 17,214 ms、目标校验 100,207 ms），与此前安装版首次启动的 259,036 ms 相比约快 **53%**，达到首启的阶段目标；二者 DataDir/安装环境并非完全相同，安装版完整就绪耗时仍须重新验收。后续追加 `.d.ts` 声明文件裁剪尚待测量。

Electron Node + ASAR 原型可以读取并运行 DSH 的配置入口，Koffi 与 Sharp 在所需解包布局下可加载；Windows 下 node-pty `spawn()` 在 Electron Node 模式中途崩溃，故**不能据此切换 Legion 的执行 Node**。Legion 采用不同边界：独立 Node 仍运行桥接和服务；单一 ASAR 只用于传输 DSH 载荷，应用第一次启动时在独立子进程中安全展开并校验后再运行。

2026-10-01 ASAR 安装验收：DSH 归档为 **143,201,284 字节**，安装包为 **199,251,933 字节**；清单保留 DSH 的 13,895 个逻辑文件与 SHA-256，应用资源目录实物只需一个 DSH 归档。Windows x64 stage 总清单为 16,805 个文件记录（包含归档内部逻辑文件），无归档时预计物理资源为 2,910 个文件，使用归档后约 **2,911 个物理资源文件**（另有发行描述符）。当前主机的两个实际安装测试分别为 **88 秒**和 **66 秒**；与此前 527 秒基线相比均超过 **50%**改进。NSIS 安装后真实启动并从已安装 `dsh.asar` 完成首启展开、SHA-256/逐文件校验及 DSH、Team Hub、Workbench、Whiteboard 就绪耗时 **88 秒**；第二次同数据目录启动所有四项服务再次出现就绪记录，耗时 **25 秒**。关闭、卸载和卸载后数据哨兵保留通过；DSH URL token 日志未见明文。此次使用当前 Windows 主机和隔离测试身份，不能替代干净 VM、真实模型任务、审批执行、签名/SBOM及升级恢复验收。

[anywhere-labs DSH Desktop 的打包说明](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-plugin-desktop/README.md) 描述了 Electron 主进程承载 DSH Host、将必要的物理资源置于解包区的布局；其 [issue #981](https://github.com/anywhere-labs/dsh-desktop/issues/981) 报告将核心从单个 168 MiB `app.asar` 改成约 22,098 个散文件后，Host 启动增至 26–38 秒。这是特定版本的启动回归报告，不是 Legion 安装基准，也不能证明其安装器更快。本方案采用“降低散文件成本、避免重复复制”的可测目标，不照搬其产品架构或未经验证的打包方式。

### 6.3 持久化位置

```text
%LOCALAPPDATA%\Programs\Legion\       只读应用和随包 Node；升级时替换
%LOCALAPPDATA%\Legion\data\           team-hub 数据、附件、产品配置、受控 DSH 版本
%LOCALAPPDATA%\Legion\cache\          下载与构建缓存
%LOCALAPPDATA%\Legion\log\            可轮转日志
%LOCALAPPDATA%\Legion\secrets\        受保护密钥材料，与普通 DataDir 分开
<用户明确选择的目录>                  工作空间和 Git 项目
```

具体路径以 `product/paths.mjs` 和 Windows 安装器解析出的绝对目录为准，不在代码中写死 `%LOCALAPPDATA%` 字符串。安装目录及应用资源只读；升级和卸载不能把数据库、密钥、审计、附件或用户工作空间当作程序文件清理。受控 DSH 使用产品专属 home/profile，不默认修改用户已有的 `~/.dsh` 或正在运行的 DSH Desktop。导入旧配置与数据只在用户明确选择并完成备份后执行。

### 6.4 版本绑定

保留现有 `product/release/runtime-manifest.json` 的运行时契约，新增桌面发行描述符绑定桌面壳、Electron、随包 Node/npm、Legion、DSH 精确版本、补丁版本、bridge 协议、目标平台/架构和载荷文件清单哈希。描述符验证自身 schema，并和现有 manifest 逐项交叉校验；完整性依赖签名或已可信安装资源，单独的哈希不能证明发行者身份。

所有组件形成一次 Legion 发行的经过验证的版本组合；Legion 与 DSH 的版本号无需相等。升级 DSH 必须通过新的 Legion 发行验收，不能在客户启动时使用 `latest` 或兼容区间选择版本。研究提交的官方桌面包版本为 `0.2.0-rc.2`，本仓库当前 DSH 清单仍为 `0.1.5-rc.2`；**本次参考不自动升级 DSH**。更换版本必须先验证组合补丁、Runtime Contract、权限强制面和真实任务兼容性。

## 7. 本机接口安全

默认只监听 `127.0.0.1`。Electron 工作窗口关闭 Node 集成，启用上下文隔离与渲染进程沙箱；只允许导航到本次 Workbench origin。外部链接交给系统浏览器打开前必须校验协议与目标；不向 Workbench 暴露原始 Electron、文件系统或进程接口。启动页与 Workbench 的桌面桥接命令只提供实际需要的少量动作，并核对 IPC 发送者。

**桌面模式必须使用非空鉴权。**当前 Workbench 的写 token 未配置时允许部分写请求，读请求也可访问；这不满足独立桌面发行的边界。Electron 主进程在每次启动时生成工作台凭证，经 `start` 握手交给 bridge，再按最小范围注入 Workbench；bridge 独立生成 team-hub 凭证，只交给确需使用它的服务。Electron 主进程只向精确匹配的 Workbench origin 添加工作台凭证，渲染页面拿不到凭证值；Workbench 桌面模式对敏感读写 API 及代理入口校验凭证、`Host` 和 `Origin`，拒绝跨站请求及 DNS rebinding 形式的非预期 Host。team-hub 凭证只在 bridge、team-hub、Workbench 代理和确需访问它的 worker 之间传递；现有 DSH Runtime Contract 的短期 token 保持独立。所有凭证不得进入 URL、启动参数、日志、诊断包或产品数据库正文。

凭证注入同时核对窗口/会话归属与目标 origin，不能仅用 URL 匹配给任意 webContents 授权。重启时撤销旧请求授权，完成本次服务身份核验后才绑定新地址；拒绝非预期子框架、权限请求和导航。启动/向导 IPC 仅接受拥有者窗口的主框架；禁止把 `ipcRenderer` 或通用执行接口交给页面。

这一节是桌面发行的前置开发项，不依赖“只监听本机”来替代鉴权。普通浏览器访问 Workbench 如果要保留，应是明确启用的另一种模式，并拥有独立的登录/凭证交付流程。

### 7.1 Runtime 的审批通道

本仓库 `team-hub/approval-registrar-row.mjs` 目前通过通用 hub HTTP 客户端调用 `POST /api/permissions/check` 和 `GET /api/permissions/inbox`。Runtime 的环境白名单禁止 `TEAM_HUB_TOKEN`；该注册器也明确说明，hub 配置 token 后审批请求会失败并阻断工具调用。桌面强制鉴权会使这个已有限制成为确定的产品路径，因此仅完成 Workbench/hub API 防护仍不能通过完整执行验收。

设计新增 Launcher 所有的专用审批通道，位于控制面，由 Launcher 启停；它向 hub 转发时持有私有 hub 凭证，Runtime 只持有单独的短期通道凭证。通道只提供发起审批和读取本次申请状态两种操作，既不代理任意 hub 路径，也不提供批准、改策略或通用写入。读结果限定到本通道创建的申请 ID，不向 Runtime 返回整个审批箱。

每次申请关联当前有效 Run/attempt、执行身份、空间、工具调用的规范化哈希及工作目录；控制面对照有效租约和 RunRequest 权限校验，不信任 Runtime 自报的跨空间身份。首次授权、重启、Run 结束和租约失效分别创建或撤销通道许可。凭证不进入模型提示词、argv、公开事件或数据库正文。实际承载可在 Launcher 内部使用受控本机端点，但地址只能由本次启动产生并通过受保护配置交付；Runtime 不能通过客户端输入选择上游或额外路由。

这项工作须修改审批注册器的端口接线，并有真实鉴权 hub 的集成验证；在完成前，桌面版对需要审批的工具保持具名拒绝，执行能力状态不得显示为完整可用。验收覆盖允许申请、人员批准后仅本次调用放行、跨空间/过期凭证拒绝、越权读取审批箱拒绝以及直接写 hub 拒绝。

## 8. 升级、回滚与卸载

桌面更新由 Legion 的 `product/upgrade/` 流程**唯一拥有**；Electron Builder/NSIS 负责制造和安装产物，不再启用第二套自动更新器。发行物使用可验证的完整性清单和签名。正式发布还要对 Windows 可执行文件及安装器做代码签名。

升级顺序沿用现有产品规格：预检产品/DSH/补丁组合与磁盘空间 → 停止新任务认领 → 等待或安全中断在途 Run → 备份数据库及配置 → 校验下载产物 → 停止服务并确认进程树退出 → 将新版本置于同卷版本目录 → 原子切换活动版本指针 → 执行已登记的迁移 → 运行真实 team-hub、Workbench、DSH 与强制面健康检查 → 提交升级。健康检查失败时，按迁移类型判断能否回滚程序；已发生不可逆或状态未知的数据写入时必须进入“需要向前修复/恢复备份”状态，不能仅替换旧二进制。

NSIS 初始安装和升级调度的职责必须分清：快捷方式指向稳定的启动入口，活动版本由单一指针解析；安装器不能在仍有服务持有文件句柄时覆盖现役目录。`product/upgrade/` 目前有部分签名、迁移和判定原语，但真实 Windows 文件释放、默认健康探针、系统级原子切换以及 UI 通知仍需接线和真机验证。

退出前由 Launcher 检查在途 Run、认领租约及计划任务，向用户说明受影响工作；用户选择继续后台运行或停止并退出。升级进入独立的暂停阶段：停止认领、阻止新的变更请求、排空已接受请求，再检查工作。停止结果必须同时包含任务处理完成与进程退出证据；被强制结束或状态未知时，不交给安装器覆盖程序。普通退出可在明确策略下回收进程，但不能据此宣称任务已经完成。

启动错误、bridge 崩溃、renderer 崩溃分别记入 LogDir，报告包含发行版本、阶段、错误码、受管进程摘要与脱敏日志尾部。单份报告和内存缓冲有上限，默认保留最近十份；报告持久化超时不得阻塞恢复页。恢复动作先停止并确认受管进程，再重试启动或备份并隔离可选第三方插件；禁止一键抹掉 DataDir 或跳过 Legion 强制面插件来“修复”运行。

卸载默认只删程序，保留 DataDir、密钥和工作空间；“彻底删除 Legion 数据”是另一个明确的用户动作，并在执行前列出实际目标目录。绝不自动删除用户工作空间。

## 9. 开发切片与交付门禁

| 切片 | 交付物 | 完成门槛 |
| --- | --- | --- |
| D1 桌面壳 | `desktop/`、单实例窗口、启动页、托盘、导航限制 | 开发机重复双击只唤醒一个窗口；关闭/退出行为可观察 |
| D2 生命周期桥 | 版本化控制协议、Launcher 适配、真实进度与失败事件 | Electron 不直接拉起四服务；CLI 与桌面模式共用一套 Launcher 判据 |
| D3 首次运行 | 随包 Node/npm、DSH 本地初始化、向导 UI、模型验证 | 干净 Windows 可断网初始化核心；真实模型验证失败可恢复且不开认领 |
| D4 接口防护 | Workbench 桌面模式鉴权、来源校验、凭证传递与脱敏 | 未带凭证的敏感请求被拒绝；页面与诊断包不含凭证 |
| D5 安装与升级 | NSIS、闭包校验、签名、真实健康探针、版本切换 | 安装、重启、升级失败恢复和卸载在真实 Windows VM 上通过 |
| D6 发布验证 | 黄金任务、故障注入、SBOM/许可证、发布清单 | 满足本文件 §10 的完整验收；外部真实项目验证独立记录 |

每个切片完成后先验证其新增边界；发行门禁再跑现有仓库级 CI 与真实安装包端到端。切片 D1–D3 可先使用 internal 通道；不能仅凭本机源码运行通过就晋级 canary 或 stable。

## 10. 验收矩阵

在全新 Windows x64 虚拟机的普通用户账户中执行；机器上没有 Node、pnpm、DSH、Legion 源码及开发环境变量。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 单安装包首次启动 | 从桌面图标进入启动页；DSH 本地初始化、配置和验证均有真实进度；无需终端或 npm 下载 |
| 断网与载荷损坏 | 完整包断网可初始化核心；模型网络错误单独呈现；损坏载荷具名失败且不联网替换或开放认领 |
| 重复双击与端口占用 | 只保留一个产品实例；未知端口占用具名失败，不接管别人的服务 |
| 工作台就绪 | 窗口加载后 `/hub/api/config` 指向本次 team-hub；任务/空间数据可读写 |
| 执行闭环 | 配置模型、绑定工作空间、发布真实低风险目标、完成至少一次员工执行与交接，结果和审计可追溯 |
| 关闭、退出、重开 | 关闭窗口按设置保持托盘或退出；在途工作退出有明确处理；退出确认后受管进程消失，再次启动恢复数据与任务状态 |
| 网络中断与 DSH 崩溃 | 模型连接失败可重试；运行时故障不产生任务伪成功、重复外部写或无声派工 |
| 安全 | 非预期 Host/Origin、无凭证的敏感 API、未经授权的高风险工具调用均被拒绝 |
| 受控审批 | 开启 hub 鉴权时 Runtime 可走专用通道发起并等待自己的审批；无法读其他申请、批自己的申请或直接写 hub |
| 升级与恢复 | 损坏包、数据库迁移失败、健康检查失败及 Windows 文件占用都有可验证的安全落点 |
| 卸载重装 | 默认保留数据并可重装读回；工作空间始终不受卸载影响 |

证据应包含安装包哈希与签名结果、安装目录清单、关键状态日志、进程树、就绪探针结果、任务/审计记录和升级恢复记录。测试替身可用于协议与错误分支，但“无需开发环境即可运行”只能由真实安装包在干净机器上证明。

## 11. 风险与待同步事项

1. **桌面分发决定更新**：PRT-011 的 CLI 路线保留，桌面正式包改为随包生产 DSH 与 Node/npm；需要交付载荷构建、离线初始化与发行描述符。独立 Node 的版本、签名与安全更新随 Legion 发行维护。
2. **Legion 插件发行**：现有 `file:` 依赖及开发机 junction 不能出现在客户安装包。构建需把 Legion 自有包与补丁层变成可校验的实际文件，并在隔离 DSH profile 中验证加载。
3. **既有服务鉴权不足**：Workbench 读面及未配置 token 的写面需要桌面模式收紧；这可能影响用浏览器访问本机 Workbench 的现有开发流程，因此用显式模式隔离行为。
4. **升级原语与产品闭环有差距**：进度表中的部分“完成”是判定器或测试原语，真实安装器、默认健康探针、进程释放和用户通知仍是桌面发行范围。
5. **既有守护与新 Orchestrator 冲突**：独立桌面版使用产品专属 DSH home/profile，不自动启用旧 `dsh-scrum-worker` 或 `services-plugin`；迁移旧环境时先备份并核对唯一调度器。
6. **产物体积与离线初始化**：实际包体、复制后的磁盘占用、启动耗时尚未测量。构建阶段的联网依赖不能转嫁为用户首次启动时的隐式安装；真实模型网络需求须单独说明。
7. **官方演进与当前运行时差异**：参考提交与本仓库受控 DSH 版本不同。采用架构机制不意味着能够直接替换私有 Desktop Host 或复用全部官方插件；版本升级需独立资格验证。
8. **审批通道尚未接线**：现有注册器在 hub 开启鉴权后会失败。§7.1 的专用通道是完整执行验收的前置条件；不能通过向 Runtime 发放管理凭证或关闭鉴权解决。

## 12. 参考依据

- 本仓库：[Product Runtime 产品化架构](2026-09-11-legion-product-runtime-design.md)、[PRT-011 DSH 分发决策](../prt/PRT-011-dsh-distribution-decision.md)、`product/process-manifest.mjs`、`product/launcher/`、`product/paths.mjs`、`product/upgrade/`。
- 参考实现：[DSH Desktop 项目](https://github.com/anywhere-labs/dsh-desktop)、[桌面包架构](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-plugin-desktop/README.md)。
- 平台约束：[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[Electron Builder NSIS](https://www.electron.build/v26/docs/nsis/)、[应用内容与额外资源](https://www.electron.build/docs/contents/)。

## 13. 官方桌面实现参考与采用决定

研究于 2026-09-30 完成，固定到官方仓库提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。以下“官方事实”来自所链接的源码；“Legion 决定”是本项目设计，不表示官方实现已适用于当前 Legion。

| 主题 | 官方事实与源码 | Legion 决定 |
| --- | --- | --- |
| 主界面与后台 | Electron 壳使用共享 Web 应用；私有 Desktop Host 调用共享 profile runner。[共享 Web 决策](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/.agents/notes/implemented/architecture/2026-09-10-desktop-web-wrapper.md) | 复用 Legion Workbench 和现有 API；壳仅拥有原生能力，Launcher 拥有多服务 |
| 后台执行器 | Electron 通过 `ELECTRON_RUN_AS_NODE=1` 运行 Host；Cordis 使用 `--expose-internals`。[Node 模式决策](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/.agents/notes/implemented/architecture/2026-09-11-desktop-electron-node-runtime.md) | 首发使用独立固定 Node，沿用 Launcher 的执行契约；若以后合并执行器，须验证 ABI、Cordis、原生模块与子进程启动 |
| 生命周期通信 | Host 用 Node IPC 发 ready/fatal/停止确认；控制查询有请求关联和截止时间。[Host 进程](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/host-process.ts) | 保留已有有界 NDJSON 桥；补请求截止时间、停止确认和进程退出证据，不让控制协议混入子进程日志 |
| 版本与核心载荷 | 构建阶段准备生产依赖、物化链接、生成描述符并验证；应用版本与 dsh 版本绑定。[载荷构建](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/scripts/prepare-dsh.ts) | 同一发行绑定精确组合；构建阶段携带 DSH 生产载荷，首次本地初始化；Legion 与 DSH 保持各自版本号 |
| 页面与凭证 | 本地协议交付静态页，主进程交换 Host cookie 并转发请求，过滤响应凭证。[Web document](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/web-document.ts) | 首发保持 Workbench HTTP origin；由窗口专属 session 注入 token，页面不获得 token；后续协议迁移另设门禁 |
| 单实例与隔离 | profile 操作前取得单实例锁；桌面可执行依赖和普通 CLI 分开。[单实例代码](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/single-instance.ts)、[桌面说明](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/README.md) | Electron 锁保护壳，DataDir 锁保护写入与服务；使用产品专属 home/profile，不共享官方桌面的可执行依赖 |
| 退出与升级 | 退出检查活动和计划任务，检查超时视为未知；升级停止要求优雅完成确认。[退出决策](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/quit-confirmation.ts)、[Host 停止实现](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/host-process.ts) | 增加任务感知退出与升级暂停；延续 `product/upgrade/` 单一升级所有者，不另启官方 updater |
| 恢复与诊断 | 原生恢复可在 Host 不可用时执行；报告限量保留。[恢复协调](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/fatal-recovery.ts)、[崩溃报告](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/src/crash-report.ts) | 提供独立恢复页及脱敏报告；修复可选插件时保留配置备份和任务数据，强制面失效保持阻断 |
| 目标平台资源 | Builder 选择平台载荷，原生模块和物理资源解包，并校验签名。[打包配置](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/scripts/electron-builder-config.mjs) | Windows x64 首发，后台全部用实际文件；闭包验证后做安装目录 smoke 和干净机器验收 |

### 13.1 对当前开发的调整

已完成的桌面壳和控制桥继续使用。接口鉴权先完成，再做向导；生产载荷构建前移到向导验收前，向导默认走本地初始化。新增请求截止时间、取消、停止确认、在途任务检查、脱敏崩溃报告及载荷损坏恢复验收。开发态可测试 npm 路线，但不能用其成功结果替代正式包验收。

### 13.2 上游复用边界

优先按机制复用，并以固定提交核对后续上游变化。若引入官方代码，逐文件记录来源、MIT 版权与修改，随包保留所需许可及第三方通知。官方 UI 资源、产品名称、账户入口和更新发布凭证不因开源代码引用而成为 Legion 资源；本产品保持自己的标识、配置与发行渠道。首发不复制官方账户系统、Office/Python 载荷或浏览器 guest 功能，后续按 Legion 实际需求和依赖闭包单独设计。
