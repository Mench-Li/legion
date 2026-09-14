# PRT-315（切片 5）：拆分 `plugins/src/index.ts` —— 验收与沉淀（验收边界）

spec（`docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md:882`）：

> `PRT-315`：按仓储、状态机、workspace、验收和交接边界拆分 `plugins/src/index.ts`，每次只迁移一个切片。

前四个切片：`./mediation.ts`（交接）、`./reclamation.ts`（仓储）、`./stateMachine.ts`（状态机）、
`./workspace.ts`（workspace）。本切片是**第 5 个**，取「验收边界」——`sweep()` 里
`// 4.2` ~ `// 4.5a` 四段**任务 done 之后**的结算与自检。

新模块：`plugins/src/acceptance.ts`（426 行，LF）；新用例：`plugins/tests/acceptance.test.mjs`（603 行）。

---

## 1. 搬了什么、没搬什么

### 搬了（231 行，逐字）

| 段 | 内容 | 提取坐标（改前） |
| --- | --- | --- |
| 4.2 | 注释 + `expSettled` + `settleExperience()` | 937–940 / 944–969（30 行） |
| 4.3 | 注释 + `taskScanText` + `collectVoteEvents` | 971–976 / 979–1007（35 行） |
| 4.3 | `sweepExperienceVotes()` | 1174–1225（52 行） |
| 4.4 | 注释 + `runRuleDoctorNow()` | 1382–1421（40 行） |
| 4.5a | 注释 + `dshSkillsDir` / `readExistingDshSkills` / `applySkillPlan` / `syncSkillsToDsh` | 632–705（74 行） |

对外形状与其它切片一致：`createAcceptance(deps)` 返回
`{ settleExperience, sweepExperienceVotes, runRuleDoctorNow, syncSkillsToDsh }`，
`index.ts` 只做接线，调用顺序照旧 `// 4.2 → 4.3 → 4.4 → 4.5a`。

### 没搬（**每一处都点名**）

| 没搬的东西 | 为什么 |
| --- | --- |
| `promoteDraft()`（4.3 的 promote **动作**） | 要 `ensureForeman` + `ctx.subagents.start` + `hubPost` + learnings/register 落盘。搬进来会让**新增文件**出现执行面记号 → `dsh-boundary` 棘轮当场红。故只搬**票务与判定**，动作由构造点作为**兄弟能力**注入（与 `mediation.ts` 注入 `safeComment`/`advanceTo` 同形）。`expPromoting` / `expPromoteRetryAt` 两个每实例状态随之留在 `index.ts`。 |
| `expDraftDir()` / `expLearningDir()` | 仓库根解析属 **workspace 边界**；且 `recallCorpus()`（召回注入）与 `promoteDraft()`（晋升落盘）两个**非验收边界**的读者也读它。故 `draftDir` 由调用方注入。 |
| `readRepoNormsFiles()` / `readNormsTombstones()` / `readNormsSync()` | **规范注入边界**（`buildWorkerPrompt` 也用 `readNormsSync`）。搬进来要么留第二份定义（任务禁止），要么让提示词装配反向依赖验收模块。故注入。 |
| `pendingRecallRefs` / `recallCorpus` / `recallSectionCache` / `recallForTask` | P2-③ **召回注入**（worker 提示词装配）的产物，本模块只是消费方（读 + `clear()`）。按 `mediating` 的先例，同一份 Map 由外部持有。 |
| `lastInjectedNorms` / `normsGlobalText` | `buildWorkerPrompt()` / `refreshNorms()` 每轮改写的 `let`，**按取值函数注入**（所有权仍在 `index.ts`）。 |
| `lastRuleDoctor` | 由本模块**写**、由 `writeDaemonStatus`（daemon.json 的 `rulesDoctor` 字段，**非**验收边界）**读**。按 `workspace.ts` 的 `binding` 先例，所有权留在调用方，注入 `{ get, set }` **访问器**。 |

### `// 4.`（`advancePipeline`）与 `// 5.`（`orchestrateSlices`）**未动**

