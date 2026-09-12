# PRT-607 接入审批箱与无人值守策略

> spec line 929：「`PRT-607`：接入审批箱和无人值守策略。」
> spec line 472：无人值守模式下，要求人工审批的操作**默认拒绝或保持等待**，不自动降级为允许。
> spec §6.6 line 451：`ask`、`allow-once` → `tools/pre-execute` → `ctx.approval`；
> 「Legion answerer 把请求写入审批箱；只有 `allowed-once` 执行」。
> spec §6.6 line 452：无人值守禁止询问 → `approval/policy=never`，DSH 在 answerer waterfall 前拒绝。
> spec line 495：Legion 必须声明**自己的** permission preset 表，不复用 DSH 默认表。
> spec line 1083：无人值守 preset 不得把 sandbox 降级为 `danger-full-access`。
> spec line 1084：承载 Run 的 session 在 Run 期间无法改写 approval policy 或 preset。

状态：**已交付**（两个半边）

- 审批箱那一半：`team-hub/run-store.mjs`（进入 `AwaitingApproval` 时真的建出可批的审批行）
- 无人值守那一半：`runtime/dsh-composition/approval-policy.mjs`
  （判据 `approval-policy.test.mjs` 14 例）

---

## 1 一句话

> **无人值守不是"没有人所以放行"，而是"没有人所以不能放行"。**

这一批要防的不是"审批箱坏了"，而是**"没有人"这件事被实现成一种权限**：

| 形态 | 它看起来像什么 |
| --- | --- |
| `policy=never` ⇒ 需要人的操作自动放行 | "没人可问，那就先干着" |
| 现场没人 ⇒ `ask` 变成放行 | "问不到人就当没人反对" |
| 审批超时 ⇒ 算通过 | "不能一直卡着" |
| 审批箱 `unavailable` ⇒ 算放行 | "箱子的故障不该阻塞业务" |
| `legion-unattended` ⇒ 沙箱同时升到 `danger-full-access` | "反正是无人值守" |
| Run 期间改 approval policy | "临时放宽一下" |

> 一个「无人值守时把需要审批的操作自动放行」的降级，
> 与一个「无人值守等于没有权限门」的实现，是同一个东西。

---

## 2 本批抓到的真问题

### 2.1 ★★★ 进了 `AwaitingApproval`，但**没有任何东西可批**（审批箱那一半）

`transitions.mjs` 为入边 `X → AwaitingApproval` 声明了
`requiresPersist: ['attempt','approval']`。但 `run-store.mjs` 里那个 `approval`
证据检查对**入边**刻意返回 `EVIDENCE_NOT_APPLICABLE`——理由是"有东西可批"这件事
正是这条迁移**自己**要创建的，要求它在 UPDATE 之前就存在是循环的。注释里写明这属于
PRT-607，并且指出：

> 一条任务可以停在 `AwaitingApproval` 而**没有任何东西可批**，而界面上它是一个待办。

后果不是"少了一层检查"，而是**用户会一直等下去**：

> 一个「进了等待审批、但没有任何东西可批」的状态，
> 与一个「任务卡住了」的状态，在「用户会不会一直等下去」上是同一个东西。

修法三条，缺一不可：

1. **同一次事务里建审批行**。`transition()` 在 `UPDATE run_attempts` 的**同一个事务**内调用
   一个新注入的 `createApproval` 端口。不是事务外补一句——那会留下"状态已经变成
   `AwaitingApproval`、但审批行还没写"的窗口，而那个窗口里进程被杀就是原始缺陷。
2. **没有端口就抛**，不静默跳过。`createApproval` 注入了才允许进 `AwaitingApproval`；
   缺端口时报 `APPROVAL_NOT_WIRED`。这是**装配**的错，不是这次请求的错。
3. **端口调用之后回查**。端口可能"被调用了但什么都没做"——那样状态与缺陷前**完全一样**，
   而事件流里那句 `requires_persist: ["attempt","approval"]` 看起来仍然像是被保证的。
   所以同事务内回查"属于这条 Attempt 的审批行现在存在吗"，不存在就抛
   `APPROVAL_NOT_CREATED`。

两个码分开是刻意的：

> 一个「把装配缺失报成请求非法」的诊断，
> 与一个「值班的人去改请求、而端口一直没接上」的诊断，是同一个东西。

**为什么是注入端口而不是直接 import `approval-binding.mjs`**：`run-store.mjs` 刻意不认识
其他模块的 schema（同一个文件里 `createTask` / `readPipeline` 就是这个先例）。直接 import
会让状态机仓储与审批表**强耦合**，而审批表的 schema 属于 `approval-binding.mjs`。

