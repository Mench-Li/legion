# P1-1 第 2 步现场切换 runbook — v2 唯一中枢落地

> 适用范围：生产 3080 宿主（PID 由 dsh web CLI 拉起，单宿主同时承载 web GUI +
> team-hub/board/worker 三插件 + services-plugin 托管 8787/4820/5173）。
> 执行人：用户（重启宿主会中断本 GUI 会话，故不能由 agent 自执行）。
> 时间：代码合入 main 后、用户方便时。执行后跑 `scripts/live/p11-step2-verify.mjs` 验收。

## 背景（本步改了什么，合入后生效）

| 变更 | 文件 | 生效条件 |
|---|---|---|
| team-hub 宿主 = v2 外壳（第 1 步，已合入） | `team-hub/src/index.ts` → 动态 import `server.mjs` | 宿主重启 |
| board-plugin hub 模式 v2 化：写后不再渲染本地、activity/board/events SSE 桥 v2 `/api/events`、hub 面板 = v2 动态页、reject/promote → 501 指引 | `board-plugin/src/index.ts` + `hub-panels.ts`（需 build → `lib/`） | 宿主重启（junction=源码 → 读 lib 产物） |
| v1 看板服务退役：services-plugin 不再托管 `serve.mjs :4820` | `services-plugin/index.js` | 宿主重启 |
| v1 文件库归档脚本（重启后执行） | `scripts/ci/archive-v1-scrum.mjs` | 手动运行 |

## 执行步骤

### 0. 前置：代码已合入 main + board-plugin 已 build

仓库内执行（可由 agent 或用户做）：
```
git -C D:/project/DSH/legion log --oneline -1          # 确认合入
DSH_CHECKOUT=D:/project/DSH/dsh/deepseek-harness node scripts/ci/build-external-package.mjs board-plugin
node scripts/ci/build-external-package.mjs team-hub    # 第 1 步已 build；再跑一次无妨
```

### 0b. ⚠ 部署链前置：@dsh-external 必须是 junction（2026-09-09 现场发现）

首次重启后 probe 失败，根因：生产 `~/.dsh/profiles/web/node_modules/@dsh-external/` 里
`dsh-team-hub` 与 `dsh-scrum-board` 是 **2026-08-26/09-01 的陈旧复制副本**（非 junction），
宿主加载的是副本旧代码（/team-hub 旧 v1 适配器、board 本地模式），legion 侧新 lib 从未生效。
`dsh-scrum-worker`/`dsh-legion-services` 一直是 junction，故不受影响。

已修正（2026-09-09 18:50）：两陈旧副本改名备份（`dsh-team-hub.v1copy-20260909-185030` 等），
重建 junction → `D:\project\DSH\legion\team-hub` / `board-plugin`。
**若日后 pnpm install / profile 重建使副本回归，需按此重查**：
```
Get-Item ~/.dsh/profiles/web/node_modules/@dsh-external/* | Select Name,LinkType   # 应全为 Junction
```

### 1. 重启 3080 宿主

在 DSH Desktop / 宿主进程管理界面重启 web 服务（等同结束 PID 13816 并重新
`node apps/cli/lib/bin.js web`）。重启即完成三件事：
- `/team-hub` = v2 外壳（同 8787 数据池 team-hub/team.db）；
- board-plugin 探测同宿主 /team-hub → hub 模式 = v2（面板/SSE/写面全切）；
- services-plugin 不再托管 4820（若旧 8040 子进程随宿主退出，不会再生）。

### 2. 归档 v1 文件库（可选但推荐；4820 已停后执行）

```
cd D:/project/DSH/legion
node scripts/ci/archive-v1-scrum.mjs        # 前置检查：4820 关闭 + tasks.json 无近期写
```
失败时按提示处理；确认无活跃写者后可用 `--force` 跳过检查。
归档后：`scrum/archive/v1-<时间戳>/` 存 tasks.json/activity.jsonl/board.json/kanban.html/KANBAN.md；
`scrum/tasks.json` 不再存在（.archived 占位说明）。

### 3. 现场验收 probe

```
node scripts/live/p11-step2-verify.mjs                # 宿主 teamToken 空时
node scripts/live/p11-step2-verify.mjs --token <t>    # 若宿主 teamToken 非空
```
验收项：① /team-hub config v2（db=team.db）② board 面板 = v2 动态页
③ board 数据 = v2 software 活池 ④ 与 8787 同池（任务 id 集合一致）
⑤ 4820 已停 + tasks.json 已归档 ⑥ 写冒烟 create→canceled ⑦ reject → 501。
退出码 0 = 全过。

### 4. 回归确认

- 宿主日志无 board-plugin 错误（`.legion-services.log` 应只剩 team-hub/workbench 两服务启动）。
- workbench :5173 正常（其 /hub 仍代理 8787，不受影响）。
- worker 守护正常 sweep（daemon.json lastSweepAt 持续更新；看板任务随 worker 动作实时变）。

## 回滚预案

若验收失败/现场异常：
1. 归档未执行 → `git revert` 本步 commit（board-plugin/services-plugin 回到旧实现）；
2. 归档已执行 → 把 `scrum/archive/v1-<时间戳>/` 文件移回 scrum/（.archived 说明删除）；
3. 重启宿主回到旧代码生效态；4820 需要时手动 `node scrum/serve.mjs --port 4820`。
   数据无损：v2 库（team-hub/team.db）全程只读不迁移；v1 文件全程只移动不删除。
