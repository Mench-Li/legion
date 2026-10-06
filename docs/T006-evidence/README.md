# T-006 验收复跑证据（coder）

> 角色：编码实现（coder）｜任务：T-006（隔离 worktree `w/T-006`，基线 `fcbfaf18`）
> 上游依据（团队经验 **exp-t092「回归复跑先查上游验证防空转」**）：先核对上游是否已交付验证，避免多轮 worker 空转。
> 判型结论速览：**无新增功能增量、无功能缺失**——T-006 是验收脚本自动派发的占位任务，本轮为同批回归锚定复跑，按最小动作收尾（只补证据，不改源码）。

---

## 1. 任务正文的认定（为什么本任务没有功能需求）

T-006 的标题与描述都是同一句：`验收脚本派的任务 2026-10-06T09:27:24.549Z`，不含任何功能描述。定位其来源：

- 来源：`product/server/verify-phone.mjs:214` —— 用固定模板串（`body` = 「验收脚本派的任务 」+ ISO 时间戳）配 `intent: 'create_task'` 建任务；
- 同文件 §⑬（201-273 行）就是「**手机派任务真的能被电脑领走**」这条真实部署验收。

即：T-006 由手机验收脚本按固定模板自动创建，**正文天然只有一个时间戳**，它要验的是「派单→认领→交付」链路，而不是某个功能。验收脚本本身（⑬₂）对「队列被 in_review/in_progress 占着」也是按「不适用」跳过，而不是判失败。

## 2. 上游交付状态核对（exp-t092 第 1、2 步）

本任务机器可执行的验收面 = 仓库声明文件 [.legion/delivery.json](../../.legion/delivery.json)（**已入库**）里的 13 条验证命令；它由集成服务在候选提交上执行。

- 交付面（写意图/预约/交付/集成/指标/UI 徽标）由目标 **G-mujfc9vi-1** 的 T-170→T-173 交付并已 promote 进 main；
  基线测试报告 [docs/G-mujfc9vi-1/TEST_REPORT.md](../G-mujfc9vi-1/TEST_REPORT.md) 记录 2026-09-27（w/T-172 HEAD `0be2781`）时这 13 套件为 **123 / 123 / 0 全绿**；
- T-173 部署收口另确认 `.legion/delivery.json` 经 `loadDeliveryConfig` `ok=true / errors=[] / verifyCount=13`（[DEPLOY.md](../G-mujfc9vi-1/DEPLOY.md) §0）。
- 本轮在同一套命令上复跑：**143 / 143 / 0 全绿**，套件计数较 9-27 基线增长（期间 main 上又补了用例），**没有出现红项，也没有需要补的功能**。

## 3. 验收标准逐条对应

| 验收标准 | 结果 | 证据 |
| --- | --- | --- |
| 实现满足验收标准与用例，无功能缺失 | ✅ 不适用（占位任务无功能需求）；机器验收面 13/13 套件、143/143 用例全绿，无红项 | 本文 §2、§4；原始日志 [suites.txt](./suites.txt) |
| 真实跑过 typecheck / build / 测试，证据含命令与输出要点 | ✅ 13 条测试命令逐条真跑（exit 0）；另跑 plugins / workbench 两个 typecheck（exit 0） | §4、§5 |
| 改动仅在任务范围内；新引入依赖有说明 | ✅ 仅新增本证据目录（`docs/T006-evidence/`），未改任何源码；**零新增依赖** | `git status` / 本文 §6 |
| 自测通过才提交验收 | ✅ 全部命令 exit 0 后上报 done | §4、§5 |
| 用户可见行为变更须同步 FEATURES/README | ✅ 豁免：本次为纯证据留痕，无任何用户可见行为变更（docSync 不适用） | §6 |

## 4. 回归复跑：13 条仓库验证命令（跑在 w/T-006 @ fcbfaf18）

逐条按 `.legion/delivery.json` 的 argv 执行，输出见 [suites.txt](suites.txt)。

| # | id | 命令 | 用例 | 结果 | exit |
| --- | --- | --- | --- | --- | --- |
| 1 | path-domain | `node packages/shared/test/path-domain.test.mjs` | 9 | pass 9 / fail 0 | 0 |
| 2 | repo-identity | `node packages/shared/test/repo-identity.test.mjs` | 7 | pass 7 / fail 0 | 0 |
| 3 | write-intent-store | `node team-hub/write-intent-store.test.mjs` | 25 | pass 25 / fail 0 | 0 |
| 4 | claim-policy | `node team-hub/claim-policy.test.mjs` | 39 | pass 39 / fail 0 | 0 |
| 5 | git-plumbing | `node team-hub/git-plumbing.test.mjs` | 8 | pass 8 / fail 0 | 0 |
| 6 | delivery-store | `node team-hub/delivery-store.test.mjs` | 12 | pass 12 / fail 0 | 0 |
| 7 | integration-worker | `node team-hub/integration-worker.test.mjs` | 9 | pass 9 / fail 0 | 0 |
| 8 | write-intent-routes | `node team-hub/write-intent-routes.test.mjs` | 7 | pass 7 / fail 0 | 0 |
| 9 | delivery-routes | `node team-hub/delivery-routes.test.mjs` | 4 | pass 4 / fail 0 | 0 |
| 10 | metrics | `node team-hub/metrics.test.mjs` | 3 | pass 3 / fail 0 | 0 |
| 11 | write-eligibility | `node --experimental-strip-types plugins/tests/write-eligibility.test.mjs` | 8 | pass 8 / fail 0 | 0 |
| 12 | legacy-convergence | `node --experimental-strip-types plugins/tests/legacy-convergence.test.mjs` | 6 | pass 6 / fail 0 | 0 |
| 13 | delivery-ui | `node --experimental-strip-types workbench/scripts/delivery-ui.test.mjs` | 6 | pass 6 / fail 0 | 0 |
| | **合计** | | **143** | **143 pass / 0 fail** | **全 0** |

> 口径说明：沙箱内 `node --test` 会因测试运行器以管道 stdio 派生子进程而 `spawn EPERM`；本仓库的套件都是「每文件一个进程、入口即自跑 `node:test`」的形状，直跑 `node <file>` 与 CI 语义等价（与 docs/TEST_REPORT.md 既有口径一致）。

## 5. 类型检查（typecheck）

| # | 命令 | 结果 | exit |
| --- | --- | --- | --- |
| A | `node D:/project/DSH/dsh/deepseek-harness/node_modules/typescript/bin/tsc -p plugins/tsconfig.json --noEmit` | 无诊断输出 | 0 |
| B | `node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit` | 无诊断输出 | 0 |

> 未跑全量 `pnpm` build：本 worktree 根目录无 `node_modules`（各子包自带）；13 条仓库验证命令不包含 build 步骤，故按声明验收面执行。纯证据改动不触及任何 TS 源码，typecheck 通过即证明未引入编译面回归。

## 6. 边界与假设

- **只增不改**：新增 `docs/T006-evidence/`（本文件 + `suites.txt`），未修改任何源码、他人文档或其它工作区产物；零新增依赖。
- **假设**：把「验收脚本派发的占位任务」按 exp-t092 的「同批回归锚定复跑」处理——上游（G-mujfc9vi-1 / T-172 / T-173）已交付并验证过这 13 套件，本轮只做当前 HEAD 的复跑留痕，不重复另造实现、不空转多轮 worker。若将军认为 T-006 另有隐含功能需求，请在看板评论补充，我按新输入重做。
- 未 push（`w/*` 已被 pre-push 守卫拦截），改动只留在本 worktree。
