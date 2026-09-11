# PRT-258 产品层契约（第一批：目录布局 / 配置优先级 / 进程清单）

**对应**：`PRT-258`（部分）
**实现**：`product/paths.mjs`、`product/process-manifest.mjs`、`product/index.mjs`、`product/index.d.mts`
**用例**：`product/paths.test.mjs`（18 例）、`product/process-manifest.test.mjs`（11 例），CI 套件 `product-runtime`
**上游输入**：`PRT-003-config-secret-inventory.md`（4 处目录越界）、`PRT-011-dsh-distribution-decision.md`（路线 C）、`PRT-010-dsh-composition-baseline.md`

> PRT-258 要求冻结四份契约：进程清单、per-user 目录布局、配置 Schema、Secret Store 接口。
> 本批次交付**前三份**；Secret Store 接口随 `PRT-254/PRT-505` 落地（理由见 §5）。
> 这是有意拆开的，不是遗漏——把四份契约塞进一次提交会让每一份都缺少针对性用例。

---

## 1. 为什么这批不是「几个 join 调用」

阶段 2.5 的完成标准是「不依赖终端和 DSH 配置知识，设计伙伴可以安装产品、配置 BYOK、
启动一个受限数字员工并查看结果」。这条标准的前提是**进程怎么起、数据放哪里、
配置从哪一层生效**必须是可判定的事实，而不是 Launcher 里的三类隐式约定。

三处**只会静默出错**的地方，本批次各做成了结构化判定：

| 风险 | 表现 | 本批次的判据 |
| --- | --- | --- |
| 业务数据写进安装目录 | 升级替换 InstallDir 时丢数据；平时完全正常 | `layoutDiagnostics` → `WRITABLE_DIR_INSIDE_INSTALL_DIR`（error） |
| 四类可写目录相互嵌套 | 备份/清理/升级互相破坏，且各自都"看起来在工作" | `ROLE_DIRS_OVERLAP`（error，两两判定） |
| 配置优先级由调用方传参顺序决定 | 同一份配置在不同入口得到不同结果 | `mergeConfigLayers` 按 `CONFIG_LAYERS` 排序，未知层/重复层**抛错** |

**第四条**来自启动面：进程清单里的入口**根本不存在**时，若只是跳过，
表现是「任务一直没人做」而不是一条错误。因此 `MANIFEST_KNOWN_GAPS` 把当前
两处缺口写成机器可读的事实，并由用例与「对真实仓库跑出来的结果」对账：

```
ENTRY_MISSING:orchestrator     product/orchestrator/worker.mjs 尚未创建（PRT-301）
ENTRY_UNRESOLVED:runtime       runtime 入口由产品配置提供（PRT-011 路线 C），未配置即拒绝启动
```

缺口被补上时用例会**变红**，逼着清单与文档一起更新——反向漂移（文档说没有、
代码里其实有了）比漏做更难发现。

---

## 2. 冻结的目录布局（spec §6.11）

```
InstallDir/   只读程序、固定依赖和 DSH Runtime
DataDir/      team-hub 数据库、附件、审计和产品元数据
Workspace/    用户授权的项目目录
CacheDir/     构建、下载和临时缓存
LogDir/       可轮转日志
```

三条实现决定：

1. **Windows 默认产品家目录取 `%LOCALAPPDATA%\Legion`**，不是 Roaming。
   SQLite 库、日志与缓存是**本机状态**，放进 Roaming 会跟着账号漫游到别的机器上。
2. **Workspace 刻意没有默认值。** 默认出一个目录再往里写，等于替用户决定
   「哪些目录可以被数字员工读写」。未配置时是 `WORKSPACE_NOT_CONFIGURED`（error），
   由首次运行向导（PRT-707）显式取值。
3. **环境变量压过显式入参。** 入参代表「调用方已按前三层合并好的值」，
   而 spec §6.11 把「受控环境变量」排在最高优先级。反过来做会让 §6.11 在实现里
   被悄悄倒置，表现是「部署时设的环境变量不生效」，且只在那台机器上不生效。

路径判定按平台取 `path.win32` / `path.posix`，并且**两套语义都有用例**：
大小写/分隔符差异造成的假阴性只会在「另一种」语义下暴露，而开发机只有一种。

`isPathInside` 用「补上分隔符后再前缀比较」而不是 `startsWith(parent)`：
后者会把 `C:\LegionData` 判成 `C:\Legion` 的子目录，而这两个是并列目录——
混淆它们正好会让「业务数据落在安装目录内」的门禁**漏报**。

---

## 3. 冻结的配置优先级（spec §6.11）

```
内置默认值 < 产品配置 < 工作空间配置 < 用户设置 < 受控环境变量
```

