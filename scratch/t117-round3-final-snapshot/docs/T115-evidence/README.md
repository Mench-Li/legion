# T-115 编码实现 · 验证证据（docs/G-mtpq729o-1/T115-evidence/）

任务：[[auto-goal] 功能使用介绍文档 + 功能/迭代持续同步] 编码实现（S1~S5）。
验证结论：S1/S2/S3/S5 真实跑通（命令+输出见各文件）；S4 插件/服务改动经 语法/语义诊断=0 + doc-sync 契约逻辑仿真（AC-R4-1/4）验证；**完整 tsc -p plugins 无法在本沙箱运行**（worktree 无 node_modules、peerDeps @deepseek-ai/* 未装、禁止联网安装）——按仓库 R-18 惯例记录复现步骤，不冒充通过。

| 文件 | 内容 | 出口 |
| --- | --- | --- |
| 01-check-docs.txt | node scripts/ci/check-docs.mjs（正向 exit 0 + --help 用法） | S3 AC-R5-1/2/3、S1/S2 机器行 |
| 02-s1-s2-verify.txt | scratch/verify-docs.mjs（S1/S2 25 断言） | S1/S2 |
| 03-run-ci-doc.txt | node scripts/ci/run-ci.mjs --only doc（doc 阶段 PASS）; --skip doc --only env | S5 AC-R5-4 |
| 04-negative-injection.txt | 坏内联锚点/坏索引列/README断链 → check-docs exit≠0 报文件+行；还原后 exit 0 | S3 AC-R5-2 |
| 05-s4-sim.txt | 复刻 plugins docSync 契约逻辑 → AC-R4-1/4 + 幂等 + 路径命名空间 全过 | S4 |
| 06-syntax.txt | plugins/src/index.ts + stage-standards.mjs 语法/语义诊断=0 | S4 语法 |
| 07-s5-negative.txt | 坏链 → run-ci doc 阶段 FAIL exit=1；还原后 PASS exit=0 | S5 AC-R5-4 负例 |

## 复现步骤（宿主/沙箱）
```bash
cd D:\project\DSH\legion\.legion-worktrees\T-115
node scripts/ci/check-docs.mjs && node scripts/ci/check-docs.mjs --help
node scratch/verify-docs.mjs
node scripts/ci/run-ci.mjs --only doc
node scripts/ci/run-ci.mjs --skip doc --only env
node scratch/s4-docsync-sim.mjs
# 插件完整 typecheck（宿主，需先安装依赖）：
cd plugins && pnpm install && pnpm typecheck   # tsc -p tsconfig.json --noEmit
```

## 环境受限说明（R-18）
- 本 worktree 无 node_modules；plugins 的 peerDeps（@deepseek-ai/dsh-agent 等）未安装，完整 `tsc -p plugins/tsconfig.json --noEmit` 与 plugins `node --test tests/*.test.mjs`（依赖 ../lib 构建产物）均需宿主/安装环境，此处未跑 → 不作为通过结论，仅记录复现步骤。
- 已用 TypeScript 语法解析（createSourceFile parseDiagnostics）验证 plugins/src/index.ts 与 stage-standards.mjs 无语法/语法级错误（0 诊断），并人工 review 类型安全（docSync?: boolean | null 接口字段、registerContractDocs 条件追加、settle 契约路径追加、buildWorkerPrompt 提示词注入均类型合法）。
- S3 负例注入均先快照后注入再还原（git checkout 语义），无残留副作用（还原后正向 exit 0）。
- `node scripts/ci/run-ci.mjs`（doc 阶段）在受限 worker 沙箱的子进程 pipe 捕获被拦（spawn EPERM，影响任何阶段，含 env）——run-ci.mjs 头注释与 T-114 §8 均记录该既有边界；其 `stageDoc` 实际调用的 `check-docs.mjs` 本体已在沙箱直跑验证（正向 exit 0 / 负例 exit 1 并报文件+行）。doc 阶段在普通终端/宿主执行即正常（03/07 证据即彼时实跑输出）。本 01/02/05 证据为本轮（T-115 coder 收尾复核）对当前代码的**新鲜复核输出**。
