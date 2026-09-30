# Legion Desktop 内部构建验收记录

更新日期：2026-10-01。工作分支：`codex/legion-desktop`。此记录区分已完成的验证和仍开放的交付门槛。

## 当前判断

**桌面端核心安装与自启动链路已通过本机真实安装验收；整体产品仍未到正式发行状态。** 最新 x64 安装包在无现有 Legion 安装的测试用户环境中完成安装，安装目录 28,268 项与发布清单逐项匹配；首次启动从安装包离线导入 DSH 后，DSH、Team Hub、Workbench 和白板均达到各自就绪信号，工作台打开，退出与卸载后的数据保留均通过。Orchestrator 进入 `no-executor` 安全状态，未认领任务。独立 Runtime Contract 观测、真实模型任务、人工审批传输、升级恢复、干净 VM、签名与 SBOM 仍开放。

安装后的设计是使用应用私有的 Node/npm、MinGit 和 DSH，无需用户先安装或启动宿主 DSH。项目自身的语言工具链由项目要求决定，不能从“Legion 核心依赖已随包交付”推导出任意项目的工具链均已安装。

## 发行绑定

| 组件 | 固定版本/状态 |
| --- | --- |
| Legion / 桌面包 | `0.1.0`，internal |
| Electron | `44.4.5` |
| Node | `24.19.0`，官方 Windows x64 压缩包，SHA-256 固定于 `desktop/payload/node.json` |
| DSH | `0.1.5-rc.2`；231 个 DSH 家族包固定相同版本，517 个生产依赖已安装 |
| Cordis / Schemastery | `4.0.2` / `3.18.2` |
| MinGit | `2.56.0.windows.1`，官方压缩包及固定 SHA-256 |
| 组合补丁 / Runtime Contract | `1` / `1` |
| Workbench | 已按现有 pnpm lock 构建 |
| 后台资源清单 | 28,268 个文件、423,180,361 字节；每次构建重新生成真实大小及哈希，仅包含 Windows x64 所需载荷 |
| 签名 | 当前内部构建尚未签名；不作为稳定发行 |

## 已验证