### 2.2 ★★★ `never` 只能产出 `deny`，不能产出任何形式的放行

包括"已经有过一次性批准"：

> 一个「policy=never 但带一次性批准就放行」的判定，
> 与一个「无人值守时，只要之前有人批过一次就永远放行」的判定，是同一个东西。

`allow-once` 这个 requirement 值看起来像"已经有人批过了"，但在 `policy=never` 的 session 里，
**批准本身就需要问人**——所以它和 `ask` 走同一条路：`deny`。

自检 `assertNeverNeverAllows` 穷举 3 种 requirement × 2 种 attended × 2 种 highRisk = 12 行，
断言"需要人"的 8 行**无一**放行、且决策集合恰好是 `['deny']`。

### 2.3 ★★★ `hold` 与 `deny` 是两件事，混起来会让人去追问一个从未被问过的人

| 决策 | 含义 | 审计上是 |
| --- | --- | --- |
| `deny` | 这次就是不行（`never` 是一个**决定**） | 一次拒绝 |
| `hold` | 现在问不到人，**保持等待**（人回来就能批） | 一次挂起 |

> 一个「把'问不到人'记成'人拒绝了'」的审计，
> 与一个「值班的人去追问一个从未被问过的人」的审计，是同一个东西。

同一条理由贯穿到审批箱结果的合并上：`unavailable`（"我们问不到人"）

- 在 `ask` 上 ⇒ **`hold`**（挂起），
- 不是 `deny`（那会把故障伪装成决策），
- 更不是放行：

> 一个「问不到人就当没人反对」的默认，
> 与一个「超时算通过」的默认，是同一个东西。

### 2.4 ★★★ 沙箱降级：`never` 与 `danger-full-access` 被绑在一起的那个坑

spec line 495 说得很具体：DSH 默认表把 `workspace-write`↔`ask` 与
`danger-full-access`↔`never` 绑定，**若按默认表实现「无人值守 = never」，沙箱会同时被
降级为 `danger-full-access`**。

> 一个「复用 DSH 默认 preset 表」的实现，
> 与一个「无人值守时沙箱悄悄升到 danger-full-access」的实现，是同一个东西——
> 只不过前者的代码里没有任何一行写着 `danger-full-access`。

所以 `assertPreset` 查两件事：① preset 名必须在 Legion 自己的表里（用
`default` / `danger-full-access` 这类 DSH 名字会抛）；② `legion-unattended` 的 sandbox
必须是 `workspace-write`。

### 2.5 ★★ 一条"检查一个不可能出现的值"的检查

第 ② 条在**真实表上永远为假**——`legion-unattended` 就是 `workspace-write`。
于是它看起来像一道防线，实际上从来没被执行过。

> 一个「检查一个不可能出现的值」的检查，
> 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。

修法：`assertPreset(preset, { table })` 让表可注入，用例传一张**被改坏的表**
（`legion-unattended` → `danger-full-access`）断言它抛。生产调用点不传这个参数。
同时留一个**对照组**：同一张被改坏的表里 `legion-attended` 仍然合法——
证明拦下来的是"降级"这件事本身，而不是"表坏了"。

### 2.6 ★★ 未知输入一律 fail-closed，不给默认值

| 不认识的输入 | 兜底的后果 |
| --- | --- |
| `policy` 拼错（`nver`） | 被当成 `ask` ⇒ 无人值守时会去问一个不在场的人 |
| `requirement` 缺失 | 被当成 `none` ⇒ **一切都放行** |
| `attended` 缺失 | 被当成"现场有人" ⇒ 去问一个不在场的人 |
| 审批结果不在闭集 | 被当成放行 ⇒ 审批箱坏了也照过 |

> 一个「不认识的 policy 就按 `ask` 处理」的兜底，
> 与一个「拼错的 `nver` 被当成 `ask`、于是无人值守时会去问一个不在场的人」的兜底，
> 是同一个东西。

`requirement` 缺失那条最要紧：它默认成 `none` 就是"这一批要防的那件事"本身。

---

## 2.5 ★ 顺带修掉的一条真实竞态（不是本批引入的，但本批把它撞出来了）

PRT-607 的全量 CI 在 `test` 阶段偶发失败，失败套件是 P1-1 立的那个迁移竞态回归锚点
`scripts/ci/dual-write-smoke.test.mjs`。**与 PRT-607 无关**——我在未改动的 HEAD
（`63c9a7c`，已推送的 PRT-606 提交）上复现了（6 次里 1 次）。

### 根因

