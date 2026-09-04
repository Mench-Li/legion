# T-058 测试执行报告（tester）——S3 serve.mjs 扩 /api/files list/read/download（仅回环 + 路径防护）

> 角色：tester（测试执行）｜任务：T-058｜分支：w/T-058（独立 worktree，起始 HEAD=6e01ef1）｜日期：2026-09-04
> 测试对象：S3 只读面三端点（GET /api/files/list|read|download）——实现 = d90c91d（T-046，promote 已合入）；其后无提交再触碰 serve.mjs / files-api.test.mjs（HEAD..origin/main 亦无该两文件改动）→ 被测代码 = T-054/T-056 审查基线同一状态。
> 依据用例：docs/TEST_CASES.md §S3（TC-S3-01..15）+ TASK_BREAKDOWN S3 AC1..AC5 + T-042 判定 P0-2（下载流式）回归。
> 取代声明：本报告取代 docs/TEST_REPORT.md 上版（T-042 全量 110 用例报告；git 历史可回溯）。本阶段只执行与记录：不修 bug、不改实现代码；证据 = 真实命令输出（存 docs/T058-evidence/）。

---

## 0. 结论速览

| 结论 | 说明 |
| --- | --- |
| **判定：非全绿** | S3 只读面功能正确性成立：list/read/download 契约（TC-S3-01..11/13..15）、路径逃逸矩阵、仅回环门禁、二进制/超大 read 受控、P0-2 流式下载修复——全部实测通过，同文件域回归全绿；但复现 **2 项「必须修改」级失败**：**F1** TC-S3-12 嵌套仓库 .git 未拦截（read/download 200 泄露凭证元数据，安全承诺失实）；**F2** 非法 % 编码路径单请求一击崩溃 serve.mjs 进程（URIError 未捕获，S3 端点路径形态实测可达）。F1/F2 均非本次测试引入——分别为 T-054 审查 R1、T-056 审查 R2 已标记的「必须修改」项，当前代码尚未修复。 |
| L0 契约 | files-api 34/34（suites 14）、web 12/12（suites 8）——直跑等效（node <文件>，沙箱禁 --test spawn） |
| L1 真实进程 | 自建真实 serve.mjs 进程 + HTTP 断言：l1-s3-smoke PASS=70 FAIL=3（3 失败全为 F1 嵌套 .git）；崩溃探针 2 复现 + 1 对照（F2） |
| 静态 | worktree 无 node_modules → tsc/vite 未复跑（如实声明；切片仅 .mjs 不在 TS 构建图，T-046 coder 已录 tsc 0 错误 / vite build 615 modules 绿）；node --check serve.mjs 及各证据脚本 exit 0 |
| 回归 | 同文件域（workbench/scripts）全绿；切片 diff 仅 3 文件，跨域无需重跑（详见 §5） |

---

## 1. 执行环境与方式（环境 / 步骤 / 日志证据）

- 环境：Windows 沙箱（workspace-write，禁网）；node v24.19.0（唯一运行时）；零第三方依赖下载。
- 工作目录：D:/project/DSH/legion/.legion-worktrees/T-058（分支 w/T-058，clean tree 起始，无 WIP；本阶段只产出报告与证据，未改实现代码）。
- 执行方式：
  - L0：node workbench/scripts/files-api.test.mjs、node workbench/scripts/web.test.mjs（node:test 进程内直跑等效，同 T-039 §2 注）。日志：docs/T058-run-filesapi.txt（34 tests / 14 suites / pass 34 / fail 0）、docs/T058-run-web.txt（12/8/pass 12/fail 0）。
  - L1：自建真实进程冒烟资产 docs/T058-evidence/l1-s3-smoke.mjs —— spawn 真实 serve.mjs（随机端口 127.0.0.1，stdio=ignore 规避沙箱管道 EPERM）+ DSH_WORKBENCH_SPACES_JSON 注入 scope（fx→夹具根、nobind→未绑定），node 内置 fetch/http 逐条断言；夹具按 TEST_CASES §8.5 并补嵌套 git 仓库。日志：docs/T058-evidence/l1-s3-smoke.txt。
  - 崩溃探针：docs/T058-evidence/p1-path-urierror-crash.mjs（+ p1-crash-stack.mjs 捕 stderr）。日志：docs/T058-evidence/p1-crash.txt、p1-crash-stack.txt。
