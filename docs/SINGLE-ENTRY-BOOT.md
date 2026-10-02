# 单入口自启：只启动 Legion，不手工启 DSH（设计与现状）

> 目标（用户 2026-09-30 提出）：**后期应当是反向的 —— 只需要启动 Legion，
> 就能直接完成所有内容，不依赖 DSH 的 web/desktop 启动。**
>
> 本文记录：现在能直接做到哪一步、缺哪一环、以及朝向目标的中间形态。
> 档案接线（本目标的第一步）见 [档案接线](PROFILE-WIRING.md)；产品化那条线的现状见
> [`product/launcher/`](../../product/launcher/) 与 [STATUS.md](STATUS.md) 里 PRT-257 的记述。

## 1. 一个绕不开的事实：执行面**就在 DSH 宿主里**

`dsh-scrum-worker` 是一个 DSH 插件：它在**宿主进程内**起 interval、认领任务、用宿主的
subagent 能力派工。所以"不依赖 DSH 启动"这句话，正确的读法是
**"不依赖用户手工去点 DSH Desktop 或敲 `dsh web`"**，而不是"没有 DSH 进程也能派工"：

| 层 | 谁提供 | 能不能脱离 DSH 进程 |
| --- | --- | --- |
| 数据面 `team-hub :8787` | 纯 node 脚本 | ✅ 能（现在就由 `legion-services` 托管） |
| 指挥面 `workbench :5173` | 纯 node 脚本 + 静态产物 | ✅ 能 |
| **执行面（守护/派工）** | **DSH 插件**（宿主进程内） | ❌ 不能——它需要一个活着的 DSH 宿主 |

结论：单入口要做的不是"去掉 DSH"，而是**由 Legion 自己把那个宿主拉起来并盯住它**
（谁启动、用哪个 profile、补丁层指哪、退出怎么收回、崩了怎么重启）。

## 2. 宿主的启动命令行（本机实测形状）

```text
"D:\software\dsh\DeepSeek Harness.exe" --expose-internals \
  D:\software\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js \
  <dsh 包目录> <profile 目录> <runtime 目录> <pnpm> <runtime bin> ...
```

- Desktop 的 profile 是 `C:\Users\11150\.dsh\profiles\desktop`（GUI 在 `:19387`）。
- 同一套 CLI 的 `web` 模式：`dsh web`（profile 取 `web`，默认 `:3080`）。
- 官方 CLI 垫片：`D:\software\dsh\resources\runtime\cli\bin\dsh.cmd`
  （内部就是 `DeepSeek Harness.exe --expose-internals <cli.js> %*`，并设 `ELECTRON_RUN_AS_NODE=1`）。
- 环境里已有 `DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_WEB_URL`，
  **但没有 `dsh` 在 PATH 上** —— 所以"单入口"必须自己解析 CLI 路径，不能指望 `dsh` 命令存在。

## 3. 两条路径，按代价从低到高

### 路径 A（中间形态，本批可落地）：`legion start` = 接线 + 拉宿主 + 盯就绪

一个 Legion 自己的入口脚本（`scripts/` 下，纯 node、零依赖），职责四件：

1. **接线**：调 `scripts/legion-profile.mjs --wire --profile <p>`（幂等）。
2. **拉宿主**：用上面的命令行形状起 `<cli.js> web --profile <p>`（`web` 模式；
   桌面模式由 `DeepSeek Harness.exe` 自己独占，无头/脚本场景不做）。
3. **盯就绪**：探 `:8787` / `:5173` / `/api/config` 与 **守护心跳**
   （`scrum/daemon.json` 的 `mtime` 必须往前走——只探端口会把"服务在、守护死"报成健康）。
4. **盯退出**：子进程退出按退避重启；Legion 退出时统一回收（与 `services-plugin` 同款语义）。

### 路径 B（产品形态）：走 `product/launcher/`

`product/launcher/` 已经写好了这条路的地基：DSH 运行时安装进 DataDir、`--patch` 强制面
覆盖层、进程计划与端口仲裁、doctor/自检。**它现在卡在一处配置上**：
产品配置 `runtime.command` 为空 → Launcher 拒绝启动（这是刻意的：宁可不启动，
也不要"启动了一个我们不知道是什么的宿主"）。把上面那条命令行形状填进去（或由 installer 写入），
这条线就是真正的"一键启动"。

## 4. 判据（什么叫"单入口成了"）

一条命令，从**没有任何 Legion 进程**的状态开始，在 60 秒内达到：

| 检查 | 判据 |
| --- | --- |
| 数据面 | `GET :8787/api/config` → 200 |
| 指挥面 | `GET :5173/` → 200 且 `GET :5173/hub/api/config` → 200（中枢可达） |
| 执行面 | `scrum/daemon.json` 的 `mtime` 在窗口内前进 ≥1 次（守护真的在扫单） |
| 幂等 | 再跑一次不产生第二个宿主/第二个 8787 监听 |
| 退出 | 停掉入口后 8787/5173 都被回收（不留孤儿） |

这张表就是验收标准；**"服务起来了"不算"军团起来了"**——守护不在扫单的军团，
与一个没有军团的看板，在指挥台上长得一模一样。
