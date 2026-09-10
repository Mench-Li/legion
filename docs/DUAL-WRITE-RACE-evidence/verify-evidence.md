<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本文反映 **dual-write 偶发失败定性时**（2026-09-10）的排查与结论，其中的命令、端口、失败签名只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· [docs/CONFIG.md](../CONFIG.md)（统一配置）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# dual-write 偶发失败定性：启动期迁移竞态（真实缺陷）

**切片**：定性 `dual-write` 套件那次「1 个用例失败」的偶发记录
**日期**：2026-09-10
**起因**：`docs/REMAINING-TASKS.md` 候选 #2 —— CI test 阶段恢复后全量运行中该套件偶发失败一次，
失败原文丢失（当时 `run-ci` 只保留 6 行摘要，见 `docs/CI-TEST-STAGE-evidence/verify-evidence.md` §5）
**改动**：`team-hub/server.mjs`（启动期迁移原子化）、`scripts/ci/dual-write-smoke.test.mjs`（+2 个回归锚点、boot 失败可诊断、空闲端口）
**证据**：`.ci/dw-test/`（全量 test 阶段）、本文件 §3 的 A/B 原始结论

---

## 1. 结论（先说）

**不是 `audit.seq` 撞号，也不是测试自身抖动** —— 是**启动期并发**的两个真实缺陷（此前都没有测试覆盖）：

1. **迁移竞态**：两个进程（本仓库的既有部署形态就是「8787 独立进程 + 3080 宿主 v2 外壳」，见 P1-1）
   **同时打开同一个新库**时，会各自读到「某列不存在」并都执行 `ALTER TABLE ... ADD COLUMN`，
   **后到者崩溃**：`SQLite error: duplicate column name: model`，进程在模块加载期直接退出。
2. **WAL 切换无等待预算**：`PRAGMA journal_mode = WAL` **不受 `busy_timeout` 约束**
   （实测另一连接持锁时 106ms 内抛 `database is locked`），新库首次启动必经这一步，
   两个进程同时启动时后到者同样在模块加载期崩溃。

宿主形态下的后果：外壳 `team-hub/src/index.ts` 对 `import('../server.mjs')` 有 `.catch`（L81-83），
所以**不会带走宿主进程**，而是记一条「加载 v2 中枢失败」并把 **`/team-hub` 路由整体缺失，直到重启**——
即「两个进程同时启动」这个日常动作（重启/滚动重启）可能让 v2 中枢静默不可用。

**顺带纠正一个此前只是「假定」的事实**：`busy_timeout = 5000` 对**普通写事务确实生效**
（实测：另一连接持锁时，`BEGIN IMMEDIATE` 按预算等待 2066ms 后成功），
所以 P1-1 的 `audit.seq`「锁内读库 MAX 分配」设计是成立的；不生效的只有 WAL 切换这一步。


## 2. 复现（探针第 1 次即稳定命中）

原套件的失败率低（约 8 次全量运行命中 1 次），因此没有盲目重复跑，而是写了一个探针把失败细节全抓住
（响应 status/body、fetch 抛错、服务器 stderr、每请求延迟）：两个 `server.mjs` 指向同一**新**库、
端口由 OS 分配、**两次 spawn 紧挨着发出**、`Promise.all` 等两进程就绪。

探针第一次运行即复现（stderr 原文）：

```
Error: duplicate column name: model
    at file:///.../team-hub/server.mjs:273:41
      if (!memberCols.includes('model')) db.exec('ALTER TABLE members ADD COLUMN model TEXT DEFAULT NULL')
  code: 'ERR_SQLITE_ERROR', errcode: 1, errstr: 'SQL logic error'
Node.js v24.19.0
```

同款写法在启动期共 3 处（后两处更危险）：

| 位置 | 写法 | 风险 |
| --- | --- | --- |
| `spaces` 迁移 | `PRAGMA table_info` 判空后 3 次 `ALTER` | duplicate column 崩溃 |
| `members` 迁移 | 同上（本次探针命中的就是它） | duplicate column 崩溃 |
| **`goal` 老库重建** | 判形状后 **`DROP TABLE goal`** + `CREATE` + 逐行搬迁 | 两个进程互相删表/重复搬迁 → **丢数据** |
| `ensureColumn()`（25 处调用点） | 同一个「先查后改」模式 | 同上一类崩溃 |

## 3. 修复

### 3.1 启动期迁移原子化（第一处）

**统一入口 + 跨进程原子**：启动期补列一律走 `ensureColumn`，实现改为

```js
function ensureColumn(table, column, ddl) {
  if (columnExists(table, column)) return
  db.exec('BEGIN IMMEDIATE')          // 直接取写锁（不走 DEFERRED 的读→升写，避免锁升级死锁）
  try {
    if (!columnExists(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)   // 锁内**重读**
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    if (columnExists(table, column)) return   // 另一进程在等待写锁期间已完成该列 → 幂等成功
    throw e
  }
}
```

