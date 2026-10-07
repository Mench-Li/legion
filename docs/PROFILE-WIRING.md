# 档案接线：让 Legion 随宿主自动起（`scripts/legion-profile.mjs`）

> 本文回答两个问题：**为什么 `profiles/web` 会自动起而 `profiles/desktop` 不会**，
> 以及**怎么一条命令把任意档案接好、怎么复查、怎么回退**。
> 上游背景见 [README §4.1](../../README.md)、[功能手册：安装与启动](../FEATURES.md)。

## 1. 「自动启动」依赖的是两份**档案侧**事实

DSH 宿主启动时会不会拉起 Legion，不取决于 Legion 仓库里有什么，而取决于当前那个
**profile** 里有没有这两样东西：

| # | 事实 | 落点 | 缺了会怎样 |
| --- | --- | --- | --- |
| ① | 四个 `@dsh-external/dsh-*` 包**可解析** | `<profile>/node_modules/@dsh-external/<pkg>`（junction） | 补丁行里的 `name` 加载不到 → warn-and-skip，**什么都不发生** |
| ② | 补丁层里有那两行 `insert` | `<profile>/cordis.patch.yml` | 包在、但没有人挂它 → 服务不起、守护不扫单 |

> 一个"依赖建好了、补丁行没写"的档案，与一个"什么都没配"的档案，
> 在宿主启动日志里长得一样 —— 都是什么都没发生。

## 2. 现状（2026-09-30 实测）

```
node scripts/legion-profile.mjs --verify --profile web,desktop
```

| 档案 | 依赖 | junction | 补丁行 | 结论 |
| --- | --- | --- | --- | --- |
| `~/.dsh/profiles/web` | 4/4 | 4/4 | 2/2 | ✅ 已接好（历史手工接线） |
| `~/.dsh/profiles/desktop` | 4/4 | 4/4 | 2/2 | ✅ 由本脚本接好（2026-09-30 23:57） |

Desktop 档案补的是 `node` 侧**新增**的两行：`legion-services`（三件套托管）
与 `legion-scrum-worker`（software 空间士兵守护，`isolate: true`）。

**并行度是按档案给的**：新接的档案默认 `maxWorkers: 1`，而 `web` 档案里用户手写的
`maxWorkers: 2` **不动**。理由是两个宿主会同时活着，认领互斥只保证"同一条任务不被双派"，
不保证"同一个仓库上的并发度不翻倍"；同一条判据**刻意不钉具体数字**（钉了会把用户
既有意图判成"过时"，那种输出的下场是被人整行忽略）。

## 3. 用法

```powershell
# 复查（只读，默认动作）：缺什么一目了然，有缺口退出码 1
node scripts/legion-profile.mjs --verify --profile web,desktop

# 接线（幂等）：补 package.json 的 file: 依赖 + 建 junction + 追加缺失的补丁行
node scripts/legion-profile.mjs --wire --profile desktop

# 先看看会改什么（不写盘）
node scripts/legion-profile.mjs --wire --profile desktop --dry-run

# 回退：两个文件各自退回同目录下最近的 .bak-*
node scripts/legion-profile.mjs --restore --profile desktop
```

**改前必留备份**：`package.json.bak-<时间戳>` 与 `cordis.patch.yml.bak-<时间戳>`，
与原件同目录。`--restore` 就是读它们。

### 指向远程 Hub（手机要从**服务器**派任务到这台电脑）

默认的 worker 连的是**本机** `http://127.0.0.1:8787` + `scope: software`。
要让手机在服务器上派的任务落到这台电脑上跑，worker 必须指向那台服务器：

```powershell
# 方式一：命令行（调 legion-profile.mjs 时用）
node scripts/legion-profile.mjs --wire --profile web `
  --hub-url https://legion-si.online --hub-token <令牌> --scope default

