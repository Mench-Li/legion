# PRT-712（后半）：仪表盘的生产数据源

> spec §6.6。九个指标的口径早已做全，而 `readMetrics(source)` 的 `source`
> **从来只有测试传过**。

## §1 这一批要解决的问题

`product/metrics.mjs` 把九个指标的定义、未知档、比率与"此刻不适用"都做全了
（34 例断言），也早就留好了 `readMetrics(source)` 这个注入点——
而它的 `source` **没有任何生产调用方**：

> 一个「口径完整但没人喂它数」的仪表盘，
> 与一个什么都不显示的仪表盘，是同一个东西——
> 只不过前者有一份写得非常仔细的指标定义。

## §2 数据从哪来

| 指标 | 生产者 |
| --- | --- |
| `queue-depth` | `run-store.metricsCounts().queueDepth` |
| `oldest-pending-age-ms` | `metricsCounts().oldestPendingAgeMs`（空队列 → `null`） |
| `active-leases` | `metricsCounts().activeLeases`（在途**且租约未过期**） |
| `lease-expiry-rate` | `leasesExpired` / `leasesTotal` 两个读数点 |
| `attempt-retry-rate` | `attemptsRetried` / `attemptsTotal` 两个读数点 |
| `dead-letter-count` | `metricsCounts().deadLetterCount` |
| `upgrade-result` | `upgrade/audit.mjs` 的 `upgradeResultMetric()` |
| `runtime-availability` | **没有**（见 §5） |
| `model-error-rate` | **没有**（见 §5） |

比率类指标的两个数**各占一个读数点**，名字与 `METRIC_DEFS[...].ratioOf` 逐字一致。
只给一个（或让另一个悄悄变成 `undefined`）会得到一个没有含义的百分比，
所以两个都取不到时两个都返回 `null`，比率层如实报"还算不出来"。

## §3 ★ 抓到的真缺陷：两张词表接不上

`product/upgrade/audit.mjs` 的 `upgradeResultMetric()` 在"一条升级记录都没有"时返回
`'not-started'`；而 `METRIC_DEFS['upgrade-result'].allowed` 里那个词是 `'never-run'`。

两张词表**各自都是对的**，接起来就错：

```
computeMetrics({ 'upgrade-result': 'not-started' })
  → { known: false, value: null, reason: 'metric-no-data' }
```

也就是说：**一台从未升级过的新装机器，仪表盘上"升级结果"永远显示「—」**。

> 一个把「从来没有升过级」显示成「读不出来」的仪表盘，
> 与一个什么都没显示的仪表盘，是同一个东西——
> 只不过前者看起来像是一个暂时的故障，于是没人会去查。

而"从来没升过级"其实是一个**确定**的事实，不是"读不出来"。

**修法**：两张词表各自都有存在的理由（审计侧说"这次升级还没开始"，
指标侧说"从来没跑过"），所以**不改任何一边**，只在它们相遇的地方换算：

```js
export const UPGRADE_RESULT_VOCABULARY = Object.freeze({ 'not-started': 'never-run' })
```

并把这段事实写在常量旁边——下一个人搜 `not-started` 能搜到它。
认不出的词**原样返回**，让指标层按"不合法类别值"报出来，而不是由这里编一个。

## §4 ★ 合并掉的三处抄写

「租约还握在某个 worker 手里」这个状态清单，原先在 `team-hub/run-store.mjs`
里**逐字抄了三遍**：

- `recoverExpired` 的不带 scope 那条 SQL；
- `recoverExpired` 的带 scope 那条 SQL；
- `stats()` 的过期租约统计。

后果很具体：**`stats().expiredLeases` 会与 `recoverExpired` 实际愿意回收的集合不一致**——
仪表盘说"有 3 个过期租约"，而回收只认其中 2 个，剩下那个没有人会去查。

> 一个「统计过期租约」与「回收过期租约」各写一遍状态清单的实现，
> 与一个「报表上的过期数永远收不回来」的实现，是同一个东西——
> 只不过平时看不出来。

这与 `team-hub/claim-policy.mjs` 开头写的那件事是同一类（那里是两条认领 SQL
各写一遍任务级资格）。现在只有 `IN_FLIGHT_ATTEMPT_STATES` 一处，
SQL 由 `inFlightStatesSql()` 生成——**并排再写一份 SQL 字面量就是第四处抄写**。

生成器拒绝空数组：`IN ()` 在 SQLite 里恒为假，会让"有多少过期租约"**永远返回 0**。

## §5 三条纪律

| # | 纪律 | 为什么 |
| --- | --- | --- |
| ① | 队列为空时 `oldestPendingAgeMs` 返回 `null`，**不是 0** | `0` 会被读成"有一个刚进来的任务"，那是一句与事实相反的话 |
| ② | 没给运行库时**不装**那六个读数点，而是逐个点名进 `missing` | 装了但恒返回 0 的读数点，会让"库连不上"表现为"队列是空的、没有死信" |
| ③ | 库里没有 `metricsCounts()` 时**构造期就抛错** | 把构造错误推迟到读数时，等于让一个配置错误伪装成一次读数失败 |