它们是流水线补流转 / 切片编排边界，不是「任务完成后的结算」。`// 4.5 合入调解` 也**未动**（切片 1 已搬）。

---

## 2. 行数与用例

| | 改前 | 改后 |
| --- | --- | --- |
| `plugins/src/index.ts` | **3069 行**（全 CRLF） | **2862 行**（全 CRLF，裸 LF = 0） |
| `plugins/src/acceptance.ts` | — | **426 行**（全 LF） |
| `plugins/tests/acceptance.test.mjs` | — | **603 行**（全 LF） |
| `runtime/adapters/dsh/parity.mjs` | 593 行 | **614 行**（全 CRLF；只增 JSDoc 注释块） |

```
$ git diff --stat -- plugins/src/index.ts
 plugins/src/index.ts | 297 ++++++++-------------------------------------------
 1 file changed, 45 insertions(+), 252 deletions(-)
```

净 −207 行；其中锚点**之上** −217 行（4.5a −72 / 4.2 −26 / 4.3 注释+事件扫描 −29 /
4.3 票务扫单 −50 / 4.4 −36 / import 净 −4），锚点**之下** +10 行（调用点 16→9、接线 1→18）。

用例：**300 → 337**（本切片新增 37 条，全部在 `acceptance.test.mjs`），**0 fail**。

```
ℹ tests 337
ℹ suites 10
ℹ pass 337
ℹ fail 0
```

---

## 3. ★ 每实例状态 / 取值函数 / 访问器 / 兄弟能力

1. **每实例状态**：`expSettled` 活在 `createAcceptance()` 的**工厂闭包**里，不是模块级变量。
   `superviseSpaces()` 会在同一进程里按空间 mount 多个 `spaceWorker`
   （`index.ts` 的 `mountRunner`），它们共用一个模块注册表；模块级 `expSettled` 会让空间 A 的
   done 任务把空间 B 的同名 taskId 一起挡住——多空间部署里任务 id 只在空间内唯一。
   本模块**没有任何模块级可变状态**（顶部只有 import 与类型）。
2. **取值函数**：`useHub` / `hubUrl`（`detectHub()` 改写）、`normsGlobalText`（`refreshNorms()` 每轮刷新）、
   `injectedNorms`（`buildWorkerPrompt()` 每次派工写一次）四个 `let` 一律 `() => x`。
   传值的症状：技能桥永远看不到 hub（一次都不同步出去）、doctor 拿一份空产物比对
   （把**全部**规则判成 missing）。
3. **访问器**：`ruleDoctor: { get, set }`——本模块是写者不是拥有者。不用「返回值由调用方回写」，
   因为 doctor 的**状态变化比较**必须在 `set` 之前读到旧报告；回写会把读取推到调用方，
   而调用方手里没有上一轮报告。
4. **兄弟能力**：`promoteDraft` 原样注入（名字不变，故旧代码那两行 `void promoteDraft(...)`
   一字未改）。
5. **传值**：`config`（结构性类型 `{ mode, dshSkillsDir }`，不 import `Config` 以免真的循环依赖——
   `Config` 来自 `index.ts` 的 zod schema）、`log` / `scope` / `activity` / `draftDir`（const 箭头）、
   `pendingRecallRefs`（身份稳定的 Map，内容会变、对象不换）。

---

## 4. 验证一：搬迁**逐字对拍**（7 条改写规则）

`_prt-handoff/prt315e-compare.mjs`：before 取 `git show HEAD:plugins/src/index.ts`，
after 取 `plugins/src/acceptance.ts`；两侧用**各自的锚点**切块（不复用组装脚本的行号），
归一化（去纯空行 / 去公共缩进 / 去行尾空白）后逐行比较。

