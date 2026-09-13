# PRT-255 隔离测试空间验证（安装 / 运行 / 取消 / 重启 / 诊断）

**spec 出处**：§8 第 857 行 ——「在隔离测试空间完成安装、运行、取消、重启和诊断验证。」
**新增交付**：`product/launcher/isolated-space.test.mjs`（套件 `isolated-space`，10 例）

---

## 1. 这一套与既有 launcher 套件的分工

`launcher.test.mjs` 直接驱动**库**（`createLauncher()`）；`cli.test.mjs` 覆盖参数、
退出码与 `--init`。两者都不能回答 PRT-255 真正问的那个问题：

> **一个新用户，只用文档上的那几个开关，能不能把产品装起来并且跑起来？**

> 一个「所有模块的单元测试都通过」的产品，
> 与一个「装完之后起不来」的产品，是同一个东西——
> 只不过前者在一张张绿灯清单上看起来是完整的。

所以这一套把产品**自己的入口**（`product/launcher/cli.mjs`）当**子进程**驱动，
五步各自的判据都是「**下一步骤能成立**」才算上一步真的做完了：

| 步骤 | 判据（全部是盘上/端口上/退出码上能看见的事实） |
| --- | --- |
| ① 安装 | exit 0 + `product.config.json` 与 `product.json` 真的落盘 + 用户工作区被**显式跳过**（`user-owned`）+ 重复安装幂等 |
| ② 运行 | stdout 报就绪 + **自己去连那两个端口**（只信 stdout 上的 "ready" 等于信一句声明） |
| ③ 取消 | 进程结束 + **端口真的能再绑上**（"进程没了"与"端口放开了"不是一回事） |
| ④ 重启 | **同一组端口**还能起来（上一次没收干净的话，这一步会以 `PORT_IN_USE` 失败） |
| ⑤ 诊断 | exit 0 + 包目录与清单真的落盘 + **清单说明它排除了什么** |
| ⑥ 链路 | 五步连起来走一遍，且**五步的名字都出现在记录里**（不许"某步被跳过但整体绿"） |

另有两条回归用例守着下面第 2 节的根因与"根因有没有被说出来"。

---

## 2. ★ 这一套第一次跑就抓到的真缺陷

第一次运行的结果是 **4 绿 4 红**：①安装 与 ⑤诊断 绿，②运行 / ③取消 / ④重启 / ⑥链路 全红。
原因不是产品起不来，而是**产品家目录解析不出来**：

```
resolveLayout 一直有 homeDir / appDataDir 两个入参，
而唯一的生产调用方（product/launcher/cli.mjs）从来没传过它们
  → productHome = null
  → secretsFile = null（它默认在 <productHome>/secrets/ 下）
  → 每次启动都被 SECRETS_PLACEMENT_INVALID 拒绝
```

**实测形态**：用文档上的那几个开关（`--install-dir` / `--data-dir` / `--workspace`）
装完之后，`--init` 成功、诊断包导得出，**而产品根本起不来**：

> 一个「装得上、也导得出诊断包」的产品，
> 与一个「装完起不来」的产品，是同一个东西——
> 只不过前者在"安装成功"这个返回值上是完全正确的。

### 2.1 第二处缺陷：没有人说得出根因

当时**没有任何一条诊断**提到家目录。`layout.productHomeSource` 被记成
`'unresolved'`，但 `layoutDiagnostics` 从不把它变成一条诊断。用户看到的唯一线索是：

```
SECRETS_PLACEMENT_INVALID：密钥库位置不合法：布局里没有密钥库路径：
请先解析产品目录布局（resolveLayout）再打开密钥库。
```

而布局**是**解析过的，只是家目录没定下来；何况"请你先调用 `resolveLayout`"
这句是给库的调用方看的，**命令行用户根本无从照做**。

> 一个把「我不知道该把产品家目录放在哪」说成「你没有解析布局」的提示，
> 与一个什么都没说的提示，在用户能不能自己修好这件事上是同一个东西——
> 只不过前者读起来像是一条有用的错误。

### 2.2 两处修法

