# PRT-011 DSH 分发形态决策

**对应**：`PRT-011`
**状态**：✅ **已裁决（2026-09-11）：路线 C** —— 依赖 `@deepseek-ai/dsh` npm 包，
由 Launcher 装进 `DataDir` 并做原子切换。
**采集方式**：`D:\project\DSH\dsh\deepseek-harness` 与 `$DSH_HOME` 实测（2026-09-11）

---

## 0. 裁决结果

| 决策项 | 结果 |
| --- | --- |
| 首发分发形态 | **C —— 依赖 npm 上的 `@deepseek-ai/dsh`**，不自建打包、不内置 1.6 GB 运行时 |

由此确定的下游约束（移交 `PRT-257` Launcher）：

1. **运行时代码来源**：从 npm 获取 `@deepseek-ai/dsh`，装进 `DataDir`
   （**不是** InstallDir——见 PRT-001 §2.1 同类问题）。
2. **版本锁定**：产品清单声明受支持的版本区间；`dshCompositionPatchVersion`（spec §9.1）
   用于判断升级是否动到我们依赖的组合行（该字段尚不存在，PRT-010 基线是它之前的对照起点）。
3. **原子切换与回滚**：新版装新目录 → 校验 → 切指针；失败保留旧版可回滚。
4. **不得编辑 shipped preset install**：产品自有内容只进
   `profiles/<profile>/cordis.patch.yml` 用户层（实测该文件已是 Legion 唯一挂载点）。
5. **首次运行需联网**（已接受）。之后走缓存；离线场景不在首发承诺内。

**仍未决、且属 PRT-257 前置的问题**：Legion 自身四个 `file:` 包怎么分发给用户。
见 §3 第 3 条——它与分发形态是同一个问题的两半。

---

## 1. 实测事实

### 1.1 DSH 本身**已经是可分发的 npm 包**

| 项 | 值 |
| --- | --- |
| 包名 | `@deepseek-ai/dsh` |
| 版本 | `0.1.5-rc.2` |
| `bin` | `{ "dsh": "lib/bin.js" }` |
| `files` | `["lib/*.js"]` |
| 是否 private | **否**（可发布） |
| 许可证 | **MIT**（Copyright (c) 2026 DeepSeek） |
| Node 要求 | `^22.19.0 \|\| >=24.0.0` |
| 仓库 | monorepo，根包 `@deepseek-ai/dsh-root` 为 private，`apps/cli` 才是发布单元 |

仓库里已有完整的发布侧校验脚本（`publish-npm-baseline.ts`、
`verify-built-package-invariants.mjs`、`verify-dsh-package-licenses.ts`、
`package-invariants.ts`），说明**发布链路是既有的**，不需要 Legion 自建。

> 这条事实把问题从「要不要自己打包一套 DSH」变成「**要不要依赖一个已有的 npm 包**」。
> 两者的工程量差一个数量级。

### 1.2 当前部署其实是**开发布局**，不是分发形态

实测 `$DSH_HOME`（`~/.dsh`）：

| 路径 | 大小 | 说明 |
| --- | --- | --- |
| `sessions/` | **257.9 MB** | 用户会话数据（**不是**运行时代码） |
| `attachments/` | 5.1 MB | 附件 |
| `storages/` | 4.1 MB | 存储 |
| `super-injector/` | 2.0 MB | 守护日志 |
| `profiles/` | **0.2 MB** | **看起来很小——因为是 junction** |
| 合计 | 270.2 MB | |

`profiles/node_modules/@deepseek-ai/` 下有 **244 个 junction**，全部指向：

```
D:\project\DSH\dsh\deepseek-harness\apps\cli\node_modules\@deepseek-ai\*
```

也就是说：**DSH 运行时代码根本不在 `DSH_HOME` 里**，而是从一份**源码 checkout** junction 过去。

### 1.3 DSH checkout 的体积

| 目录 | 大小 |
| --- | --- |
| `node_modules/` | **1489.7 MB** |
| `.git/` | 200.2 MB |
| `packages/` | 112.4 MB |
| `apps/` | 16.5 MB |
| `.agents/`、`snapshots/`、`docs/`、`scripts/`、`vendor/` 等 | 26.1 MB |
| **合计** | **≈ 1845 MB** |

运行时有效载荷 ≈ **1.6 GB**（`node_modules` + `packages` + `apps`，含 dev 依赖未裁剪）。

### 1.4 Legion 侧的挂载形态

四个包都是 `file:` 依赖（详见 PRT-010 §2.3）。pnpm 对 `file:` 是**复制快照**，
非符号链接——**改源码不重新 install 则运行时不生效**。

---

## 2. 三条路线