```
形态自检 12/12 通过
旧块行数：4.2 注释=4  4.2 settleExperience=26  4.3 注释=6  4.3 taskScanText + collectVoteEvents=29  4.3 sweepExperienceVotes=52  4.4 注释 + runRuleDoctorNow=40  4.5a 技能桥=74
新块行数：4.2 注释=4  4.2 settleExperience=26  4.3 注释=6  4.3 taskScanText + collectVoteEvents=29  4.3 sweepExperienceVotes=52  4.4 注释 + runRuleDoctorNow=40  4.5a 技能桥=74

✔ 4.2 注释：4 行逐字一致（归一化后）
✔ 4.2 settleExperience：26 行逐字一致（归一化后）
✔ 4.3 注释：6 行逐字一致（归一化后）
✔ 4.3 taskScanText + collectVoteEvents：29 行逐字一致（归一化后）
✔ 4.3 sweepExperienceVotes：52 行逐字一致（归一化后）
✔ 4.4 注释 + runRuleDoctorNow：40 行逐字一致（归一化后）
✔ 4.5a 技能桥：74 行逐字一致（归一化后）

改写规则白名单（穷尽，共 7 条）：
  /\bexpDraftDir\(\)/g  →  draftDir()
  /\buseHub\b/g  →  useHub()
  /\$\{hubUrl\}\/api\/skills/g  →  ${hubUrl()}/api/skills
  /\blastInjectedNorms\b/g  →  injectedNorms()
  /globalText: normsGlobalText,/g  →  globalText: normsGlobalText(),
  /const prev = lastRuleDoctor\b/g  →  const prev = ruleDoctor.get()
  /lastRuleDoctor = report\b/g  →  ruleDoctor.set(report)

结论：PASS（搬家逐字一致，只放行上面这份规则）
```

**没有改变的行为**（逐项）：日志串与 `activity(...)` 文案、调用顺序、`try/catch` 的吞错范围、
**两种「跳过」的判定次序**（内存 Set 先查先置位，磁盘 `existsSync` 后查）、friction 阈值与
`shouldDraft` 的第二道闸门、文件/目录拼法、`planSkillSync` 的收敛协议、doctor 的
「状态变化才 log」比较键、`promoteDraft` 拿到的**改动前**正文、sweep 的 `pendingRecallRefs`
「消费完即清」时点。

---

## 5. 验证二：断验证 7 组 —— **6 组咬住、1 组没咬住（真缺口，已补）**

`_prt-handoff/prt315e-breakverify.mjs`：改源码（必要时连用例夹具一起改）→ 重建 `lib` →
跑 `tests/acceptance.test.mjs` → 存**原始红输出** → 按 pristine 备份**逐字节还原**（sha256 相等）→ 重建 → 复绿。

```
pristine sha256：
  src  34b8b7ebda482fe138ac2dfb8bfb00594cfad6bc7325b659346edcd5e9e8f2d2
  test 9651ef5189257428ff56e2d752e3ba895f9df8f2c3f465e07ac6816a09a0e4ca

  咬住  M1  4.2 删掉「盘上已存在」闸门（existsSync 短路）
  咬住  M2  4.2 删掉「先记再干活」（expSettled.add 置位）
  咬住  M3  4.4 去掉「状态变化才 log」（每轮都记）
  咬住  M4  4.5a 模式闸门放宽（mediator 也写用户级技能目录）
  咬住  M5  4.3 去掉 prune 判定（90 天无票不再 stale）
  咬住  M6  4.5a 只删 `..` 那道闸门（夹具已含 id="..evil"）
  ★ 没咬住  M6-pre  4.5a 只删 `..` 闸门 + **摘掉夹具里 id="..evil" 那两行**（对照：应当咬不住）

还原后：构建 OK，用例 ℹ pass 37 / ℹ fail 0（exit=0）
  src 还原后 sha256 = 34b8b7ebda482fe138ac2dfb8bfb00594cfad6bc7325b659346edcd5e9e8f2d2
  test 还原后 sha256 = 9651ef5189257428ff56e2d752e3ba895f9df8f2c3f465e07ac6816a09a0e4ca
```