| 缺陷 | 修法 | 文件 |
| --- | --- | --- |
| 家目录恒为 null | 新增 `osHomeFacts()`，从 `LOCALAPPDATA` / `USERPROFILE` / `HOME` 推出家目录事实并传给 `resolveLayout` | `product/launcher/cli.mjs` |
| 根因无人可说 | 新增 `PRODUCT_HOME_UNRESOLVED`（`error` 级，点名后果是"任何一次启动都会被拒绝"）。显式 `LEGION_HOME` 仍然压过操作系统事实（spec §6.11 的优先级不许倒置） | `product/paths.mjs`、`product/config-schema.mjs`（`foreignEnv` 登记三个 OS 变量 + 诊断码） |

两条回归用例分别钉住"根因"与"根因有没有被说出来"，包括反向控制
（给了家目录之后**不得**再报、`LEGION_HOME` 必须压过 OS 事实）。

---

## 3. 探针过程中我自己踩到的两个坑（如实记录）

### 3.1 被中断的破坏性验证会留下改过的源码

第一次跑探针时被外层 600s 上限杀掉，**杀掉时补丁还打在源码上**——
`listening()` 里残留了一行 `return Promise.resolve(false)`。
因为下一次运行的"基线快照"是在残留状态下拍的，它还报告"全部还原 = true"。

**处置**：探针脚本现在①每次 `spawnSync` 自带硬超时（远小于外层上限）；
②正文结束无条件 `restore()`；③注册 `exit`/`SIGINT`/`SIGTERM` 还原；
④收尾**逐字节复核**并把残留打印出来。

### 3.2 `exitCode === null` 不等于"进程还在跑"

被信号打死的进程 `child.exitCode` 是 `null`（信号在 `signalCode` 上）。
于是收尾钩子里 `if (child.exitCode === null) await cancel()` 会对一个
**已经结束**的进程再调一次 `cancel()`，注册一个**永远不会再触发**的 `close`
监听，把用例挂死在测试超时上（实测 ③ 卡到 45 秒）。

**处置**：`startStack` 自己记 `closed` 并暴露 `isRunning()`；
`cancel()` 对已结束的进程**立刻返回**记下的结果。

> 一个"看起来还在跑"的进程状态，与一个"已经结束"的进程状态，
> 在收尾代码眼里是同一个东西——只不过它会让收尾**永远等下去**。

---

## 4. ⚠️ 诚实边界

1. **隔离的是用户数据，不是程序。** DataDir / 配置 / 缓存 / 日志全在临时目录里，
   但**程序树就是本仓库**——因为进程入口（`team-hub/server.mjs` 等）按安装目录解析。
   这与真实产品一致（安装目录是程序，数据目录是用户的数据），但它**不是**一个
   "连程序也复制一份"的沙箱。
2. **本平台无法真的送控制台 Ctrl+C。** `child.kill('SIGTERM')` 在 Windows 上是
   **无条件终止**（Node 无法模拟 POSIX 信号），所以 CLI 里"收到信号 → `launcher.stop()`
   → 优雅收尾"那段代码**在这条路径上跑不到**。
   优雅停止的内部行为由 `supervisor.test.mjs` / `launcher.test.mjs` 在进程内验证；
   本套件验证的是**取消对用户的可观测后果**（进程结束、端口放开、同一组端口能再起来）
   ——后者才是决定他能不能接着用的那件事。
3. **只覆盖 team-hub + workbench 两个进程。** `runtime` 与 `orchestrator` 的入口
   在本仓库里不存在（`ENTRY_MISSING`），白板未纳入；因此"受限范围"的产品状态
   **永远不会是 ready**，本套件也不断言整体 `ready`。
4. **用例真起进程**，在 CI 里约占 10 秒并占用两个临时端口。
5. **没有覆盖**：真实安装包（无安装器）、跨机器升级、Windows Defender 干扰、
   `--runtime-command` 走的 DSH Runtime 路线（没有可用的 runtime 命令）。
6. **`--diagnostics` 那两条只验证"包落盘且有清单"**，不验证包内每一份文件的
   脱敏质量——那由 `product/diagnostics/redact-package.test.mjs` 负责。