# 方式二：环境变量（任何**包着**它跑的入口都能透传，比如 scripts/legion-start.mjs）
$env:LEGION_HUB_URL_FOR_NODE   = 'https://legion-si.online'
$env:LEGION_HUB_TOKEN_FOR_NODE = '<令牌>'
$env:LEGION_HUB_SCOPE_FOR_NODE = 'default'
node scripts/legion-profile.mjs --wire --profile web
```

优先级是 **命令行 > 环境变量 > 默认**。不配就是本机——既有部署的行为一字不变。

**★ 三种方式都要配上**（`hubUrl` / `hubToken` / `scope`），只配 URL 会连上但认领不到任务：
任务是按 `scope` 派发的，scope 对不上就是"连得上、什么都没发生"。

**★ 已经写进补丁行的那一行，本脚本不会自动改。** `--verify` 会如实报出来：

```
· 已存在但配置过时 1 行：legion-scrum-worker（缺 scope: 'default' / hubUrl: 'https://…'）
  ⚠ 过时的值**不会自动改**（那一行是既有配置，改它要人来定）
```

——这是刻意的。改用户档案里既有的那一行，与"追加一行本来没有的"不是同一件事：
前者是在覆盖别人的决定，后者只是在补缺口。照着报出来的值手工改那一行即可。

**★ `hubToken` 的值不会出现在 `--verify` 的输出里**（`ensure` 只断言"这个键在场"）。
一条会把令牌明文打进终端与 CI 日志的"过时告警"，比不告警更坏。

## 4. 几个刻意的设计选择

| 选择 | 理由 |
| --- | --- |
| **追加**补丁行，绝不重写整个 `cordis.patch.yml` | 那是**用户**的文件（`dsh plugin add` 也往这里写）。重写会把他的行与注释一起弄丢 |
| 生成的块**不带 `id`** | `{id, insert}` 在 DSH 里的语义是"插进 `id` 那一行的 config 数组"，要求那一行存在且是 group；实测靶子不存在时 **warn-and-skip 且不抛** |
| 写文件前跑**形状检查**（`checkInsertBlockText`） | 判据是 YAML 的块映射嵌套规则（兄弟键必须与第一个键对齐），不是"缩进看着顺眼"。第一版只查"偶数缩进 + 有 name"，放行了一份非法 YAML |
| 仍然写 `package.json` 的依赖 | junction 是**当前状态**，`file:` 依赖是**下次 `pnpm install` 的依据**。只建 junction 的接线会在任何一次 reinstall 之后静默消失 |
| `--verify` 是默认动作 | 一个默认就写用户档案的工具，有一天会在错误的档案上执行 |
| 单引号标量（`'D:/project/DSH/legion'`） | 单引号里没有转义序列，Windows 路径原样可读；内部单引号翻倍即可 |

## 5. 多宿主并存（web + desktop 同时开）

- `legion-services` 起服务前先探端口：**已被监听则跳过**，两个宿主并存不会抢 8787/5173；
  宿主退出时回收自己起的那些（`.legion-services.log` 有启停记录）。
- 两个守护实例同时扫同一个 hub：认领走 team-hub 的**乐观锁**（谁先 claim 谁干），
  不会双派；`daemon.json` 由 `primaryScope: 'software'` 的实例维护，两边一致。
- 目前 desktop 档案只接 `legion-services` + `legion-scrum-worker`（**新增**），
  web 档案保留它原有的 team-hub / scrum-board 行（**不动**用户既有配置）。

## 6. 已知边界

- **需要重启宿主才生效**：插件行在宿主启动时装载。改完档案请重启 DSH（Desktop 或 web）。
- **本脚本不懂 YAML 解析**：仓库里没有 YAML 解析器（`js-yaml` 不在任何 `node_modules` 里），
  所以它只做"追加 + 自检形状"。真正的解析判据是宿主能否起来 —— 起不来就用 `--restore` 回退。
- **产品化路径未接**：让"只启动 Legion 就完成一切"是 `product/launcher/` 那条线
  （`runtime.command` 目前为空 → Launcher 拒绝启动），本脚本是那条线**可复用的第一块**
  （档案接线与复查），见 [`docs/STATUS.md`](../STATUS.md) 里 PRT-257 的现状。