崩溃点不在 2026-09-10 修过的 `server.mjs`，而在**后来从 server.mjs 抽出去**的
`team-hub/approval-binding.mjs`。完整 stderr（8 轮复现命中 1 轮）：

```
team-hub/approval-binding.mjs:117
    if (!cols.includes(name)) db.exec(`ALTER TABLE ${APPROVAL_TABLE} ADD COLUMN ${name} TEXT`)
Error: duplicate column name: bindingHash
    at ensureApprovalSchema (…/approval-binding.mjs:117:34)
    at …/team-hub/server.mjs:939:1     ← 模块加载期
```

`ensureApprovalSchema` 自己写了一段「读一次 `PRAGMA table_info`，不在清单里就 `ALTER`」
——**正是 2026-09-10 修掉的形状**，只不过它在另一个文件里。

> 一个「修好了当时那 25 处」的修复，
> 与一个「第 26 处是后来新写的、于是坏在同一个地方」的修复，是同一个东西——
> 只不过后者在代码审查里看起来是幂等的。

这也正是 `schema-util.mjs` 头注释早就写过的那句：「一份微妙的并发原语存在两份实现时，
其中一份迟早会腐烂」。修法：补列走 `ensureColumn`（`BEGIN IMMEDIATE` 内重读）。

### 顺手扫出**第三处**

修完这一处后，我按同一形状扫了全仓库（`PRAGMA table_info` / `ALTER TABLE`），
又发现 `server.mjs` 里的一处——它换了个形状，危害不同：

```js
// 老库自动补列；已存在则 ALTER 抛错被吞。
for (const col of ['taskId TEXT', 'goalId TEXT', 'recurrence TEXT']) {
  try { db.exec('ALTER TABLE calendar_events ADD COLUMN ' + col) } catch { /* 列已存在 */ }
}
```

它不是竞态（`try/catch` 恰好对"列已存在"是安全的），而是**把两件不同的事吞成一件**：

| 被吞掉的 | 是什么 |
| --- | --- |
| `duplicate column name` | 列已经有了，**正常** |
| 磁盘满 / 表被锁 / 库只读 / SQL 写错 | 列**真的没加上**，而这里一声不响 |

后者的后果不在启动期出现，而在几周后某个不相干的查询报 `no such column: taskId`
——那时没人会想到"几个月前的一次启动时那条 ALTER 失败了"。

> 一个「把'加列失败'吞成'已经有了'」的迁移，
> 与一个「某个查询在几周后报 no such column」的迁移，是同一个东西——
> 只不过前者在启动日志里看起来一切正常。

`server.mjs` 里其余 **33 处**补列早就走 `ensureColumn` 了，这是漏掉的一处。

### 把它变成**类**级不变量（而不是只修这两个点）

`scripts/ci/dual-write-smoke.test.mjs` 新增第 3 个锚点：直接扫生产源码，
禁掉两种形状——① 自己 `db.exec('ALTER TABLE …')`；② 把 ALTER 包在 `try/catch` 里吞掉。
唯一允许自己写 ALTER 的地方是 `schema-util.mjs` 的 `ensureColumn` 内部。

扫描面自检**不是**"文件数够多"，而是"那几个真正会跑迁移的文件必须在扫描面里"
（`server.mjs` / `approval-binding.mjs` / `run-store.mjs`）：

> 一个「数了数有 90 个文件」的自检，
> 与一个「确认那两个真正会跑迁移的文件在扫描面里」的自检，不是同一个东西。

★ 两个分支**合并成一个断言**报告。第一版写成两条 `assert.deepEqual`，
破坏性验证时暴露了问题：故意注入的坏形状同时命中两个分支，而**只有第一条被报出来**
——第二条在这次运行里从来没被执行过。

> 一个「排在后面、于是从没被跑到」的断言，
> 与一条不存在的断言，在"它到底拦住了什么"上是同一个东西。

破坏性验证覆盖三种形状，确认两个分支**各自独立**成立：

| 注入的形状 | `[自己 exec ALTER]` | `[try/catch 吞掉 ALTER]` |
| --- | --- | --- |
| `server.mjs` 的 `try { db.exec(ALTER) } catch {}` | ✅ 命中 | ✅ 命中 |
| `approval-binding.mjs` 的裸 `db.exec(ALTER)`（无 try） | ✅ 命中 | —— 不该命中，确实没有 |
| ALTER 交给 helper、自己包 `try/catch`（同一行无 `.exec(`） | —— 不该命中，确实没有 | ✅ 命中 |

