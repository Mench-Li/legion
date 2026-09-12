# PRT-706 产品目录与首次运行初始化 + 产品配置读取（PRT-703 配置侧、PRT-259 配置面）

状态：**已交付**。新增 `product/config.mjs`、`product/init.mjs`，套件 `product-config`（**27 例**：
`config.test.mjs` 16 + `init.test.mjs` 11，全部跑**真实文件系统**的临时目录）。
CLI 新增 `--init` / `--dry-run` / `--no-config`，并把产品配置文件接进启动路径。

---

## 1 这一批要解决的是同一类问题的两个面

产品层有两处「用户以为生效了、其实没有」的地方：

| 面 | 用户做了什么 | 产品以为 | 真实情况 |
| --- | --- | --- | --- |
| 配置 | 在 `product.config.json` 里改了端口并重启 | 配置已生效 | 文件里多了一个逗号 / 有个 BOM / 键名拼错 → 整份配置被忽略，值悄悄回到默认 |
| 初始化 | 双击启动产品 | 目录都建好了 | 从没建过；各进程各自报「打不开数据库」，或者更糟：把库建在了安装目录里 |

两处的共同点是**失败不抛异常**。因此本批次的断言几乎全在问同一句话：
**这件事有没有被报出来？**

---

## 2 配置读取（`product/config.mjs`）

### 2.1 五层优先级与「谁给了这个值」

优先级就是 spec §6.11 定的那一行，没有第二种理解：

```
内置默认值 < 产品配置 < 工作空间配置 < 用户设置 < 受控环境变量 < 命令行
```

前五段由 `product/paths.mjs` 的 `mergeConfigLayers` 实现（`product-runtime` 套件已在守）。
最后一段「命令行」是这里的补充：`--port.team-hub=9000` 的意思是「**就这一次**用 9000」。
若被配置文件里的值压过去，用户没有任何办法临时改一次——只能编辑文件、启动、再改回来。

`merged.provenance` 把「点号路径 → 生效层」记下来。排障时最有用的一句话是
「端口 9000 来自工作空间配置」，而不是「端口是 9000」。

### 2.2 那些必须报出来的失败

| 情形 | 代码 | 为什么不能容忍 |
| --- | --- | --- |
| JSON 有语法错误 | `CONFIG_INVALID_JSON` | 整份配置被忽略 → 所有值回到默认值，而用户以为设置生效了 |
| 文件存在但读不出来 | `CONFIG_UNREADABLE` | 同上，且原因（权限/占用）必须一并说出 |
| 顶层不是对象 | `CONFIG_NOT_OBJECT` | 数组/标量不是配置，静默当成空对象等于吞掉用户输入 |
| 类型不符（`"8787"`） | `CONFIG_TYPE_MISMATCH` | **字符串形式的数字会让端口比较永远不成立**，症状是「起不来」或「就绪超时」，而真因是类型 |
| 明文密钥 | `CONFIG_PLAINTEXT_SECRET` | §6.7/§6.11 禁止；写入侧拦不住手工编辑，而手工编辑是最常见路径 |
| 未知键 | `CONFIG_UNKNOWN_KEY`（**warn**） | 降级读更高版本的配置是真实场景，不该拒绝启动；但必须被看见，否则「改了配置没反应」无从解释 |

### 2.3 一个实测出来的 Windows 陷阱：UTF-8 BOM

`JSON.parse` **拒绝** `U+FEFF`。而这在本机是常态：

```powershell
Set-Content -Path data\product.config.json -Encoding utf8 -Value '{...}'   # Windows PowerShell 会加 BOM
```

开发中第一次用上面这条命令改端口，得到的就是：

```
✖ 产品配置有问题
  ✖ CONFIG_INVALID_JSON：配置文件 ...\product.config.json 不是合法 JSON：Unexpected token '﻿'
```

文件在用户眼里完全正常。因此 `readJsonFile` 在读之前先剥 BOM。
**这条不是猜测**：它在本批次开发过程中真实触发过一次，用例里保留了那个字节序列。

---

## 3 首次运行初始化（`product/init.mjs`）

```
node product/launcher/cli.mjs --init [--dry-run]
```

动作只有四步：**建目录 → 写默认产品配置 → 写产品元数据 → 校验可写性**。

### 3.1 三条拒绝边界

① **绝不写进安装目录。** 安装目录在升级时被整体替换。初始化在**建任何目录之前**先跑
`layoutDiagnostics`，命中 error 就 `phase: 'layout'` 直接返回，`created` 为空数组。
部分初始化会留下一个「像是装好了」的目录树，而它缺东西——那比完全没装更难排查。

