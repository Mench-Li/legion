# PRT-801 .. PRT-813：安装、使用、升级、恢复的升级侧

**spec**：§6.9–6.12、§7、§9.1–9.4、§10 line 744；完成标准 line 980
**状态**：✅ 判据与用例已交付；⚠️ **没有任何生产调用点**——见 §7
**证据**：`product/upgrade/`（9 个模块 + 9 个用例文件）、`D:\project\DSH\legion\.worktrees\_prt-handoff\break-phase8.mjs` + `.json`

---

## 1 一句话

把「升级失败了会怎样」从**一句承诺**变成**四个各自被真的走到过、且各自的落点写在返回值里的读数**。

完成标准（line 980）要求：模拟下载损坏、迁移失败、DSH 启动失败和健康检查失败时，
系统能恢复到**已知兼容状态**且**业务数据不丢失**。这句话里有两个词是坑：

- **「已知兼容状态」** 不是"程序退回去了"，而是"程序与数据库互相读得懂"；
- **「业务数据不丢失」** 在 contract 迁移之后**不成立**——那时只剩"从备份恢复"，
  而它必然丢掉备份之后的写入。本批的做法是**把这个损失变成一条读数**，
  而不是把它藏在一句"回滚成功"里。

---

## 2 这个阶段真正的坑

### 2.1 ★ 「未知」被写成「已知」：`knownCompatible` 差点是个装饰

四条完成标准里有三条的落点都是"退回旧版本、数据未动"，也就是 `knownCompatible: true`。
**第四条不是**：一份 contract 迁移（`compatibility: 'breaking'`）失败之后，
数据库已经被改写，程序**不能再退回去**——那时唯一能回到已知结构的动作是
从升级前备份恢复数据库，而它会丢数据。

第一版的 `fail()` 让 `knownCompatible` 在几乎所有路径上为真。
这不是一个会立刻显形的 bug：它在平时完全正常，只在**最需要它说"不"的那一次**上说是。

> 一个「失败之后一律报『处于已知兼容状态』」的判定，
> 与一个「把未知状态报成已知」的判定，是同一个东西——
> 只不过前者的失效方式是**让值班的人以为自己可以收工了**。

处置：`knownCompatible` 由 `args.verdict !== 'forward-fix-required'` 推出，
并且反向用例（⑧）**要求它被驱动到 `false`**。如果它恒真，那条用例就红。

### 2.2 ★★ 回滚裁决少了一半输入：`failedMigrations`

这是本阶段**最危险的一处**，而且它是**由自检发现的**。

一份迁移的 `up()` 里有多条语句时，"第一句成功、第二句抛错"是常见的失败形态。
而**失败的那一份不会留下 applied 记录**——它没有跑完。第一版的 `rollbackUpgrade`
只看 `appliedMigrations`，于是在这种情形下得出结论：
"本次没有任何迁移被应用，因此仅回滚程序是安全的"，然后把程序退回到一个
读不懂当前数据库结构的旧版本上。

> 一个只看「已应用」记录的回滚裁决，
> 与一个「把写到一半的 contract 迁移当成没跑过」的裁决，是同一个东西。
> ——只不过前者会**安静地**把库留给一个读不懂它的程序。

处置：`runMigrations` 在 `failed` 里多带一个 `partialWrites` 三态读数
（`false` = 确定没写／`null` = **不知道**／不出现即按已应用算），
`rollbackUpgrade` 新增 `failedMigrations` 参数，编排按三档映射：

| `outcome` | `partialWrites` | 归入 |
| --- | --- | --- |
| `checksum-drift` | `false` | 一条语句都没跑 → **不参与裁决** |
| `failed` | `false`（记账失败） | `up()` 跑完了 → 按**已应用**算 |
| `failed` | `null`（`up()` 里抛错） | **不知道** → 按**已应用**算 |

`dataSafetyOf` 同步收 `failedMigrations`，于是"写到哪儿了不知道"不再被报成
"本次运行没有向数据库写入任何迁移"。

### 2.3 ★ 补丁层成对关系：`'unverified'` 从缝里过去了

