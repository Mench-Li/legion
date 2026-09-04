# T-062 测试执行报告（tester）—— S4 upload / mkdir / rename / delete + token 鉴权 + confirm

> 角色：tester（测试执行）｜任务：T-062｜分支：w/T-062（独立 worktree）｜日期：2026-09-04
> 测试对象：S4 文件中心·写面（workbench/scripts/serve.mjs 的 /api/files/upload|mkdir|rename|delete + 鉴权 + confirm）。
> 被测基线：本 worktree（w/T-062，HEAD=4f0119f "promote T-061"，工作树干净）即当前仓库已含的 S4 实现（serve.mjs / files-api.test.mjs / web.test.mjs），本阶段仅执行与记录，未改任何实现代码。
> 依据用例：docs/TEST_CASES.md §S4（TC-S4-01..17）、TASK_BREAKDOWN S4 AC1..AC5、I1/I2/I6。
> 取代声明：本报告取代 docs/TEST_REPORT.md 上版（T-061 S1 报告，git 历史可回溯）。

---

## 0. 结论速览

| 结论 | 说明 |
| --- | --- |
| 判定：S4 本域全绿 | S4 验收用例 TC-S4-01..17 全部实测通过：上传（含中文名/嵌套）、上限预检、overwrite 两态、mkdir 多层/已存在/与文件同名、rename/目标已存在、delete confirm 二次确认/非空拒删/空目录可删、token 401/200 矩阵、写路径逃逸全拒、流式超限/中断原子上传（P0-1）、并发上传至多一个 200、零新增依赖。 |
| L0 契约 | files-api.test.mjs 34/34（suites 14）exit 0 —— 覆盖 TC-S3-01..15（只读面回归）+ TC-S4-01..17（写面）；web.test.mjs 12/12（S6 回归）exit 0 |
| L1 真实进程 | 独立 serve.mjs 进程（--port 4843 --token tk，DSH_WORKBENCH_SPACES_JSON 注入临时空间）+ curl 实测：token 矩阵 401/401/200/200、mkdir 200/400/400、rename 200/409、delete 400/200/400/200、写逃逸 403/400/400 |
| 非全绿警示（共享面） | 共享 serve.mjs 仍复现 2 项「必须修改」级既有缺陷（非 S4 引入）：F2 serve.mjs:944 顶层 decodeURIComponent 未捕获 URIError，单请求非法 % 路径即令整个进程崩溃 exit 1（DoS）；F1 assertNotGitInternal 只拦顶层 .git，嵌套仓库 .git/config 可经 read/download 200 外泄（凭证/元数据）。 |
| 静态 | 零新增运行时依赖（S4 写面仅 import node: 内置）；node --check serve.mjs / files-api.test.mjs / web.test.mjs 均 exit 0 |
| 回归 | 同文件域 files-api 34/34、web 12/12 全绿；S4 未触发前端/白板/S1/S2/S6 改动（详见 §5） |

---

## 1. 执行环境与方式（环境 / 步骤 / 实际结果 / 日志证据）

- 环境：Windows 沙箱（workspace-write，禁网）；node v24.19.0（唯一运行时，node:test / node:http / node:fs 内置）。
- 工作目录：D:/project/DSH/legion/.legion-worktrees/T-062（分支 w/T-062）。本阶段仅产出报告与证据，未改任何实现代码。
- 执行方式（沙箱 spawn 受限，故用进程内直跑等效 + 独立进程 curl 冒烟）：
  - L0 契约：node files-api.test.mjs（进程内 import serve.mjs 直测，三实例 plain/token/cap 内存+真实 HTTP 路由层）；node web.test.mjs（S6 回归）。
  - L1 冒烟：node serve.mjs --port 4843 --host 127.0.0.1 --token tk（后台真实进程）+ curl.exe 逐请求实测。
- 日志证据（真实命令输出，存 docs/T062-evidence/）：
  - 01-filesapi.txt（files-api.test.mjs 34/34）
  - 02-web.txt（web.test.mjs 12/12）
  - 03-l1-smoke.txt（独立进程 curl：token 矩阵 + 写契约 + 写逃逸）
  - 04-f1-f2-probes.txt（F1/F2 复现）
  - node --check 三项均 exit 0（见 §4）

> 注：写鉴权仅接受 Authorization: Bearer <token>（serve.mjs requireWriteToken，仅比较 req.headers.authorization 的 Bearer 段）；x-dsh-token / ?token= 传送方式不被本实现支持——这不是缺陷，契约即 Bearer-only，TC-S4-13 用 Bearer 验证（见 §2 TC-S4-13）。

---

## 2. 用例执行结果（TC-S4-01..17；每行 前置/步骤/实际结果，判据对照 TEST_CASES「期望结果」列）