**没咬住的那一组是真缺口，不是"变异选得不好"**：`acceptance.ts` 的 id 过滤是
`!s.id.includes('/') && !s.id.includes('..')` 两道闸门；我最初的夹具只有
`'../escape'` / `'a/b'` / `''` —— 前两个都被 `'/'` 那道拦住、第三个被长度拦住，
**所以单独删掉 `..` 那道闸门，原来的用例一条都不红**。这意味着一个只含 `..` 的 id
（如 `..evil`，不含 `/`）能绕过当时的测试网。我据此加了夹具
`{ id: '..evil', ... }` 与断言 `existsSync(join(dir, '..evil')) === false`，
再跑 M6 → 咬住；M6-pre（把那一行摘掉）→ 不咬住。**两组对照都跑过，结论是实测的，不是推断的。**

（M6 的红输出里能看到实际被建出的目录与成功日志，说明这不是"断言写错导致的假红"。）

---

## 6. 验证三：逻辑只有一处（按**构建产物**查，不按源码查）

`_prt-handoff/prt315e-singleplace.mjs` 只读 `lib/*.js`（源代码里两处都在，
容易"看着源码下结论"）。注意：构建产物**保留注释**，所以指纹串必须取
**运行期字符串**而不是短语（第一版用 `经验草稿落盘`，被 `index.ts` 里那条解释性注释
误判成"仍在 index"——这条已修正并写进脚本注释）。

```
lib/index.js = 2769 行；lib/acceptance.js = 391 行

✔ "→ 经验草稿落盘："：acceptance.js=true  index.js=false
✔ "经验草稿已生成"：acceptance.js=true  index.js=false
✔ "经验草稿生成失败"：acceptance.js=true  index.js=false
✔ "经验票务扫单失败"：acceptance.js=true  index.js=false
✔ "经验草稿 ${f} 票务更新失败"：acceptance.js=true  index.js=false
✔ "【规则 doctor】"：acceptance.js=true  index.js=false
✔ "规则注入缺失"：acceptance.js=true  index.js=false
✔ "技能桥同步失败"：acceptance.js=true  index.js=false
✔ "技能桥落盘失败"：acceptance.js=true  index.js=false
✔ "技能桥："：acceptance.js=true  index.js=false

✔ 保留了 "经验草稿晋升为"：index.js=true  acceptance.js=false
✔ 保留了 "经验草稿 promote 失败"：index.js=true  acceptance.js=false
✔ "activity('experience', draftTaskId"：index.js=true  acceptance.js=false

✔ acceptance.js 不含执行面记号 "ctx.subagents"：false
✔ acceptance.js 不含执行面记号 "@deepseek-ai/dsh-"：false

结论：PASS（搬走的只有一处，留下的也只有一处）
```

**唯一"两处都有"的定义**：`ruleDoctor` 报告的**产出**搬了、`writeDaemonStatus` 里的
**投影**（`daemon.json.rulesDoctor` 的 6 个字段）留在 `index.ts`——那不是逻辑重复，
是**消费者**，由访问器读同一份报告。

---

## 7. 棘轮一：`dsh-parity` 2007 → **1790**（对拍出来的，不是算出来的）

先在改后源码上跑 `node --test runtime/adapters/dsh/parity.test.mjs` —— **5 条当场红**，
其中一条是「`plugins/src/index.ts:2007` 处未找到旧调用 → 对拍已失去意义」。
然后用 `parity.mjs` **自己的抽取器**逐个调用点求顶层选项集合：

```
旧调用记法 = "ctx.subagents.start("（本脚本不写出它的字面形式）
期望选项集 = label, prompt, parent, signal, outputSchema, ...spread
旧锚点 = 2007
index.ts 行数 = 2862

调用点总数 = 4 （上一批记录 4）
各行号 = 993, 1790, 2003, 2415

  行   993  选项 = [label, prompt, parent, signal, outputSchema]
  行  1790  选项 = [label, prompt, parent, signal, outputSchema, ...spread]   ← ★ 与期望完全一致
  行  2003  选项 = [label, prompt, parent, signal, outputSchema]
  行  2415  选项 = [label, prompt, parent, signal, outputSchema, agentOptions]

与期望选项集完全一致的调用点 = 1 个： 1790
★ 结论：新行号应为 1790（原 2007）——唯一，可安全改写 LEGACY_CALL_SITE.line
  位移 = -217 行
  算术会给出 1790（2007 − 217），与实际相差 0 行 ⇒ 本批算术恰好也对（这正是最容易蒙对的一次）
```