`manifest.mjs` 的 `checkUpgradePath` 有三种结果：`match` / `mismatch` / `unverified`。
`preflight.mjs` 的第一版写成"`mismatch` 才拦"的**黑名单**，
外加"`patchPair === null` → `unknown`"。
调用方把 `'unverified'` 这个**字符串**原样转发过来时，
它既不是 `'mismatch'` 也不是 `null`，于是落到 `ok`。

这正是 spec §9.1 line 689 想拦的那一格：补丁锚点随 DSH 版本变化，
锚点失效时**进程照常启动而强制面（ToolGuard / pre-execute / approval answerer）全都不在**。

> 一个「没查到成对关系就放行」的体检，
> 与一个「锚点全失效而没人发现」的升级，是同一个东西。

处置：改成**白名单**——`patchPair !== 'match'` 一律 `unknown`（含 `null`、
`'unverified'` 与任何认不出的值）。新增反向用例（52①）把黑名单版本打红。

### 2.4 ★ 「不删 `-wal`/`-shm`」：把两个时刻的数据库合并

PRT-809 的备注写着「PRT-006 已定『恢复前必须删 `-wal`/`-shm`』」。
这一条最初**没有实现**。缺它的后果不是"恢复失败"，而是**恢复成功**：
把一个旧的 `.db` 拷回去、却把升级期间产生的 `-wal` 留在原地，
SQLite 下次打开时会把那份属于**新结构**的 WAL 重放到**旧文件**上，
得到一个既不是备份时刻、也不是升级之后的第三个状态——而它**能打开**。

> 一个「只把 .db 拷回来」的恢复，
> 与一个「把两个不同时刻的数据库合并」的恢复，是同一个东西——
> 只不过前者的名字叫「恢复成功」。

处置：`restoreSnapshot` 在写回任何 `.db` 之前删掉它旁边的 `-wal`/`-shm`，
并把删掉的东西以 `sidecarsRemoved` 报出来（**空数组**与"没检查"分开；
非 `.db` 的同名文件不动）。探针 51⑲ / 52③ 各自把这条打红。

### 2.5 ★ 只读「声明过的文件」的完整性校验

`verifyIntegrity` 最初是单向的：清单里声明的文件都要对得上。
但**磁盘上有、清单里没有**的那一个不会被看见——而那一个正好可能是被塞进去的。
反方向补上之后，探针 51③ 从"运行时崩溃"改成了"断言失败"：
第一版探针把 `verdict: 'undeclared'` 改成 `'ok'`，用例红了但红在
`TypeError: Cannot read properties of undefined (reading 'path')`
（`reason` 里读 `failed[0].path` 时数组为空）——那证明的是**文件坏了**，
不是判据在起作用。处置是给 `reason` 与 `code` 加 `?.` 兜底，
让"某处写入不同步"变成一条**能被读到的结果**而不是一次崩溃。

### 2.6 ★ 签名核对里的「自证」

`verifySignature` 会**重算** `subject` 再与包里留档的 `subject` 比。
第一版的用例是靠改 `contentHash` 来让它红的——但那走的是
"留档的 subject 与内容不匹配"，而不是"签名自证"这条路径。
处置是把用例拆成两条：一条只改留档的 `subject`，另一条显式展示
**持有私钥的人可以给伪造内容重新签名并通过 `verifySignature`**，
而 `verifyPackage` 仍然 `rejected`（摘要对不上）。
这两条测的不是同一件事，压成一条会让后者永远不被走到。

### 2.7 若干"缺失 ≠ 空"的同一条纪律

- `checkDiskSpace` 缺 `freeBytes` ⇒ `unknown`，**不是**"空间充足"；
- `checkInFlightTasks` 缺任务读数 ⇒ `unknown`；状态**认不出**的按**活跃**处理；
- `drillStatus` 只数 `outcome === 'ok'` 的演练（演练失败不算演练过）；
- `planRetention` 的 `underRetained` 是**独立读数**（"没有可清理的" ≠ "策略满足"）；
- `listUpgradeRecords` 读不出来的文件报 `{unreadable: true}` 而不是丢弃；
- `checkSubprocessTreeExited` 拿到 `null` ⇒ `unknown`（`[]` 才是 ok）。

---

## 3 交付