| 用例 | 判据 | 实际结果（证据） |
| --- | --- | --- |
| TC-S4-01 上传成功（中文名+嵌套） | ✅ PASS | L0：上传新文件（中文名 + 嵌套目录）→ 200；list 可见；download 字节一致（64MB 以内）。L1：PUT upload?path=ok.txt → 200 |
| TC-S4-02 上限（MAX/MAX+1） | ✅ PASS | L0：MAX_UPLOAD 恰好 200 落盘；+1 → 413/400 拒绝且目标零落盘；L1 路由层实例（真实 64MB 上限）声明超限 Content-Length → 413 预检快速拒绝、零落盘 |
| TC-S4-03 覆盖需 overwrite=1 | ✅ PASS | L0+L1：带 overwrite 上传已存在文件 → 409{"error":"目标已存在：如需覆盖请带 overwrite=1"}，原文件内容未动 |
| TC-S4-04 overwrite=1 覆盖 | ✅ PASS | L0+L1：带 overwrite=1 上传 → 200 覆盖成功、新内容可读回 |
| TC-S4-05 mkdir 多层 | ✅ PASS | L0+L1：mkdir path=a/b/c（嵌套一次建多层）→ 200；list 逐层可见 |
| TC-S4-06 mkdir 已存在/与文件同名 | ✅ PASS | L0+L1：mkdir 已存在目录 → 400{"error":"目录已存在"}；mkdir 与文件同名 → 400（目录与文件冲突） |
| TC-S4-07 rename 迁移 | ✅ PASS | L0+L1：rename from=new.txt to=renamed.txt → 200；源消失、目标存在且内容一致 |
| TC-S4-08 rename 目标已存在/越界 | ✅ PASS | L0+L1：rename 到已存在目标 → 409{"error":"目标已存在，不能覆盖"}；from/to 带 ../ → 400 拒绝（与 S3 同强度规范化） |
| TC-S4-09 delete 无 confirm | ✅ PASS | L0+L1：delete 无 confirm/confirm≠yes → 400{"error":"删除需要二次确认：请带 confirm=yes"}，文件仍在 |
| TC-S4-10 delete confirm=yes | ✅ PASS | L0+L1：delete confirm=yes 删文件 → 200；list 不再可见；read → 400 不存在 |
| TC-S4-11 非空目录拒删 | ✅ PASS | L0+L1：delete 非空目录 confirm=yes → 400{"error":"非空目录拒绝删除：请先清空目录内容"}，内容原样保留 |
| TC-S4-12 空目录可删 | ✅ PASS | L0+L1：delete 空目录 confirm=yes → 200；list 不可见 |
| TC-S4-13 token 矩阵 | ✅ PASS | L1（独立进程 --token tk）：①无 token 写 401 ②错 token 写 401 ③对 token(Bearer tk) 写 200 ④无 token 读(list) 200；未配置 token 时写放行（AC2 现状语义）由 L0 plain 实例确认 |
| TC-S4-14 写路径逃逸全拒 | ✅ PASS | L0 全样本 + L1 抽样：upload/mkdir/rename/delete 注入 ../、绝对路径、NUL、盘符、根外 symlink → 全部 400/403，根外零副作用（L1：../→403"路径越界"，C:/abs→400，%00→400） |
| TC-S4-15 流式/限长（P0-1） | ✅ PASS | L0 cap 实例（16KB 注入口）：overwrite=1 流式超限 → 413/断连，原文件字节原样、无临时残留；上传中断 → 原文件保持、零残留、服务不崩；超限+1 拒绝无整读内存迹象 |
| TC-S4-16 并发上传同路径 | ✅ PASS | L0：两请求并发写同一新路径（均无 overwrite）→ 一个 200 一个 409；最终字节 = 二写之一完整内容（无半写/混合/损坏） |
| TC-S4-17 零新增依赖 | ✅ PASS | S4 写面 serve.mjs 仅 import node:http/fs/child_process/path/os/url/dns/promises 等内置；文件接口测试仅 node:test/assert/fs/os/path/module/url/http；package.json 未因 S4 新增依赖（详见 §4） |

合计：TC-S4-01..17 全部 ✅ PASS，0 失败（S4 本域）。

---

## 3. 依赖与静态校验（TC-S4-17 / S4 AC5）

