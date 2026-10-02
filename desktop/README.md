# Legion 桌面端

Windows x64 桌面入口，负责启动现有的 Legion Product Launcher。Electron 管理窗口和系统托盘；`product/launcher/desktop-bridge.mjs` 负责连接 Launcher 并管理所有服务。

## 源码模式运行

在源码检出目录中，进入 `desktop/` 安装依赖并运行 `npm start`。`PATH` 中必须有本机 Node 可执行文件，也可以将 `LEGION_DESKTOP_NODE` 设为该文件的绝对路径。正式安装器会附带固定版本的 Node 和 Legion 运行时目录。

此开发入口属于内部集成构建。桌面模式需要每次启动时生成的私有 Workbench 和 Hub 凭据；Electron 只会将 Workbench 凭据注入到所属窗口的已验证本地来源。浏览器开发模式与桌面模式相互独立。首次设置和独立安装器的工作仍按[实施计划](../docs/superpowers/plans/2026-09-29-legion-desktop.md)跟踪。

## 打包与服务准备

桌面载荷构建器和可取消的本地导入器已经实现。运行时准备和服务监督共用一份由 Launcher 管理的 DataDir 租约。x64 安装器包含固定版本的 Node/npm、MinGit、锁定的 DSH 生产依赖树和 Legion 运行时模块；首次启动会从已安装资源验证并导入 DSH，不需要 npm 或网络。桌面运行时使用自己的 DSH home，不会加载或依赖操作者的 DSH Web/桌面应用或 profile。

启动页可选择工作区，并填写 actor/scope/action 和明确的读写范围。只有所属主框架才能调用系统目录选择器；确认时使用主进程持有的工作区路径。初始化与非密钥设置持久化共用产品所有者的 DataDir 租约。操作者策略保存在优先级最高的 Legion 设置层，高于项目配置。模型设置页使用密码输入框输入 API 密钥，先通过 `/v1/models` 验证固定的 DeepSeek profile，然后只将密钥保存到 Windows DPAPI 保护存储。启动前会再次验证模型回执。Runtime Contract 就绪且范围化审批通道可用之前，自动任务调度保持关闭。

## 构建 Windows 内部版本

请使用 Windows x64 构建机。在 `desktop/` 中依次运行 `npm ci`、`npm run prepare:node`、`npm run prepare:payload` 和 `npm run prepare:git`。Node/Git 归档具有固定 SHA-256 输入；DSH 使用生产锁文件和精确家族版本覆盖。使用已提交的 pnpm 锁文件构建 Workbench，再运行 `npm run stage`、`npm run verify:closure`，最后运行 `npm run pack` 或 `npm run dist`。

生成的 `desktop-release.json` 会记录 Node/npm、Git、DSH 和 Legion 的物理资源。只有 Electron 窗口代码放在 ASAR 中。Windows x64 暂存会在生成清单前移除 node-pty 中仅供 ARM64 使用的二进制，以匹配目标平台和 NSIS 输出。本机已通过安装后首次导入 DSH 和启动 Legion 服务的检查；范围化 Runtime 审批通道、Runtime Contract 就绪、任务执行、升级/恢复和干净虚拟机发行验收仍未完成。内部安装器通过测试不等于已签名的稳定发行版。详见[实施计划](../docs/superpowers/plans/2026-09-29-legion-desktop.md)和[设计方案](../docs/superpowers/specs/2026-09-27-legion-desktop-design.md)。

构建 `dist` 时还会通过官方发行资源 API 准备带固定哈希的 NSIS 资源归档。安装过程中不会从网络下载构建脚本。安装器按当前用户安装，卸载时保留产品数据。当前内部产物未签名，使用 Electron 默认应用图标；实际测试结果和未完成门槛见[验收记录](../docs/release/legion-desktop-acceptance.md)。

打包后的后台使用受管理的 `legion-desktop` DSH profile，并在启动时加载补丁。它不依赖另行打开的 Harness Web 或桌面应用。Node 和 Git 由 Legion 私有管理；当前用户作用域的 DPAPI 使用 Windows 自带 PowerShell。核心应用包不包含任意项目所需的编程语言工具链。
