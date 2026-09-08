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