### 3.1 模块（9 个，`product/upgrade/`）

| 文件 | 行 | 任务 | 关键导出 |
| --- | --- | --- | --- |
| `manifest.mjs` | 571 | 801 / 802 | `createManifest` `validateManifest` `assertManifest` `upgradeWindow` `checkUpgradePath` `reconcileObserved` `digestOf` `MANIFEST_CHECKED` |
| `package.mjs` | 746 | 803 / 804 | `buildPackage` `signPackage` `verifyIntegrity` `verifySignature` `verifyPackage` `unpackPackage` `readPackageManifest` `PACKAGE_CHECKED` |
| `preflight.mjs` | 498 | 805 | `checkCompatibility` `requiredBytes` `checkDiskSpace` `checkInFlightTasks` `runPreflight` `PREFLIGHT_CHECKED` |
| `backup.mjs` | 709 | 806 / 812 | `createSnapshot` `listSnapshots` `planRetention` `applyRetention` `restoreSnapshot` `restoreDrill` `drillStatus` `BACKUP_CHECKED` |
| `migration.mjs` | 596 | 807 | `defineMigration` `checksumOf` `validateMigrationPlan` `createMemoryMigrationStore` `runMigrations` `planRollback` `MIGRATION_CHECKED` |
| `switchover.mjs` | 651 | 808 / 809 | `installLayout` `readActivePointer` `activateVersion` `probeHealth` `rollbackUpgrade` `runSwitchover` `SWITCHOVER_CHECKED` |
| `channels.mjs` | 458 | 810 | `canaryBucket` `isOffered` `selectOffered` `nextChannel` `planPromotion` `assertPromotion` `CHANNELS_CHECKED` |
| `audit.mjs` | 608 | 811 / 813 | `createUpgradeRecord` `writeUpgradeRecord` `listUpgradeRecords` `releaseNotes` `formatReleaseNotes` `upgradeNotification` `checkLongPaths` `releaseWithRetry` `checkSubprocessTreeExited` `preSwitchWindowsCheck` `AUDIT_CHECKED` |
| `index.mjs` | 867 | 编排 | `runUpgrade` `patchPairOf` `dataSafetyOf` `checkMigrationPlanRollback` `rollbackWithBackupRestore` `writeReleaseNotesFile` `ORCHESTRATOR_CHECKED` |

零第三方依赖：只用 `node:crypto`（真 ed25519）、`node:fs`、`node:path`、`node:os`。

**9 个模块全部带装载期自检**（`*_CHECKED`），每一个的 `problems === []`，
且 `samples` 里是**算出来的值**而不是布尔 `ok`。自检被设计成"两侧都跑"：

- `PREFLIGHT_CHECKED`：同一份"没有磁盘读数"的输入在 `pre-download` 通过、
  在 `pre-switch` 被拦；`patchPair` 为 `'unverified'` 必须被拦；
- `BACKUP_CHECKED`：源不存在必须拒绝建快照 / 快照被改过必须报 corrupt /
  恢复后主库内容必须等于快照时刻 / `-wal` 必须被删且被记下 /
  只有失败演练记录时必须 stale；
- `ORCHESTRATOR_CHECKED`：`UPGRADE_VERDICTS` 每一个都必须在
  `RESULT_BY_VERDICT` 里有映射（`unmappedCount === 0`），
  且 `restoredNoMigrationsIntact === false`。

### 3.2 用例（9 个文件，200 例）

| 文件 | 例数 | 任务 |
| --- | --- | --- |
| `manifest.test.mjs` | 18 | 801/802 |
| `package.test.mjs` | 22 | 803/804 |
| `preflight.test.mjs` | 16 | 805 |
| `backup.test.mjs` | 21 | 806/812 |
| `migration.test.mjs` | 20 | 807 |
| `switchover.test.mjs` | 26 | 808/809 |
| `channels.test.mjs` | 22 | 810 |
| `audit.test.mjs` | 29 | 811/813 |
| `upgrade.test.mjs` | 26 | **完成标准 line 980 的四条失败路径** |