完整现场与读数以 §10「同一竞态的第二处实例」追加在
`docs/DUAL-WRITE-RACE-evidence/verify-evidence.md`（原 §1–§9 是 2026-09-10 那次的定性，
不改原结论）。

---

## 3 ★ 本批最强的不变量：审批结果不能覆盖一个不放行的决定

`applyApprovalOutcome` 里唯一不能被删掉的那一行：

```js
if (verdict.allowed === false && verdict.decision !== 'ask' && grants) {
  throw fail(POLICY_CODES.UNATTENDED_WOULD_ALLOW, ...)
}
```

> 一个「已经决定不放行的调用被一个"允许"结果覆盖」的实现，
> 与一个「无人值守时只要审批箱说行就行」的实现，是同一个东西。

`deny` 与 `hold` 都是"已经不放行"——它们**不是**"待定"。一个 `allowed-once`
结果与它们矛盾，所以是**抛**而不是"以结果为准"：这不是能用默认值化解的分歧，
而是说明调用方把两件事接错了。

`ask` 是唯一的"待定"：它遇到 `allowed-once` 才变成放行，遇到
`rejected`/`cancelled` 变成 `deny`，遇到 `unavailable` 变成 `hold`。

自检 `assertOnlyAllowedOnceGrants` 断言放行的结果**恰好一个**（`allowed-once`）——
不是"除了拒绝之外的都放行"。

---

## 4 ★ 两份结果闭集必须一致（而它们无法互相 import）

`approval-policy.mjs` 与 `enforcement.mjs` 是同一层的两个模块，互相 import 会成环，
所以两边各有一份 `['allowed-once','rejected','cancelled','unavailable']`。

但"两份"在这里是**危险**的：

> 一个「本模块认为 `unavailable` 是合法结果、而审批箱那一侧从不产出它」的差异，
> 与一个「超时永远走不到该走的那条分支」的差异，是同一个东西。

解法：模块导出 `approvalOutcomeSet()`，**测试**同时 import 两边并断言两集合相等
（测试可以，模块不行）。另有一条用例断言"闭集之外的值必须抛"，逐个试
`'allowed'` / `'ok'` / `'yes'` / `true` / `null` / `undefined` / `''`。

---

## 5 诚实边界

1. **两个半边都还没有在真实链路上跑过。** `approval-policy.mjs` 是一个**判定函数**，
   没有任何调用点；`run-store.mjs` 的 `createApproval` 端口在 `server.mjs` 里有了实现
   （`createAwaitingApprovalInTx`），但**工具级**的暂停路径（`Running → AwaitingApproval`）
   没有任何套件通过 HTTP 走过一遍——目前只有验收路径
   （`Validating → AwaitingApproval`，由 `acceptance-routes.test.mjs` 覆盖）在 HTTP 上跑过。
   所以"审批箱形成可用闭环"这句话仍然**不成立**。
2. **审批行的写入路径与 `approval-policy.mjs` 的判定还没有接起来。**
   `server.mjs` 合成的是 `runtime:delivery-approval` 这个动作，**不经过**
   `decideApproval()`。也就是说：无人值守策略目前管不到"要不要为这条审批行建一个待办"。
   把两者接起来属于 PRT-612（固定映射）的范围。
3. **`assertKnobsUnchanged` 只做判定，不做审计与持久化。** spec line 1084 还要求
   "任何改写都留下审计记录"——那属于 PRT-619。本模块只保证"Run 期间改了会被拒绝"。
4. **`attended` 是一个调用方提供的布尔值。** 本模块无法验证它是不是真的。
   一个把 `attended` 硬编码成 `true` 的调用点会绕过 §7 的全部保护——
   而这正是"无人值守"必须由**配置**（`policy=never`）而不是由**运行时探测**来决定的理由。
   `policy=never` 那条分支不依赖 `attended`，所以它是硬的。
5. **`hold` 之后谁来唤醒没有实现。** 一条 `hold` 的判定需要一个"人回来了"的事件来重新判定，
   本模块不提供等待队列、不提供超时、也不提供重放。
6. **`highRisk` 是透传的，本模块不做分类。** 分类在 PRT-606（`external-api-scope.mjs`）与
   `tool-capability.mjs` 里。本模块把它带进判定对象只是为了审计能复原上下文。
7. **`assertPreset` 的沙箱检查只对 `legion-unattended` 这一个名字生效**（名字是硬编码的）。
   新增第三个无人值守档位时，这条检查**不会**自动覆盖它。
8. **`approval-policy.mjs` 与 `patch-layer.mjs` 是单向依赖。** 前者 import 后者的
   `LEGION_PERMISSION_PRESETS` 常量，所以本模块不能反过来被 patch-layer 使用。
