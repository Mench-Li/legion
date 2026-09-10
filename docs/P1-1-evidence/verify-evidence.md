<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-09**（commit `1dc82aa`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P1-1 第 1 步验证证据 —— v2 唯一权威 + 宿主外壳收敛

> 验证时间：2026-09-09　基线：`main`（`d47c6f5`，P1-3 合入后）
> 关联：`docs/P1-1-DECISION.md`（决策 D1=A / D2=两步走）· `docs/REMAINING-TASKS.md` P1-1
> 范围：第 1 步代码收敛（server.mjs 工厂面 + src/index.ts v2 外壳 + 对拍测试）；**未动生产拓扑/配置/库**

## 1. 改动面（git 可复现）

| 文件 | 类型 |
|---|---|
| `team-hub/server.mjs` | 改：导出 `DEFAULT_DB_FILE`；`handle(req,res,stripPrefix?)` 前缀剥离；导出 `handle`/`disposeHub`；修重复导出 |
| `team-hub/src/index.ts` | 重写：v2 外壳（Config 转接 env → import server.mjs → webServer 挂前缀）；taskctl v1 实现删除 |
| `team-hub/server.d.mts` | 新：ambient 声明（tsc 解析相对 .mjs） |
| `board-plugin/src/index.ts` | 改：Config `hubProbe`（默认 true，向后兼容） |
| `tests/contract/team-hub-parity.test.mjs` | 新：双形态对拍 |
| `tests/p13-fixture/host-fixture.mjs` | 改：team-hub dbPath 隔离 / board hubProbe:false |
| `tests/p13-fixture/p13-host-injection.test.mjs` | 改：① config v2 形状；④ SSE v2 信封断言 |
| `scripts/ci/run-ci.mjs` | 改：suite 登记 parity |

## 2. 验证记录

### 2.1 team-hub 全组回归（server.mjs 改动零回归）

命令：`node --test team-hub/*.test.mjs read-auth/read-open-loopback tests/contract/team-hub-parity.test.mjs`

结果：**tests 138 / pass 138 / fail 0**（chat 42、skills 20、calendar 13、spaces 5、goal 14、rules 7、artifact 16、security 6、read-auth 14、read-open-loopback 1、parity 1）

要点：
- chat/skills/calendar 等 137 个既有断言全绿 → `handle` 签名扩展（第三参可选）与导出修复对独立服务零影响。
- parity 对拍断言：config 响应全等（auth/db/port）、404 文案一致且无 `/team-hub` 前缀残留、401/409 文案归一化一致、board 同库同时刻全等、create→transition→comment 两侧结构等价。

### 2.2 P1-3 真实宿主注入冒烟（v2 外壳在真实 loader 生效）

命令：`node --test tests/p13-fixture/p13-host-injection.test.mjs`（DSH_CHECKOUT 配置）

结果：**5/5**（① 注入生命周期 · ② HTTP 契约+token 矩阵 · ③ board 本地 · ④ SSE 信封回放+seq 递增 · ⑤ dispose 退出 exit 0）

要点：
- ① v2 `/team-hub/api/config`：`{auth:true, db:…p13-hub.db, port:fx.port}` → 外壳把 webServer.port 传给 v2（宿主注入证据），隔离库生效。
- ② 401/200/409 与 task/version/comments 语义与 v2 契约一致（同 handle 即同语义）。
- ④ `/team-hub/api/events`：连接即回放 audit 信封（`id:`+`data:` 含 seq/event/taskId），新写 → seq 递增广播。
- ⑤ 关闭清理：SSE 被服务端 end（disposeHub），宿主进程自然退出 exit 0（无 libuv 崩溃）。

### 2.3 环境隔离与诚实边界

- 全程使用 mkdtemp 隔离库（`p13-hub.db`、parity `hub.db`）；**未触碰** 生产 `team-hub/team.db`（5.5MB）、`scrum/tasks.json`、`~/.dsh/profiles/web/cordis.patch.yml`，未重启 3080/8787/4820/5173 实例。
- P1-3 fixture 中 board-plugin 以 `hubProbe:false` 保持本地模式验证（隔离宿主无 8787；避免 board 探测宿主 v2 hub 后其 v1 语义动作 reject/promote 404）。
- 诚实边界：
  1. 聊天/日历/技能/空间/附件端点本轮未逐个在宿主前缀路径打全量矩阵——宿主挂的就是 v2 handle 全端点面（与独立服务同一函数），由 parity 抽样 + team-hub 组全量保证语义同一；如需逐端点宿主面断言可另立 suite。
  2. 生产「重启宿主即切 v2 外壳」的现场行为未验证（D2 决策：第 2 步另立批次现场验收）。
  3. v1 独有 `/api/reject|promote` 已随 v1 适配器下线；board-plugin hub 模式对这两动作的映射/降级未做（D3，归第 2 步）。

## 3. 结论

第 1 步验收达成：宿主 `/team-hub` 与独立 8787 服务共享**同一 v2 handle/同一默认数据池**，不再存在第二套任务状态机与鉴权实现；双形态对拍 + P1-3 真实宿主冒烟全绿。
