# PRT-002　DSH 执行面依赖清单与静态边界

> 日期：2026-09-11
> 状态：已落地（清单 + 扫描器 + CI 门禁）
> 上游：`docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md` §6.2、PRT-002、PRT-108
> 产出于分支 `codex/product-runtime-design`（本分支从 `main` 切出，尚未包含该 spec 文件）

## 1. 这份清单解决什么

Product Runtime 的核心承诺是「Legion 产品层只通过 Runtime Contract 调用执行引擎」。在
Orchestrator 与 Adapter 建好之前，这个承诺无法靠「设计说明」保证——它唯一可执行的形式是
**阻止 DSH 执行面耦合继续增长**。

因此 PRT-002（依赖清单）与 PRT-108（CI 静态边界检查）在本阶段合并为一件可运行的东西：

| 产物 | 路径 | 作用 |
|---|---|---|
| 扫描器 | `scripts/ci/dsh-boundary.mjs` | 生成清单、执行棘轮判定 |
| 基线（机器可读） | `scripts/ci/dsh-boundary-baseline.json` | 冻结当前债务，只许减不许增 |
| 单测 | `scripts/ci/dsh-boundary.test.mjs` | 记号识别 / 反误报 / 判定语义 / 棘轮真实性 |
| CI 阶段 | `run-ci.mjs` → `boundary`（紧随 `env`） | 秒级静态门禁，尽早失败 |
| 本文档 | 本文件 | 口径、分类与迁移目标 |

日常命令：

```bash
node scripts/ci/dsh-boundary.mjs --report           # 人读清单
node scripts/ci/dsh-boundary.mjs --check            # CI 门禁（默认）
node scripts/ci/dsh-boundary.mjs --update-baseline  # 显式下移债务线
```

## 2. 判定口径

### 2.1 只认「执行面」，不认「宿主面」

棘轮只覆盖 **单 Agent 推理循环** 这一片，即 Runtime Contract 要隔离的对象：

- `ctx.subagents` / `ctx.agentDefaultModel` / `ctx.agents` / `ctx.agentPresets`
- `inject` 中声明的同名服务（声明式硬依赖比调用点更硬：服务缺失时插件会进入 waiting）
- 执行面包：`@deepseek-ai/dsh-{subagent,agent,agent-default-model,agent-presets,session,tools}`

**刻意排除**的宿主平面能力：`ctx.effect` / `ctx.logger` / `ctx.webServer` / `ctx.setInterval` /
`ctx.plugin` / `@deepseek-ai/cordis` / `schemastery`。

理由：team-hub 与 board-plugin 是合法的宿主插件，`team-hub/src/index.ts` 与
`board-plugin/src/index.ts` 本来就通过 `ctx.webServer` 注册路由。把它们一并棘轮只会制造噪音，
而噪音会让真正的边界告警被淹掉。**边界检查一旦开始误报，就会被绕过，比不检查更糟。**

### 2.2 三类判定

| 情形 | 判定 | 说明 |
|---|---|---|
| 适配层（`runtime/adapters/dsh/`、`runtime/dsh-composition/`） | 豁免 | 这是「唯一允许调用 DSH」的落点 |
| 边界模块（`runtime/contracts/`、`runtime/manager/`、`orchestrator/`、`product/`、`security/`） | 必须为零 | **永不接受基线例外**，防止一次 `--update-baseline` 把违规洗白 |
| 其余文件 | 棘轮 | 逐文件逐记号与基线比对，超一次即红 |

`runtime/contracts/` 为零这条尤其关键：契约必须独立于 Cordis/DSH 类型，否则
「用内存 Fake Adapter 完成全部 Orchestrator 测试」这条完成标准无法成立。

### 2.3 扫描范围

`git ls-files --cached --others --exclude-standard`：

- 含**已跟踪**与**未跟踪但未被忽略**的源码。只用 `git ls-files` 会让本地 `--check`
  看不见刚新建、还没 `git add` 的文件——本地全绿、提交后 CI 才红。CI 里两者等价，
  但棘轮必须在提交前那一步就拦得住。