- 夹具要点（scope=fx → mkdtemp 临时目录）：ok.txt、中文 文件.txt、docs/guide.txt、big.log(276KB > 256KiB)、pic.png(二进制)、big.bin(64MB)、根级 .git/config、nestedrepo/.git 与 vendor/sub-repo/.git（嵌套仓库）、link-in / link-out(junction)、empty/、nonempty/、bulk/(120 文件)、outside/(根外，仅越界断言用)。

---

## 2. 用例执行结果（TC-S3-01..15 + P0-2 回归；每行含 前置/步骤/实际结果，判据 = TEST_CASES「期望结果」列）

| 用例 | 判定 | 实际结果（证据） |
| --- | --- | --- |
| TC-S3-01 🟢P0 list 契约 | ✅ PASS | L0 绿 + L1：GET /api/files/list?scope=fx&path= → 200 ok:true；entries 目录在前、含 size/mtime/ext，类型 dir/file 正确；.git 等隐藏项不进列表；含 .git 的目录（nestedrepo）isRepo=true |
| TC-S3-02 🟡P0 根/空目录/缺省 | ✅ PASS | path='' / 缺省 → 根 200；空目录 → 200 entries=[]（不报错） |
| TC-S3-03 🔴P0 未绑定 scope | ✅ PASS | scope=nobind（无 local_dir）→ 400 绑定引导错误；scope=ghost（未注册）→ 400 未注册引导；均绝无文件列表回落 |
| TC-S3-04 🔴P0 list 语义错误 | ✅ PASS | path 指向文件 / 不存在目录 → 400 可读错误，非 500 |
| TC-S3-05 🟢P0 read 文本 | ✅ PASS | ok.txt → 200 content 原样、truncated=false、lineCount=2、totalBytes 精确 |
| TC-S3-06 🟡P0 超大截断 | ✅ PASS | big.log(276480B) → 200 truncated=true、content 恰 262144B(=MAX_READ)、totalBytes=276480 全量 |
| TC-S3-07 🔴P0 二进制/目录 | ✅ PASS | pic.png → 200 binary:true + 明确「二进制文件不可预览」（无乱码）；read 目录 → 400 |
| TC-S3-08 🟢P0 download | ✅ PASS | 200 原始字节与磁盘逐字节一致；Content-Type text/plain、Content-Disposition attachment（filename*=UTF-8）、Content-Length 精确；不存在/目录 → 400 可读错误 |
| TC-S3-08b（T-046 新增，TEST_CASES 未登记见 §6 注记） | ✅ PASS | L0：openDownloadStream 返回 length+可读流、字节一致；目录/.git/越界/symlink 同强度拒绝 |
| TC-S3-09 🔴P0 逃逸主矩阵 | ✅ PASS | read/download/list × {..%2F 单解码越界、..%252F 双编码（字面量→400，无二次解码逃逸）、a/../../、/绝对、C:/Windows/win.ini、c:\\ 小写盘符、NUL %00、..\\} 全部 400/403；根内 docs/guide.txt 正常放行（不误伤） |
| TC-S3-10 🟡P1 符号链接 | ✅ PASS | junction 界内（link-in）放行 200；界外（link-out/secret.txt）read/download → 403 |
| TC-S3-11 🔴P1 仅回环 | ✅ PASS | 函数级 isLoopback：127.0.0.1 / ::1 / ::ffff:127.0.0.1 → true；10.0.0.5 / 192.168.1.2 / 空 → false；代码真读 handleFilesApi 首行非回环 403。真实非回环请求本机无法制造 → 依 TEST_CASES 约定以函数级 + 评审证据为准 |
| TC-S3-12 🔴P2 .git 内部拒绝 | ❌ **FAIL（F1）** | 根级 .git/config read/download/list → 403 ✅；**嵌套 vendor/sub-repo/.git/config：read → 200 泄露内容、download → 200 泄露原始体、list 嵌套 .git → 200**（应为 403）。复现步骤见 §3-F1 |
| TC-S3-13 🟡P1 中文/Unicode/空格 | ✅ PASS | read/list/download 中文 文件.txt 全链路 200，无乱码/无 400 |
| TC-S3-14 🟡P2 大目录/空目录 | ✅ PASS | bulk/ 120 项全量返回（不截断）；empty/ entries=[]；结构稳定 |
| TC-S3-15 🟢P2 共存 + 零依赖 | ✅ PASS | L1：文件面与 /api/fs/home 并存 200；slice diff（d90c91d）= serve.mjs / files-api.test.mjs / evidence.json 3 文件、未触 package.json；serve.mjs imports 全 node: 内置 → 零新增依赖 |
| P0-2 回归（T-042 判定缺陷，本切片修复核心） | ✅ PASS | 路由层零整读引用（grep readFileBytes 仅测试/定义）+ L1 真进程：64MB download Content-Length=67108864 精确、sha256 与磁盘一致、**TTFB=15ms**（头先行）；下载中途断连 → 服务存活；**64MB 下载挂起期间并发 list 7ms**（事件循环未被整读阻塞） |
| F2 稳健性（非法 % 路径） | ❌ **FAIL（F2）** | GET /%zz 与 GET /api/files/list%zz?scope=fx → 客户端 ECONNRESET，服务进程 exit 1（stderr 实捕 URIError: URI malformed @ serve.mjs:944）；对照：合法请求后进程存活。复现见 §3-F2 |

