# Legion Desktop 内部构建验收记录

更新日期：2026-10-01。工作分支：`codex/legion-desktop`。此记录区分已完成的验证和仍开放的交付门槛。

## 当前判断

**桌面端尚未完成全部交付流程。** 已实现桌面外壳、本地鉴权、退出确认、随包依赖构建、离线运行时导入、内部 NSIS 构建，以及应用目录的打包和独立资源验证。首次设置界面、带实际授权的完整执行、升级恢复和干净 Windows 安装验收仍开放。

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
| 后台资源清单 | 约 28,275 个文件、436 MB；每次构建重新生成真实大小及哈希 |
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

首次导入实测约 **307 秒**，包含完整文件校验、复制和再次校验。已据此扩展准备/启动的有界等待时间，并增加校验、复制进度；文件枚举与哈希并发优化后需重新记录实际耗时。此测试验证本地导入，不代表模型或任务执行已就绪。

独立服务测试首先暴露固定 DSH 版本的 live patch watcher 在打印 URL 后仍可能因 HMR 尚未装配而退出。现在使用产品私有 `legion-desktop` profile，固定 base/web bundles 和 `patchReload=startup`，设置通过受控重启应用；保持 `--expose-internals` 位于 Node 脚本之前。桌面始终解析已验证的随包运行时指针，忽略配置中另一条宿主 Runtime 命令。

首次安装烟测在约 240 秒等待上限处中断，程序资源仍在解包，未完成安装登记和卸载器生成。这个结果是**未通过**；测试目录已保留用于核对，不能把已出现的 Legion.exe 当作安装成功。后续安装烟测需避开并行压缩并使用有界的更长等待，确认安装器退出、真实应用启动和卸载器收尾。

本轮聚焦桌面回归 **35/35 PASS**；运行时解析、导入及所有权回归 **30/30 PASS**。生产资源闭包仍为 265 个模块，通过实际 Windows DPAPI、ConPTY、Koffi 和 Sharp 验证。

## 开放门槛

- 首次设置界面：工作区、明确执行身份及范围、模型配置、真实验证、恢复与继续设置。
- Runtime 的审批传输：独立短期授权通道，绑定 Run/attempt/调用范围；不能传入 hub 管理凭证。
- Orchestrator：在配置、契约和用户授权完成前暂停认领；任务感知的退出与升级。
- 完整后台启动、一个真实模型任务、人工审批与匹配工具执行的证据。
- 内部 NSIS 安装包的安装、开始菜单/桌面快捷方式及卸载验证。
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