`mergeConfigLayers` 的合并语义刻意写死：

- 普通对象**递归合并**；
- 数组与标量**整体替换**——按下标合并数组会静默产出「没人写过」的配置，
  而这类配置无法归因到任何一层，排障时最费时间；
- `undefined` = 该层未表态；`null` = 显式清空。

返回值带 `provenance`（点号路径 → 生效层）。没有它，「这个值到底是谁给的」
只能靠猜；有了它，诊断页可以直接回答「为什么我改了产品配置却没用」。

**写入门禁**：`assertConfigWritable` 复用 `runtime/contracts/model.mjs` 的
`findPlaintextSecrets`，命中即拒绝写入普通配置文件（spec §6.7 / §6.11）。
刻意复用而不是再写一份判据：两份判据漂移的表现是「一处说没有密钥、另一处说有」，
两边都不可信。

---

## 4. 冻结的进程清单（spec §6.10 / PRT-701 输入）

| 进程 | 类别 | 必需 | 依赖 | 端口 | 就绪判据 |
| --- | --- | --- | --- | --- | --- |
| `team-hub` | server | 是 | — | 8787 | `GET /api/config` → 200 |
| `workbench` | server | 是 | team-hub | 5173 | `GET /` → 200 |
| `runtime` | server | 是 | — | 3080 | `GET /` → 200（入口由配置提供） |
| `orchestrator` | worker | 是 | team-hub、runtime | — | 无（常驻 worker） |
| `whiteboard` | server | 否 | — | 8080 | `GET /` → 200 |

启动波次：`[team-hub, runtime, whiteboard]` → `[workbench, orchestrator]`。
同波内按清单顺序排序，保证**同一输入两次启动得到相同顺序**——
顺序本身不是功能，但顺序的不确定性会让所有日志对照失效。

`validateProcessPlan` 在 **spawn 之前**拦下六类缺陷：
端口撞车、未知依赖、依赖成环、绑非回环地址（spec §10 默认只监听 loopback）、
服务进程缺就绪判据、进程声明写入安装目录。`installRoot` 未提供时如实报
`ENTRY_NOT_VERIFIED`（warn），**不假装通过**——与 PRT-215 自检
「未生效按 incompatible 处理」是同一条口径。

### 与既有 `services-plugin/index.js` 的关系

现有实现（DSH Desktop 内）只托管 2 个进程、只做 TCP 连接探测、没有熔断、
dispose 时直接 `kill()`。本清单是它的**严格超集与替代契约**：另加 DSH Runtime
与 Orchestrator worker，并把就绪判据从「端口能连」升级为「能连 + 契约端点回应」。
端口能连只说明有东西在听，不说明是对的东西。

---

## 5. 本批次**未交付**的部分（不得当成已完成）

- **Launcher 本身**（真正 spawn、监督、退避、熔断、优雅关闭）→ `PRT-251` / `PRT-704`。
  本批次只交付「启动之前就能判定的事实」。
- **就绪判据全部是声明，未经实测**。五条 `readiness` 都标了 `verified: false`：
  清单里的 HTTP 判据（如 `GET /api/config`）尚未在真实进程上量过响应码与耗时。
  实测归 `PRT-703`，**在这一条被验证前，Launcher 不得把「HTTP 200」当作已证实的就绪标准**。
- **`product/` 尚未纳入 `scripts/config/scan.mjs` 的进程扫描范围**。
  本批次的模块**不读任何 `process.env`**（env 由调用方显式传入），因此当前没有
  未声明读取点。Launcher 落地时必须同时注册 `product` 进程与它的 config-schema，
  否则新读取点会绕过 §6.11 的声明门禁。
- **Port 冲突检测只是清单内自检**，不含「系统里已有进程占用该端口」的探测 → `PRT-703`。

> 第四份契约（Secret Store 接口）已在同一分支的后续提交中交付，见
> [`PRT-505-secret-store.md`](./PRT-505-secret-store.md)。

---

## 6. 复现

```powershell
cd D:\project\DSH\legion\.worktrees\prt-runtime
node --test product/paths.test.mjs product/process-manifest.test.mjs   # 29 例
node scripts/ci/dsh-boundary.mjs --check                                # product/ 对 DSH 依赖为 0
node scripts/config/scan.mjs --check                                    # 配置声明门禁（本批次未新增读取点）
node scripts/ci/run-ci.mjs --only env,boundary,deps,build,test,smoke,stage,doc --out .ci/prt-258
```

`product/` 在 `scripts/ci/dsh-boundary.mjs` 里属于 `mustBeZeroPrefixes`：
本批次的四个文件对执行面依赖为 **0 处**，基线仍是 3 文件 / 26 处。