- 排除 `.skills-cache/`（第三方技能缓存，499 个文件，非 Legion 源码）。
- 排除扫描器自身与它的夹具两个确切路径：它们**按构造**含有执行面记号（正则模式与测试字面量）。

### 2.4 扫描是词法的，不是语义的

H 计数包含注释与字符串里的记号，**刻意偏保守**：宁可多算也不漏算。

真正的实现是带注释剥离的词法器，而半吊子剥离（例如按 `//` 截断整行）会在
`const u = 'https://x' ; ctx.subagents.start()` 这类行上**吞掉真实调用**，
把假阳性换成假阴性——对边界门禁而言这是更坏的交易。

实际影响很小：当前 26 处记号中只有 2 处是注释提及（见 §3.1）。若某天注释噪音变大，
再引入词法器；在此之前不为自己制造假阴性。

## 3. 当前债务清单（基线 v1）

**3 个文件 / 26 处记号。** 全部集中在迁移期兼容路径，新架构模块为零。

### 3.1 `plugins/src/index.ts` —— 22 处（唯一真正需要迁移的文件）

这是仓库中**唯一**导入 DSH 执行面包的源文件，也是 stage 3 编排提取的对象。

| 标记 | 次数 | 位置 | 性质 |
|---|---|---|---|
| `@deepseek-ai/dsh-session` | 1 | 27 | 类型（`SessionId`） |
| `@deepseek-ai/dsh-agent` | 1 | 28 | 类型（`Agent`） |
| `@deepseek-ai/dsh-subagent` | 1 | 29 | 类型（`SubagentRuntime`） |
| `@deepseek-ai/dsh-tools` | 1 | 30 | 类型（`ObjectJsonSchema`） |
| `@deepseek-ai/dsh-agent-presets` | 1 | 31 | 类型 |
| `@deepseek-ai/dsh-agent-default-model` | 1 | 32 | 类型 |
| `inject.{subagents,agentDefaultModel,agents,agentPresets}` | 4 | 63 | **声明式硬依赖** |
| `ctx.subagents` | 6 | 78, 1255, 2219, 2681, 3014, 3108 | 4 处真实调用 + 2 处注释提及 |
| `ctx.agentDefaultModel` | 4 | 1017, 1366, 3063, 3158 | 2 处报状态 + 2 处配执行 |
| `ctx.agents` | 1 | 1367 | 创建 foreman agent |
| `ctx.agentPresets` | 1 | 1371 | 挂载岗位 preset |

**最硬的一处是第 63 行：**

```ts
export const inject = ['timer', 'agents', 'subagents', 'agentDefaultModel', 'agentPresets']
```

它把 4 个执行面服务声明为硬依赖，意味着这个插件在 DSH 执行面缺失时会进入 waiting——
这是「插件即执行器」的根因，也是 M1 Runtime 边界要拆掉的第一个结。

按迁移目标可分三类，工期差别很大：

1. **仅读取状态（易）**：1017（写 daemon 状态）、3158（心跳上报）、3063（fallback 取值）。
   只是读一个 `{provider, model}`，可先经 Runtime Contract 的 `listModels`/`selectModel` 代理。
2. **创建执行身份（中）**：1366–1371 的 foreman 创建（`agents.create` + `agentPresets.mount`）
   是 `RunRequest` 的雏形，应整体迁入 `runtime/adapters/dsh/`。
3. **发起执行（中）**：1255（经验抽取）、2219（worker 派工）、2681、3108（对话回复）四处
   `ctx.subagents.start`，是 PRT-202 的直接对象。

### 3.2 `plugins/tests/goal-context.test.mjs` —— 3 处

`ctx.subagents` 作为测试替身出现（141 / 400 / 523）。它们描述的是**被测代码当前的接口形状**，
因此必须随 PRT-202/PRT-210 一起改，不能单独清理。

### 3.3 `scripts/live/p26-chat-e2e.mjs` —— 1 处

