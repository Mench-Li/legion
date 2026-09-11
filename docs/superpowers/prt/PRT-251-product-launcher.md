# PRT-251 最小 Product Launcher

> 覆盖 spec §6.10（启动顺序）、§6.3（产品状态）、§6.11（目录布局）、§10（仅回环）、§9.4（子进程树退出），
> 以及任务 **PRT-251 / PRT-701 / PRT-702 / PRT-703 / PRT-704 / PRT-705（部分）**。
> 上游契约见 [`PRT-258-product-contracts.md`](./PRT-258-product-contracts.md)。

## 1 交付物

| 文件 | 职责 |
| --- | --- |
| `product/launcher/launcher.mjs` | 编排：启动前体检 → 按波次拉起 → 等就绪 → 状态查询 → 回滚/停止；`productStateOf` 六态映射 |
| `product/launcher/supervisor.mjs` | 子进程监督：退避（按**存活时长**重置）、熔断、优雅停止与杀进程树 |
| `product/launcher/readiness.mjs` | 就绪判据：状态码 + **身份断言**；失败分类（可重试 vs 立刻失败） |
| `product/launcher/ports.mjs` | 端口：`canBind`（能否绑）、`somethingIsListening`（谁在听）、同批重复申请 |
| `product/launcher/allowlist.mjs` | 子进程环境**白名单**（替代 `{ ...process.env }` 打底） |
| `product/launcher/cli.mjs` | 命令行入口：`--check` 体检 / 启动 / `--json`；参数错误与失败各有退出码 |
| `product/config-schema.mjs` | 产品层配置声明：读取面、注入面、子进程 env 键名 |
| `product/launcher/*.test.mjs` | 6 个测试文件、57 例（含 3 例真实进程） |

## 2 三条「最小」的边界

**① 启动前拦下所有确定性错误。** `--check` 是一条**独立且优先**的用法：端口冲突、入口缺失、
依赖成环、非回环绑定、目录越界都在 spawn 之前回答。理由是这个产品的典型故障是**起了一半**——
team-hub 好了、workbench 没起来，界面能开、数据是空的。它已经产生了副作用（占端口、建库、
留下半启动进程），而排查它比排查「完全起不来」贵得多。

**② 必需进程失败则整体回滚。** 可选组件（白板）失败只降级；必需进程失败则把已启动的停掉，
不留半启动状态（`launcher.test.mjs` 断言回滚后所有进程都是 `stopped`）。

**③ 就绪失败要区分「还早」与「错了」。**

| 探测结果 | 分类 | 行为 |
| --- | --- | --- |
| `connection-refused` / `no-response` | 可重试 | 按 `intervalMs` 继续等，直到 `timeoutMs` |
| `identity-mismatch` / `body-not-json` / `http-status-mismatch` | 立刻失败 | **只探一次**并立即熔断 |
| 进程已退出 | 立刻失败 | 不把超时等满 |

把「身份不符」当「等超时」有两个坏结果：真正的配置错误被拖成 60 秒，而超时文案把排查方向
指向「服务太慢」。真实进程用例断言这条路径 **<10s 返回**（超时设了 60s）。

## 3 两条**实测发现的**缺陷（不是推演）

这一批的两条缺陷都是**真实进程用例**发现的，不是读代码读出来的。它们保留在用例里作为回归锚点：

### 3.1 workbench 会去代理**别的** hub

`workbench/scripts/serve.mjs:2542` 的 `/hub/*` 反向代理默认指 `http://127.0.0.1:8787`。
把 team-hub 起在临时端口（51814）上之后，就绪探测报出：

```
http://127.0.0.1:51815/hub/api/config 响应来自**其他**进程：
port: 期望 51814，实际 8787——端口上监听的不是本次启动的实例
```

也就是说 workbench 去代理了默认端口上的**另一个 hub 实例**（上一次运行残留的、或别的程序）。

**没有身份断言就发现不了这件事**：`/hub/api/config` 照样返回 200，于是 Launcher 报「就绪」，
而用户看到的界面数据来自**另一个数据库**。修法是让 Launcher 派生 `DSH_HUB_UPSTREAM` 指向
本次启动的 hub（`derivedValuesFor`）——跨进程接线必须是**派生值**，不能让每个进程各自猜默认值。

### 3.2 类型问题伪装成「安全问题」

就绪期望值 `'{port}'` 最初被展开成字符串 `"51814"`，与 `/api/config` 返回的 **number** 严格比较
永远不成立。真实运行的表现为：

```
identity-mismatch：…… 期望 51814，实际 51814
```

一个类型问题被报成「端口上不是我们的服务」，排查方向被完全带偏。修法是整串占位符
**保留原类型**，只有混合字符串才拼接（`expandExpectation`）。

## 4 环境白名单：这不是洁癖

`services-plugin/index.js` 的做法是 `{ ...process.env, ...覆盖项 }`（其 config-schema 自己写着
「每个子进程都带着 `{ ...process.env }` 启动」）。后果不是理论问题：Launcher 进程里出现过的
任何凭证（别的工具 token、CI 变量）都会进入 team-hub、workbench、白板三个进程；
而白板与 workbench **不需要**模型密钥，却拿到了它。

