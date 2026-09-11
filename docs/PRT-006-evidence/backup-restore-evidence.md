<!-- evidence-banner:start -->
> **历史证据快照** —— 本文件记录 2026-09-11 一次实测的**当时结果**，其中的数字（行数、
> 缺口位置、文件大小）来自产出机上那份 team.db。它**不是**当前状态的声明，
> 也不应被当作基线；要看当前状态请用
> `node scripts/prt/backup-restore-verify.mjs`。现场数据每次写入都会让这些数字变化。
<!-- evidence-banner:end -->

# PRT-006 备份 / 恢复验证证据

**对应**：`PRT-006`
**验证对象**：现场 team.db（`D:\project\DSH\legion\team-hub\team.db`，8787 上的 hub 正在使用）
**工具**：[`scripts/prt/backup-restore-verify.mjs`](../../../scripts/prt/backup-restore-verify.mjs)
**单测**：[`backup-restore-verify.test.mjs`](../../../scripts/prt/backup-restore-verify.test.mjs)（14 例，合成夹具）
**方式**：**源库只读**；所有备份/恢复/危害实验都在临时目录的副本上做。
单测里有一条断言专门锁死这一点（比对源库与 `-wal` 的大小与 mtime 在验证前后不变）。

---

## 1. 结论

| 验证项 | 结果 |
| --- | --- |
| ① 只复制 `team.db`（不含 `-wal`） | ❌ **丢数据且无任何报错** |
| ② 复制 `team.db` + `-wal` + `-shm`（DEPLOY.md §6 写法） | ✅ 完整恢复 |
| ③ `VACUUM INTO` 一致性快照 | ✅ 完整恢复，且只需源库**读**权限 |
| ④ 从快照恢复到干净目录 | ✅ 单文件即可用，不依赖 `-wal`/`-shm` |
| ⑤ 恢复 `.db` 但残留陈旧 `-wal` | ❌ **陈旧 WAL 被重放，且 `integrity_check` 仍报 ok** |
| ⑥ 源库写入期间的文件复制 | ⚠️ 非同一时点视图（逐文件复制跨多个时点） |

### 1.1 现场实测数字（当日）

```
源库 6308 KB + -wal 4229 KB
逻辑状态：23 表 / 10472 行 / integrity=ok
audit.seq：1..9986，共 9984 条，缺口 1 处

① 只复制 .db            FAIL   audit: 9984 -> 9731   总行数 10472 -> 10198
② 三件套                PASS   10569 KB
③ VACUUM INTO           PASS   6280 KB
④ 恢复到干净目录        PASS   6280 KB
⑤ 陈旧 -wal 混用        FAIL   泄漏 1 行不属于该快照的合成数据；integrity_check=ok
```

---

## 2. 三个要点，按危害排序

### 2.1 陈旧 `-wal` 被静默重放（最危险）

把 A 时点的 `.db` 与 B 时点的 `-wal` 放在同一目录，SQLite **不会拒绝**它——
它只校验 WAL 自身的页校验和，不校验「这个 WAL 是否属于这个库」。
实测结果是 B 的页被重放到 A 的库上，**而结果库 `integrity_check` 报 ok**。

这意味着：**这个错误无法靠完整性校验发现**。`PRAGMA integrity_check` 是通过的，
库能正常打开、正常查询，只是内容混合了两个时点。

危害路径很具体：`docs/DEPLOY.md` 原本的数据回滚步骤是
「替换 team-hub/team.db（含 -wal/-shm 同批）」。若执行者只替换了 `.db`
（最容易漏的一步），或分批替换时中途失败，就会落到这个状态。

**处置**（已写入 DEPLOY.md §6.1 与回滚表）：
回滚时必须先 `Remove-Item team-hub\team.db-wal, team-hub\team.db-shm`，再放入备份的 `.db`。

### 2.2 只复制 `.db` 会静默丢数据

现场库的 `-wal` 有 **4229 KB**——比很多数据库整个还大。只复制 `.db` 的副本
少了 **253 条 audit 记录**与 21 条 `web_fetch_history`，而副本 `integrity_check` 报 ok。

