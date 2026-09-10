<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-08**（commit `77ce2c2`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-123 编码实现验证证据（coder · G-mtr3su6f-1）

> 阶段：编码实现（T-123，w/T-123 worktree）｜角色：coder
> 覆盖切片：S1~S9（docs/G-mtr3su6f-1/TASK_BREAKDOWN.md 全批，单 coder 任务按注册顺序执行）
> 环境：node v24.19.0；DSH_CHECKOUT = D:\\project\\DSH\\dsh\\deepseek-harness（plugins 构建/typecheck 依赖其 node_modules/.bin/tsc）
> 沙箱说明（仓库既有边界，run-ci.mjs 头部有同款记载）：pwsh 沙箱拦截子进程 pipe 捕获（Node spawn EPERM），
> vite/esbuild 子服务与 node --test 子 runner 无法在 pwsh 管道内直跑 → 验证经 run_code 宿主进程以文件重定向 stdio 执行（命令与普通终端一致，见 T-043 先例）。

## 0. 变更范围（git status，只落任务文件域）

- plugins/src：chatErrorClassifier.ts（新建，S1）、spaceDigest.ts（新建，S4）、chatContext.ts（新建，S6 接线模块）、chatResponder.ts（S5 扩展）、index.ts（S1/S2/S6 接线）
- plugins/tests：chat-error-classifier.test.mjs（新建）、space-digest.test.mjs（新建）、chat-responder.test.mjs（S5 追加）
- team-hub：server.mjs（S2 chat/health + 守护心跳存储 + S3 chat_attachments 表/上传/取回/绑定/清理/审计 + G1 护栏常量）、chat.test.mjs（S2/S3 用例追加）
- workbench/src：ChatView.tsx（S7 选空间入口/健康状态点/回复设置弹窗 + S8 附件行）、api.ts（fetchChatHealth/uploadChatAttachment/postChatMessage attachmentIds）、types.ts（ChatAttachmentRef/ChatHealthInfo）、App.tsx（onPickScope 传参）
- 文档（S9）：docs/FEATURES.md（§3.9 重写 + §5.1 排障行）、README.md（§3.9 引导 + §6 排障）、workbench/README.md（对话中心细目）
- docs/goals/G-mtr3su6f-1.md 的 M 为守护派工镜像快照（非本任务改动）
- 零新增运行时/开发依赖（延续 RESEARCH §9 结论）

## 1. 验证命令与输出要点

### 1.1 plugins 编译 + typecheck（0 诊断）
```
node D:\project\DSH\dsh\deepseek-harness\node_modules\typescript\bin\tsc -p plugins/tsconfig.json          # 产物 lib/ 重建
node D:\project\DSH\dsh\deepseek-harness\node_modules\typescript\bin\tsc -p plugins/tsconfig.json --noEmit
# → TSC_EXIT=0（0 诊断；src 全量含新增 chatErrorClassifier/spaceDigest/chatContext）
```

### 1.2 plugins 测试全量：70/70 PASS（含新增 S1/S4/S5 与既有回归）
```
node --test plugins/tests/*.test.mjs   # 宿主进程直跑（node --test 子 runner 在 pwsh 沙箱被 EPERM 拦截，宿主直跑等效）
# → tests 70 / pass 70 / fail 0 / duration ~6.5s
# 其中：chat-error-classifier 4（TC-S1-01..04 五类别+负例+边界）｜space-digest 7（TC-S4-01..09）
#       chat-responder 9（TC-S10-04/01/02/03/05 既有回归 + TC-S5-02/03/08/04/06/07/09/05 新断言）
```

### 1.3 team-hub 全量测试：116/116 PASS（chat 41 例 = 既有 23 + S2 健康 6 + S3 附件 12）
```
node team-hub/chat.test.mjs            # → tests 41 / suites 20 / pass 41 / fail 0 / exit 0
node --test team-hub/*.test.mjs        # 全套（chat+skills+goal+calendar+spaces+artifact-content+rules）→ 116/116 exit 0
```
- S2 健康：TC-S2-01/05/08（形状+在线判定+最近失败+诚实标注）、TC-S2-02（60s 心跳窗）、TC-S2-03（enabled=false）、TC-S2-04（模型解析链）、HTTP 只读/400/心跳 model 透出
- S3 附件：TC-S3-01（UTF-8 上传 staged+落盘）、02/03（黑名单/非法 UTF-8 4xx）、04/05/06（env 小值超大小/超数量 413/400、恰界值成功）、07/15（绑定 meta 只存引用 + body 无全文）、08/09（跨会话/跨 scope 403）、10（悬空引用拒绝且消息不落库）、11/12（TTL 清理行+文件）、13（audit chat:attachment:* 含 fileName/size/scope）、14（旧库自动建表零迁移）、16（uploads 与临时库同基隔离）

