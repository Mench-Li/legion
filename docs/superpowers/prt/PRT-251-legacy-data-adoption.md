# PRT-251 续 ④：安装目录里的业务数据没有接管进 DataDir

> spec 附录 A.2 第 2 条（实测结论，原文）：
>
>   「**数据落点越界**：3 处 path 字段的默认值落在安装目录内
>    （`TEAM_HUB_DB=team-hub/team.db` + whiteboard 三处）。安装目录会被升级
>    覆盖 → 需用 `DataDir` 承接（`PRT-505` / `PRT-257` 输入）。」
>
> spec §7 line 610：「所有迁移必须幂等，旧数据库升级前自动备份。」
>
> 日期：2026-09-17　状态：**缺口已修（本文含实现、判据与破坏性验证）**
> 关系：PRT-251 的续篇。承接物早已备好（`DATA_PATH_ENV` + `envFor()`），
> 缺的是"承接"这个动作本身。

---

## 1 缺口一句话

Launcher 已经把 team-hub 的写路径指到 `<DataDir>/team-hub/team.db`。
**但那个文件不存在**，而旧数据在 `<安装目录>/team-hub/team.db` 里躺着。
于是切到 Launcher 之后，team-hub 对着一个空路径建库 ⇒ **界面是空的**，
而日志里没有任何一条说"我少读了什么"。

> 「以后写在 DataDir 下」与「DataDir 里已经有那些数据」
> 是两件不同的事——前者做到了，后者没做，而它们在**启动成功**这个读数上
> 是同一个东西。

## 2 实测（本机，2026-09-17）

| 事实 | 读数 |
| --- | --- |
| 安装目录 | `D:\project\DSH\legion`（`product.json` 的 `installDirAtCreation`） |
| 旧库 | `team-hub\team.db` **11,653,120 B**（44 张表 / 33,263 行） |
| 旧库的 WAL | `team-hub\team.db-wal` **4,330,152 B**（未 checkpoint） |
| DataDir | `%LOCALAPPDATA%\Legion\data\team-hub\` —— **空目录** |
| `product/` 里 adopt / legacy-db / 迁移 team.db 的实现 | **0 处** |
| 旧 team-hub 进程 | PID 23108 正在跑（`team-hub/server.mjs`），**正在写那份库** |

## 3 ★ 只拷 `team.db` 会**静默丢数据**（这是本缺口真正的坑）

WAL 模式下，已提交但尚未 checkpoint 的事务**只存在于 `-wal` 文件里**。
"把 team.db 拷过去"因此得到一个**能打开、能查询、schema 齐全、
却少了一部分已提交数据**的库。

这不是推测，是并排跑出来的读数（`scratch/probe-adoption-live.mjs`，只读）：

```
③ 同一个旧库，两条路径
   表              旧库     朴素拷贝     快照
   audit          31798      31716    31798
   合计：旧库 33263 ｜ 朴素拷贝 33181（**少 82 行**）｜ 快照 33263
   快照与旧库**逐表相等**的表：44/44