`upgrade.test.mjs` 是这一批里唯一真正重要的那个文件。它把四条失败路径
**端到端地**走一遍（不是各自调一个函数），每条都断言
`verdict` / `reachedStage` / `knownCompatible` / `dataSafety` /
**活动指针的实际内容** / 审计落盘：

| 失败点 | 落点 | 活动指针 | `knownCompatible` | `dataSafety` |
| --- | --- | --- | --- | --- |
| ① 下载损坏（摘要对不上） | `not-started` @ `download-verify` | 未动 | `true` | `untouched` |
| ② 迁移失败（additive） | `rolled-back` @ `migrate` | **退回旧版本** | `true` | `preserved` |
| ③ DSH 启动失败（`ECONNREFUSED`） | `rolled-back` @ `health` | **退回旧版本** | `true` | `preserved` |
| ④ 健康检查失败（答了"不行"） | `rolled-back` @ `health` | **退回旧版本** | `true` | `preserved` |
| ④ 健康检查挂起（超时） | `rolled-back` @ `health` | **退回旧版本** | `true` | `preserved` |
| ⑤ contract 迁移失败且无 `down` | `forward-fix-required` | **留在新版本** | **`false`** | **`at-risk`** |
| ⑤ 从备份恢复 | 恢复完成 | 退回旧版本 | — | **`restored-from-backup`**（丢写入） |

③ 与 ④ 是**两件事**：一个的处置是"程序有 bug"，另一个是"配置或依赖没就位"。
把它们压成一档的实现，会在排障时给出同一个建议。

### 3.3 注册信息（未改 `scripts/ci/run-ci.mjs`，由协调方登记）

```
label: 'product-upgrade（阶段 8 PRT-801..813：安装包、预检、备份、迁移、原子切换与回滚）'
files:
  product/upgrade/audit.test.mjs
  product/upgrade/backup.test.mjs
  product/upgrade/channels.test.mjs
  product/upgrade/manifest.test.mjs
  product/upgrade/migration.test.mjs
  product/upgrade/package.test.mjs
  product/upgrade/preflight.test.mjs
  product/upgrade/switchover.test.mjs
  product/upgrade/upgrade.test.mjs
cwd: ROOT
```

---

## 4 验证

### 4.1 用例

```
node --test product/upgrade/manifest.test.mjs product/upgrade/package.test.mjs \
  product/upgrade/preflight.test.mjs product/upgrade/backup.test.mjs \
  product/upgrade/migration.test.mjs product/upgrade/switchover.test.mjs \
  product/upgrade/channels.test.mjs product/upgrade/audit.test.mjs \
  product/upgrade/upgrade.test.mjs
```

`ℹ tests 200 / ℹ pass 200 / ℹ fail 0`（逐文件计数见 §4.3）。

`node scripts/config/scan.mjs --check` → **PASS**（446 个疑似字面量）。

### 4.2 反向验证：`break-phase8.mjs`（23 处探针，23 处有效）

每一处做三件事：**单行**替换一处判据 → 跑对应用例 → 要求
**至少一个用例因断言而红**，然后**逐字节**还原并当场字符串比对。

红的原因被显式分类，`SyntaxError` 与 `import-error` **算失败**——
把一行改成语法不合法的东西也会让用例红，而那种红证明的是"文件坏了"，
不是"判据在起作用"。

