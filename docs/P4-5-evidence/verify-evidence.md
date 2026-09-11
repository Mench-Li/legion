<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **P4-5 切片当时**的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）｜[README.md](../../README.md)（总览）｜[docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P4-5 白板审计：归档可读、可跨重启回溯 —— 验证证据

> 任务来源：`docs/REMAINING-TASKS.md` 候选 **#7**（= `docs/STATUS.md` 已知限制 **#11**）。
> 原话：「指标与审计为进程内（P3-1 边界）：重启归零、无长期归档；`/api/rooms/<id>/audit`
> 只返回当前进程事件」。

## 1. 先把候选描述拆准

候选把三件事写在了一句话里，但它们的性质完全不同——**侦察阶段先把它们分开**，否则会把
「刻意的设计」当成缺陷去改：

| 子项 | 事实 | 判定 |
| --- | --- | --- |
| `/metrics` 运行计数器重启归零 | 计数器是**进程运行期**读数（在线数/限流状态等） | **刻意设计，不改**（跨重启累计应由审计承担，混在一起会让「当前在线」变成谎言） |
| 审计 JSONL 按大小轮转、无长期归档 | P3-1 已实现落盘 + 轮转（8MiB × 3 份） | 已实现；「长期归档」是**独立的产品决策**（见 §5 边界 1），不在本切片 |
| **`/api/rooms/<id>/audit` 只返回当前进程事件** | 接口只看内存环形缓冲，**从不读磁盘归档** | **真缺陷** —— 本切片修的就是这一条 |

最后一条的真实后果比原话更严重：JSONL 一直在写，但**没有任何代码路径读它**。于是进程一重启，
API 会说「这个房间没有事件」，而磁盘上躺着完整历史；「事后取证」只能靠人工 parse 文件。

## 2. 交付物

| 文件 | 作用 |
| --- | --- |
| `whiteboard/apps/server/src/audit.mjs`（改） | 归档读取（`queryArchive`）、合并去重（`queryAll`）、跨重启单调 `auditSeq`、留存事实（`retention`）、坏行容错 |
| `whiteboard/apps/server/src/index.js`（改） | `?source=process\|archive\|all`（非法值 400）；响应附 `retention` 与可行动 `hint`；`/metrics` 暴露留存事实；**补记 `ops` / `presence` 两个声明了却从未写入的审计类型** |
| `whiteboard/apps/server/test/audit-archive.test.mjs`（新，**12 例**） | 10 条纯函数用例 + 2 条**真实进程真重启**端到端用例 |
| `whiteboard/package.json` | `test` 脚本加入新文件（16 → 17 个文件） |
| `scripts/ci/run-ci.mjs` | `whiteboard` 套件标签补「P4-5 审计归档跨重启」 |
| `docs/DEPLOY.md`（whiteboard）、`whiteboard/README.md`、`whiteboard/docs/adr/ADR-0008…md` | 端点参数、curl 示例、ADR 边界同步 |

## 3. A/B 现场读数（真实进程，**真杀真启**）

同一个探针（起服务 → 连 ws 画一笔 → `SIGKILL` → 起新进程 → 查同一房间），只换代码：

| 读数 | 修复前（`main`） | 修复后 |
| --- | --- | --- |
| 进程 A 记录的审计类型 | `connect, room_open, disconnect`（**无 `ops`**） | `connect, room_open, **ops**, disconnect` |
| 事件是否带序号 | **否**（无 `auditSeq`） | 是（每条都有） |
| 重启后默认查询 | `total: 0`，**无 hint、无 retention** | `total: 0`（不变），但附 `source: "process"` + hint：`进程内暂无事件；磁盘归档有 1 个文件（最早 2026-09-11T05:39:51.566Z），用 source=archive 或 source=all 查询历史事件` + `retention.fileCount: 1` |
| 重启后 `?source=archive` | **`total: 0`**（旧代码忽略该参数） | **`total: 4`**，类型与进程 A 完全一致（含 `ops`） |
| `/metrics` 的 `audit` 段 | 无 `rotations`、无 `retention` | `rotations: 0`，`retention: { fileCount: 1, bytes: 543, spanMs: 314 }` |
| **磁盘上的归档** | `audit.jsonl: 345B`（**数据一直在，只是没人读**） | `audit.jsonl: 543B`（多出的部分是补记的 `ops`） |

**这就是候选 #7 的症状本身**：修复前磁盘有 345B 历史，而 API 说「0 条、什么都没有」——
调用方无法区分「从来没发生过」与「发生过但我查不到」。

## 4. 侦察中发现并修掉的第二处缺陷：**声明了却从未写入的审计类型**

`AUDIT_TYPES` 白名单里有 `ops` 与 `presence`，但全仓 grep 显示**服务端从未写入这两个类型**
（只写 `room_open` / `connect` / `disconnect` / `deny` / `reject` / `rate_limit` / `policy_close` /
`op_denied` / `room_idle_close`）。而 `audit.mjs` 的文件头注释声称记录
「谁（连接/IP）、在哪个房间、**做了什么**、结果如何」——「做了什么」恰恰是缺的那一块。

后果是审计（以及本切片刚做好的归档）只能回答「谁来了、谁被拒了」，**无法回答「谁改了什么」**。
`metrics.opsAccepted` 一直在计数，说明数据是现成的，只是没进审计。

**修法**：接受 op 后记 `ops`（只记**结构性摘要**：条数 + `{ add: 2, del: 1 }` 类型分布），
presence 记是否非空。**刻意不记元素内容/坐标/颜色**——审计是治理工具，不是内容归档；
画布内容仍只留在房间库里（与 `audit.mjs` 的既有设计一致）。

这也是**第二条独立的负向对照**（见 §5）：把新版 `audit.mjs` 配旧版 `index.js`，
端到端用例即以 `应含 ops：connect,room_open` 失败——两处缺陷各自被锚定。

## 5. 验证证据

### 5.1 用例读数

| 运行 | 结果 |
| --- | --- |
| `node --test apps/server/test/audit-archive.test.mjs` | **12/12 PASS** |
| 既有 `metrics-audit.test.mjs`（13 例，未改动） | **13/13 PASS**（既有语义零回归） |
| `npm test`（白板全量） | **197/197 PASS**（185 → **197**，+12） |
| **负向对照 ①**：测试打在未修的 `audit.mjs` + `index.js` 上 | **整个文件加载失败**（`AUDIT_SOURCES` 不存在 → 能力本身不存在） |
| **负向对照 ②**：新 `audit.mjs` + 旧 `index.js`（只差类型补记） | **2 FAIL**，失败信息 `应含 ops：connect,room_open` |

### 5.2 覆盖的关键边界（均在用例里）

| 场景 | 断言 |
| --- | --- |
| 重启后读历史 | 新实例 ring 为空、默认查询 0 条，但 `source=archive` 拿回上个进程的事件 |
| 序号跨重启单调 | 进程 A 写 `[1,2]`，进程 B 从 3 续；全档序号连续且唯一 |
| 序号是服务端不变量 | 调用方传 `auditSeq: 999` 被覆盖为服务端序号 |
| `retention` 诚实性 | 轮转过 → `historyTruncated: true` + `spanMs = newestTs − oldestTs`；**没轮转过 → `false`**（不谎报） |
| 坏行容错 | 末尾半行被跳过并计入 `malformed`，完整记录照常可读；**尾部播种仍成功**（不因半行放弃整个归档） |
| 半行后接完整行 | 两行被拼成一行 → 该条计入 `malformed`（**如实登记为不可恢复**，非静默） |
| limit 语义 | 返回**最近的** N 条并标 `truncated: true`，不假装这就是全部 |
| 跨文件查询 | 轮转后凑够历史需读多个文件（`filesRead > 1`），拼接后仍按时间正序且不重复 |
| 非法 `source` | `?source=nope` → **400 `bad_source`** + `allowed` 列表（不静默当默认值） |
| 无目录（内存模式） | 所有查询不抛错，`retention.enabled: false` |

### 5.3 端到端（真实进程、真重启）

用例「进程 A 产生事件 → 进程 B（新进程、空内存）通过 `source=archive` 查回同一段历史」：
起进程 A → 真实 ws 连接 + 真实写 op → 收掉 → 起进程 B（`WB_AUDIT_DIR` 同一目录）→
断言 ① 默认查询为空但带 `hint`（指向 `source=archive`）与 `retention`；② `source=archive`
拿回 `connect` 与 `ops` 且按房间隔离；③ 进程 B 新写事件的序号大于归档里的最大序号；
④ `source=all` 合并后序号仍唯一；⑤ 非法 `source` 400。

## 6. 未覆盖 / 已知边界（诚实登记）

1. **仍无长期归档**：轮转按**单文件字节**（默认 8MiB）保留 3 份，不按时间/天数；
   超出即永久滚出。`historyTruncated` 只**如实报告**这件事，不做归档扩张——
   真正的长期归档（外部存储/压缩/生命周期策略）是独立产品决策，且与 ADR-0008 决策 1
   「不引入外部存储、不承诺横向扩展」直接冲突，需将军另批。
2. **`archive` 查询的 `total` 是「本次返回条数」**，不是全档精确匹配总数：真实总数需全档扫描，
   与「单次请求最多 1000 条 / 32MiB」的上限冲突。用 `truncated` + `archive.scanned` 表达，
   调用方需自行加大 limit 才能逼近全量。
3. **轮转期间的竞态**：归档查询是「读文件」而非「快照读」。若查询恰好发生在 `_rotate()` 的
   `rename` 之间，可能有**一个文件的窗口**读到不完整集合（表现为少几条 + `truncated`）。
   未加锁（加锁会与主流程争用）；未在用例中构造该竞态。
4. **`retention` 有 2s 缓存**（`RETENTION_TTL_MS`，避免 `/metrics` 轮询时反复 stat）：
   刚发生的轮转在最长 2s 内可能仍显示旧读数。写路径测试用 `{ force: true }` 规避。
5. **未做内存占用的压测**：`queryArchive` 对每个文件用 `readFileSync` **整读**（最大 8MiB × 4 文件），
   并把它切成行数组。单次请求的最坏内存约数十 MB。当前规模可接受，但**若把 `FILE_MAX_BYTES`
   调大，这里要先改成流式**。
6. **`ops` 审计只记摘要、不记内容**：能回答「谁在这个房间写了几个元素、什么操作类型」，
   **不能**回答「他画了什么」。无操作级回放（与 ADR-0008 既有边界一致，本切片未扩张）。
7. **`malformed` 计数不区分「半行」与「彻底损坏」**：都计入同一个计数，不记录行号/偏移，
   排查时无法直接定位。未做（认为是过度设计）。
8. **`all` 的排序以 `ts` 为主键**：跨重启合并若发生**时钟回拨**，顺序可能与真实写入顺序不一致；
   `auditSeq` 只作同一 ts 内的次序。未构造时钟回拨用例。

## 7. 复跑命令

```bash
# 新用例（纯函数 + 真实进程重启）
cd whiteboard && node --test apps/server/test/audit-archive.test.mjs

# 白板全量（含既有 metrics-audit 回归）
cd whiteboard && npm test

# 全量门禁（env + test + doc）
node scripts/ci/run-ci.mjs --only env,test,doc --out .ci/p4-5
```