| | **A. 内置完整运行时** | **B. 依赖宿主已装 DSH** | **C. 混合（推荐）** |
| --- | --- | --- | --- |
| 做法 | 打包 Node + DSH + 依赖树 | 要求用户已有 `dsh`，Legion 依赖它 | 依赖 npm 上的 `@deepseek-ai/dsh`，由 Launcher 装进 DataDir |
| 安装体积 | ≈ 1.6 GB + Node（~50 MB） | ≈ 0（Legion 自身 ~几百 KB） | ≈ 首次安装时下载；可缓存复用 |
| 首启耗时 | 最快（无需下载） | 最快，但前置条件可能不满足 | 首次需下载（网络可用时），之后走缓存 |
| 升级复杂度 | **最高**：要随 DSH 频繁发版重打包 | **最低**：用户自己升级 | 中：Launcher 解析版本 + 原子切换 |
| 法务影响 | 需随包分发 MIT 许可证与版权声明 | 无（用户自行获取） | 同 A，但只在下载产物中附 |
| 离线可用 | ✅ | ✅（若已装） | ❌ 首次（之后 ✅） |
| 主要风险 | 1.6 GB 安装包的分发与更新成本 | **前置条件失败就是装不上** | 首次需网络；需处理版本不兼容 |
| 匹配现有资产 | 无 | 依赖用户环境 | **复用既有 npm 发布链路** |

### 2.1 为什么排除 A

1.6 GB 的安装包意味着每次 DSH 发版都要重新分发一份完整运行时。当前 DSH 版本是
`0.1.5-rc.2`——**release candidate**，迭代节奏不会慢。把 RC 打进安装包，
用户拿到的是「某个冻结的 RC」，出问题只能等下一次整体发版。

且 A 并不能省掉 B/C 的问题：**Legion 自己的四个包仍是 `file:` 复制快照**，
仍然需要一套安装/升级机制。

### 2.2 为什么 B 单独不够

要求用户先有一个可用的 DSH，等于把「产品能不能用」交给用户的环境。
spec §3.1 把「安装后可用」列为产品目标；B 单独无法保证它。

且实测显示当前 DSH 是 junction 到源码 checkout——**这正是 B 的极端形态**：
只有开发机上成立。今天这台机器能用，不代表用户机器能用。

### 2.3 为什么推荐 C

C 把「运行时代码的来源」从「随包分发」改为「按需获取 + 缓存」，同时**复用了既有的
npm 发布链路**（§1.1），不需要 Legion 自建打包。

需要 C 处理的四件事（即 `PRT-257` Launcher 的输入）：

1. **版本解析与锁定**：产品清单声明受支持的 `dsh` 版本区间；
   `dshCompositionPatchVersion`（spec §9.1）用于判断升级是否动到我们依赖的组合行。
2. **安装位置**：DSH 运行时进 `DataDir`（**不是** InstallDir——见 PRT-001 §2.1 的同类问题）。
3. **原子切换与回滚**：新版本装到新目录 → 校验 → 切指针；失败保留旧版本可回滚。
4. **不得编辑 shipped preset install**：产品自有内容只进 `profiles/<profile>/cordis.patch.yml`
   这一用户层（实测该文件已是 Legion 的唯一挂载点），DSH 自带的 preset 一律只读。

---

## 3. 未决与移交项

1. ~~首发形态走 A / B / C 哪一条？~~ → **C（已裁决）**。
2. ~~是否接受首次运行需要网络？~~ → **接受**（C 的固有代价，离线不在首发承诺内）。
3. **仍待回答：Legion 的四个 `file:` 包如何分发给用户？** 它们目前依赖源码路径
   （`D:/project/DSH/legion/*`），要装到用户机器只有两条路：
   发布成 npm 包，或由 Launcher 从安装目录做 junction。
   **这条不在原计划的 PRT-011 范围内，但它和分发形态是同一个问题的两半**——
   PRT-257 必须先回答它，否则 Launcher 装好了 DSH 也挂不上 Legion 自己的包。
4. **仍待回答：`0.1.5-rc.2` 是否可作为首个对外版本的依赖？** RC 依赖对产品意味着
   什么风险偏好。C 让这件事**可推迟**（版本区间可在清单里收紧），但首发必须给出一个值。

---

## 4. 不做的事

- **不改动任何现有文件布局**。本次只采集事实，未移动、未清理、未重装任何东西。
- **不实现 Launcher**。本文件是 `PRT-257` 的输入，不是它的实现。
- **不评估 DSH 之外的分发渠道**（如容器镜像、系统包管理器）。若有这类需求，
  应另立任务——它们与 A/B/C 正交。
- **不内置 Node 运行时**（A 已排除）。Node 版本要求由清单声明
  （`^22.19.0 || >=24.0.0`），检测到不满足时应给出可读报错而不是静默失败。