| 编号 | 判据 | 文件 | 红例数 |
| --- | --- | --- | --- |
| ㊿ | 区间记号表去掉 `^` | manifest | 2 |
| 51① | N-1 窗口必须从 `(N-1).1.0` 出发 | manifest | 3 |
| 51② | 缺失签名 ⇒ `verified` | package | 3 |
| 51③ | 取消"多出来的文件"检查 | package | 1 |
| 51④ | 不核对留档 `subject` | package | 1 |
| 51⑤ | 磁盘无读数照常算 | preflight | 2 |
| 51⑥ | 认不出的任务状态按已收敛 | preflight | 2 |
| 51⑦ | `underRetained` 恒假 | backup | 2 |
| 51⑧ | 演练新鲜度把失败也算"演练过" | backup | 2 |
| 51⑨ | 校验和漂移降级成"已是最新" | migration | 1 |
| 51⑩ | 没有超时的健康检查返回 `healthy` | switchover | 2 |
| 51⑪ | contract 之后允许仅回滚程序 | switchover | 1 |
| 51⑫ | canary 不要求显式同意 | channels | 2 |
| 51⑬ | 通道晋级可以跨级 | channels | 3 |
| 51⑭ | 需人工介入的回滚通知渲染成 `info` | audit | 1 |
| 51⑮ | 子进程树"活着"的判定恒空 | audit | 3 |
| 51⑯ | 审计文件允许覆盖 | audit | 1 |
| 51⑰ | 切换前的磁盘复查不再拦 | index | 1 |
| 51⑱ | `forward-fix-required` 判成"已知兼容" | index | 1 |
| 51⑲ | 恢复时不删 `-wal`/`-shm` | backup | 2 |
| 52① | 成对关系黑名单化 | preflight | 1 |
| 52② | `pre-switch` 不再把磁盘未知当致命 | preflight | 2 |
| 52③ | 自检 `sidecarsRemoved` 读数写死成 0 | backup | 1 |

编号规则：**㊿** 是 50，之后从 **51①…51⑲、52①…52③** 顺延
（带圈数字在 50 之后不是单个码位）。脚本同时写 `break-phase8.json`。

### 4.3 逐文件计数

```
audit.test.mjs        pass=29 fail=0
backup.test.mjs       pass=21 fail=0
channels.test.mjs     pass=22 fail=0
manifest.test.mjs     pass=18 fail=0
migration.test.mjs    pass=20 fail=0
package.test.mjs      pass=22 fail=0
preflight.test.mjs    pass=16 fail=0
switchover.test.mjs   pass=26 fail=0
upgrade.test.mjs      pass=26 fail=0
合计                  pass=200 fail=0
```

---

## 5 完成标准的四条，对着看

| 完成标准里的失败 | 真的被驱动？ | 怎么驱动的 |
| --- | --- | --- |
| 下载损坏 | ✅ 真跑 | 改一个字节 → `verifyIntegrity` `mismatch` → 断言活动指针未动、审计落盘 |
| 迁移失败 | ✅ 真跑 | 注入会抛错的 `base.exec` → 断言**活动指针回到旧版本**、迁移记录 `['applied','failed']` |
| DSH 启动失败 | ✅ 真跑 | 探针抛 `ECONNREFUSED` → 断言 `health.verdict === 'unhealthy'` 且指针退回 |
| 健康检查失败 | ✅ 真跑 | 探针返回 `{ok:false}`、探针挂起（50ms 超时）、探针缺席，三种各一条 |
| 恢复到已知兼容状态 | ✅ 真跑 | 每条都断言 `readActivePointer()` 的**实际内容**，不是只看返回值 |
| 业务数据不丢失 | ⚠️ **一半** | additive 路径断言数据一行未丢；contract 路径**明确断言会丢**（`businessDataIntact: false` + `restored-from-backup`） |

---

## 6 与 spec 条文的对应

| spec | 落点 |
| --- | --- |
| line 689（补丁层成对） | `manifest.checkUpgradePath` + 三结果 `match`/`mismatch`/`unverified` + `index.patchPairOf`（绑定表**必须由调用方给**） |
| line 691（不能单独升 DSH） | `reconcileObserved`：`dshVersion` 与 `dshCompositionPatchVersion` **分开比**；缺失观测 ≠ 无漂移 |
| line 695–701（三通道） | `channels`：canary 需**显式同意** + 确定性分桶；晋级不许跨级且要熬够 soak |
| line 718–731（十步流程） | `UPGRADE_STAGES` + `runUpgrade` 按序 emit；用例断言 `preflight → switch → migrate → health` 的顺序 |
| line 733（expand/contract） | `planRollback` 三种 safety + **拒绝仅回滚程序**（除非显式 `force`） |
| line 735（补丁层原子重放） | `runSwitchover` 在同一 stage 里重放并校验；失败保持旧版本 |
| line 737（N-1 / 备份保留 / 演练） | `upgradeWindow` + `planRetention`（窗口 ∪ 数量，取大者）+ `restoreDrill`（`verify` 必填） |
| line 739（Windows 四种边角） | `audit`：`isInUseError` / `isScannerDelayError` / `checkLongPath` / `releaseWithRetry` / `checkSubprocessTreeExited` |
| line 744（完整性 + 代码签名） | `package`：sha256 逐文件 + 内容摘要**独立判** + 真 ed25519（`node:crypto`） |