`buildChildEnv` 只放行三类键：进程清单声明的键、平台必需键（写死在代码里，且用例断言
其中**不含**任何疑似凭证名）、Launcher 显式给定的值。写入未声明的键**抛错**（漏声明 = 清单
与实现不一致）。`secretSurfaceOf` 让「哪几个进程拿得到凭证键」成为一个可回答的问题。

白板的环境变量名是**通用名**（`PORT` / `HOST`，见 `whiteboard/.../config-schema.mjs:29-30`）——
这正是必须白名单的理由：通用名在「继承全部 env」时会轻易被外部值覆盖。

## 5 关闭 PRT-003 实测的 4 处越界写入

PRT-003 实测到 4 个 path 字段的默认值落在**安装目录内**，而安装目录在升级时被整体替换：
`TEAM_HUB_DB=team-hub/team.db`、whiteboard 的 `DB_PATH` / `WB_ROOMS_DIR` / `WB_AUDIT_DIR`。

Launcher 是唯一知道 DataDir 的地方，因此由它把这四个写路径显式指到 DataDir 下
（`DATA_PATH_ENV`）。真实进程用例断言 `data/team-hub/team.db` 存在、且**安装目录内没有**。

> 这条差距为什么一直没人发现：`team-hub/.gitignore:5` 是 `*.db`。
> 写进安装目录的库**不会出现在 `git status` 里**，也不会被任何评审看见——
> 它只是在那里，然后在升级替换安装目录时连带消失（或更糟：被当成新版本的旧数据读进去）。

## 6 顺带修掉的一处「两份清单互相矛盾」

新增 `product` 进程时暴露了一个**结构性**问题：进程 → config-schema 的映射曾经有**两份**手写副本
（`scripts/config/scan.mjs` 的 `schemaModuleFor` 与 `scripts/config/check.mjs` 的 `SCHEMA_FILES`），
只更新一份的结果是：

```
scan --check            → PASS（全部读取点与字面量已在 schema 中处理）
topology-inventory --diff → 声明缺口：product 的 8 个 LEGION_* 键未声明
```

**两份结论互相矛盾，因此两份都不可信。** 已合并为一份：`scan.mjs` 直接引用 `check.mjs` 的
`SCHEMA_FILES`，并新增一条断言「`PROCESSES` 里的每个进程都必须在 `SCHEMA_FILES` 里」。

`prt-001-003-inventory.json` 的 `defaultPaths` 也补了 `launcherOverride` 字段（**从
`product/launcher/launcher.mjs` 的 `DATA_PATH_ENV` 现算**，不另写一份）：
那 4 处越界写入的默认值仍在各进程的 config-schema 里，但**经 Launcher 启动时会被覆盖**。
不标注的话，读者会从清单得出「这件事还没做」；标注得太满又会掩盖「不经 Launcher 手跑仍然越界」。
两种情形写在同一条 note 里。

## 7 未交付（不得当成已完成）

- **首次运行初始化**（建目录、写默认配置、选工作区）→ `PRT-706`；本批次只**校验**布局。
  工作区没有默认值：它是用户授权的项目目录，不是产品自留地（`WORKSPACE_NOT_CONFIGURED` 为 error）。
- **托盘 / 日志轮转 / 磁盘保护 / 诊断包导出** → `PRT-708`~`710`。
- **`incompatible` / `upgrading` 两个产品状态**没有判据来源：它们要版本清单（`PRT-801`）才能成立，
  现在 `PRODUCT_STATE_TEXT` 里有文案但没有输入。
- **完整产品当前起不来，且这是如实上报的**：`node product/launcher/cli.mjs --check` 返回 4，报出
  - `[runtime] ENTRY_UNRESOLVED`：`runtime.command` 未配置（PRT-011 路线 C 尚未落地）；
  - `[orchestrator] ENTRY_MISSING`：`product/orchestrator/worker.mjs` 不存在（`PRT-301`）。
  `--include=` 是**显式**的受限范围用法，且受限范围的产品状态**永远不会是 `ready`**
  （`productStateOf(..., { partial: true })` → `degraded`），状态文案里始终带范围。
- **退避/熔断参数尚未进配置文件**：目前是模块默认值 + 调用方可覆盖，配置文件化的落点是 `PRT-253`/`PRT-259`。
- **`services-plugin` 未替换**：本批次交付的是**替代实现**，接线（让 Desktop/插件改用它）属 `PRT-252`。
- **白板 `WB_IN_MEMORY` 等写路径外的键已声明但未注入**：需要时就地补 `DATA_PATH_ENV`，不要紧着加白名单。

## 8 复现

```powershell
# 单元 + 真实进程（57 例；真实进程部分会临时占用两个端口，自建临时 DataDir）
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node --test product/launcher/*.test.mjs

# 启动前体检（会如实报出两个入口缺口，退出码 4）
$root = Join-Path $env:TEMP ('legion-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$env:LEGION_HOME=$root; $env:LEGION_INSTALL_DIR=(Get-Location).Path
$env:LEGION_DATA_DIR=(Join-Path $root 'data'); $env:LEGION_WORKSPACE_DIR=(Join-Path $root 'ws')
node product/launcher/cli.mjs --check

# 只拉起当前真实存在的那两个进程（受限范围；状态会如实标成 degraded）
node product/launcher/cli.mjs --include=team-hub,workbench --json

# 两个门禁
node scripts/ci/dsh-boundary.mjs --check      # product/ 属 must-be-zero
node scripts/config/scan.mjs --check          # 产品层读取面/注入面声明
```