```

> 一个"拷了主文件、丢了 WAL"的接管，
> 与一个"数据本来就只有这么多"的接管，在**新库能正常打开**这个读数上
> 是同一个东西——只不过前者少掉的那部分要到某一天才发现，
> 而那时已经无法判断是没拷过来还是本来就没有。

**处置**：SQLite 走 **`VACUUM INTO`**（数据库自己产出一致快照），
**不做文件拷贝**。附带的好处是 `VACUUM INTO` **要求目标不存在**——
幂等性因此不是靠我们记得检查，而是 SQLite 自己保证的。

## 4 四个不变量（每条都有用例）

| 不变量 | 理由 | 判据 |
| --- | --- | --- |
| **不覆盖** | 接管只能发生一次；第二次运行必须是空操作 | ⑦（篡改目标后第二次不得改回去） |
| **不删来源** | 源库原样留下，它同时就是 spec line 610 要的那份"升级前备份" | ⑥（来源与 `-wal` 都还在） |
| **写不落在安装目录内** | §6.10；安装目录升级时被原子替换 | ④（`TARGET_INSIDE_INSTALL`） |
| **"没有来源"不是错误** | 没见过旧库的新装机，四个来源全都不存在 | ③（`nothing-to-adopt` 且 `ok: true`） |

## 5 修法（已实施）

### 5.1 旧的落点**不另立一张清单**

`launcher.mjs:108-110` 原文：「这些键的**代码默认值落在安装目录内**」。
所以 `dataDir/team-hub/team.db` 的旧落点就是 `installDir/team-hub/team.db`——
**同一条相对片段**，由 `DATA_PATH_ENV` 直接推出来：

```js
adoptionPathsFor({ layout, item })
//   source = join(layout.installDir, ...item.fragment.split('/'))
//   target = join(layout.dataDir,     ...item.fragment.split('/'))
```

`adoptionItems()` 接受**注入的**映射（生产是 `DATA_PATH_ENV`），
自己一份都不写。理由与 `topology-inventory.mjs:205` 那句逐字相同：

> 两份手写的清单必然漂移，而漂移的表现是"清单说已由 DataDir 承接、
> 而接管路径其实没有"——那正是本缺口要修的那个形状。

`.db` 后缀决定走快照、其余走递归拷贝（`kindOfFragment()`）——
不另立第二张 kind 表，同一个理由。

### 5.2 接管的**位置**：`preflight()` 之后、spawn 之前

```
start() → 日志 → 单实例锁 → 上一次残留 → preflight()
                                              ↓ 通过
                                    ★ adoptLegacyData()      ← 本批新增
                                              ↓
                                    凭证材料化 → 计划 → spawn
```

两端都卡死：

- **晚于 `preflight()`** ⇒ 只在"这次真的要起来"时才动数据；
- **早于 spawn** ⇒ team-hub 打开库**之前**它就在 DataDir 里了。
  否则 hub 会对着空路径建表，而接管再也无从判断——目标已存在 ⇒ 按幂等
  规则跳过 ⇒ **用户的数据永远接不进来**。这一条是位置的全部理由。

### 5.3 ★ 接不成 ⇒ **拒绝启动**，不是警告后照常起

这是本缺口唯一能不再重演的方式：

> 一个"有旧数据、但没接管成功、于是空着起来"的启动，
> 与一个"这是台新机器、本来就没有数据"的启动，
> 在**界面**上是同一个读数（都是空的）——只不过前者的数据就在旁边
> 一个目录里，而用户会以为数据丢了。

`ok: false` 时 `start()` 在 `phase: 'legacy-adoption'` 早退，
诊断里带上逐项的具名码（⑬）。而 `nothing-to-adopt` 是**正常**，
照常启动——拒绝只针对"有东西该接、却没接成"（⑬b 是它的反向控制）。

### 5.4 实现坐标

| 文件 | 改动 |
| --- | --- |
| `product/launcher/legacy-data-adoption.mjs` | **新增**。计划（纯）+ 执行 + 快照 + 校验 + 装载期自检 |
| `product/launcher/launcher.mjs` | 导入；`start()` 里 `preflight()` 之后调 `this.adoptLegacyData()`，不成则早退；新增 `adoptLegacyData({dryRun})` 方法；`adoptionDiagnostics` 聚合进 `allDiagnostics()` |
| `product/launcher/legacy-data-adoption.test.mjs` | **新增**，15 例 |
| `scripts/ci/run-ci.mjs` | 新套件登记 |
| `scratch/probe-adoption-live.mjs` | **新增**只读探针（对**真**旧库跑，本文 §3 的读数来自它） |

### 5.5 ★ 接管**按启动范围**发生（`--include`）——后续批补上的

上面 §5.2 说接管的位置是「`preflight()` 之后、spawn 之前」，并说那是位置的全部理由。
那个说法**漏了一半**：位置对，但范围当时是"全量"——于是

> `--include=runtime`（「我只想把 DSH 起起来看看」）
> 会顺手把 team-hub 的库接走。

而接管是**一次性快照**（目标存在即永远跳过，见 §4 第一条不变量），
所以那样一次试运行会把唯一一次接管机会用掉，
而且是在旧 hub **还在写那个库**的时候。

修法：`adoptionItems()` / `planAdoption()` / `adoptLegacyData()` 都接受
`processes`（启动范围），`start()` 传 `includedKeys`：

```
接管项 = DATA_PATH_ENV 里那些「拥有者进程 ∈ 本次启动范围」的项
```

`null`（不设范围）与 `[]`（一个都不启动）是**两件事**：前者是"没告诉我要启动哪些"，
后者是"一个都不启动"。用例 ㉗ 把这条差别单独钉住。

★ 还有一格**必须**单独说：受限那一次**不许**写进记忆化。

```js
if (!scoped) adoptionReading = reading
```

否则一次 `--include=runtime` 会把「这个 Launcher 的接管读数」替换成
「我这次没看 team-hub」，于是随后一次真正的全量启动读到那份**空**读数，
并据此认为无事可做。那不是幂等，是记忆化把范围问题变成了数据问题（用例 ㉙）。

### 5.6 实现坐标（追加）

| 文件 | 改动 |
| --- | --- |
| `product/launcher/legacy-data-adoption.mjs` | `adoptionItems`/`planAdoption`/`adoptLegacyData` 接受 `processes` |
| `product/launcher/launcher.mjs` | `start()` 传 `includedKeys`；`adoptLegacyData({dryRun, processes})`；**受限那次不写记忆化**；总结诊断里报出范围 |

## 6 复现与核对（**机器判据**）

```bash
# ① 计划三态 + 两种拒绝 + 真 WAL 两条路径 + 幂等 + Launcher 拒绝启动（15 例）
node --test product/launcher/legacy-data-adoption.test.mjs

