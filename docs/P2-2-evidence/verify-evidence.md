# P2-2 team-hub 读接口权限模型统一 — 验证证据

> 时间：2026-09-09　基线：`main`（REMAINING-TASKS.md P2-2）
> 运行环境：Windows，Node v24.19.0，`DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness`

## 结论

P2-2 验收标准全部达成（HTTP 矩阵 + 回环不回退锁定 + 消费方 token 头同步），已接入发布门禁：

1. ✅ 非回环监听无 token 拒绝启动（既有 `validateSecurityConfig`）；已配 token 时读面全门禁——除
   `/api/config` 能力探测与 OPTIONS 外，全部 GET/SSE/写端点统一 401；未知路径同受门禁不泄露存在性。
2. ✅ 正确 token 可读、错误 token 无法读取——Bearer / `x-dsh-token` / `?token=` 三种携带方式均验证
   （`?token=` 专供浏览器 EventSource 读订阅）。
3. ✅ 本地回环开发体验不回退——回环 + 已配 token 场景锁定：读/SSE/config 无 token 仍 200、写面仍
   401、带 token 可正常写入；team-hub 全组 137/137、run-ci test 全 PASS。

## 改动清单

- `team-hub/server.mjs`：`isLoopbackHost` / `readAuthRequired` 纯函数导出；`handle()` 读面统一门禁
  （远程保护模式，config/OPTIONS 除外）；`authorized()` 支持三种 token 携带方式；CORS 补
  `x-dsh-token`；模块头文档同步。
- `team-hub/security.test.mjs`：新增决策纯函数用例（回环/远程 × 有/无 token 矩阵）。
- `team-hub/read-auth.test.mjs`（新）：远程模式（TEAM_HUB_HOST=0.0.0.0 + token）HTTP 矩阵 8 用例。
- `team-hub/read-open-loopback.test.mjs`（新）：回环 + 已配 token 不回退锁定 6 用例。
- `workbench/src/api.ts`：`hubGet`（hub GET 统一带 Bearer）与 `hubEventSourceUrl`（hub 审计 SSE 追加
  `?token=`）；~20 个 hub 读函数 + `subscribeHubAudit` 全部改走带 token 路径；v1(apiBase) 读面不动；
  CalendarView 自带 token 头不动。
- `board-plugin`：hub GET/POST 早已带 Bearer（P1-2 契约套件验证），无需改动。
- `scrum/serve.mjs`（v1）：读面按既有契约开放（零 token 看板），写面 token 门禁不变，无需改动。
- `scripts/ci/run-ci.mjs`：test 阶段新增 `read-auth` 套件组。
- 顺带修复 `board-plugin/tests/http-contract.test.mjs` Windows junction 清理 EPERM 抖动
  （快速递归删除含 junction 临时目录 5/6 复现 exit=1 假红）→ 先删 junction + 宽容重试 + 失败仅遗留
  不抛；修复后 8/8 连续 exit 0。
- `docs/REMAINING-TASKS.md`：P2-2 标记完成，推荐顺序同步。

## 复跑记录

### 1) run-ci test 阶段（门禁全链路）

```
node scripts/ci/run-ci.mjs --only test --out .ci/p2-2-test-run-2   # DSH_CHECKOUT 指向主 checkout
...
  PASS security（监听安全配置）: exit=0 tests=6 pass=6 fail=0
  PASS read-auth（远程读面鉴权矩阵）: exit=0 tests=14 pass=14 fail=0
  ...
  PASS scrum（任务生命周期与产物）: exit=0 tests=25 pass=25 fail=0
  PASS board-plugin（宿主 HTTP 契约回归）: exit=0 tests=32 pass=32 fail=0
  PASS plugins（外部 DSH 回归）: exit=0 tests=135 pass=135 fail=0
[test] -> PASS (44897ms)
```

完整计数见 `ci-test-summary.json`（本目录）。`.ci/` 为可再生成运行时产物（gitignore），不入库。

### 2) run-ci build 阶段（Workbench tsc + vite 消费方改动门禁）

```
node scripts/ci/run-ci.mjs --only build --out .ci/p2-2-build-run
build: whiteboard PASS
build: workbench PASS（tsc --noEmit && vite build；622 modules transformed）
[build] -> PASS (18597ms)
```

完整计数见 `ci-build-summary.json`。

### 3) team-hub 全组直跑（含新套件）

```
node --test team-hub/*.test.mjs（10 文件）
ℹ tests 137  ℹ pass 137  ℹ fail 0  ℹ skipped 0
```

## 诚实边界

- 读面门禁以「监听 host 是否回环」判定，绑定行为与生产一致（非回环即远程）；测试以
  TEAM_HUB_HOST=0.0.0.0 环境注入模拟远程（实际 listen 127.0.0.1 不占外网端口）。
- Workbench 改动经 tsc + vite 构建验证（浏览器运行时行为不在本环境验证范围）。
- scope/member 一致性过滤属既有实现（skills include=pending 收口、chat 会话归属校验等），本项未新增；
  远程模式对「成员级」读过滤不做新模型（token 为团队级共享凭证，与既有写面语义一致）。
