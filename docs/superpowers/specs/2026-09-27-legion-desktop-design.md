# Legion 独立桌面应用设计

> 日期：2026-09-27
> 状态：待评审
> 范围：Windows x64、当前用户安装的 Legion 桌面入口、服务生命周期与安装发行
> 依赖设计：[Legion Product Runtime 产品化架构设计](2026-09-11-legion-product-runtime-design.md)

## 1. 摘要与目标

Legion 桌面版是一个以 Workbench 为主界面的本地应用。用户安装后双击 Legion，桌面壳显示启动进度，后台由 Product Launcher 拉起 team-hub、Workbench、受控 DSH Runtime 和 Legion Orchestrator；就绪后在应用窗口中打开 Workbench。退出 Legion 时停止自动认领并回收本次启动的服务。用户无需打开终端、安装 Node 或配置 DSH/Cordis。

首发沿用已裁决的 DSH 分发路线 C：首次运行联网获取产品版本清单指定的 `@deepseek-ai/dsh` 精确版本，安装到 Legion 的 DataDir，之后使用已验证的本地版本。**本设计新增的分发决定是安装包自带固定版本的 Node/npm**，供 Launcher 和各服务在没有开发环境的客户机器上运行；DSH 本体仍不随初始安装包分发。此决定需要同步修订 [PRT-011 分发决策](../prt/PRT-011-dsh-distribution-decision.md)中“不内置 Node”的一项，不改变其“首次联网安装 DSH”的主路线。

目标是完成以下用户路径：

1. 在没有 Legion、DSH、Node、pnpm 或源码检出的干净 Windows x64 用户环境中安装 Legion。
2. 双击桌面或开始菜单图标，观察到真实的准备、启动与失败状态。
3. 首次运行完成 DSH 安装、模型密钥配置和执行能力验证。
4. 在 Legion 窗口中发布目标、查看任务；受控执行引擎和 Orchestrator 可自动协作。
5. 关闭窗口、从托盘重新打开、彻底退出及再次启动，均保持明确的进程归属和任务状态。
6. 安全升级、失败恢复和卸载不损坏业务数据与用户工作空间。

首发不交付 macOS/Linux、局域网共享、多用户 Windows Service、离线首次安装、独立的 DSH 桌面界面或第三方桌面插件市场。首次安装 DSH 需要网络；模型调用是否需要网络取决于用户选择的模型提供方。

## 2. 现状与设计约束

| 现有资产 | 可直接复用的职责 | 桌面版新增工作 |
| --- | --- | --- |
| `product/process-manifest.mjs` | 五进程清单、依赖和就绪契约 | 固定桌面发行所需的进程集合与资源闭包检查 |
| `product/launcher/` | 单实例数据锁、启动监督、就绪检查、退出、运行时安装、向导、日志与诊断 | 向桌面壳提供长期运行的控制与进度协议 |
| `product/paths.mjs` | InstallDir、DataDir、CacheDir、LogDir、Workspace 分离 | 把安装位置和可写位置落实到安装器 |
| `product/upgrade/` | 版本清单、签名/哈希、备份、迁移与回滚判定 | 接入真实安装产物、健康探针和系统级切换动作 |
| `services-plugin/` | 开发态随 DSH Desktop 启停 team-hub 和 Workbench | 独立桌面版禁止与 Launcher 同时托管相同服务 |
| `workbench/`、`team-hub/` | 用户界面、数据与 API | 桌面模式的本地鉴权和来源约束 |

当前仓库没有独立 Electron 应用或 Windows 安装器配置。`PRT-803` 的签名与文件校验实现不能替代真实安装包、开始菜单入口及干净机器验收。本设计只补桌面交付层；不重新设计任务状态机、Runtime Contract、权限策略和数据库模型。

