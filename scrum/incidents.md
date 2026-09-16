# Legion 运行事件台账（将军）

## INC-2026-09-06-01：worker 模型流僵死（fjbigmodel 网关）
状态：**已修复（待重启宿主生效）**

### 现象
- T-095 多轮僵死（白昼复现：88min 静默）；T-107 r1 有效工作 64min 后 14:39:11 流静默 53min → 守护 15:32 强杀；T-100 r1 16min 模型瞬时 error。
- 共同病灶：模型流中途静默/偶发 error，pi-ai 5min 流空闲看门狗**不触发**（SDK 传输层对 abort 不响应时 next() 永不返回）。

### 处置（将军令，用户批准 A+B+C）
- **A** `C:\Users\11150\.dsh\profiles\web\cordis.patch.yml`：worker/mediator workerTimeoutMs 5400000→**1500000**（25min）、staleMinutes 100→**40**。需重启宿主生效。
- **B** `C:\Users\11150\.dsh\settings.yaml`：custom-ds/custom-gpt 各加 `streamIdleTimeoutMs: 90000`（90s）。pi-ai per-call snapshot，或已对新调用热生效。
- **C** harness 根治 `D:\project\DSH\dsh\deepseek-harness\packages\llm\llm-pi-ai\src\adapter.ts`：
  - 新增 `boundedNext()`：保留 watchdog.next() 的 idle arm 语义；idle/上游 abort 触发后给 SDK 2s 宽限（SDK_ABORT_GRACE_MS）settle，仍不响应则抛 signal.reason —— 不依赖 SDK 是否响应 abort，超时必然恢复控制权。
  - finally 收尾 `iterator.return()` 同样加 2s 有界等待，防 teardown 挂死。
  - 验证：adapter+sdk-options 49/49 测试通过；`tsc -b` exit 0；产物已编译至宿主加载位置（profile node_modules junction，lib/types/adapter.js 15:45:05）。

### 待办
- [ ] 重启宿主（DSH Desktop）使 A+C 生效（会中断在跑 worker → orphan 自动回收续做，WIP worktree 保留）。
- [ ] 重启后观察：若再遇流静默，应 ≤90s+2s 触发 llm/retry（B+C），daemon 兜底 25min（A）——验证三档生效。
- [ ] 上游改进候选（非本次范围）：SDK @earendil-works/pi-ai openai-responses transport 的 abort 传播（harness 侧已兜底，SDK 根治留给上游）；网关 fjbigmodel 稳定性（运维侧）。

### 并行链观察（同日）
- 两链并行共享单文件 docs/*.md 互踩：T-099 worktree 曾拿到另一链文档（本次未跑偏）。建议后续按 goalId 分目录（未排期）。

## INC-2026-09-16-01：给流水线末环加环节 → 历史已收口目标凭空长出新链（T-156 复发）
状态：**已修复**（数据层已生效；守护侧加固待重启宿主）

### 现象
- 新增 `soldier-market` 环节（插在 ops-social 之前，改末环后继）后，**两个历史已收口目标**
  （G-mttwdurn-1 收于 09-11、G-mtybi2u5-1 收于 09-12）的末环任务被判为「该有后继」，凭空长出 4 个任务：
  - T-162 / T-163（soldier-market）：均已执行完并 promote（产物合格，保留）
  - T-164 / T-165（soldier-ops-social）：**T-164 取消时正在跑**，T-165 未开工
- **下游风险**：这两条链的下一环是**素材制作**——会覆盖已验收的 `creative-kit.md`，甚至再触发一轮 45 分钟视频渲染。
- 根因两层：
  1. 守护跑的是**旧代码**。守护启动 09-14 09:28，而那条防线代码落盘 09-14 09:55 —— 守护早 27 分钟，
     于是跑的是没有该防线的版本。**注释里记的正是同一个现场（T-156）**，也就是说这是复发。
  2. 就算代码是新的，防线本身 **fail-open**：只读守护进程内缓存，**缓存缺失时保持原行为 = 放行**。

### 处置
- **数据层唯一收口点**（`team-hub/server.mjs` 新增 `assertGoalOpen`）：建任务前拒绝已 `done`/`canceled` 的目标，
  在 `createTask` 与 `insertGoalTask` 两条路径都设卡 → 覆盖守护补建、切片展开、fix 回炉、手工 `/api/create`。
  选数据层而非调用方，是因为**旧守护、缓存未就绪的窗口都拦不住调用方侧判断**。
- **守护侧 fail-closed**（`plugins/src/index.ts`）：缓存缺失时权威回查目标；仍拿不到（hub 不可达）则**保守跳过**
  —— 此处跳过不丢合法流转，因为创建后继同样要走 hub，hub 不可达时创建本来也会失败。
- 误建任务：T-164/T-165 置 `canceled`（终态，`parent` 链阻止每轮重建）；T-162/T-163 产物合格且已 promote，保留。

### 验证
- 新增 `team-hub/goal-closed.test.mjs` 10 例（两侧都钉：已收口必须拦 / 正常建链不得误伤）。
- 既有 14 套件全绿：goal 15、pipeline 19、spaces 5、calendar 29、chat 42、rules 7、skills 20、
  security 6、permissions 2、permission-engine 4、read-auth 8、read-open-loopback 6、artifact-content 16。
- 临时库+临时端口端到端；**线上**对 `G-mttwdurn-1` 实测拦截 → HTTP 400，看板 22 无新增（零副作用）。

### 纠错记录（本次自查抓到）
- 初版错误提示写「用 `/api/goal/status` 恢复为 active」，**实测发现 done 是终态、不可恢复**
  （`setGoalState` 只允许 paused→active）。已改为「发布**新目标**承接」，并加反向断言
  `assert.doesNotMatch(..., /恢复为 active/)` 钉住。原单测因为直接改库而漏掉了这个误导——补了真实路径用例。

### 待办
- [ ] 重启宿主使守护侧 fail-closed 生效（数据层已生效，故当前**已无复发风险**，此项为纵深防御）。
- [ ] 清理 T-164 工作树遗留的半成品（`.legion-worktrees/T-164/` 下 4 个未跟踪 `research/ozon/ops/t164-*`）。
