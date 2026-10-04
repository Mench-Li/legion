<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-04**（commit `0311a61b`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# 2026-10-03 · desktop 档案自动启动实测（含一次仓库级阻塞的修复）

## 1. 结论

「Legion 随宿主自动起」在 **desktop 档案**上已经**真实发生过一次**：

- 用户在 09-30 23:57 之后重启了 DSH Desktop（profile = `desktop`）；
- 日志 `D:\project\DSH\legion\.legion-services.log` 在 **2026-10-03T03:32:54Z**
  出现 `legion-services 挂载 → team-hub 已启动 → 军团指挥台已启动`；
- 守护心跳 `scrum/daemon.json` 在同一分钟由 worker 写入（`maxWorkers: 2`、`scope: software`、
  `role: soldier-auto`、`forever: true` 来自 desktop 那份补丁行）。

也就是说：补丁层**被 DSH 读进去了**，两个插件行**都生效了**（`legion-services` 起了服务、
`legion-scrum-worker` 起了守护）。**档案接线这一环不再是假设。**

## 2. 但当时两个服务立刻退出了——原因不在档案，在仓库本身

```
[team-hub] Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\project\DSH\legion\product\local-auth.mjs'
           imported from D:\project\DSH\legion\team-hub\server.mjs      → 退出 code=1（存活 141ms）
[workbench] 同一个缺失                                                     → 退出 code=1（存活 147ms）
```

`product/local-auth.mjs` **在 HEAD 里存在、在工作树里不存在**，而它的测试
（`product/local-auth.test.mjs`）还在树里，两个入口（`team-hub/server.mjs:63` 与
`workbench/scripts/serve.mjs:40`）都在 import 它。这是**半完成的 rebase 留下的坏引用**
（`.git/REBASE_HEAD` 指向 `16a0b4db`，但 `.git/rebase-merge` 已不在；索引里挂着大量
`D` 删除，包括整个 `desktop/`）。

### 修了什么（只从 HEAD 取回磁盘上缺的文件，不发明新内容）

| 文件 | 依据 |
| --- | --- |
| `product/local-auth.mjs`（2485 B） | HEAD 里有；`git checkout HEAD --` 取回；`node --test product/local-auth.test.mjs` → **3/3 通过** |
| `team-hub/agent-conversations.mjs`（33234 B） | 同上（HEAD 里有） |
| `team-hub/routes/agents.mjs`（1802 B） | 同上 |
| `team-hub/routes/workflow-packs.mjs`（3455 B） | 同上 |
| `product/workflow-packs/pack.mjs`（16447 B） | 同上 |

排查工具：`scratch/find-missing-imports.mjs`（只读探针，从 5 个入口递归解析相对 import，
报出"哪个文件 import 了磁盘上不存在的模块"）。修复前后：

```
修前：扫描 186 个模块 → 缺失 6 处（5 个文件 + 2 处注释里的假引用）
修后：扫描 191 个模块 → 只剩 2 处**注释里的**假引用（不是真 import）
  · team-hub/routes/permissions.mjs:25  ← 注释里写的 `import('./server.mjs')`（测试说明）
  · team-hub/server.mjs:338             ← 注释里写的 `import('../server.mjs')`（宿主外壳说明）
```

## 3. 修复后的端到端实测（2026-10-03 11:36 本地）

| 检查 | 命令/证据 | 结果 |
| --- | --- | --- |
| 数据面 | `GET :8787/api/config`、`/api/spaces` | **200** |
| 指挥面 | `GET :5173/` | **200**（由 `legion-services` 自启的进程，pid 17460） |
| 中枢可达 | `GET :5173/hub/api/config` | **200** |
| 真数据 | `GET :5173/hub/api/board?scope=software` | **200** |
| **执行面** | `scrum/daemon.json` 心跳：11:31:01 → **11:36:05**（45 秒窗口内前进） | **守护在扫单** |
| 守护日志 | `C:\Users\11150\.dsh\super-injector\dsh-scrum-worker.log` 末行 03:36:04（真实任务 T-123..T-126） | 正常 |

★ 这条"执行面"判据是刻意选的：**只看端口会把"服务在、守护死"报成健康**
（本批次前半段正是这个状态——8787/5173 起来了，守护因为 fetch failed 一直在空转）。

## 4. 仍未做

- `desktop` 档案里 `maxWorkers` 是 **2**（写入时用的默认值），新档案默认已改为 1；
  两个宿主同时活着时并发度为 2+2。要么改档案里的数字，要么接受——**没有自动改写既有配置**。
- 单入口（"只启动 Legion"）见 [`docs/SINGLE-ENTRY-BOOT.md`](../SINGLE-ENTRY-BOOT.md)：本批只做到
  "接线 + 拉宿主 + 盯就绪"的判据设计，未接 `product/launcher` 的 `runtime.command`。
- `desktop` 档案只接了 `legion-services` + `legion-scrum-worker`（新增两行）；
  `team-hub` / `scrum-board` 两个宿主内 UI 插件**没有**加进去（避免两个宿主的 `/team-hub`
  与 `/scrum-board` 路由重复）。这是**有意的差异**，不是漏项。