---

## 3. 复现缺陷（步骤 / 实际结果 / 归属）

### F1 🟠 TC-S3-12（嵌套 .git 未拦截 → 凭证/元数据可被 read/download 直取；安全承诺失实）

- 位置：workbench/scripts/serve.mjs assertNotGitInternal（209–212 行）仅判 parts[0]==='.git'；被 listDirEntries / previewTextFile / openDownloadStream 三端点首行共用。JSDoc（208 行）承诺「.git 内部（含 .git 下任意层级）一律拒绝」，TEST_CASES TC-S3-12 同口径；files-api.test.mjs TC-S3-12（201–205 行）只覆盖根级 .git/config → 嵌套缺口未暴露。
- 复现步骤（真实 serve.mjs + DSH_WORKBENCH_SPACES_JSON 注入 fx；夹具含 vendor/sub-repo/.git/config，内容含标记串 NESTED-LEAK-MARKER-1f2e3d）：
  1. GET /api/files/read?scope=fx&path=vendor/sub-repo/.git/config → HTTP 200，返回体含 [core] secret = NESTED-LEAK-MARKER-1f2e3d（内容泄露）
  2. GET /api/files/download?scope=fx&path=vendor/sub-repo/.git/config → HTTP 200，响应体即 .git/config 原始字节
  3. GET /api/files/list?scope=fx&path=vendor/sub-repo/.git → HTTP 200（期望 403）
- 实际结果 vs 期望：TC-S3-12 判据「默认禁止进入 .git 内部 → 403」未达成——多仓库目录（monorepo 子包 / vendor / .legion-worktrees 类嵌套 git）下 read/download 可直取嵌套仓库 .git/config、credentials、packed-refs 等凭证/元数据。
- 归属：S3 实现共用守卫（**T-054 审查 R1「必须修改」**，当前代码未修复）。修复路径（审查已给）：parts.some(p => p === '.git') 任意段命中即拒；.gitignore/.github 等非精确项不误伤（本报告已对照：read .gitignore → 400 而非 403 ✅）。并补 TC-S3-12 嵌套用例。

### F2 🔴 非法 % 编码路径单请求一击崩溃进程（可用性；S3 端点路径形态可达）

- 位置：workbench/scripts/serve.mjs 942–944 行——每个请求先 decodeURIComponent(url.pathname) 且未捕获 URIError；该行位于所有路由分发之前（S3/S4/S6 共用 dispatcher）。
- 复现步骤（真实进程）：
  1. GET /%zz（任意非法 % 路径）→ 客户端 ECONNRESET，进程 exit 1；stderr 实捕：URIError: URI malformed → at decodeURIComponent → serve.mjs:944（见 docs/T058-evidence/p1-crash-stack.txt）
  2. GET /api/files/list%zz?scope=fx（S3 只读端点路径形态）→ 同样 ECONNRESET + exit 1
  3. 对照：GET /api/files/list?scope=fx&path= → 400、GET /api/fs/home → 200，进程存活 → 崩溃确系该单请求所致
- 实际结果 vs 期望：畸形请求应返回 400/404 而非整体崩溃（单请求 DoS 面）。
- 归属：serve.mjs 顶层 dispatcher（**T-056 审查 R2「必须修改」**，当前代码未修复；共享面，S3/S4/S6 全受影响）。修复路径：decodeURIComponent 包 try/catch → 畸形路径 400，或改为逐段安全解码。

---

## 4. 验收口径（TASK_BREAKDOWN S3 AC1..AC5）逐条判定