实机 e2e 脚本中的 `ctx.subagents`。属于验证工具，随对话回复路径迁移。

## 4. 如何下移债务线

基线**只许减不许增**，但允许在真实迁移后下移。下移的唯一正确姿势：

1. 把调用移入 `runtime/adapters/dsh/`，或改造为经 Runtime Contract 调用；
2. 运行 `node scripts/ci/dsh-boundary.mjs --report` 确认该文件记号数确实下降；
3. 运行 `--update-baseline` 重写基线，并在提交信息中说明「哪一处迁移导致下移」。

`--update-baseline` 会**拒绝**把边界模块写进基线（exit 1），因此违规无法被洗白。

反向的红线：用 `--update-baseline` 让新增调用点过关，等价于把棘轮拆掉。CI 不会分辨意图，
评审必须问一句「这次下移对应哪一次真实迁移」。

## 5. 验证

`scripts/ci/dsh-boundary.test.mjs` 共 22 条用例，分四类：

- ① 记号识别：点号/下标访问、`inject` 多行数组、包说明符。
- ② 反误报：前缀包名互不吞噬（`dsh-agent` vs `dsh-agent-default-model`）、相似服务名
  （`ctx.agents` vs `ctx.agentPresets`）、更长标识符、非执行面宿主能力、局部同名 `ctx`、
  以及 §2.4 的词法口径。
- ③ 判定语义：持平/低于基线通过；`increased` / `new-token` / `new-file` / `must-be-zero` 归因准确；
  适配层豁免；边界模块即使被写入基线也照样红。
- ④ **棘轮真实性**：当前仓库扫描结果与基线逐文件逐记号一致；基线不含豁免项；
  在真实仓库放一个真实探针文件跑真实 CLI，证明 `--check` 真的会红。
  第 ④ 类是本套件存在的理由——只测纯函数无法证明扫描范围（`git ls-files` 口径）本身是对的，
  而该缺陷在开发过程中**真实出现过一次**（见 §6）。

## 6. 开发过程中被测试抓到的一个真实缺陷

首版扫描范围用的是 `git ls-files`（只看已跟踪文件）。端到端用例
「真的新增一处执行面调用会让 `--check` 变红」当即失败：新建的探针文件未被跟踪，
因此扫描器看不见它——**本地 `--check` 会全绿，提交后 CI 才红**。

修复为 `--cached --others --exclude-standard`。这条经验也说明了为什么第 ④ 类用例不可省略。

## 7. 与 spec 的对应

| spec 条目 | 本文档 / 代码 |
|---|---|
| §6.2「除该模块和迁移期兼容代码外不得新增直接调用」 | `dsh-boundary.mjs` 棘轮 |
| §6.2「CI 增加静态边界检查防止回归」 | `run-ci.mjs` → `boundary` 阶段 |
| PRT-002「依赖清单和静态扫描规则」 | 本文档 §2–§3 + `--report` |
| PRT-108「增加禁止新增直接 DSH 调用的静态边界检查」 | `boundary` 阶段 + 22 条单测 |
| §6.1「Runtime Contract 必须独立于 Cordis 和 DSH 类型」 | `runtime/contracts/` 必须为零 |
| §6.9 适配层是唯一允许调用处 | `ADAPTER_PREFIXES` 豁免 |

## 8. 尚未覆盖（留给后续阶段）

- **宿主面耦合未棘轮**：`ctx.effect` / `ctx.setInterval` / `ctx.plugin` 仍广泛存在于
  `plugins/src/index.ts`，是生命周期耦合的来源。它们不属执行面，本阶段有意不纳入；
  M1 之后若要收紧，应新增独立基线而不是扩大本文件的判定面。
- **动态调用未覆盖**：`ctx[name]` 这类计算属性访问无法静态识别。
- **构建期依赖未覆盖**：`scripts/ci/build-external-package.mjs` 依赖 DSH checkout 提供
  Cordis/Agent/Session/Subagent 模块，属 PRT-011（DSH 分发形态）的范围。