# ② 对**真**旧库跑一遍完整链路（只读；不碰正在跑的 DSH 与那份库）
node scratch/probe-adoption-live.mjs

node scripts/prt/progress-check.mjs
node scripts/prt/spec-progress.mjs --check
```

★ 最要紧的一条是 ⑥，它**并排**断言两件事：
快照取到全部 40 行，且**朴素拷贝取不到**（`naiveCount === 1`）。
只断言前一半的用例对"我们用的是哪条路径"完全不敏感——
两条路径在新库**能打开**这件事上是一样的。

### 6.1 破坏性验证（每条都必须**变红**）

```bash
$env:MUTATE_ONLY='㉑,㉒,㉓,㉔,㉕,㉖'; node scratch/mutate.mjs
```

**6/6 全部咬住**：

| 变异 | 期望变红 | 实际 |
| --- | --- | --- |
| ㉑ SQLite 退化成朴素文件拷贝 | 真 SQLite + 真 WAL | ✔ 红 **6** 条（含 ⑥） |
| ㉒ 目标已存在也照拷 | （装载期自检） | ✔ 红 1 |
| ㉓ 「没有来源」判成拒绝 | （装载期自检） | ✔ 红 1 |
| ㉔ 关掉"目标不得落在安装目录内" | （装载期自检） | ✔ 红 1 |
| ㉕ 接不成只记诊断、照常启动 | ⑬ | ✔ 红 1 |
| ㉖ 快照后不校验 | ⑪ | ✔ 红 1 |

㉒㉓㉔ 的红实体是**文件名**而不是某条用例名，如实记下来：
这三处的性质被**两层**守着，先动的是模块末尾的**装载期自检**
（`ADOPTION_CHECKED = selfCheckAdoption()`），它在 `import` 那一刻就抛。

> 一个"装载期就拒绝"的模块，与一个"装载成功、运行时才判错"的模块，
> 在变红清单上不是同一个东西——前者的红发生在**任何用例跑之前**。

之所以敢这么记：这三条性质**同时**被用例独立守着
（③ 断 `nothing.ok === true`、③ 断 `ALREADY`、④ 断 `TARGET_INSIDE_INSTALL`）。
不把 `expect` 放宽到"随便红一条就算咬住"——那会把"整个文件加载失败"
也算成一次成功的破坏性验证。

### 6.2 范围那几条的破坏性验证（追加）

```bash
$env:MUTATE_ONLY='㉞,㉟,㊱'; node scratch/mutate.mjs
```

| 变异 | 期望变红 |
| --- | --- |
| ㉞ `start()` 不再把 `--include` 交给接管 | ㉚（端到端） |
| ㊱ 接管忽略 `processes` | ㉗（纯计划） |
| ㊲ 受限那次也写记忆化 | ㉙ |

㉞ 是这三条里最要紧的：另外两条验的是"那个参数管不管用"，
而它验的是**启动路径有没有把范围交下去**——也就是用户加 `--include` 时
实际会发生什么。直接调 `adoptLegacyData({processes})` 的用例答不了这个问题。

★ 而 ㉞ 第一次跑出的是 **0 条变红**，暴露了用例 ㉚ 的**假绿**：
本机 3080 上跑着用户的 DSH，而 runtime 的缺省端口就是 3080 ⇒ 体检在 `ports`
阶段就失败 ⇒ `start()` **根本走不到接管** ⇒ "盘上没写"成立，
但它与"范围生效了"毫无关系。

> 一条"因为什么都没跑所以盘上没写"的用例，
> 与一条"因为范围生效所以盘上没写"的用例，在盘上是同一个读数。

修法三处一起加，这个形状才不会回来：`allowPortInUse`，
断言 `pre.ok === true`，以及断言接管**真的执行过**（`LEGACY_ADOPTION` 诊断存在）。

## 7 诚实边界

1. **没有起过一个由 Launcher 完整启动的部署**（用户在跑的 DSH 在 3080 上，
   本批不动它）。真机读数来自**只读**探针，覆盖到"计划→快照→校验→幂等"
   整条链，**没有**覆盖到"Launcher 起来后 team-hub 真的读到了那些行"
   ——那需要一次真实切换。
2. **本批没有真的把用户那份旧库接管走**。`D:\project\DSH\legion\team-hub\team.db`
   与它的 4.3 MB WAL **原样未动**（探针只读、DataDir 未写）。
   切换动作留给用户决定。
3. **旧库正在被旧 hub 写的时候**，快照取到的是"那一刻的一致视图"。
   之后旧 hub 再写的行**不会**进来——这是"接管是一次快照"的必然含义，
   不是缺陷；但它意味着**切换那一刻要停旧栈**，而这条运行手册本批没写。
4. **`VACUUM INTO` 的目标路径是拼进 SQL 的**（SQLite 不接受把目标绑成参数），
   所以单引号做了转义。路径里含 `'` 的情况有用例逻辑但**没有真机验证**。
5. **只在 win32 / `node:sqlite`（Node 22+）上跑过**。缺少 `node:sqlite` 时
   模块**不降级成文件拷贝**（那正是 §3 的坑），而是具名失败——
   该分支由 ⑨/⑩ 的具名失败共同覆盖，**没有**在真的缺 `node:sqlite` 的
   Node 上跑过。
6. **白板的三个落点在本机全都不存在**（`whiteboard/whiteboard.db`、
   `rooms`、`audit` 都没有），所以那三项走的是 `SOURCE_MISSING`；
   目录递归拷贝由 ⑧ 用**造的**目录验，不是真机数据。
7. **范围是按"拥有者进程"切的**，而一个落点的拥有者是 `DATA_PATH_ENV`
   那张表说的。若将来某个进程**读**另一个进程的库（今天没有），
   "按拥有者切"就不再等于"按读者切"了——那时这个假设要重新审。
8. 本批**不主张**新建任务号：它是 PRT-251 的续篇，与 `PRT-214`/`PRT-253`
   的续篇同例。