| 口径 | 判定 | 依据 |
| --- | --- | --- |
| S3 AC1 files-api 全绿：list/read/download 契约 | ✅ 达成 | files-api 34/34（含 TC-S3-01..08b）；L1 真 HTTP 形状/截断/字节断言全绿 |
| S3 AC2 越界防护用例全绿（../、绝对、NUL、根外 symlink → 400/403，normalize 后在根内） | ⚠️ 部分（F1） | 逃逸主矩阵本身全绿；但 .git「内部任意层级拒绝」承诺对**嵌套**仓库失实（F1）——同属 AC2/安全面口径 |
| S3 AC3 仅回环：非回环 403（复用 isLoopback） | ✅ 达成 | 函数级 isLoopback 两态用例 + handleFilesApi 首行 403 代码真读（本机恒回环，依 TEST_CASES 约定） |
| S3 AC4 二进制与超大 read 受控 | ✅ 达成 | TC-S3-06/07 实测：截断精确、二进制明确不可预览 |
| S3 AC5 零新增依赖 | ✅ 达成 | slice diff 未触 package.json；serve.mjs 仅 node: 内置 import |
| P0-2（T-042 判定：下载整读阻塞）修复闭环 | ✅ 达成 | 代码零整读 + L1 64MB：CL 精确 / sha 一致 / TTFB 15ms / 断连存活 / 挂起中并发 7ms（三层证据） |
| 隐含「服务稳健可用」 | ❌ F2 | 单请求畸形 % 路径即可崩溃整个 serve.mjs（含 S3 端点） |

---

## 5. 回归范围与结论

- **同文件域（workbench/scripts，serve.mjs 域）回归**：files-api.test.mjs 34/34（S3 只读 + S4 写面——S4 建立在 S3 目录根/路径防护之上）+ web.test.mjs 12/12（S6）——**全绿** → S3 P0-2 流式修复未破坏 S4/S6 面。
- **切片改动范围**：d90c91d diff = serve.mjs(+30/−4) + files-api.test.mjs(+20) + docs/T046-evidence/evidence.json(+53) 共 3 文件；其后至 origin/main 无任何提交触碰 serve.mjs / files-api.test.mjs → 被测 = T-054/T-056 审查基线同一状态。
- **跨域**：team-hub（chat/skills）、tests/contract、whiteboard、前端 TS 未被切片触及 → 无跨域回归风险面；chat/skills/contracts/whiteboard 属 R-1 全量回归范围；前端 tsc/vite build 因 worktree 无 node_modules 未复跑（如实声明；切片不改 TS 面）。
- **结论**：S3 只读面功能正确性成立（AC1/AC3/AC4/AC5 + P0-2 全部真实验证），逃逸矩阵与仅回环门禁扎实；但 **F1（嵌套 .git，安全承诺失实）与 F2（非法 % 路径一击崩溃，可用性）两项「必须修改」级失败未达成全绿**——均为既有审查标记项（T-054 R1 / T-056 R2）在本轮实测复现确认，修复各 <5 行且有现成路径。**判定：非全绿；F1/F2 修复并补对应回归用例前不建议 promote 验收通过**，功能面其余部分可正常推进。

---

## 6. 附注（口径/文档注记，不阻塞）

- TC-S3-08b 已落实现与测试（files-api.test.mjs 114–132 行）但未登记 docs/TEST_CASES.md（T-054 审查 P2-A）——建议后续文档任务在 TEST_CASES.md S3 表补 08b 行（注明函数级、HTTP 层由 L1 覆盖），恢复 AC→TC 追溯链；本测试不改 TEST_CASES.md。
- L1 冒烟脚本（l1-s3-smoke.mjs / p1-path-urierror-crash.mjs）已固化入仓 docs/T058-evidence/，可重复执行（呼应 T-054 §2.3「L1 资产固化为可重复脚本」注记）。
- 400 vs 404 口径、Content-Length 并发增长竞态、路径 TOCTOU 等 T-054 建议优化项（P2-B/C/D）不在本切片验收门槛，未逐条行为级复验（同审查判定：可排期优化，不改变结论）。
- 证据文件：docs/T058-run-filesapi.txt、docs/T058-run-web.txt、docs/T058-evidence/{l1-s3-smoke.mjs, l1-s3-smoke.txt, p1-path-urierror-crash.mjs, p1-crash.txt, p1-crash-stack.mjs, p1-crash-stack.txt, evidence.json}。