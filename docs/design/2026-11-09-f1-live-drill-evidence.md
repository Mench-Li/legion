# F1 · 真实守护四态演练（live drill evidence）

- 时间：2026-11-09 14:57–15:07（Asia/Shanghai）
- 环境：**隔离**（临时库 + 临时 git 仓库 + 临时 hub）；守护通过 profile 的**热加载 bundle** 接入，
  只服务隔离空间 `drill`，未触碰生产空间与真实仓库。
- 任务：`T-001`（`role=coder`），正文要求 worker **不要改代码**、直接上报 `status=dropped`。

## 判定结果

| 断言 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| 落定状态 | `canceled`（无需处理） | `canceled` | ✅ |
| 报告评论 | 0 条（不打扰人） | 0 条（另有 1 条 🟢 派工播报，不算报告） | ✅ |
| 活动痕迹 | 有 `drop` | `{"kind":"drop","text":"无需处理（dropped）：演练：超出范围"}` | ✅ |

## 时间线（同一秒内落定）

```
06:57:26.148  audit claim         {"soldier":"coder"}
06:57:26.156  activity claim      编码（coder）认领开工
07:07:00.040  activity drop       无需处理（dropped）：演练：超出范围     ← 真 dropped 路径
07:07:00.047  audit transition    {"to":"canceled"}（actor=bot，7ms 后）
```

关键点：`drop` 文案里带着 agent 自己写的 summary（"演练：超出范围"），
所以这**不是**超时结算——超时不会知道 summary，且 `claim + workerTimeout = 07:07:26` 比落定晚 26 秒。

## 两处判据口径修正（演练自己抓出来的）

1. `activity()` 写的是**本地 JSONL**（`scrumDir/activity.jsonl`），**不是** hub 的 `audit` 表
   ⇒ 断言 `audit.action === 'drop'` 永远为假。
   证据：本次 `releaseStaleRows=149` 而 `dropRowsInHub=0`。
2. "评论条数"必须排除**派工播报**（🟢 已派 AI worker…）：那是开工通知，不是打扰。
   已改为只统计含"无需处理/canceled"的报告评论。

## 顺带发现（已开单并已修一半）

### ① `release-stale` 审计刷屏（**已修，带判据**）

现象：守护每跳一次就调 `/api/release-stale`，路由**无条件**记账，于是什么都没释放也写一行。

真实库实测（2026-11-09 17:05）：

```
audit 总行数        : 136,476
其中 release-stale  : 132,198   ← 占 97%
其中空载荷（啥也没释放）:  84,253
最近一小时            :     104
```

也就是说：**审计表 97% 是同一件事的"什么都没发生"**。真出问题时要找的是"哪几件事被回收了"，
而这个信息被 13 万行噪音埋掉了。

修法：`released` 与 `quarantined` 都为空时不写审计（`routes/task-lifecycle.mjs`）。
判据 `release-stale-audit.test.mjs` 4/4：空转不留痕、连跳两次不增长、真回收要留痕且带 id、
回收之后再空转停在原地。

隔离演练实测：整场 waiting 演练（含一次 stale 回收）`release-stale` 只有 **1 行**（原来 10 分钟 149 行）。

⚠ **生效条件**：修的是 hub 的代码，所以真实的 8787 进程要**重启**才会用上新逻辑；
重启前它仍按旧逻辑继续写空载荷。

### ② `waiting` 真机验证（**通过**）

同一套隔离演练，把任务正文换成"报 `status=waiting, wait_for=human-decision`"：

```
08:34:15.897  activity claim     编码（coder）认领开工
08:40:18.447  activity report    等待 human-decision：演练：等待人工决定
claim 之后的 transition 行数     : 0        ← ★ waiting 不迁移
报告评论                          : 0 条     ← 不发进度噪音
```

口径说明：不能断言"若干分钟后仍是 `in_progress`"——stale 回收会把它放回 `todo`（本次 15 分钟后确实如此）。
**waiting 的本质是"报告那一刻没有引发迁移"**，所以断言落在 `claim` 之后没有 `transition` 上。

### ③ 岗位无模型绑定（未修，待判断）

活动流记 `岗位 drill/coder 没有模型绑定 → 这次用了平台默认模型`。
隔离演练下无妨（正好验证回落可用），但说明"按岗位选模型"未覆盖该岗位。


---

## ④ 归档执行记录（2026-11-10 10:39）

nginx 无关；这一节是**真库上的实际操作**，不是演练。

前置：先修掉刷屏（空转不写审计），确认重启后 `release-stale` **新增 0 行**，再归档历史。

```
干跑：可归档空载荷 84,252 行（seq 上限 136,478，当前最大 136,478）
执行：node team-hub/scripts/archive-audit.mjs --apply --batch=5000
备份：%TEMP%\team.db.bak-20261110-103910（119.9 MB，动库前先复制）
```

结果与自检：

| 指标 | 归档前 | 归档后 |
| --- | --- | --- |
| audit 行数 | 136,476 | **52,224** |
| audit 最大 seq | 136,478 | **136,478（未变）** ← 游标安全 |
| `release-stale` 行数 | 132,198 | 47,946（保留非空载荷） |
| 其中空载荷 | 84,253 | 1（就是天花板那一行，刻意留） |
| `audit_archive` | — | **84,252** |

三条安全线逐条核对：

1. **seq 天花板没被削低**：最大 seq 仍是 136,478 ⇒ `audit.seq = MAX(seq)+1` 不会回退，游标不重放。
2. **可追溯**：84,252 行都在 `audit_archive` 里，带 `archived_at` 与 `archive_reason`。
3. **幂等**：连跑第二次归档 0 行（判据 ⑥ 覆盖）。

归档期间 8787 hub 全程在线（分批 5000 行一个短事务，没有长时间独占写锁）。

判据 `audit-archive.test.mjs` **9/9**：空载荷识别（坏 JSON / null / 缺字段一律不当空）、plan 只读、
apply 进出、**seq 单调性**、永不归档天花板行、幂等、非目标不动、`before` 截止、分批 limit。

> 说明：`VACUUM` 才会把文件空间收回去，这里**刻意不做**——它是重操作且会锁库，应由人挑时间。