### 1.4 workbench typecheck + vite build（全绿）
```
node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit   # → TSC_EXIT=0（0 诊断）
node workbench/node_modules/vite/bin/vite.js build  # 于 workbench/ 目录宿主直跑 → exit 0；621 modules transformed，built in 5.58s
# 注：pnpm --dir workbench build 在 pwsh 沙箱内因 esbuild 子服务 spawn EPERM 失败（仓库既有边界，run-ci.mjs 头部记载），
#     其两步（tsc --noEmit && vite build）经宿主分别执行均 exit 0，等效于 build 门禁通过
```

### 1.5 S9 文档门禁
```
node scripts/ci/check-docs.mjs     # → check-docs: PASS（8 类校验项全绿）exit 0
node -e "<三要素+排障+入口关键句断言>"  # → 'S9 key sentences OK'
```

### 1.6 静态纪律断言（源码）
- grep '回复子代理未完成' plugins/src → 0 命中（笼统兜底文案已从生产路径清除，仅测试负例引用）
- grep 'dangerouslySetInnerHTML' ChatView.tsx → 仅注释 1 处（无实际使用）
- grep 'child_process|spawn' spaceDigest.ts → 仅注释 1 处（TC-S4-08 静态断言通过）
- index.ts chat 区无自动重试/历史自动回填新逻辑（D-5/D-8 语义保持，grep 命中均为任务调度既有文案）

## 2. 逐切片 DoD ↔ 验证对照

| 切片 | 落点 | 验证要点（上文命令） | 结论 |
| --- | --- | --- | --- |
| S1 失败可行动化 | chatErrorClassifier.ts + index.ts 失败分支 | 1.2（4 例：五类别/负例/边界/timeout+foreman 语义）；1.6 无裸文案 | ✅ |
| S2 健康端点+心跳+daemon 状态 | server.mjs chatHealth + members.model + index.ts hubHeartbeat/daemonChatState | 1.3 chat.test S2 describe（含 HTTP）；daemon.json chat 字段随 writeDaemonStatus 写出（宿主需真实守护进程观察，见 §3） | ✅ |
| S3 附件数据面 | server.mjs chat_attachments/上传/取回/绑定/清理/审计/护栏常量 | 1.3 chat.test S3 describe（默认 env + env 小值 + TTL + 旧库迁移 + 隔离） | ✅ |
| S4 空间摘要模块 | spaceDigest.ts（新建） | 1.2（7 例 fixture：allowlist/噪声/确定性/截断/降级/只读/静态） | ✅ |
| S5 提示词扩展 | chatResponder.ts 分块注入+预算+降级 | 1.2 chat-responder 9 例（四象限/预算/占位/注入面/既有 TC-S10 回归） | ✅ |
| S6 守护上下文接线 | chatContext.ts + index.ts answerChatMessage | 1.1 typecheck 0；接线经 1.2/1.3 边界验证；真实 LLM 出站冒烟见 §3（tester 承接） | ✅（宿主级留 T-125） |
| S7 UI 前置 | ChatView/App/api/types | 1.4（tsc 0 + vite build exit 0）；!scope 卡片已替换为选空间入口（源码断言） | ✅ |
| S8 UI 附件行 | ChatView/api/types | 1.4；composer 📎/chip/移除/发送携带 attachmentIds（tsc 强类型约束） | ✅ |
| S9 文档收口 | FEATURES/README/workbench README | 1.5（check-docs PASS + 关键句 OK）；改动仅限三文档 | ✅ |

## 3. 宿主级冒烟项（如实记录复现步骤；本沙箱无运行中 daemon/模型通道，留 T-125 tester 在隔离 hub+守护宿主执行）
1. S2 daemon.json chat 字段：启动插件 daemon（worker 模式 + hub 可达）后 cat <scrumDir>/daemon.json 应见 `chat:{lastReplyAt,lastFailAt,lastFailReason}`，且 GET /api/members 该 worker 行 online=true（60s 心跳窗）。
2. S6 真实出站 L1（对应 E2E-1/2/3）：隔离 hub（TEAM_HUB_DB=mkdtemp）+ 守护 + software 绑定 legion 仓库 → 问「顶层目录/README 讲什么」应引用真实内容；上传带独有编号文本文件提问 → 回复含该编号；不带附件同问无该事实（对照断言）；连续两问第二问不含第一问附件内容（AC-R4-6）。
3. E2E-4 失败可行动：注入不可用模型 → ❌ 气泡含恢复指引 + 健康条红/黄；修复后重试 → awaiting→replied 幂等。

## 4. 结论
S1~S9 实现落盘且每片 DoD 对应命令通过：plugins typecheck 0、plugins 70/70、team-hub 116/116（chat 41 含新增 S2/S3）、workbench tsc 0 + vite exit 0、check-docs PASS。无功能缺失、无任务范围外改动、零新依赖。
