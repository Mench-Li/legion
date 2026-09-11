# PRT-008 术语冻结 / PRT-010 DSH 组合分层基线

**对应**：`PRT-008`、`PRT-010`
**机器基线**：[`prt-010-composition-baseline.json`](./prt-010-composition-baseline.json)（本文件是它的人读副本；两者冲突时以 JSON 为准）
**采集方式**：`node scripts/prt/composition-baseline.mjs --record`

---

## 1. 术语冻结（PRT-008）

以下是 spec §4.6 的落地副本。**在此冻结**：实现、测试、评审、提交信息一律使用这组含义。
放在这里而不是只留在 spec 分支，是因为改代码的人不该为了读懂一个字段名去切分支。

| 术语 | 权威含义 | 最容易搞错的地方 |
| --- | --- | --- |
| **Task** | team-hub 中可由一个岗位完成和验收的业务工作单元 | 它是**业务**概念，与执行引擎无关 |
| **Attempt** | Task 的一次执行尝试；重试创建新 Attempt，历史不可覆盖 | 重试**不是**改原记录，是新增 |
| **Run** | Runtime 对一个 Attempt 的一次模型执行实例 | **1 Attempt : 1 Run**；重试即新 Attempt → **新 Run** |
| **Session** | DSH 内部持久会话；可能承载一个或多个可继续 Run，**不等同于 Task** | 别把 Session 当 Task 用；一个 Session 可以跨多个 Run |
| **Lease** | Orchestrator 对 Task 的限时执行所有权 | 有**期限**，不是永久占有 |
| **Lease Epoch** | 每次成功领取递增的 fencing token，用于拒绝旧 worker 写入 | 这是防「旧 worker 复活写坏数据」的机制 |
| **TeamPlan** | 目标创建时冻结的团队、岗位、流水线和能力包组合快照 | **冻结**：目标运行期间不因配置改动而变 |
| **Context Snapshot** | BuildingContext 完成时冻结、实际发送给 Runtime 的不可变输入 | **不可变**；审计要能回答「当时到底发了什么」 |

### 1.1 三条由术语直接推出的实现约束

这三条在本次实现中已被**代码**固定下来（不只是文档）：

1. **Run 与 Attempt 一一对应** → 重试必须换 `runId`。
   在 Fake Adapter 的编排模拟里，我第一次复用 `runId` 做重试，终态仲裁器
   把第二次尝试的终态判为「迟到事件」而拒绝提交。**仲裁器是对的，我的编排是错的**——
   这正是 §6.4「重试创建新 attempt，不覆盖历史 attempt」在契约层面的体现。
2. **Attempt 历史不可覆盖** → 因此需要终态仲裁器（首个终态为准，迟到只作诊断），
   而不是「最后一次写入胜出」。
3. **Context Snapshot 不可变** → 审计记录里存的是引用（`contextSnapshotRef`），
   不是每次重建；否则「当时发了什么」无法回答。

### 1.2 术语反例（不要这样用）

| 错误说法 | 为什么错 | 正确说法 |
| --- | --- | --- |
| 「重试这个 Run」 | Run 是执行实例，不可重试 | 「为该 Attempt 创建新 Attempt → 新 Run」 |
| 「这个 Session 还没做完」 | Session 是引擎侧会话，不是任务 | 「这个 Task 还在 in_progress」 |
| 「更新一下 TeamPlan」 | TeamPlan 是冻结快照 | 「为目标创建新的 TeamPlan」 |
| 「把 Lease 续到任务结束」 | Lease 有限期；无限期等于没有所有权概念 | 「按心跳续租；超时后由他人接管」 |

---

## 2. DSH 组合分层（PRT-010）

### 2.1 分层链（实测）

profile 根 `cordis.yml` 是**空列表** `[]`（已实测确认）。整棵树**完全由 patch 链合成**：

| 顺序 | 层 | 文件 | 合成方式 |
| --- | --- | --- | --- |
| 1 | `dsh-base` | `packages/bundle/base/cordis.patch.yml` | `insert`（一份插入打到空根上） |
| 2 | `@deepseek-ai/dsh-web-app` | `packages/bundle/web-app/cordis.patch.yml` | `patch-over`（按 id 覆盖 base 行） |
| 3 | **用户 profile 层** | `$DSH_HOME/profiles/web/cordis.patch.yml` | `patch-over`（Legion 在这里） |

`dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`，
`patchReload: 'live'`——**组合改动热生效**，不需要重启。

DSH 侧的两条语义（摘自 base patch 的头部注释，此处不重复实现）：

- 一个 patch **替换**目标行的整个 `config`，而不是合并进去。因此「按模式取值不同的行」
  不放在 base 层，而是各模式 bundle 各自完整重述。
- 行顺序**没有加载语义**（激活由服务可用性驱动），分组只为方便阅读。

### 2.2 Legion 挂载面：6 行