**⚠️ 算术又恰好对了（切片 4 也是）。** 切片 2/3 的算术都不对、切片 4/5 的都对——
决定对不对的从来不是记性，而是「被搬走的行是否**全部**在锚点之上」这一事实。
本次之所以对，是因为四段全在 632–1421 行（锚点之上），锚点之下那两处改动（16→9、1→18）
不计入位移。规矩不变：**每次都重新对拍**，算术只用来解释位移，不用来产出新行号。

重钉：`_prt-handoff/prt315e-repin-parity.mjs`（注释插在 JSDoc 的 `*/` **之前**——
切片 3 插在之后，导致 `parity.test.mjs` 解析红而不是断言红）。重钉后：

```
ℹ tests 36  ℹ pass 36  ℹ fail 0
```

---

## 8. 棘轮二：`dsh-boundary` 未增长（3 个文件 / 26 处）

```
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）
```

新文件 `acceptance.ts` 对执行面记号的贡献是 **0**：本模块不 import 任何
`@deepseek-ai/dsh-*`，也不出现 `ctx.*` 执行服务；`promoteDraft` 正是因此才不搬。
这一条有两个独立佐证：上表的 singleplace 检查，以及 `parity.test.mjs` 自带的
「本模块对执行面记号贡献 0」用例。

---

## 9. 验证读数（原始输出）

```
$ npm run typecheck        # DSH_CHECKOUT 已设置
> tsc -p tsconfig.json --noEmit
（无输出，exit 0）

$ npm test
ℹ tests 337
ℹ suites 10
ℹ pass 337
ℹ fail 0

$ node --test runtime/adapters/dsh/parity.test.mjs
ℹ tests 36
ℹ pass 36
ℹ fail 0

$ node scripts/ci/dsh-boundary.mjs --check
dsh-boundary: PASS（执行面依赖未增长：3 个文件 / 26 处，均在基线内）

$ git diff --stat -- plugins/src/index.ts
 plugins/src/index.ts | 297 ++++++++-------------------------------------------
 1 file changed, 45 insertions(+), 252 deletions(-)
```

---

## 10. ⚠️ 诚实边界（每条都按"**没验到什么**"写）

1. **sweep 的调用顺序没有任何执行期用例**。`// 4.2 → 4.3 → 4.4 → 4.5a` 这四行的先后
   在 `index.ts` 的 `sweep()` 里，**不在本模块**。我的排序用例钉住的是
   「两个方法**是有序依赖的**：先 sweep 无草稿 → 本轮零票；先 settle 再 sweep → 当场得票」，
   `*不是*`「`index.ts` 里那四行的顺序」。把 `index.ts` 里 `settleExperience` 与
   `sweepExperienceVotes` 对调，**不会红任何一条用例**——这一条只有读接线（或 review diff）才能发现。
2. **`promoteDraft` 是替身**。用例证明的是「门槛够了 / 动的是哪一份正文 / 每轮至多一次」，
   **不**证明真实 AI 改写、hub register、learnings 落盘（这些仍在 `index.ts`，属执行面）。
3. **`fetch` 是替身**。只断言请求 URL 与由它驱动的收敛结果，**不**证明真实 team-hub 行为。
4. **`~/.dsh/skills` 的实际回落路径没有任何用例**。`config.dshSkillsDir` 为空时会回落到
   `join(homedir(), '.dsh', 'skills')`——用例**故意**不碰它（那是操作员的活体 harness）。
   被验证的只有：配置位注入（临时目录）、空白串（`'   '` → trim 后空 → 直接 return）。
   `dshSkillsDir()` 里那句 `|| join(homedir(), '.dsh', 'skills')` 本身**逐字未改**，
   但它**没有**被任何断言执行过。