② **绝不替用户创建工作区。** 工作区是用户授权的项目目录。
「未指定」由布局不变量拦住（`WORKSPACE_NOT_CONFIGURED`，error）；
「已指定但不存在」由初始化报 `INIT_WORKSPACE_MISSING`。
**判定点只有一处**：开发中曾有第二个判定点（`INIT_WORKSPACE_UNSET`），
它其实永远不可达（布局那一步已经短路返回），是死代码——同一件事判两次就会有两个口径，
而口径不一致时两份都不可信。已删除，用例改为断言布局门禁负责这一条。

替用户建目录的代价是**时间**：错误会在很晚才暴露，那时产品已经在别的目录里写过东西了。

③ **绝不覆盖已有的产品配置。** 首次运行写下的 `runtime.command` 是空串（等用户在向导里填）。
第二次运行把它覆盖掉，用户填的东西就无声消失了。因此「存在即跳过」是硬规则，不是优化。

### 3.2 幂等与「如实报告做了什么」

`initializeProductDir` 返回 `{ ok, phase, created[], skipped[], files[], diagnostics[] }`。
`skipped` 区分 `exists` / `user-owned`，`files` 记录 `product-config` 与 `product-meta`。
一个「静默成功」的初始化让「为什么我的配置不见了」无从回答。

### 3.3 `dryRun` 暴露的一个真实缺陷

首次运行向导要回答「点下去会发生什么」，因此必须有 dry-run。第一版实现里，
「要不要写配置」的判据是 `exists(layout.dataDir)`——而 dry-run **不会真的建目录**，
于是它安静地少报了两个文件。判据已改为「这一步成没成」（`dataDirUsable`），
而不是「盘上有没有」。判据用文件系统当代理时，任何「不落盘」的模式都会让报告失真。

### 3.4 可写性探测真的写一个文件

`probeWritable` 写一个 `.legion-write-probe` 再删掉。`fs.access` 在位掩码语义上会骗人
（Windows 上尤其），而「目录可写」这件事的代价是启动后在很晚的时候才发现写不进去。

---

## 4 CLI 接线

| 参数 | 行为 | 退出码 |
| --- | --- | --- |
| `--init` | 建目录、写配置与元数据，**不启动进程** | 0 / 7 |
| `--init --dry-run` | 只报告将创建什么 | 0 / 7 |
| `--no-config` | 忽略产品配置文件（排障用：回答「是不是配置的问题」） | — |

退出码现在是契约的一部分：

```
0 成功 | 2 参数错误 | 3 布局未确定 | 4 --check 未通过 | 5 启动失败 | 6 配置有 error | 7 初始化未完成
```

**默认安装目录改为「Launcher 自己所在的那棵树」**（`defaultInstallDir()`）。
上一版要求用户显式设 `LEGION_INSTALL_DIR`，于是最基本的用法——

```
node product/launcher/cli.mjs --init
```

——第一步就报 `INSTALL_DIR_UNRESOLVED`。Launcher 恰好是唯一知道答案的那一方（它就在安装目录里）。
优先级仍是 显式 CLI > 环境变量 > 本默认值。

### 4.1 接线之后的真实输出

```
$ node product/launcher/cli.mjs --init --workspace=...\ws
Legion 首次运行初始化
  ＋ data         ...\data
  ＋ cache        ...\cache
  ＋ log          ...\log
  ＋ data         ...\data\team-hub
  ＋ data         ...\data\whiteboard
  ＋ data         ...\data\whiteboard\rooms
  ＋ data         ...\data\whiteboard\audit
  ＋ data         ...\data\orchestrator
  ✎ product-config ...\data\product.config.json
  ✎ product-meta   ...\data\product.json
✔ 初始化完成（新建 8 个目录、2 个文件）

$ node product/launcher/cli.mjs --check      # 配置里已填 runtime.command
✖ 启动前体检未通过（阶段：plan）
  ✖ [orchestrator] ENTRY_MISSING：进程 orchestrator 的入口不存在：...\product\orchestrator\worker.mjs（任务 PRT-301）
```

**注意第二段**：填入 `runtime.command` 之后 `ENTRY_UNRESOLVED` 消失了——配置 → Launcher 的接线
是通的（用例 `配置文件提供 runtime.command 后，runtime 入口不再报 ENTRY_UNRESOLVED` 钉住了这一点）。
剩下的 `ENTRY_MISSING` 是真实缺口（PRT-301 未实现），不是本批次的问题。

---

## 5 未交付

- **PRT-707 首次运行向导**：`--init --dry-run` 是它的地基（「先看看会发生什么」），
  但界面本身未做。
- **PRT-709 日志轮转与磁盘保护**：`directorySize()` 已提供前置读数（可注入、带条目上限），
  轮转策略未实现。
- **配置写入路径只覆盖首次运行**：向导改配置时需要「写入 + 校验 + 原子替换」，
  目前只有 `assertWritableConfig` 这一道门禁。
- **`services-plugin` 仍未替换**：配置与初始化都接在**新** Launcher 上，
  旧监管者仍在旧路径上跑（接线属 PRT-252）。
