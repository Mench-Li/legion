# patches/dsh —— 我们对 DSH 的兼容补丁

这里放的是**Legion 对 DSH 运行时的兼容补丁**，以及它们在本机的部署证据。

## 为什么补丁在 Legion 里，而不在 DSH 仓库里

Legion 是产品，DSH 是它面向的运行时。DSH 的上游是官方仓库
（`https://github.com/deepseek-ai/deepseek-harness.git`），**我们推不上去**。
所以对运行时行为的修复只有两种落点：

1. **Legion 持有补丁**（就是这里），部署到实际 profile；
2. 提给上游，等发布后删掉本地补丁。

而"在 DSH 检出的 `master` 上留一个本地提交"不属于其中任何一种。它的后果不是立刻出错，
而是在你某天 `git pull` 时才出现：

> 一个"你有 fork 但没有构建"的仓库，
> 在你想升级的那天，会同时收走你的修复和你对它的记忆。

同一条纪律已经在 [`scripts/ci/dsh-boundary.mjs`](../../scripts/ci/dsh-boundary.mjs) 里写成
架构承诺（「Legion 产品层只通过 Runtime Contract 调用执行引擎」）。

**当前状态**：`DSH master` 与上游一致（无本地提交）；补丁以分支
`legion/compat-claude-provider` + 本目录的补丁文件两种形式存在。

## 补丁清单

| 文件 | 修什么 | 对着哪一版 |
| --- | --- | --- |
| `0001-subagent-claude-code-accept-terminal-assistant-text.patch` | `subagent-claude-code`：SDK 返回 `subtype=success`、`is_error=false`，但 `result` 文本为空时，回退到累积的 `assistant` 文本 —— 否则"成功"被判成"无结果"，上层看到 `invalid-result` | DSH `0.2.1-rc.2`（`687f282e`） |

基线（哈希、目标文件、部署证据）在 [`base.json`](base.json)，**由脚本生成**，不要手改。

## 用法

```bash
# 看有哪些补丁
node scripts/dsh-patch.mjs --list

# 校验：补丁文件没被改过 / 已装 DSH 还是基线那份 / 部署产物里修复还在
node scripts/dsh-patch.mjs --check

# 校验 + 确认补丁能落到某份 DSH 检出上（不落盘）
node scripts/dsh-patch.mjs --check --source=D:/project/DSH/dsh/deepseek-harness

# 应用到检出（自动建/切 legion/… 分支，绝不在 master/main 上动）
node scripts/dsh-patch.mjs --apply --source=D:/project/DSH/dsh/deepseek-harness

# ★ 从源码构建那一个包（tsc -b --force + tsdown 单包打包）
node scripts/dsh-patch.mjs --build --source=D:/project/DSH/dsh/deepseek-harness

# ★ 装进 profile（只覆盖 lib/index.js，先备份；不动 package.json 与依赖解析）
node scripts/dsh-patch.mjs --install --source=D:/project/DSH/dsh/deepseek-harness

# 撤下（分支保留，便于追溯）
node scripts/dsh-patch.mjs --revert --source=D:/project/DSH/dsh/deepseek-harness

# 重新记录本机证据（部署产物变了之后才需要）
node scripts/dsh-patch.mjs --record
```

## 三个判定分别防什么

`--check` 有意分成三项，因为它们对应三种**完全不同**的事故：

| 判定 | 防的事故 | 为什么不能用另一项代替 |
| --- | --- | --- |
| 补丁文件哈希 | 有人手改了补丁，基线不再描述它 | 只看文件在不在，会漏掉"补丁被改坏" |
| 已装 `app.asar` 哈希 | DSH 升级/重装过，补丁是对旧基线写的 | 只看版本号会漏掉"同版本不同构建" |
| 部署产物里的**内容标记** | profile 被重装，修复已经不在生效 | **只记哈希答不出这个**：哈希变了可能只是重建，标记没了才是修复没了 |

对应地，`base.json` 里的 `deployed.markers` 存的是**内容**（例如 `assistantText`），
不是哈希 —— 它回答的是"修复到底在不在"，而不是"文件变没变"。

## 为什么是"构建源码"，而不是"手改已装产物"

补丁打在 `src/*.ts` 上，必须由 DSH 自己的构建链编出 `lib/`，再装进 profile。手改已装的
`lib/index.js` 看着更快，但那是把债从"看得见的提交"换成"看不见的 JS 差异"：
产物不可读、升级即丢，而且与这里的 `.patch` 形成两轨、迟早漂移。

构建只做**一个包**（整仓 200+ 包没必要）：

1. `tsc -b packages/<area>/<name> --force` → `lib/types/`
2. `tsdown -c patches/dsh/single-package.tsdown.config.mts`（cwd = 包目录）→ `lib/index.js`

`single-package.tsdown.config.mts` 里那三个参数都是实测踩出来的，改之前请先读它的注释：

| 参数 | 不写它会怎样 |
| --- | --- |
| `process.cwd()` 基准 | 相对 `entry` 以**配置文件所在目录**解析 ⇒ `UNRESOLVED_ENTRY` |
| `outExtensions: .js` | 默认产出 `index.mjs`，而包 `main` 指向 `lib/index.js` ⇒ 宿主加载不到 |
| `external` 用**函数**而非正则 | 正则会把相对模块也判成外部包 ⇒ 产物 3.2KB、补丁根本没合并进去（**而构建仍报成功**） |

判据因此不看"exit 0"，而是看三件事同时成立：字节量级（20KB 量级，不是 3KB 也不是 2.26MB）、
依赖仍然外置（保留 8 条 `import`）、补丁标记在产物里
（`scripts/ci/dsh-patch.test.mjs` ⑮）。

## 注意

- **改完要重启 DSH 宿主**才会生效（profile 里的 `lib/` 是宿主启动时加载的）。
- 补丁只含**代码与测试**，不含 `README.i18n.yaml` 那类派生文档哈希：那些由 DSH 自己的
  工具生成，写进补丁会让补丁只能落在**那一版**上游上（`scripts/ci/dsh-patch.test.mjs` ③ 守着这条）。
- 上游一旦自己修了这个问题，**先删补丁再升级**，不要两条路一起走。
- 安装只覆盖 `lib/index.js` 并先备份（`index.js.bak-legion-<时间戳>`）：
  package.json 与依赖解析保持原样，所以这次安装不可能破坏运行中的宿主，也能一键回退。
