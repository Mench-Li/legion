<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-09**（commit `d47c6f5`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P1-3 DSH 宿主真实插件注入冒烟 — 验证证据

> 时间：2026-09-09　基线：`main`（REMAINING-TASKS.md P1-3）
> 环境：Windows，Node v24.19.0，`DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness`
> 范围：真实 DSH 宿主进程（隔离 `$DSH_HOME` + 自定义 profile）加载 legion 三插件
> （`@dsh-external/dsh-team-hub`、`dsh-scrum-board`、`dsh-scrum-worker`）

## 结论

P1-3 验收标准达成（真实宿主启动/注入/HTTP/SSE/token/关闭清理全链路），并顺手修复两个
**真实宿主注入才暴露的 board-plugin 缺陷**：

1. ✅ **真实宿主启动 + 三插件注入**：以真实 dsh CLI（`apps/cli/lib/bin.js`）+ `dsh-base` bundle
   起隔离宿主，profile 用户补丁层 insert 三插件 + fixture 控制插件；三插件 `apply` 全部执行
   （webServer.register 前缀生效、scrum-worker 注入面 timer/agents/subagents/agentDefaultModel/
   agentPresets 全 resolved → apply 内同步 `writeDaemonStatus` 落盘 daemon.json 证明完整 mount）。
2. ✅ **route prefix / HTTP / token 矩阵**：`/team-hub/api/config|board|create|transition|comment` +
   Bearer 401/200/乐观锁 409；`/scrum-board`（board 快照 / kanban.html / artifact 404 语义）。
3. ✅ **SSE 宿主形态**：`/team-hub/api/events`（宿主内 watchFile 捕获外部 activity.jsonl 追加 →
   增量广播）；`/scrum-board/api/board/events`（连接即 board.json 全量快照）。
4. ✅ **关闭清理**：保持两条 SSE 连接 → `/__p13/shutdown`（bounded dispose）→ 两端 SSE 被服务端
   end、子进程 ≤20s 自然退出 exit 0（残留 watcher/interval/连接会让进程挂起 → 超时即 fail）。

## 修复的真实缺陷（board-plugin，P1-3 现场暴露）

| 缺陷 | 根因 | 修复 | 回归 |
|---|---|---|---|
| **冷启动 mount 崩溃** | `ctx.effect` 里 `watch(board.json)` 在文件尚未由 render 生成时同步抛 ENOENT → 插件在空任务库/冷宿主上 boot fail-loud | 目录级 `watch(scrumDir)` + filename 分派（board.json→广播 / tasks.json→防抖重渲染），scrumDir 必然存在 | http-contract 32/32 仍绿 |
| **detectHub 硬编码 3080** | 探测 `http://127.0.0.1:3080/team-hub` 会把 board 指到其他宿主/生产实例（P0 组合里 3080 恰是同宿主才碰巧正确） | 改探测 `http://127.0.0.1:${ctx.webServer.port}/team-hub`（同宿主 team-hub；隔离/异端口部署不再错配） | http-contract 32/32 仍绿 |

## 新增文件

- `tests/p13-fixture/control-plugin.mjs`：file:// 注入的 fixture 控制插件
  （GET `/__p13/ready` + POST `/__p13/shutdown` → `ctx.appExit(0)` bounded 退出）。
- `tests/p13-fixture/host-fixture.mjs`：fixture 生成（隔离 home + profile + node_modules junction +
  空 scrum 库）、`spawnHost`、`waitReady`、`req`、`sseCollect`、`waitSseClosed`。
- `tests/p13-fixture/p13-host-injection.test.mjs`：5 用例真实宿主注入冒烟（无 DSH_CHECKOUT 整组 SKIP）。
- `scripts/ci/run-ci.mjs`：test 阶段新增 `p13-host-injection` 套件组。
- `board-plugin/src/index.ts`：watcher + detectHub 修复（见上表）。

## 复跑记录

### 1) 单套件（隔离宿主全链路）

```
node --test tests/p13-fixture/p13-host-injection.test.mjs   # DSH_CHECKOUT 指向主 checkout
  ✔ ① 注入生命周期：三插件经真实 loader 组合 apply 成功，route prefix 各自挂载
  ✔ ② team-hub 宿主路径 HTTP 契约 + token 矩阵（Bearer）
  ✔ ③ board-plugin 宿主路径：board 快照 / kanban / artifact 404 语义
  ✔ ④ SSE 宿主形态：activity.jsonl watch 增量广播 + board 连接即全量
  ✔ ⑤ 关闭清理：bounded dispose 结束 SSE、进程自然退出 exit 0
✔ P1-3 ...  tests 5  pass 5  fail 0
```

### 2) run-ci test 阶段（门禁全链路，含 P1-3）

```
node scripts/ci/run-ci.mjs --only test --out .ci/p1-3-test-run   # DSH_CHECKOUT 指向主 checkout
  PASS board-plugin（宿主 HTTP 契约回归）: exit=0 tests=32 pass=32 fail=0
  PASS p13-host-injection（P1-3 真实宿主插件注入冒烟）: exit=0 tests=5 pass=5 fail=0
  ... 全套件 PASS
[test] -> PASS
```

完整计数见 `ci-test-summary.json`（本目录）。

## 验收映射（P1-3 原文）

| 验收 | 落点 |
|---|---|
| 启动真实 DSH 宿主 fixture | 真实 cli + dsh-base + 自定义 profile（隔离 $DSH_HOME/端口/空任务库） |
| 加载 team-hub / board-plugin / plugins | profile patch insert 三 @dsh-external 插件（junction 到 legion，同生产形态） |
| 验证 /api/config、/api/board、/api/artifact、SSE、token 矩阵 | ①–④ 用例（见上） |
| 宿主关闭时 watcher/SSE/定时器/DB 连接正确清理 | ⑤ 用例：SSE 被服务端 end + 进程自然退出 exit 0（残留句柄会让进程挂起） |

## 诚实边界

- 隔离 fixture 不含 client/UI bundle（dsh-web-app）：验证的是 **host 半**注入（真实 loader +
  webServer + 生命周期）。board-plugin 的 client 半（conversation.view iframe slot 等浏览器注入）
  需真实 GUI 面验证，登记 P1-3 附注/真实 3080 现场（P0 §3 dev_inject 流程已覆盖过注入链路）。
- scrum-worker 验证 mount + 生命周期（daemon.json 落盘 + sweep 读隔离 hub），未真实派 worker
  subagent（派工需真实模型通道；其行为由 plugins/tests 135 用例以 fakeContext 覆盖）。
- 三插件不持有 DB 连接（数据在 taskctl 文件库/team-hub 独立服务进程）；本批关闭清理验证的是
  watcher/SSE/定时器/foreman 句柄。
- 修复后 board-plugin hub 模式在「隔离宿主 + 同宿主 team-hub」下读写走自身 /team-hub（闭环隔离），
  未触碰生产 scrum 库/8787/3080 配置。