| row id | 包 | 仓库目录 | 作用 |
| --- | --- | --- | --- |
| `legion-team-hub` | `@dsh-external/dsh-team-hub` | `team-hub` | 共享任务池鉴权入口 + SSE 事件流，挂 `:3080/team-hub` |
| `legion-scrum-board` | `@dsh-external/dsh-scrum-board` | `board-plugin` | 看板 UI + 写接口 + SSE，挂 `:3080/scrum-board` |
| `legion-scrum-worker` | `@dsh-external/dsh-scrum-worker` | `plugins` | 士兵守护（`scope: software`） |
| `legion-scrum-worker-ozon` | `@dsh-external/dsh-scrum-worker` | `plugins` | 士兵守护（`scope: ozon`） |
| `legion-mediator` | `@dsh-external/dsh-scrum-worker` | `plugins` | 公共调解员（`scope: '*'`，不派工不认领） |
| `legion-services` | `@dsh-external/dsh-legion-services` | `services-plugin` | 托管 team-hub `:8787` 与指挥台 `:5173` |

**同一个包被挂了三次**（`dsh-scrum-worker` × 3）。这不是冗余：`scope` 是**启动期常量**，
一个守护实例只服务一个空间。新增空间若不补一个实例，该空间的目标链会一直停在 `todo`。

### 2.3 挂载形态：`file:` 依赖（pnpm 复制快照）

四个包都是 `file:` 依赖，实测全部 `pointsAtRepoDir: true`（指向本仓库对应目录）。

**这是最容易踩的坑**：pnpm 对 `file:` 是**复制快照**，不是符号链接。因此

> 改了 `services-plugin/index.js` → **运行时不生效**，直到重新 `pnpm install`。

`services-plugin/index.js` 的注释已记录这一点（`import.meta.url` 指向 profile 的
`node_modules` 副本），`legion-services` 的 `legionDir` 也必须显式指向源码根，
否则运行时找不到仓库。排障时先问一句：「我在改的文件，是运行中那个副本吗？」

### 2.4 空值配置键（风险信号）

基线单独记录了每行的**空值配置键**。当前实测：

| row | 空值键 | 含义 |
| --- | --- | --- |
| `legion-team-hub` | `teamToken`、`members`、`scopes` | **hub 鉴权关闭**；成员与 scope 表为空 |
| `legion-scrum-worker` | `hubToken`、`denyTools`、`worktreeRoot` | worker 调 hub **不带凭证** |
| `legion-scrum-worker-ozon` | `hubToken`、`denyTools` | 同上 |
| `legion-mediator` | `hubToken`、`denyTools`、`rolesFile`、`worktreeRoot` | `rolesFile` 空是**设计**（调解员不派工） |
| `legion-scrum-board` | `hubUrl` | 空 = 用默认上游 |
| `legion-services` | （无） | — |

两点说明：

- `teamToken: ''` 与 `hubToken: ''` 组合起来意味着 **worker → hub 的调用未鉴权**。
  这与 PRT-003 §3.1 的发现是同一个问题：token 为空是合法值，**不会报错**，只是鉴权静默关闭。
  PRT-505 应把「空 token 时至少给出显式告警」列为要求。
- `rolesFile` / `worktreeRoot` 为空是**设计如此**（调解员不派工；`worktreeRoot` 由空间绑定兜底），
  基线不做区分地一并记录，是为了让「哪个空值是意外的」由人判断，而不是由工具猜。

### 2.5 本基线是 `dshCompositionPatchVersion` 之前的对照起点

spec §9.1 要求产品清单声明 `dshCompositionPatchVersion`，用于判断
「这次升级是否会动到我们依赖的组合行」。**该字段目前不存在**，本基线是它出现之前的
对照起点：升级前后各跑一次 `--diff`，就能得到「组合面实际发生了什么变化」。

### 2.6 一个自写的坑：用户层文件会被自动追加内容

实测用户层 `cordis.patch.yml` 末尾有一行自动写入的标记：

```
# worker junction sync 2026-09-03 01:33:42
```

**带时间戳的自动写入意味着这个文件会自己变**。因此：

- 本基线**刻意不采集注释**，只采集行 id / 包名 / config 键名——否则每次
  同步跑完 diff 都会红，基线立刻被当成噪音忽略。
- 若将来要把该文件纳入更严格的版本管理，应先确认这行由谁写、能否改为幂等写入。

---

## 3. 复现

```bash
node scripts/prt/composition-baseline.mjs --where     # 打印实际读到的路径
node scripts/prt/composition-baseline.mjs --record    # 采集（需 DSH_HOME）
node scripts/prt/composition-baseline.mjs --diff      # 查漂移（无需 DSH_HOME）
node --test scripts/prt/composition-baseline.test.mjs
```

`--diff` 与「与现状对账」的那条单测在**没有 DSH_HOME 的机器上会 skip 并说明原因**，
不会假装通过。CI 机器通常没有 Legion 的 DSH profile，这是预期的。

---

## 4. 已知未覆盖

- **未采集 DSH 侧（base / 模式 bundle）的行清单**。本基线只覆盖**用户层**——
  那是 Legion 自己写的那一层，也是升级时最可能冲突的一层。DSH 内部行数很多，
  全量快照会淹没真正关心的差异。需要时用 `apps/cli/composition.md`（`gen-doc-graphs` 产物）。
- **未记录配置解析优先级**（composition `config` > env > 默认）的完整规则链；
  `services-plugin` 内部的优先级已在其 `config-schema.mjs` 记录。
- **未验证组合行的实际激活顺序**（只记录了分层声明顺序）。DSH 的激活是服务可用性驱动的，
  要观测真实顺序需要运行时事件流。
- **`cordis.patch.yml.bak-prod` 未纳入基线**。那是现场留下的备份文件，
  不是组合的一部分；它说明有人手工编辑过这份文件，但这不属本基线范围。