| 验证项 | 结果与边界 |
| --- | --- |
| CLI、Launcher、监督器、控制协议与桥接回归 | 118/118 PASS |
| 数据目录单实例锁 | 准备阶段与正常服务共享同一锁；并发获取被拒绝 |
| 准备取消 | 真实准备进程取消后无现役指针；暂存目录收尾；可重试 |
| 哈希、版本、平台、目录链接 | 改字节、版本伪装、平台不符、路径越界及 junction 被拒绝 |
| 本地接口鉴权 | 真实 hub/Workbench 拒绝无凭证请求；桌面私有请求成功 |
| 配置隔离 | 桌面 Runtime 强制使用产品自己的 DSH home；不加载操作者 DSH profile |
| 资源闭包 | 265 个后台模块的静态依赖已解析；修复漏打包的 `packages/shared` |
| 原生资源 | 随包 Node 实际加载 Koffi、Sharp、node-pty，并运行 ConPTY 子进程 |
| Windows 密钥保护 | 在仅含私有 Node/Git 与 Windows 系统组件的 PATH 下，用当前用户作用域 DPAPI 真实加密/解密中文测试值，未借助宿主 pwsh |
| DSH 配置读取 | 随包 Node 在临时独立 HOME / DSH_HOME 中成功读取 web 组合配置 |
| 打包后的窗口 | `app.isPackaged=true`；从真实应用目录打开本地页面；隔离的 userData 路径包含空格；正常退出 |
| 打包后的首次导入 | 从真实应用目录的 Node 和桥接入口执行，PATH 不包含宿主 Node/Git；无宿主 DSH profile；本地导入成功后停止确认与真实桥接退出成功 |
| 独立后台服务 | 在隔离测试目录中，以发行载荷的 Node 启动 team-hub、DSH Runtime、Workbench；三项就绪判据通过，3 秒后仍就绪，再停止并观察桥接退出。明确只启用三项，整体状态为 degraded；未据此放行调度或声称模型可用 |
| 内部 NSIS 构建 | 已实际生成约 225 MB、当前用户安装器，Authenticode 状态为 NotSigned；默认 Electron 图标，尚未作为完整交付提供 |
| 最新 NSIS 安装、资源完整性与卸载 | 安装到含空格的 per-user 临时目录，安装耗时 **526,759 ms**；Node、DSH、Git、Legion 共 **28,268** 项逐项哈希与清单一致；安装版实际启动/退出通过；卸载在 **4,616 ms** 完成，隔离 userData 中产品设置仍保留 |
| 首次安装后离线 DSH 与 Legion 服务启动 | 通过：首次启动从安装包导入并校验固定 DSH `0.1.5-rc.2`；DSH 的 `runtime.stdout.log` 启动 URL 中 token 确认为 `[REDACTED]`；Team Hub `8787`、Workbench `5173`、Whiteboard `8080` 均记录启动就绪；Electron 窗口导航至 Workbench；全程没有启动外部 DSH Web/Desktop。Orchestrator 报 `no-executor` 并保持 0 个任务认领，按设计 fail-closed |
| 工作区设置源码窗口 | 真实 Electron 窗口通过工作区选择、确认、产品目录初始化与设置持久化；再次启动恢复为 identity 设置步骤，尚未运行任务。测试替换了原生目录对话框的返回值，未替换 IPC、后台桥接、初始化或存储；另一窗口即使加载同一启动页也不能调用目录选择 |
| 身份和路径范围源码设置 | 真实 Electron 表单保存 operator 输入的 actor/scope/action、attended `ask` 策略和明确选择的工作区读写根。用配置加载器验证 Legion 用户设置优先于冲突的项目级配置；安全用例不含真实密钥。再次启动停留在模型设置，没有假报 Runtime 或模型 ready |

首次导入实测：最新安装版从应用启动到工作台打开约 **259,036 ms**；界面逐项显示初始化、校验和 `DSH 已准备完成`。之前测得约 307 秒；时间变化来自不同阶段/构建及宿主负载，仍需优化启动耗时。安装与 DSH 导入均使用本地载荷，无 npm 安装或首启网络下载；此 smoke 使用受保护存储中的非真实测试凭证，只验证后台启动，不代表真实模型/任务已就绪。

独立服务测试首先暴露固定 DSH 版本的 live patch watcher 在打印 URL 后仍可能因 HMR 尚未装配而退出。现在使用产品私有 `legion-desktop` profile，固定 base/web bundles 和 `patchReload=startup`，设置通过受控重启应用；保持 `--expose-internals` 位于 Node 脚本之前。桌面始终解析已验证的随包运行时指针，忽略配置中另一条宿主 Runtime 命令。

首次安装烟测在约 240 秒等待上限处中断，程序资源仍在解包，未完成安装登记和卸载器生成。这个初次结果是**未通过**；测试目录已保留用于核对。后续复测避开并行压缩并采用 900 秒上限，安装在 **543,687 ms（约 9 分钟）**真实完成；安装后应用启动、实际退出、卸载器收尾与隔离数据保留均通过。此耗时仍需优化，不能将当前宿主上的结果代替干净 VM 验收。

首次打包烟测发现两个真实问题，并已修复后重验：① 凭证覆盖层 `--patch` 被追加在 DSH Web app flags 之后，DSH 把它当 app 参数而退出；现在通过清单维护 launcher/app 参数边界，并把迟生成的覆盖层插回 launcher 参数段。② NSIS x64 安装器会省略 node-pty 包内 4 个 ARM64 专用 DLL/EXE，旧清单仍要求它们；现在 x64 staging 在计算清单前移除 ARM64 专用 node-pty 目录。回归覆盖了参数次序和平台裁剪，随后最新安装版服务 smoke 与完整资源哈希核对均通过。