---

## 7 ⚠️ 诚实边界

1. **没有任何生产调用点。** 全仓库唯一提到 `product/upgrade/*` 的**执行性**引用是
   `product/release/checklist.mjs` 的 `evidenceFrom` 字段——那是一张路径清单，
   不执行升级。`product/launcher/`、`product/runtime-state.mjs`、
   `product/diagnostics/` **都没有接**。所以本批交付的是**判据与用例**，
   不是"产品现在能升级了"。**这是本阶段最重要的一条限制。**

2. **`runUpgrade` 的输入全是内存里的。** 没有下载：没有 HTTP 客户端、
   没有流式校验、没有断点续传、没有真实发布服务器。`packageBytes` 由调用方给。

3. **没有真实的迁移存储。** `createMemoryMigrationStore` 是唯一的实现；
   没有 SQLite 后端，也**没有落 `schema_migrations` 表**（spec §7 提到这个表名）。
   `runMigrations` 的 `store` 与 `base` 都是注入的。

4. **健康探针没有默认实现。** `probeHealth` 的 `probe` 必须由调用方给
   （所以"没有探针"这条路径是 `unsupported` 而不是"默认健康"）。
   没有"向 DSH 的 3080 发一个真实 HTTP 请求"的默认探针。

5. **`patchBindings` 没有随产品发货。** `index.patchPairOf` 要求调用方提供
   已知可用的 `(dshVersion, compositionPatchVersion)` 组合表；
   本批**没有**给出任何一张真实的绑定表，也不读任何文件。
   在生产接线之前，升级会被自己的体检拦住（拦得对，但没接通）。

6. **`-wal`/`-shm` 的处置是"删除"而不是"先 checkpoint"。** 这是 PRT-006 定的
   方向，但删除意味着**未合并的提交直接丢弃**。这一条只在"从备份恢复"
   这条路径上有意义——它本来就是一次丢弃——但如果将来有人把它接到
   非恢复场景上，那会是一次静默的数据丢失。

7. **Windows 的四项全是纯判定，没有真的执行过。** `releaseWithRetry` 返回的是
   计划而不是一个真的重试循环；`checkLongPath` 不真的加 `\\?\` 前缀；
   `checkSubprocessTreeExited` 处理的是调用方给的 `{pid, alive}` 数组，
   不真的 `spawn`/`kill`。文件占用（`EBUSY`）与 Defender 延迟（`EPERM` + 扫描器特征）
   在用例里是**构造的错误对象**，不是真在 Windows 上撞出来的。

8. **通道与审计没有投递面。** `isOffered` / `planPromotion` 是纯函数；
   `upgradeNotification` 返回一个结构，**没有任何 UI/托盘/HTTP 把它送给用户**。
   `listUpgradeRecords` 只读本地目录。

9. **`rollbackWithBackupRestore` 不恢复程序文件。** 它只换活动指针
   （`activateVersion`），旧版本的目录必须**已经在** `versions/` 里。
   如果安装目录已经被删/损坏，这条路径失败并报 `forward-fix-required`。

10. **`applyRetention` 只删快照目录**，不删演练记录、不清理 `drills/`。

11. **`unpackPackage` 的"先收全部字节再落盘"只保证不在缺字节时建目录**，
    不保证杀进程/断电场景下的原子性（没有 fsync、没有写临时目录再 rename）。

12. **没有端到端的进程级测试。** 所有用例都在同一个 `node:test` 进程里，
    没有"启动一个真的 DSH、杀掉它、看指针"这样的测试。完成标准里的
    「DSH 启动失败」是用**注入的抛错探针**模拟的，不是真的启动一次失败的 DSH。

13. **四个失败点之外没有做故障注入矩阵。** 阶段/`stageHook` 的注入点覆盖了
    `preflight`/`backup`/`download-verify`，但 `switch`/`migrate`/`health`
    各自只有一两条路径被走到，不是笛卡尔积。