- S4 写面依赖：serve.mjs 的 /api/files/* 实现仅用 node: 内置（http/fs/child_process/path/os/url/dns/promises）；files-api.test.mjs / web.test.mjs 仅 node:test/assert/strict/fs/os/path/module/url/http。
- package.json（workbench）：dependencies 为前端构建用 react/three/@react-three/*（既有，非 S4 引入）；S4 文件写面未新增任何依赖；serving 运行无需第三方包。
- node --check serve.mjs / files-api.test.mjs / web.test.mjs 均 exit 0（语法有效）。
- 环境依赖缺口说明：workbench 前端 vite/tsc 未跑（需 node_modules + @types，沙箱禁下载）；S4 功能为纯 JS（.mjs），不在 TS 构建图，按规则不擅自安装、如实声明。

---

## 4. 回归范围与结论

- 回归范围：S4 改动集中在 workbench/scripts/serve.mjs（新增 /api/files/upload|mkdir|rename|delete 写路由 + 鉴权/confirm/写路径防护），与既有 S3 只读面（list/read/download）共用同一文件与请求入口。故回归覆盖：
  - 同文件域 S3 只读面：files-api.test.mjs 中 TC-S3-01..15（list 形状/根语义、read 预览/截断/二进制、download 流式、路径逃逸、仅回环、.git 拦截）→ 全绿。
  - 同文件域 S6 web-fetch：web.test.mjs 12/12（正文抽取/协议白名单/SSRF 矩阵/重定向链/共享 deadline P0-3/超时/非文本/4xx-5xx）→ 全绿。
- 回归结论：S4 写面未触发 S3 只读面、S6 web-fetch 的任何回归；S4 仅影响 workbench/scripts/serve.mjs，未触及 team-hub（S1/S2）、白板 contracts 等其它模块。未发现 S4 引入的既有模块回归。

---

## 5. 共享文件面既有「必须修改」级缺陷（本次真实复现；非 S4 引入）

> 归属：T-054 代码审查（R1/R2）与 T-058 测试执行（F1/F2）已发现并记录；本阶段 T-062 在 S4 被测基线上再次复现，均在真实 serve.mjs 进程验证。S4 实现本身未引入、亦未修复这两项。

### F2（P0/DoS）在路径上 decodeURIComponent 未捕获 —— 单请求崩溃整个进程
- 复现步骤：
  1) node serve.mjs --port 4843 --host 127.0.0.1 --token tk（后台进程，正常启动）
  2) curl.exe -s -o NUL -w '%{http_code}' "http://127.0.0.1:4843/api/files%zz"   （pathname 含非法 % 编码）
- 实际结果：HTTP=000（进程死亡）；随后任何请求（含 /api/config）均 HTTP=000。
  stderr：serve.mjs:944 const pathname = decodeURIComponent(url.pathname) → URIError: URI malformed
  at Server.<anonymous> (serve.mjs:944:20)；进程退出码=1。
- 影响：任意端点（含 S4 写 upload/mkdir/rename/delete）在配对非法 % 路径的请求下即可击穿服务进程，属拒绝服务。
- 归属：既有缺陷（T-054/T-058 已知），非 T-062 S4 引入；本 S4 报告未修改（只报告）。

### F1（安全性）assertNotGitInternal 只拦顶层 .git —— 嵌套仓库 .git 元数据外泄
- 复现步骤（空间目录含 subrepo/.git/config 内容 [core]...）：
  1) curl.exe -s -w '%{http_code}' "http://127.0.0.1:4843/api/files/read?scope=fx&path=subrepo/.git/config"
  2) curl.exe -s -w '%{http_code}' ".../api/files/download?scope=fx&path=subrepo/.git/config"
  3) 对照：curl.exe -s -w '%{http_code}' ".../api/files/read?scope=fx&path=.git/config"
- 实际结果：read subrepo/.git/config → HTTP=200，返回"[core]\n  repositoryformatversion = 0..."；download → HTTP=200 返回字节；read .git/config → HTTP=403{"error":"禁止访问 .git 内部"}。
- 根因：assertNotGitInternal 仅判 rel 首段 === '.git'（serve.mjs:211），嵌套仓库（子目录内含 .git）的 metapath（如 subrepo/.git/config）首段为 'subrepo'，未被拦截；写路径同样调该守卫，含 .git 的嵌套路径亦不受保护。
- 影响：嵌套 git 仓库的指纹/配置等元数据可经 read/download 读取，外泄仓库基线。
- 归属：既有缺陷（T-054 R1 / T-058 F1 已知），非 T-062 S4 引入。

---

## 6. 结论与建议

- S4 本域验收：TC-S4-01..17 全部实测通过（files-api 34/34、web 12/12、L1 独立进程 curl 冒烟），S4 各 AC（写契约/鉴权/写路径防护/流式限长/零新增依赖）达成，无失败项。
- 整体交付面：因共享 serve.mjs 仍存在 F1/F2 两项「必须修改」级既有缺陷（均真实复现，其中 F2 属单请求即击穿进程的 DoS），按「全绿才判定通过」口径，files-api 共享面整体判定「非全绿（S4 本域绿、共享面挂起 F1/F2）」。
- 建议：将军组织修复 F1（assertNotGitInternal 改为对任意路径段命中 .git 段即拒绝，读+写同强度）与 F2（顶层 decodeURIComponent 包 try/catch 或改 safeDecode，非法 % 回 400 而非崩溃），并补对应回归用例（嵌套 .git 读/写拒、非法 % 路径 400 不崩）后一并 promote。
- 本阶段未修改任何实现代码（git status 仅 docs/TEST_REPORT.md 与 docs/T062-evidence/）；T-062 S4 本域测评完毕。

---
证据见 docs/T062-evidence/（README.md 链接各日志）。
