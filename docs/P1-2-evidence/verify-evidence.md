<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-09**（commit `47cdad9`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P1-2 board-plugin 宿主 HTTP 契约测试 — 验证证据

> 时间：2026-09-09　基线：`main`（REMAINING-TASKS.md P1-2）
> 运行环境：Windows，Node v24.19.0，`DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness`

## 结论

P1-2 验收标准全部达成，board-plugin 独立 HTTP 契约套件已接入发布门禁：

1. ✅ 独立测试可在无完整 DSH GUI 的情况下运行 —— `node --test board-plugin/tests/http-contract.test.mjs`（32/32）。
2. ✅ 与 `scrum/artifact-detail.test.mjs` 使用同一组语义断言 —— `/api/artifact` 逐条语义组逐条对齐
   （worktree 分支态优先/主仓兜底、i 越界 400、未知任务与无产物 404、越权三类 403、缺失 404、
   octet-stream、url 302/`{url:true}`）。
3. ✅ 真实宿主注入测试另行保留，不用 mock 结果冒充宿主验证 —— 本套件仅以 fixture 替身覆盖 HTTP
   契约面（taskctl/render 替身 + fake team-hub 服务器），DSH 宿主 `inject`/`webServer.register`
   真实注入冒烟仍属 P1-3。

## 新增/修改

- `board-plugin/tests/http-contract.test.mjs`（新，32 用例）
- `board-plugin/tests/fixtures/`（taskctl/render 替身、roles.json、kanban/console.html）
- `board-plugin/src/index.ts`（相对产物路径白名单回退加固：候选存在但 realpath 复检不通过的
  junction/符号链接逃逸路径不再回退，整体 403 —— 本次修复由 link-out 用例守卫）
- `board-plugin/package.json`（`test` 脚本：build + node --test，镜像 plugins 先例）
- `scripts/ci/run-ci.mjs`（test 阶段 DSH_CHECKOUT 门内新增 board-plugin 构建 + 契约回归套件，
  镜像 plugins 先例；无 checkout 时 SKIP 不伪造通过）
- `docs/REMAINING-TASKS.md`（P1-2 标记完成，更新推荐顺序）

## 复跑记录

### 1) 门禁 test 阶段（真实注册路径）

```
node scripts/ci/run-ci.mjs --only test --out .ci/p1-2-test-run   # DSH_CHECKOUT 指向主 checkout
...
  PASS plugins build（DSH_CHECKOUT=...）
  PASS board-plugin build（DSH_CHECKOUT=...）
  ...
  PASS scrum（任务生命周期与产物）: exit=0 tests=25 pass=25 fail=0
  PASS plugins（外部 DSH 回归）: exit=0 tests=135 pass=135 fail=0
  PASS board-plugin（宿主 HTTP 契约回归）: exit=0 tests=32 pass=32 fail=0
[test] -> PASS (40897ms)
```

完整计数见 `ci-test-summary.json`（本目录）。`.ci/p1-2-test-run/` 为可再生成运行时产物（gitignore），
不入库。

### 2) 套件直跑（独立于 run-ci，任意环境有已编译 lib 即可）

```
node --test board-plugin/tests/http-contract.test.mjs
ℹ tests 32  ℹ pass 32  ℹ fail 0  ℹ skipped 0
```

覆盖面：静态/旁路（config/daemon/patch/前缀重写/404/CORS）、`/api/board`、`/api/activity`(limit)、
artifact 逐条（含 link-out 越权 junction 403 + link-in 放行）、本地写接口（缺参 400、乐观锁 409、
错误透传）、SSE board 初始+增量 / activity 初始+watch 增量、hub 模式（读带 scope+Bearer、500 文案、
写透传、乐观锁 409、业务 400、非 JSON 500 文案）。

注：junction 用例曾因 `{skip: !fx?.linksOk}` 在 describe 体（模块加载期，`fx` 未初始化）恒真而恒跳过；
已改为用例体内运行时 `t.skip()` 判定，本机实测 32/32 全跑（Windows junction 与 Linux dir symlink
均可用；无权限环境才按需跳过）。

### 3) scrum 锚点套件（同一语义组，回归对照）

```
node scrum/artifact-detail.test.mjs
ℹ tests 10  ℹ pass 10  ℹ fail 0  ℹ skipped 0
```

## 诚实边界

- 本套件不冒充宿主验证：DSH `inject` 生命周期、route prefix 注入、宿主级 SSE 清理与前端面板注入
  不在本套件范围（P1-3）。
- hub 模式使用 fake team-hub 服务器断言转发协议（scope/token/字段/错误映射），非真实 team-hub 语义
  （P1-1 独立服务合并后其契约面另由 team-hub 套件覆盖）。