最新内部安装包：`Legion-0.1.0-internal-x64-setup.exe`，**222,542,124 字节**，SHA-256 `18D52D2AB29E4F3FE9941C8A87C1ADAECEC7B10B5E802A9E4E823B87A7A76B8E`，Authenticode **NotSigned**。此包含当前工作区、执行者范围、密码式模型输入、模型验证、启动页和 DSH 日志 token 脱敏改动；服务烟测以隔离测试数据预先完成这些设置，未向真实 DeepSeek API 发请求。

安装 smoke 首次发现日志中残留 DSH 启动 URL token。sink 现在对完整行做 URL query token 日志专用脱敏，保留启动器内存中的原始输出供 readiness 判定；覆盖拆分 chunk 的单测通过。第一次重打包误用了旧暂存目录，安装态断言正确失败；重新运行 stage 后构建并真实安装复验通过，安装日志只保存 `[REDACTED]`，卸载及用户数据保留也通过。

本轮聚焦桌面回归 **12/12 PASS**；Launcher、运行时、进程清单、readiness 与日志回归 **147/147 PASS**。生产资源闭包仍为 265 个模块，通过实际 Windows DPAPI、ConPTY、Koffi 和 Sharp 验证。

新增工作区/身份设置及相关控制回归 **30/30 PASS**：真实 DataDir 锁贯穿初始化、配置保存直至停止；已有产品配置保持原样；私人 user-settings 层优先于项目配置并保存同一工作区读写表；损坏配置、额外凭据字段、相对/不存在路径、数据目录 junction 以及被替换的 workspace junction 都被拒绝。模型配置会先验证 DeepSeek `/v1/models`，成功后才写入 DPAPI 密钥库；本轮无真实 API key，未运行真实联网验证。真实窗口只到达模型设置步骤，设置页没有将服务状态伪造成 ready。密钥库写锁现在会在首次写入前创建私有父目录；密钥库、产品接线和桌面启动定向回归 **60/60 PASS**。

## 开放门槛

- 首次设置：工作区、执行者/范围/操作名称、读写范围、密码式 API Key 输入及真实 `/v1/models` 验证逻辑已接通；仍需实际 API 凭证的联网验证与各故障分支/继续设置的安装版验收。
- Runtime 的审批传输：独立短期授权通道，绑定 Run/attempt/调用范围；不能传入 hub 管理凭证。
- Orchestrator：在配置、契约和用户授权完成前暂停认领；任务感知的退出与升级。
- Runtime Contract 的独立就绪观察、一个真实模型任务、人工审批与匹配工具执行的证据。
- 开始菜单/桌面快捷方式、工作区设置新版安装包及严格当前用户安装策略验证。
- 升级/回滚、崩溃恢复、有界脱敏诊断、数据保留。
- 完整许可证/SBOM、签名和发行哈希记录。
- 干净 Windows x64 普通用户虚拟机：无 Node、Git、DSH、源码和开发环境变量，断网准备核心依赖并验证安装/卸载保留用户数据。
- 全仓配置扫描：仍有 97 项已确认的既有集成发现；产品配置扫描通过，不据此声称全仓通过。

当前宿主未发现 Windows Sandbox 或 Hyper-V。宿主上的隔离目录/受限 PATH 测试不能替代干净虚拟机验收。

## 复现入口

- 单元与服务回归：上述测试文件位于 `desktop/`、`product/launcher/` 和 `product/release/`。
- 构建流程及依赖准备：[Desktop README](../../desktop/README.md)。
- 生产清单：生成在构建目录的 `resources/desktop-release.json`。
- 详细待办：[实施计划](../superpowers/plans/2026-09-29-legion-desktop.md)。
- 架构与官方 Harness 源码对照：[方案设计](../superpowers/specs/2026-09-27-legion-desktop-design.md)。