9. **审批行的字段填充由注入端口决定。** 本模块（run-store 那一半）只保证"有一行属于这条
   Attempt 的审批行存在"，不保证它的 `scope`/`mode`/`bindingHash` 填对了——
   那些属于 `approval-binding.mjs` 与 PRT-608 的范围。
10. **`createAwaitingApprovalInTx` 的幂等复用有一个未覆盖的窗口。** 它按
    `status IN ('pending','approved')` 复用开放行；一条已经 `consumed` 或 `expired` 的行
    不会被复用，于是同一 Attempt 再次进入 `AwaitingApproval` 会**新建**一条。
    这在"重试是一条新 Attempt"的纪律下是对的，但"同一 Attempt 内两次进入等待"的语义
    没有被任何用例钉住。
11. **本批改了 4 个既有测试文件**（`acceptance-store` / `approval-ttl` / `handoff-store` /
    `run-store`）。改动全部是**追加夹具**（注入 `createApproval` 端口）或**重建前置状态**
    （`approval-ttl` 的两条用例先 `DELETE` 掉自动建出的那一行，才落回它们原本要考的
    "没有审批行"这个前提）。**没有削弱或删除任何既有断言**；但这是本批最需要人复核的地方。

---

## 6 验证

- `runtime/dsh-composition/approval-policy.test.mjs`：**14 例全绿**。
- `team-hub/run-store.test.mjs`：43 例（含本批新增 4 例）；受影响的
  `acceptance-store` / `approval-ttl` / `handoff-store` / `acceptance-routes` /
  `claim-policy` 等套件全部保持绿。
- 破坏性验证：**30/30 处补丁全部变红**（`break-607.mjs`，探针 ㊷①–㊷㉚）。
- 六道门禁全绿。

### 6.1 本次基线 `--record` 的说明

`scripts/prt/baseline-snapshot.mjs --check` 报出 `team-hub/server.mjs` 与
`team-hub/run-store.mjs` 的**源文件哈希**变了。逐项核对过：

- 路由 **136**（不变）、数据表 **34**（不变）、任务状态 7 / 迁移边 20（不变）、
  目标状态 4（不变）、权限模式 5（不变）；
- 基线文件的实际 diff **只有 `sources` 里的两个 sha256**，`routes`/`tables`/状态
  这些契约项一个字节都没动。

也就是说这是"契约承载文件被改了，但契约本身没变"。`--record` 之后 `--check` 复绿。

> 顺带一提：这道门禁的**价值**恰恰在于它会为了"文件变了"而拦一次。
> 如果它只比路由与表、不比源文件哈希，那么一次"改了强制面的实现但没加路由"
> 的提交会被它默默放过——而那正是最需要人看一眼的那一类改动。

### 6.2 探针与自检的修正记录

| 对象 | 情况 | 处置 |
| --- | --- | --- |
| ㊷⑬（原"允许复用 DSH 默认 preset 表"） | 改的是 `const known = ...` 那一行，但 `known` 只被**读取**，改动不影响任何断言 ⇒ **不可能红** | 改成把"未知 preset"那条 `throw` 换成返回 DSH 默认语义（`danger-full-access`），于是 `assertPreset('default')` 不再抛，`unknownPresetCode` 期望落空 |
| ㊷⑱（原"`requirement` 不认识时按 `none` 兜底"） | 把 `if (throw)` 改成 `if (...) { requirement = 'none' }` 之后，代码紧接着仍落到**同一个** `throw` ⇒ 行为不变 | 改成同时保留原 `throw` 并把新增分支写成 `if (false) { throw }` 的形状，使兜底真的生效 |
| ㊷㉑（原"旋钮比较被删掉"） | `changed` 只在那一处被写，删掉写操作后"变了"那条分支只是**永远不会执行**，而"没变"的结论不变 ⇒ **不可能红** | 换成语义等价的**方向反转**探针：`!==` 改成 `===`，于是"没改"被判成"改了" |
| ㊷㉚（原"降级错误信息被换掉"） | 替换成正常返回之后，代码继续落到函数末尾**同一个** `return` ⇒ 行为不变 | 改成一个**能**红的等价探针：让降级那条返回 `undefined`（不抛也不返回合法对象） |

| 对象 | 情况 | 处置 |
| --- | --- | --- |
| 沙箱降级检查 | 在真实表上**永远为假**（`legion-unattended` 就是 `workspace-write`），是一条从不执行的检查 | `assertPreset` 接受可注入的 `table`，用例传被改坏的表证明它真的会拦，并留对照组证明拦的是"降级"而不是"表坏了" |
