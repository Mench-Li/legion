# P1 现场验收 Runbook —— tester_S1 与 coder_S2 同时 inflight

> 状态：**✅ 已于 2026-09-04 执行完毕**（沙箱 scope `slice-verify` + 真实守护/worker），验收记录见 `docs/P0-CONFIRMATION.md §9`，原始日志证据 `D:\tmp\slice-acceptance-evidence.txt`。
> 下文即本次实际执行路径，保留供复跑/生产侧重演；生产已回滚（scope=software / maxWorkers=1）。
> 复跑注意：devops 尾 worker 在沙箱环境两次挂起（看门狗正常接管重派）；software 空间绑定已还原为空（守护回退注入默认 repoRoot）；沙箱空间可用新增端点清理：`POST /api/spaces/delete`（body: id + confirm=`delete-space:<id>`；software/default 受保护）。
>
> 目标：兑现 `P0-CONFIRMATION.md §8` 的清单-4 现场验收线（守护日志出现两个切片任务并行在跑），
> 并顺带验证 D7' 机器闸门 / fix 回炉在生产形态下工作。
> 前置：代码已全部落地（`team-hub/server.mjs`、`plugins/src/index.ts` + `lib` 已重建、12/12 测试绿），
> 文档见 `ORCHESTRATION-V3.md` 附录「P1 实施记录」。
> ⚠ 全部步骤会**重启 DSH web 宿主进程**（守护插件运行其中），执行时不要放在依赖该进程的会话内做。

## 0. 先决条件核对

```bash
# 1) lib 与 src 同步（junction 路径即源码）
node -e "const a=require('D:/project/DSH/legion/plugins/lib/index.js'); console.log('lib ok')"
# 2) team-hub 已跑新代码（有 /api/patch、/api/goal/slices 即新）
curl -s http://127.0.0.1:8787/api/config | head -c 120; echo
curl -s -X POST http://127.0.0.1:8787/api/patch -H 'content-type: application/json' -d '{}' | head -c 200; echo
# 期望出现参数校验错误（端点存在）而非 404
```

## 1. 准备验收沙箱空间（不碰 production software 与 T-036..T-043）

用一个**全新 scope + 独立临时 git 仓库**，避免干扰在途目标：

1. 建临时仓库并做初始提交：`git init D:/tmp/slice-sandbox && cd D:/tmp/slice-sandbox && git config user.name legion && git config user.email legion@x && echo seed > seed.txt && git add -A && git commit -m init`
2. team-hub 建空间并把软件八岗复制进编队（从默认空间复制全局角色）：
   - `POST /api/spaces` `{id:"slice-sandbox", name:"切片验收沙箱", by:"general"}`
   - 若 `POST /api/spaces/slice-sandbox/agents`（roles 数组，需先有全局编队种子）不可用，改用逐个 `POST /api/agents` `{role:"requirement|researcher|breaker|test-designer|coder|reviewer|tester|devops", name:"…", scope:"slice-sandbox", by:"general"}`（与 team-hub 冒烟相同手法）。
3. 空间仓库绑定：`POST /api/spaces` 同 id 再提交 `localDir:"D:/tmp/slice-sandbox"`（守护按 scope 读取 localDir 作为 worker 目录与隔离仓库根，见 `index.ts refreshSpaceBinding`）。

## 2. 提升守护并发并指向沙箱

编辑 `~/.dsh/profiles/web/cordis.patch.yml` 的 `dsh-scrum-worker.config`：

```yaml
scope: 'slice-sandbox'   # 临时指向验收沙箱
maxWorkers: 2            # 绝对并发上限提到 2（关键：让两个 worker 同时跑）
# 槽位/预算走守护默认（sliceCoderSlots=2 sliceTesterSlots=2 perGoalSliceCap=4 maxFixPerSlice=2），无需显式写
```

保存后**重启 DSH web**（宿主进程重启使插件按新配置 + 新 lib 加载；junction 无需重建，lib 是源码路径直出）。

## 3. 发布 slice 模式目标并放行分析前缀

```bash
# 发布（mode=slice → 只建 requirement..test-designer 前缀链）
curl -s -X POST http://127.0.0.1:8787/api/goal -H 'content-type: application/json' \
  -d '{"scope":"slice-sandbox","objective":"做一个登录页（3 个独立切片验收）","mode":"slice","by":"general"}'

# 监听守护日志（前台观察即可）
tail -F ~/.dsh/super-injector/dsh-scrum-worker.log
```

分析前缀（需求澄清→方案搜索[人工闸门]→任务拆解→用例设计）依次自动流转。闸门阶段（researcher）需在 workbench/kanban 或直接 API 验收：
`POST /api/advance {id:"<researcher任务id>", by:"researcher", scope:"slice-sandbox"}`（把对应任务先 claim 亦可交给守护）。
breaker 会在 `docs/TASK_BREAKDOWN.md` 产出 `## slices` 机器可读清单（roles.json 已约定格式）。

## 4. 验收信号（P1 现场线）

test-designer done 后，守护日志应依次出现：

```
T-00X 分析前缀完成…注册切片束    （orchestrateSlices ①：解析 TASK_BREAKDOWN.md → /api/goal/slices）
T-00X 切片束已注册：N 个任务
scrum:T-00a / scrum:T-00b …       （slice coder 认领派工）
```

**关键证据（Q1/Q2 的机器验收）**：日志出现 **`tester_S1` 相关 worker 与 `coder_S2` 相关 worker 同时在 inflight** ——
即两个不同切片的 worker 并发在跑（守护 30s 一轮，多轮日志里能看到"派工"与"→ done（D7' 机器闸门通过）"交错出现；
更直接的判定：`tail` 窗口内先后出现 `T-00y 切片测试通过` 与另一切片的 `认领开工`，且二者间隔 < 一个 worker 时长，
说明 S1 在测时 S2 在写）。

D7' 附加验证（可选）：给某切片在编码阶段故意留一个可复现 bug → 观察 `test-report` 失败 →
`❌ 切片测试未通过` → `🛠 已派发修复任务` → fix 合入 → `🔄 修复已完成…自动重开重测` → 修复后 `✅ 切片测试通过（机器闸门自动 done）`。

## 5. 收尾回滚

1. 恢复 `cordis.patch.yml`：`scope: 'software'`、`maxWorkers: 1`（或按需保留 2），重启 DSH web；
2. 可删除沙箱空间：`DELETE /api/spaces/slice-sandbox`（或保留观察）；
3. 在 `P0-CONFIRMATION.md §8` / `ORCHESTRATION-V3.md` 附录勾掉「未落地」项并记录日志摘录。

## 常见问题

- **守护日志没动静**：先确认 `daemon.json`（scrum 目录）的 `scope/paused`；profile 改后必须重启宿主进程才生效。
- **register 报「分析前缀未完成」**：test-designer 尚未 done，等守护自动流转；人工闸门阶段先验收。
- **TASK_BREAKDOWN.md 无切片清单**：breaker 提示词新格式未生效（roles.json 改动同样需重启宿主进程让守护重读）。
- **team-hub 旧进程**：新端点不存在 → 按 legion-services 方式重启 team-hub 进程（非 DSH web 进程，可独立重启）。