- **破坏性的 `goal` 重建**整段放进单个 `BEGIN IMMEDIATE`（锁内重判形状），保证只有一个进程执行、旧行只搬迁一次。
- `spaces` 三列 / `members.model` 改走 `ensureColumn`；重复定义删除（25 处调用点自动获得原子语义）。
- 迁移失败仍抛错（不静默继续），保持原有严格语义。

### 3.2 WAL 切换必须自带等待预算（第二处 —— 由**全量 CI** 才暴露，单跑测不出）

3.1 修好后单跑该套件是 4/4 通过，但**全量 CI 里新锚点仍然失败**（失败原始输出已按新机制落盘，
`.ci/dw-test/suites/dual-write_*.log`），崩溃点是：

```
Error: database is locked
    at .../team-hub/server.mjs:162:4     ← db.exec('PRAGMA journal_mode = WAL')
  code: 'ERR_SQLITE_ERROR', errcode: 5
```

用**确定性探针**（探针自己开库 → `BEGIN IMMEDIATE` 持锁 → 再起一个 server 子进程 → 2s 后放锁）
把机制钉死，并对照验证 busy_timeout 的真实边界：

| 操作（另一连接持写锁时） | 是否遵守 `busy_timeout = 5000` | 实测 |
| --- | --- | --- |
| 普通写事务 `BEGIN IMMEDIATE` + INSERT | **是** | 子进程等待 **2066ms** 后成功（持锁方 2s 放锁） |
| `PRAGMA journal_mode = WAL`（需要真正切换时） | **否** | 子进程 **106ms** 即抛 `database is locked`（errcode 5），busy handler 未参与等待 |

结论：**WAL 切换是唯一不受 busy_timeout 保护、却又是「新库首次启动」必经的一步**。
两个进程同时在**新库**上启动时，后到者必然在此崩溃（此后它连迁移都跑不到，
所以 3.1 的修复在那种时序下救不了它）。修法是给它自己的有界重试：

```js
db.exec('PRAGMA busy_timeout = 5000')   // 先设（普通写靠它）
enableWal()                             // 再切 WAL：50 × 120ms ≈ 6s 的有界重试（与 busy_timeout 同量级）
```

`enableWal()` 用 `Atomics.wait` 做同步退避（不忙转 CPU）——启动期是同步代码，不能用 `await`。

**确定性验证**（同一探针，持锁 2s）：

| 版本 | 子进程行为 |
| --- | --- |
| 修复前 | t=106ms 崩溃退出，stderr：`Error: database is locked`（errcode 5） |
| 修复后 | t=726ms / 1428ms 仍存活；t=2022ms 放锁 → **t=2258ms 就绪，stderr 为空** ✓ |

**A/B 证据**（同一个新用例，同一台机器）：

| 代码版本 | `dual-write` 套件结果 |
| --- | --- |
| 修复前（`git stash` 暂存 `server.mjs`） | exit=1，**tests=4 / pass=1 / fail=3**：原用例 1 + 新锚点 3 + 新锚点 4 全部失败，失败签名 `serve 进程提前退出 exit=1`（即迁移崩溃） |
| 只修 3.1（迁移原子化） | 单跑 4/4 通过，但全量 CI 中新锚点仍失败（即 3.2 尚未修） |
| 3.1 + 3.2 全修 | exit=0，**tests=4 / pass=4 / fail=0**；该套件连续复跑 12 轮（含 36 次「双进程同时启动」）零失败 |

注意第一行：**修复前连原来的用例 1 都会失败** —— 这就是那次偶发记录的机制（两个进程同时在**新库**上启动，
谁先完成迁移/WAL 切换决定成败 → 时序相关 → 偶发）。


## 4. 新增的回归锚点（`scripts/ci/dual-write-smoke.test.mjs`）

1. **双进程同时启动迁移同一新库**（3 轮，每轮新库）：双方都必须就绪、stderr 不得出现 `duplicate column`、
   且两进程随后都能成功写库。
2. **双进程同时升级旧形状 `goal` 表**：预置一个「scope 主键、无 id」的老库 + 1 条旧目标，
   两进程同时启动后断言**恰好 1 条** `G-001` 记录且旧目标文案保留（重复迁移/丢数据都会打破该断言）。

配套的**可诊断性**加固（因为这次排查的起点就是「失败原文丢失」）：

- `boot()` 现在检测子进程**提前退出**并立刻报错（附带 stderr 尾部）——原实现只在 15s 后报「就绪超时」，
  把「进程崩了」伪装成「启动慢」；
- 端口改用 `freePort()`（由 OS 分配）而不是「42000 + 随机」：后者与 Windows 临时端口区（49152 起）重叠，
  端口被别的进程占用时会失败成同一种「就绪超时」签名，属于本次排查必须排除的干扰项。