审计记录被静默截断是最糟的一类数据丢失：备份文件存在、能打开、校验通过，
直到真的需要回溯时才发现在那个时间窗口里什么也查不到。

**处置**：`team.db*` 的通配不能省（`-wal`/`-shm` 必须同批）。
DEPLOY.md 原有的 `Copy-Item team-hub\team.db*` 写法是**正确的**，本次为它补上了原因——
不写原因的通配迟早会被人「优化」掉。

### 2.3 文件复制不是原子快照

连做两次三件套复制，若源库在复制期间有写入，两次会得到**不同**的逻辑状态——
因为逐个文件复制天然跨越多个时点，中间发生的提交会以「部分页」的形态进入副本。

本次两次连续复制恰好一致（源库在这一瞬未写入）。**这不能证明复制是原子的**，
工具的输出里也这么写了——一条「恰好通过」的记录如果被当成「机制是安全的」，
比失败更危险。

**处置**：备份用 `VACUUM INTO`（SQLite 自己产出一致快照，无需停服）；
文件复制**只应在停 hub 后**进行。

---

## 3. 一个被纠正的验收口径

原计划给 PRT-006 写的验收项是「**audit seq 连续性**」。**这条在真实数据上不成立**：

```
audit.seq：1..9986，共 9984 条，缺口 1 处
缺口位置：4501–4502（夹在 09-07T10:17:12 与 10:18:12 两条 release-stale 之间）
integrity_check：ok
```

原因是分配器本身：

```js
// team-hub/server.mjs:1196
return withTx(() => {
  const row = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM audit').get()
  const seq = (row?.m ?? 0) + 1   // ← MAX+1，不回填已作废的号
```

回滚后该号作废，下一个写入者拿到「当前 MAX+1」，于是留下空洞。
这是**有意设计**（不回填已作废号，避免已广播的 seq 被复用），不是缺陷。

因此验收口径改为：**恢复前后「缺口集合」完全一致**。
若坚持「必须连续」，PRT-006 会在真实数据上永远红——**一条永远红的验收项等于没有验收项**，
而且会训练人忽略它。

---

## 4. 复现

```powershell
# 现场库（只读；在临时副本上做全部实验）
node scripts\prt\backup-restore-verify.mjs

# 指定库
node scripts\prt\backup-restore-verify.mjs --source=D:\project\DSH\legion\team-hub\team.db

# 保留临时副本以便人工检查
node scripts\prt\backup-restore-verify.mjs --keep

# 合成夹具（CI 用，不依赖现场数据）
node --test scripts\prt\backup-restore-verify.test.mjs
```

退出码：`0` 全部通过；`1` 有失败项（现场库当前为 **1**，因为 ① 与 ⑤ 按设计会失败——
它们证伪的是两种**不安全做法**，不是产品缺陷）。

> 因此这个工具**不适合**直接当 CI 门禁：它对现场数据的存在与否敏感。
> CI 里跑的是合成夹具那 14 条单测。

---

## 5. 已知未覆盖

- **未验证跨版本恢复**（老代码读新库、新代码读老库）。DEPLOY.md 声称「表结构只增不改、
  自动补列幂等」，本次未对该声明做实验；这属 PRT-316（须在 team-hub 启动期迁移加固之后）。
- **未验证 `chat_attachments` / `uploads` 等文件类数据的备份**。现场库所在目录
  **没有 `uploads/` 目录**（`UPLOADS_ROOT` 指向 `<库目录>/uploads`），
  所以本次只能验证数据库本身。文件附件的备份路径需要另立验证——
  **这是一条真实的覆盖缺口**，spec §? 的数据分类把附件与库并列，
  但附件不在 SQLite 里，`VACUUM INTO` 覆盖不到。
- **未做恢复后的功能级验证**（起 hub 读一遍）。本次只核对了逻辑状态
  （表 / 行数 / integrity / audit 统计），没有启动服务确认接口可用。
  对 PRT-006 的目标（备份可用性）足够，但不是端到端恢复演练。
- **`sessions/`（257 MB）与 `DSH_HOME` 其余部分未纳入**。本任务只覆盖产品数据库。
