# T-126 部署验证证据（verify-evidence）

> 角色：devops（部署与 CI/CD）｜任务：T-126（所属目标 G-mtr3su6f-1 · software · chain）
> 部署对象：T-123 coder 批次（77ce2c2，S1~S9 对话中心可回答闭环 + 上下文输入）→ 经 promote T-123/T-124/T-125 到达本部署 HEAD **dabf18f**（与 T-125 实测 HEAD d9adffb 之间仅 docs 差异，代码零改动：git diff d9adffb dabf18f 无 src 变更）。
> 环境：node v24.19.0（>= 22.5，node:sqlite）；win32 x64；worktree D:\project\DSH\legion\.legion-worktrees\T-126。
> 执行载体：run_code 宿主进程直跑（pwsh 沙箱 spawn-pipe EPERM 边界同仓库既有记载，见 docs/DEPLOY.md §3.1）；零第三方新增依赖、未联网、未 push。

## 1. 全量发布门禁：node scripts/ci/run-ci.mjs（7 阶段全 PASS，exit 0）

命令：`node scripts/ci/run-ci.mjs --out docs/G-mtr3su6f-1/T126-evidence/ci-run-dabf18f`
（完整输出：ci-run-dabf18f/ci-output.txt + summary.json）

```text
Legion CI run: root=...T-126 node=24.19.0 | git head=dabf18f
[env]   PASS  env 自检（node=24.19.0，git head=dabf18f）
[deps]  PASS  已建 junction workbench/node_modules -> D:\project\DSH\legion\workbench\node_modules
[build] PASS  whiteboard PASS（node scripts/build.mjs）；workbench PASS（tsc --noEmit && vite build）
                 vite: 621 modules transformed. ✓ built in 10.37s
                 dist/index.html 0.44kB + assets/index-*.css 64.46kB + index-*.js 419.51kB + Scene3D-*.js 923.50kB
[test]  PASS  chat 41/41 · skills 20/20 · calendar 13/13 · files-api 40/40 · web 24/24 · contracts 56/56 · whiteboard 67/67（合计 261 用例 0 失败，exit 全 0）
[smoke] PASS  chat-l1-smoke 35/35（settings 开关/awaiting 队列/answer→replied/live SSE/超龄 failed 兜底）
               chat-s2-smoke 9/9（产物 GET / 200 + /hub 代理 + 分页 50+10 + scope 隔离 + 双订阅实时）
               files-s5-smoke 32/32（下载字节一致/mkdir/rename/删除二次确认/越界 .git 403）
               whiteboard 真实进程 /healthz {"ok":true,...} + GET / 200 html；v1 看板 /api/config auth=true
[stage] PASS  发布物暂存 releases/legion-dabf18f-2026-09-08/（MANIFEST.json + SHA256SUMS.txt + dist/ 快照 4 文件）
[doc]   PASS  check-docs.mjs exit=0（README + docs/FEATURES.md 结构/链接/索引 8 类全绿）
===== SUMMARY ===== env PASS · deps PASS · build PASS · test PASS · smoke PASS · stage PASS · doc PASS → exit 0
```

## 2. 配套验证（同代码 HEAD，T-125 证据目录；deploy HEAD 与其实测代码一致）

| 套件 | 结果 | 证据文件（docs/G-mtr3su6f-1/T125-evidence/） |
| --- | --- | --- |
| team-hub 全量 | 116/116（含 chat 41，suites 59，fail 0） | 03-teamhub-full.test.mjs.txt |
| plugins（chat 守护/分类器/摘要/回复器） | lib 重建 exit 0 + 115/115（15 文件，fail 0） | 04-plugins-lib-build.txt / 05-plugins-full.test.mjs.txt |
| workbench 类型+产物 | tsc 0 诊断 + vite build exit 0（621 modules） | 06/07-*.txt |
| L2 上下文注入（确定性代理） | 10/10（绑定仓库摘要+附件事实进最终提示词） | 13-l2-context-injection.txt |
| 文档关键句 | 6/6（FEATURES §3.9 三要素 + README 排障） | 11-s9-key-sentences.txt |

## 3. 已知未修复缺陷（部署放行说明，归属 coder 待修复轮）

- M1：chatHealth 跨 scope 心跳令本空间假绿 + 模型兜底泄漏（server.mjs chatHealth :1415-1416/:1430 成员查询缺 scope 过滤）。
- M2：lastFail 不随后续 replied 消除 → 健康点恒红 + 存量旧笼统文案透出（server.mjs :1431-1439 只取最新 failed）。
- 复现与归属详见 docs/G-mtr3su6f-1/TEST_REPORT.md §3 与 docs/review/T-124-REVIEW.md（T-125 在隔离 hub 行为级复现）。修复前不发布生产；acceptance 走查按 DEPLOY.md §5.2 口径理解健康点局限。

## 4. 受限项（如实登记）

- 真实 LLM 出站闭环（守护 answerChatMessage 经 DSH 宿主 cordis ctx.subagents）与浏览器级 GUI 渲染本沙箱不可达 → 留宿主部署后按 DEPLOY.md §5.3 冒烟清单执行（与 T-125 TEST_REPORT §4 同口径）。