## 5. 顺带修掉的可观测性缺陷：套件超时没杀进程树

全量 CI 里发现（并被超时兜底捕获）第二个问题：**套件超时只杀了直接子进程**。

实测过程：`notify` 套件在某次全量运行中被 300s 超时杀掉，但**整个 test 阶段跑了 1153s**（多挂 850s）。
原因是超时清理写的是 `child.kill()` —— 只杀 `node --test` 运行器，而它派生的「每文件测试进程」
以及测试自己起的 hub 子进程**继承着运行器的 stdout/stderr 管道继续存活**，
于是 `close` 事件迟迟不触发，`exec` 一直等到那些孙进程自己退出才返回。

修法（`scripts/ci/run-ci.mjs`）：

- 超时改为 **杀整棵子树**（Windows `taskkill /PID <pid> /T /F`；POSIX 用进程组信号）；
- 超时时额外生成**现场快照**（仍存活的后代进程及其命令行）并并进失败套件的原始日志——
  本次排查缺的正是这份证据：原来的超时只给出一句「可能泄漏句柄或死锁」，无法知道是哪些进程没退。

## 6. 未彻底定性的一项：`notify` 套件曾超时一次

同一次全量运行里，`notify`（`workbench/scripts/notify.test.mjs` + `notify-hub-smoke.test.mjs`）
被 300s 超时杀掉。已有的可核实事实：

| 证据 | 内容 |
| --- | --- |
| 落盘原始日志（268 字节） | hub-smoke 的 2 个用例**都通过了**（391ms / 5068ms），此后**再无任何输出** |
| 单跑（含 `CI=true`） | **19s 自行退出，15/15 通过**；多次重跑同样通过 |
| 何时出现 | 只在该次全量运行中出现过一次；随后的全量运行未复现 |

`node --test` 只在「文件进程退出后」才输出该文件结果，所以「hub-smoke 的结果已输出」说明那个文件退了，
而 `notify.test.mjs`（纯函数用例、无子进程、无定时器）却没有任何输出 —— 与它的静态特征相矛盾，
因此**没有得出机制级结论**，如实登记为「出现过一次、未复现」。
缓解措施已经到位：套件级 300s 超时 + 进程树清理 + 超时现场快照 + 失败套件原始输出落盘，
即使再现也能拿到「哪些后代进程还活着」的直接证据。

## 7. 没能证明的部分（诚实登记）

- **无法 100% 断言历史那次失败就是本缺陷**：那次的原始输出已丢失（已由 `run-ci` 的
  「失败套件原始输出落盘」机制修复）。可核实的是：(a) 失败的是**用例 1**（并发写那条，摘要里保留了用例名）；
  (b) 修复前该用例在「两进程同时对新库启动」下**必然**失败；(c) 该缺陷的触发与否取决于两个迁移窗口是否重叠
  → 天然偶发。三者与观察到的现象吻合，但**历史实例的直接证据不存在**，故只表述为「机制一致」。
- **修复前的触发率未能量化**：本次只在探针与 A/B 中各命中一次，未做 N 次统计（成本高且无必要——
  A/B 已足以证明因果）。原套件的低失败率（约 1/8）未能用「窗口重叠概率」定量解释。
- **`busy_timeout=5000` 是否在极端负载下偏小未评估**：本次压力探针（24 并发 × 8 轮 = 192 次写）
  最高延迟 82ms，未观察到 `SQLITE_BUSY`；更极端的负载未测。
- **`goal` 重建竞态只做了「旧库 + 同时启动」的用例**，未人为构造「两进程正好卡在 DROP 与 CREATE 之间」的
  确定性时序（该窗口无法用外部手段精确控制）。

## 8. 复跑方式

```powershell
cd D:\project\DSH\legion
node --test scripts/ci/dual-write-smoke.test.mjs                       # 4 个用例（含 2 个迁移竞态锚点）
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node scripts/ci/run-ci.mjs --only test --out .ci\test-run               # 全量（38 套件 / 900+ 用例）
```

## 9. 教训

1. **「先查后改」的迁移在多进程部署下不成立**：本仓库的前提就是两个进程写同一个库（P1-1），
   因此任何启动期 DDL 都必须在**事务内重判**，不能用「读一次 + 决定」。
2. **测试的子进程崩溃必须显式暴露**：`boot()` 只等「就绪超时」而不看退出码，会把「进程已死」
   报成「启动慢」，直接导致本次排查绕路。
3. **偶发失败必须留下原始证据**：本次的起点就是「一次失败、原文丢失」；没有那 6 行之外的输出，
   定性只能靠重建场景。`run-ci` 的失败套件落盘（`.ci/<run>/suites/*.log`）是为同类问题的直接改进。