5. **`writeDaemonStatus` 对报告的投影未新增用例**。`daemon.json.rulesDoctor` 的 6 个字段
   （ok/truncated/removedSources/total/present/missing）是 `index.ts` 里的**消费者**，
   本切片没动、也没加断言；既有端到端用例是否覆盖它，我**没有逐一核实**。
6. **对拍是"归一化后"的逐字**。`prt315e-compare.mjs` 会丢掉纯空行与行尾空白再比——
   一个**多余/缺失的空行**不会被这条检查抓到（我确实在 4.2 注释与 `expSettled` 之间
   插入了一个空行，改动前的源文件那里没有空行）。
7. **doctor 的 `恢复` 分支在现有代码里不可达**（既有怪癖，非本切片引入）：
   `report.ok === true` 蕴含 `missing.length === 0`，所以 `missing.length > 0` 时
   `report.ok` 恒为 false → 三元的那一支永远取 `'告警'`。我**没改**它，也**没测**它；
   只在「缺失 → 补齐」用例里断言真实会发生的 `全部进了提示词 ✓` 文案。
   同理 `total === 0`（没有任何规则单元）时 doctor **一条日志都不记**，也没测。
8. **`activity('rules-doctor', ...)` 只在告警时发**，恢复时不发——我用例覆盖了告警分支；
   恢复分支（不可达）未覆盖。
9. **`pendingRecallRefs` 的写入方（`recallForTask`）不在本切片**。模块侧只测了
   「拿到同一份 Map → 记票 → 清空」；注入方是否真的登记正确，仍由召回注入那部分负责。
10. **`M6-pre` 是唯一没咬住的变异**，且它是**我自己的夹具缺口**（不是产品代码缺口）：
    已补（新增 `id: '..evil'` 夹具 + 断言），补后 M6 咬住、M6-pre 仍不咬住（对照成立）。
11. **行尾**：`index.ts` 改后仍为纯 CRLF（2862 CRLF / 0 裸 LF）；`acceptance.ts`
    与 `acceptance.test.mjs` 为纯 LF（与切片 1–4 的新模块一致）；`parity.mjs` 纯 CRLF（614）。
    注意仓库里 `git show HEAD:plugins/src/index.ts` 给出的是 **LF blob**（3069 行），
    工作区是 CRLF——行数一致，行尾由 checkout 转换；本文档的"改前 3069 行"取自
    `git show`（见 `_prt-handoff/prt315e-count.mjs`）。
12. **未跑全量 CI**（任务禁止 `scripts/ci/run-ci.mjs`）；本切片只跑了任务点名的门禁与
    `plugins` 的 build/test/typecheck。

---

## 11. 留痕（scratch 脚本，都在 `D:\project\DSH\legion\.worktrees\_prt-handoff\`）

| 脚本 | 作用 |
| --- | --- |
| `prt315e-module.mjs` | 从旧 `index.ts` 切块 + 白名单改写 → 组装 `acceptance.ts` |
| `prt315e-index.mjs` | 摘定义、插接线、换调用点、收 import（CRLF 原样写回） |
| `prt315e-compare.mjs` | 独立第二次抽取 → 逐字对拍（第 4 节） |
| `prt315e-singleplace.mjs` | 按构建产物查"逻辑只有一处"（第 6 节） |
| `prt315e-rederive-parity.mjs` | 用 `parity.mjs` 自己的抽取器重钉锚点（第 7 节） |
| `prt315e-repin-parity.mjs` | 写回新行号 + 注释（插在 JSDoc `*/` 之前） |
| `prt315e-breakverify.mjs` | 7 组断验证 + 还原校验（第 5 节） |
| `prt315e-count.mjs` | 行数 / CRLF 精确读数 |
| `prt315e-mut-M*.log` | 各组变异的**原始红输出** |
| `prt315e-final.txt` | 最终 typecheck / npm test / parity / boundary / diff --stat 原始输出 |