参考项目 [DSH Desktop](https://github.com/anywhere-labs/dsh-desktop) 提供单实例、原生窗口、托盘、启动/停止、发行检查的实现思路。其 Electron 主进程直接装载 DSH Host，而 Legion 已有独立 Product Launcher 与进程边界，因此不复制其 Host 启动路径或用户界面。

## 3. 路线比较与决策

| 路线 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- |
| 继续使用 DSH Desktop + Legion 插件 | 最快复用现有开发部署 | 产品名称、安装、主窗口和生命周期仍由 DSH Desktop 决定；Legion 发行不可独立验收 | 保留为开发与过渡路径 |
| Fork DSH Desktop | 可复用窗口与安装器代码 | 将 DSH Host 生命周期与 Legion 产品演进绑定，维护上游同步及品牌分叉 | 不作为首发路线 |
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
| 桌面壳 → bridge | `prepare-runtime` | 复用现有运行时安装器；仅在清单校验通过后执行 |
| 桌面壳 → bridge | `wizard.submit` | 向导当前步骤的结构化输入；密钥只经该私有通道传递，不进 argv/URL/日志 |
| bridge → 桌面壳 | `progress`、`needs-input` | 阶段、具名错误码、可执行的下一步 |
| bridge → 桌面壳 | `ready`、`degraded`、`failed`、`stopped` | 已验证状态；`ready` 附 Workbench 本机地址与本次启动标识 |

bridge → 桌面壳的状态与进度消息不得包含模型密钥、team-hub token、DSH Runtime token 或完整环境变量。桌面壳 → bridge 的 `start` 握手和 `wizard.submit` 是仅有的涉密消息，分别传递本次工作台凭证和用户输入的模型密钥；两者只走私有标准输入、不进入 argv、URL、输出事件或日志。桌面壳以一个请求 `id` 对应一份结果，bridge 在被异常终止时由主进程记录失败并展示恢复入口；不能悄悄再起第二个 Launcher。CLI 模式仍保留现有命令行入口和托盘实现；桌面模式由 Electron 独占物理托盘，bridge 不挂 PowerShell 托盘。

### 4.2 窗口与页面

启动页和向导属于桌面壳，使用随安装包分发的页面。Workbench 仅在 `/hub/api/config` 身份及就绪判据通过后加载；不能依据计划端口直接加载。首次运行向导复用现有 `environment → initialize → start → configure-model → verify → heartbeat-consent → done` 状态机，但需要在桌面页呈现真实进度、错误和断点续跑。

Workbench 是唯一主工作窗口。DSH Web UI 不自动打开。默认关闭窗口后在托盘继续运行；托盘“退出 Legion”才停止受管进程。托盘至少提供“打开 Legion”“运行状态”“重新启动服务”“退出 Legion”。用户可在设置中改为关闭窗口即退出，该偏好保存在产品用户设置中。

## 5. 启动状态机与进程归属

### 5.1 首次启动

```text
双击 Legion
→ Electron 单实例锁；已有窗口则聚焦
→ 加载本地启动页
→ 启动 desktop bridge，校验产品清单和目录
→ 检查 Node/npm、DSH 当前指针、组合补丁与端口
→ 首次缺 DSH 时联网下载精确版本并校验、原子切换
→ 初始化产品目录并进入模型配置向导
→ Launcher 取得 DataDir 独占锁
→ 按进程清单启动并验证 team-hub、Workbench、DSH Runtime
→ 强制面/Runtime Contract 验证通过后启动 Orchestrator
→ 加载 Workbench；向导执行模型可用性验证
```

`spawn` 成功、TCP 可连和真实就绪是三种不同状态。team-hub 必须验证 `/api/config` 的产品/端口身份；Workbench 必须验证 `/hub/api/config` 确实代理到本次 team-hub；DSH 使用现有 Runtime 就绪发布和本次 PID/端口核对。Orchestrator 必须在 Runtime 凭证、强制面与执行契约通过后才开始认领。

### 5.2 失败与恢复

| 情况 | 用户看到的状态 | 系统动作 |
| --- | --- | --- |
| 首次下载中断或校验失败 | 执行引擎未安装；可重试，显示日志摘要 | 保留旧的有效运行时指针；不启动自动执行 |
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

首发构建 Windows x64 当前用户安装包，使用 Electron Builder 生成应用目录，再由受控的 NSIS 流程制作安装程序。安装内容限定为：

- Electron 主进程、启动/向导页面、图标与托盘资源；
- 固定版本 Node/npm，含许可证和哈希清单；
- Legion 的生产代码、产品清单、DSH 组合补丁、运行时契约文件；
- 已构建的 `workbench/dist`、team-hub 与 Orchestrator 必要依赖；
- 第三方许可证清单、SBOM、诊断与恢复入口。

构建在未打包目录及真实安装目录分别执行运行时闭包检查：不得缺模块、引用开发机绝对路径、把 junction/symlink 指向源码检出，或把 `node_modules` 中运行所需的物理文件留在不可执行的虚拟归档内。安装包必须能在路径含空格的非管理员账户下启动。初始安装包不含 DSH 本体；首次下载界面明确显示网络需求和失败重试。

### 6.2 持久化位置

```text
%LOCALAPPDATA%\Programs\Legion\       只读应用和随包 Node；升级时替换
%LOCALAPPDATA%\Legion\data\           team-hub 数据、附件、产品配置、受控 DSH 版本
%LOCALAPPDATA%\Legion\cache\          下载与构建缓存
%LOCALAPPDATA%\Legion\log\            可轮转日志
%LOCALAPPDATA%\Legion\secrets\        受保护密钥材料，与普通 DataDir 分开
<用户明确选择的目录>                  工作空间和 Git 项目
```

具体路径以 `product/paths.mjs` 和 Windows 安装器解析出的绝对目录为准，不在代码中写死 `%LOCALAPPDATA%` 字符串。安装目录及应用资源只读；升级和卸载不能把数据库、密钥、审计、附件或用户工作空间当作程序文件清理。受控 DSH 使用产品专属 home/profile，不默认修改用户已有的 `~/.dsh` 或正在运行的 DSH Desktop。导入旧配置与数据只在用户明确选择并完成备份后执行。

### 6.3 版本绑定

扩展现有 `product/release/runtime-manifest.json` 的生成与校验规则，记录桌面壳、随包 Node、Legion 和 DSH 精确版本及平台载荷哈希。`dshVersion` 与 `dshCompositionPatchVersion` 成对验证；不能从兼容区间临时挑选未经回归的新版。内部版本可继续使用当前受控 DSH 候选版本；对外 stable 前必须完成相应许可证、依赖与真实项目门禁。

## 7. 本机接口安全

默认只监听 `127.0.0.1`。Electron 工作窗口关闭 Node 集成，启用上下文隔离与渲染进程沙箱；只允许导航到本次 Workbench origin。外部链接交给系统浏览器打开前必须校验协议与目标；不向 Workbench 暴露原始 Electron、文件系统或进程接口。启动页与 Workbench 的桌面桥接命令只提供实际需要的少量动作，并核对 IPC 发送者。

**桌面模式必须使用非空鉴权。**当前 Workbench 的写 token 未配置时允许部分写请求，读请求也可访问；这不满足独立桌面发行的边界。Electron 主进程在每次启动时生成工作台凭证，经 `start` 握手交给 bridge，再按最小范围注入 Workbench；bridge 独立生成 team-hub 凭证，只交给确需使用它的服务。Electron 主进程只向精确匹配的 Workbench origin 添加工作台凭证，渲染页面拿不到凭证值；Workbench 桌面模式对敏感读写 API 及代理入口校验凭证、`Host` 和 `Origin`，拒绝跨站请求及 DNS rebinding 形式的非预期 Host。team-hub 凭证只在 bridge、team-hub、Workbench 代理和确需访问它的 worker 之间传递；现有 DSH Runtime Contract 的短期 token 保持独立。所有凭证不得进入 URL、启动参数、日志、诊断包或产品数据库正文。

这一节是桌面发行的前置开发项，不依赖“只监听本机”来替代鉴权。普通浏览器访问 Workbench 如果要保留，应是明确启用的另一种模式，并拥有独立的登录/凭证交付流程。

## 8. 升级、回滚与卸载

桌面更新由 Legion 的 `product/upgrade/` 流程**唯一拥有**；Electron Builder/NSIS 负责制造和安装产物，不再启用第二套自动更新器。发行物使用可验证的完整性清单和签名。正式发布还要对 Windows 可执行文件及安装器做代码签名。

升级顺序沿用现有产品规格：预检产品/DSH/补丁组合与磁盘空间 → 停止新任务认领 → 等待或安全中断在途 Run → 备份数据库及配置 → 校验下载产物 → 停止服务并确认进程树退出 → 将新版本置于同卷版本目录 → 原子切换活动版本指针 → 执行已登记的迁移 → 运行真实 team-hub、Workbench、DSH 与强制面健康检查 → 提交升级。健康检查失败时，按迁移类型判断能否回滚程序；已发生不可逆或状态未知的数据写入时必须进入“需要向前修复/恢复备份”状态，不能仅替换旧二进制。

NSIS 初始安装和升级调度的职责必须分清：快捷方式指向稳定的启动入口，活动版本由单一指针解析；安装器不能在仍有服务持有文件句柄时覆盖现役目录。`product/upgrade/` 目前有部分签名、迁移和判定原语，但真实 Windows 文件释放、默认健康探针、系统级原子切换以及 UI 通知仍需接线和真机验证。

卸载默认只删程序，保留 DataDir、密钥和工作空间；“彻底删除 Legion 数据”是另一个明确的用户动作，并在执行前列出实际目标目录。绝不自动删除用户工作空间。

## 9. 开发切片与交付门禁

| 切片 | 交付物 | 完成门槛 |
| --- | --- | --- |
| D1 桌面壳 | `desktop/`、单实例窗口、启动页、托盘、导航限制 | 开发机重复双击只唤醒一个窗口；关闭/退出行为可观察 |
| D2 生命周期桥 | 版本化控制协议、Launcher 适配、真实进度与失败事件 | Electron 不直接拉起四服务；CLI 与桌面模式共用一套 Launcher 判据 |
| D3 首次运行 | 随包 Node/npm、DSH 首次安装接线、向导 UI、模型验证 | 无开发依赖的干净 Windows 用户可完成首次启动；断网失败可重试 |
| D4 接口防护 | Workbench 桌面模式鉴权、来源校验、凭证传递与脱敏 | 未带凭证的敏感请求被拒绝；页面与诊断包不含凭证 |
| D5 安装与升级 | NSIS、闭包校验、签名、真实健康探针、版本切换 | 安装、重启、升级失败恢复和卸载在真实 Windows VM 上通过 |
| D6 发布验证 | 黄金任务、故障注入、SBOM/许可证、发布清单 | 满足本文件 §10 的完整验收；外部真实项目验证独立记录 |

每个切片完成后先验证其新增边界；发行门禁再跑现有仓库级 CI 与真实安装包端到端。切片 D1–D3 可先使用 internal 通道；不能仅凭本机源码运行通过就晋级 canary 或 stable。

## 10. 验收矩阵

在全新 Windows x64 虚拟机的普通用户账户中执行；机器上没有 Node、pnpm、DSH、Legion 源码及开发环境变量。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 单安装包首次启动 | 从桌面图标进入 Legion 启动页；DSH 下载、配置和验证均有真实进度；无需终端 |
| 重复双击与端口占用 | 只保留一个产品实例；未知端口占用具名失败，不接管别人的服务 |
| 工作台就绪 | 窗口加载后 `/hub/api/config` 指向本次 team-hub；任务/空间数据可读写 |
| 执行闭环 | 配置模型、绑定工作空间、发布真实低风险目标、完成至少一次员工执行与交接，结果和审计可追溯 |
| 关闭、退出、重开 | 关闭窗口按设置保持托盘或退出；托盘退出后受管进程消失；再次启动恢复数据与任务状态 |
| 网络中断与 DSH 崩溃 | 首次安装可重试；运行时故障不产生任务伪成功、重复外部写或无声派工 |
| 安全 | 非预期 Host/Origin、无凭证的敏感 API、未经授权的高风险工具调用均被拒绝 |
| 升级与恢复 | 损坏包、数据库迁移失败、健康检查失败及 Windows 文件占用都有可验证的安全落点 |
| 卸载重装 | 默认保留数据并可重装读回；工作空间始终不受卸载影响 |

证据应包含安装包哈希与签名结果、安装目录清单、关键状态日志、进程树、就绪探针结果、任务/审计记录和升级恢复记录。测试替身可用于协议与错误分支，但“无需开发环境即可运行”只能由真实安装包在干净机器上证明。

## 11. 风险与待同步事项

1. **Node 分发决策差异**：PRT-011 排除了内置 Node；本设计为桌面一键使用选择内置固定版本 Node/npm。实施前更新该决策及产品版本清单，记录额外包体和 Node 安全更新责任。
2. **Legion 插件发行**：现有 `file:` 依赖及开发机 junction 不能出现在客户安装包。构建需把 Legion 自有包与补丁层变成可校验的实际文件，并在隔离 DSH profile 中验证加载。
3. **既有服务鉴权不足**：Workbench 读面及未配置 token 的写面需要桌面模式收紧；这可能影响用浏览器访问本机 Workbench 的现有开发流程，因此用显式模式隔离行为。
4. **升级原语与产品闭环有差距**：进度表中的部分“完成”是判定器或测试原语，真实安装器、默认健康探针、进程释放和用户通知仍是桌面发行范围。
5. **既有守护与新 Orchestrator 冲突**：独立桌面版使用产品专属 DSH home/profile，不自动启用旧 `dsh-scrum-worker` 或 `services-plugin`；迁移旧环境时先备份并核对唯一调度器。
6. **首次联网依赖**：安装包可离线运行启动页，但首次 DSH 安装不承诺离线；产品必须在下载失败时保留清晰且可恢复的状态。

## 12. 参考依据

- 本仓库：[Product Runtime 产品化架构](2026-09-11-legion-product-runtime-design.md)、[PRT-011 DSH 分发决策](../prt/PRT-011-dsh-distribution-decision.md)、`product/process-manifest.mjs`、`product/launcher/`、`product/paths.mjs`、`product/upgrade/`。
- 参考实现：[DSH Desktop 项目](https://github.com/anywhere-labs/dsh-desktop)、[桌面包架构](https://github.com/anywhere-labs/dsh-desktop/blob/master/dsh-plugin-desktop/README.md)。
- 平台约束：[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[Electron Builder NSIS](https://www.electron.build/v26/docs/nsis/)、[应用内容与额外资源](https://www.electron.build/docs/contents/)。