②的实现要点：`createMetricsSource()` 返回 `{ source, missing, missingCount }`。
`missing` 让"这个指标是坏的"与"这个指标还没有人来喂"能被区分开——
两种在界面上都表现为「—」，但只有后者是**还没做**。

## §6 验证

### 6.1 为什么这一套起真的 SQLite 库

`metricsCounts()` 是**真的 SQL**，而 SQL 的错误方式恰好是"看起来对"：
列名写错、`IN ()` 恒假、`COUNT` 忘了加 `WHERE`、聚合返回 `null`。
拿一个假 store（返回几组预定数字）去测，测的只是**算术**，
而真正会错的那一半**一行都没执行**。

> 一个用假库喂出来的「数据源已验证」，
> 与一个从没跑过那条 SQL 的「数据源已验证」，是同一个东西——
> 只不过前者的用例数是完整的。

所以：建真库 → 走真 `ensureRunSchema` → 真写几行 → 再读指标。

### 6.2 套件（20 例）

`product/metrics-source.test.mjs`，已登记为 CI 套件 `metrics-source`。

### 6.3 破坏性验证：62①–62⑨，9/9

| 探针 | 补丁 | 结果 |
| --- | --- | --- |
| 62① | 空队列时 `oldestPendingAgeMs` 返回 0 | fail=1 |
| 62② | 已过期租约也算进 `activeLeases` | fail=9 断言错=3 |
| 62③ | 最老待办年龄取成 `MAX`（最新） | fail=1 |
| 62④ | 重试判据 `attempt_no > 1` 改成恒真 | fail=2 |
| 62⑤ | 拿掉词汇换算（新装机又永远显示—） | fail=2 |
| 62⑥ | 没给库时改回"装一组恒 0 的读数点" | fail=1 |
| 62⑦ | 两个"没有生产者"的指标不再点名 | fail=1 |
| 62⑧ | 撤销 `inFlightStatesSql` 合并（报表与回收对不上） | fail=1 |
| 62⑨ | 库没有 `metricsCounts()` 时不抛错 | fail=1 |

全部 `applied=1`、断言级变红、逐字节还原。

### 6.4 本轮探针过程本身的两个问题（如实记录）

**① 62⑧ 首轮 `fail=0`——跑错了测试文件。** 它补丁打在 `run-store.mjs` 上，
却让探针去跑 `claim-policy.test.mjs`。**这条判据其实很牢**（对账
`stats().expiredLeases` 与 `metricsCounts().expiredLeases` 的那条用例在
`metrics-source.test.mjs` 里），只是探针指错了地方。

> 一个"探针指错了测试文件"的 `fail=0`，
> 与一个"这条判据根本测不出来"的 `fail=0`，在输出里长得一模一样——
> 只不过前者会让人去重写一条本来很好的断言。

这是 PRT-711 那次"锚点没命中"的同类：**探针自身的错误伪装成判据的缺陷**。
故探针的 `files` 必须与补丁所在模块**对应**，改瞄后 62⑧ fail=1。

**② 我自己在夹具里踩了一次同类错误。** 一条用例用 `withStore` 包住
`await readMetrics(...)`——而 `withStore` 在 `finally` 里**同步** `close` 库，
异步读数还没读完库就关了。报错是"用例结束后仍有异步活动"，
看起来像用例写错了地方，实际是"同步收尾包住异步体"。

## §7 诚实边界

- 九个指标里**有两个今天没有任何生产者**，这是**事实**，本批不假装它们有数：
  - `runtime-availability`：没有任何东西在记录"Runtime 处于可用状态"的**时长**。
    `product/runtime-state.mjs` 会算出**此刻**的状态，但没有一份
    "窗口内 up/observed 时长"的记录。要喂它需要先有一个状态观测记录器，
    并且要先确定**窗口多长**。
  - `model-error-rate`：没有任何东西在记录模型调用的成功/失败次数。
    执行引擎与预算闸门都不落这份账。
- `metricsCounts()` 目前**只被这个数据源使用**，还没有界面或 CLI 消费者。
- **没有 `/api/metrics` 路由**（会动路由基线）；界面里没有仪表盘。
- `lease-expiry-rate` 的分母是 `lease_epoch > 0`（"曾经被租出去过"），
  与"当前在途"是两个不同的集合。这个口径是本批定的，若日后有别的消费者要重新确认。
- 租约过期率与重试率的**时间窗口口径仍未定**；`metric-bad-window`
  目前**没有任何调用方会产生**——它是为将来留的，不要读成"已经支持窗口了"。
- `upgrade-result` 的换算只在**两张词表相遇的地方**做。若日后
  `upgradeResultMetric()` 或 `allowed` 改词，这个映射需要同步——
  没有测试能自动发现"两边又对不上了"，只靠 §3 那段注释与这条用例。
