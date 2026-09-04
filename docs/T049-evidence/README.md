# T-049 验收证据 —— S5：文件中心前端 FilesView + Sidebar / QuickTools 接线

> 角色：coder｜任务：T-049｜分支：w/T-049（独立 worktree，基线 HEAD = promote T-058）
> 范围（docs/TASK_BREAKDOWN.md S5；docs/TEST_CASES.md TC-S5-01..10）：文件中心面板 + 接线收口 + 安全/错误态/一致性硬化。
> 交付口径（沿用 T-047/S2 先例）：基线上已有 S5 首版（FilesPanel，23a9957「S2+S5+S7 三中心前端」一并落库）；
> 本任务按 S5 拆解产出与 TC-S5 逐条收口：**改名对齐拆解产出 FilesView** + 补 TC-S5-10「预览 loading 态」、
> TC-S5-07「面板内绑定目录后自动列根」、防乱序预览覆盖，全量复验（typecheck / 回归 / S5 数据面冒烟 / 真进程 L1）并沉淀证据。

## 0. 改动清单（工作树可见；git 索引写被沙箱禁（共享 .git 管理目录），交守护/将军 promote 时落库）

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| workbench/src/components/FilesView.tsx | 新增（原 FilesPanel.tsx 改名 + S5 硬化） | 见 §2 逐条 |
| workbench/src/components/FilesPanel.tsx | 删除（改名至 FilesView.tsx） | 对齐拆解产出名（T-047 ChatPanel→ChatView 同法） |
| workbench/src/App.tsx | 2 行 | import 与 active==='files' 分支改用 FilesView（接线不变） |
| workbench/src/index.css | 注释改名 + .files-busy 样式（复用餐 token） | — |
| workbench/README.md | 2 处 | FilesPanel→FilesView + S5 能力补述（loading 态/绑定后自动列根） |
| README.md | 2 处 | 3.8 文件中心组件名与能力补述；顺带修正 ChatPanel→ChatView 文档漂移（与 T-047 收口一致） |
| workbench/scripts/files-s5-smoke.mjs | 新增（L1 测试资产） | FilesView 每个 UI 动作所走的真实 HTTP 序列断言（零第三方依赖） |
| docs/T049-evidence/* | 新增 | 本证据目录 |

未触碰：serve.mjs / files-api.test.mjs / web.test.mjs（S3/S4/S6 域，仅回归未改）、Sidebar/QuickTools 逻辑（S2 域，
接线在基线上已就位，本轮只验证不改）、team-hub/*、plugins/*、scrum/*。
未新增任何依赖（沿用既有 react/vite/tsc；node_modules 与 dist 为指向主 checkout 的 junction，gitignore，未联网未下载）。

## 1. 验收标准逐条对应（任务卡三项）

| 验收标准 | 结果 | 证据 |
| --- | --- | --- |
| pnpm build 绿 + 浏览器验收（预览 textContent 防 XSS） | ⚠️ 拆分见下 | pnpm build = tsc --noEmit && vite build：**tsc 环节真实 exit 0**（01-typecheck.txt）；vite/esbuild 子进程服务 spawn 被本沙箱拦截（named-pipe → EPERM，04-build-attempt.txt 实留，与 T-047/T-042 同因、会话无提权）；宿主/将军环境需补跑 `cd workbench && pnpm build`（junction 已在，直接可用）。**XSS 防插：grep 全 src 零 dangerouslySetInnerHTML 使用（05）；预览内容走 <pre> 文本节点；数据面 XSS 内容夹具原样经真实 HTTP 返回（06）**；浏览器走查清单见 §4 |
| 实现满足验收标准与用例；真实跑过 typecheck/build/测试并在证据给出命令与输出要点 | 通过 | typecheck exit 0（01）；files-api 34/34 + web.test 12/12 回归（02/03）；S5 数据面冒烟 32/32（06）；真进程 serve.mjs L1 全过（07）；vite build 尝试与受限原因留档（04） |
| 改动仅在任务范围内；新引入依赖有说明 | 通过 | 改动全在 S5 文件域 + 受影响 README + 本证据；零新增依赖（git diff 无 package.json 改动；L1 资产只用 node 内置） |

### 1.1 拆解 AC（TASK_BREAKDOWN S5）逐条

- AC1 pnpm build 全绿：tsc strict + noUnusedLocals/noUnusedParameters **exit 0**（01-typecheck.txt）；未采用 React.lazy（无独立 chunk 要求，拆解注明「若 lazy」）；
  vite build 环节沙箱 EPERM（esbuild 服务子进程需 named pipe，04 实留）——环境受限非代码问题，宿主补跑即可（node_modules/dist junction 已就位）。
- AC2 主路径（将军 :5173 浏览器验收）：接线三处静态核对通过（Sidebar MODULES files→onNavigate('files')；QuickTools「文件浏览」→onOpenModule('files')；App active==='files'→FilesView）；
  数据面 = S5 冒烟 ①~⑤（根列表形状/isRepo/逐层进入/返回根/文本与二进制与截断预览/上传立即可见/下载字节一致）经**真实 HTTP 路由**全绿（06）；GUI 步骤清单见 §4。
- AC3 预览安全：grep 全 workbench/src **零 dangerouslySetInnerHTML 使用**（05-security-grep，仅 2 处注释声明）；文件名/预览内容一律 React 文本节点
  （FilesView.tsx:34 注释 + <pre>{preview.content}</pre> + {e.name}）；冒烟用 <script>alert(1)</script>、<img onerror=…> 内容夹具经真实 read 端点原样返回（06 PASS），浏览器不会执行（React 转义）。
- AC4 错误/空态：未绑定空间 → 引导卡（含「⚙ 打开空间设置」按钮 → SpaceSettingsModal，TC-S5-07）；未选空间/未连中枢 → 各自引导分支；越界/.git/409/413 等后端错误 → 行内 .files-error 或 toast（filesGet/filesWrite 抛 Error(message) 由 UI 呈现）；大文件 read 截断提示 chip（已截断（前 N 字符 / 共 M 行））（06 数据面：未绑定 400「尚未绑定本地文件夹」、未注册 400、.git 内部 403、409 overwrite、400 confirm=yes）。
- AC5 目录变化一致性：上传/删除/改名/建目录成功后均重拉当前 dir list（load(dir)），不依赖全量重挂（06：上传后 list 立即可见、删除后不可见、read 404 化）。

### 1.2 S5 测试用例（TC-S5-01..10）逐条状态

| 用例 | 状态 | 说明 |
| --- | --- | --- |
| TC-S5-01 build | ⚠️ | tsc 0 错误（01）；vite build 沙箱 EPERM（04，环境受限）；宿主 `cd workbench && pnpm build` 补绿（junction 就位） |
| TC-S5-02 根列表/导航/上级 | ✅ 数据面+静态 | S5 冒烟 ①②：根列表（dir 前、大小/mtime/isRepo）、进 docs、回根均 200；接线三处静态核对 |
| TC-S5-03 文本/二进制预览 | ✅ 数据面 | 冒烟 ③：中文原样+行数、big.log truncated + totalBytes、pic.png binary「不可预览」 |
| TC-S5-04 上传立即可见 | ✅ 数据面 | 冒烟 ④：PUT 后 list 含新文件（无需整页刷新） |
| TC-S5-05 下载字节一致 | ✅ 数据面 | 冒烟 ⑤ + 真进程 07：download Content-Length/Disposition，SHA256 一致 |
| TC-S5-06 QuickTools 接线 | ✅ 静态 | QuickTools.tsx id==='files' → onOpenModule('files')（App setActive）→ FilesView；非 toast 占位 |
| TC-S5-07 未绑定引导 | ✅ 数据面+代码 | 冒烟 ⑦ 未绑定 400「尚未绑定本地文件夹」/未注册 400；FilesView 引导卡 + 打开空间设置按钮 + 绑定后自动列根（新 effect） |
| TC-S5-08 XSS 纯文本 | ✅ 静态+数据面 | grep 零 dangerouslySetInnerHTML 使用；内容夹具真实端点原样 JSON 返回（06）；UI 文本节点渲染 |
| TC-S5-09 删除确认/覆盖 409/后端停 | ✅ 数据面+代码 | 冒烟 ⑥：无 confirm→400 confirm=yes、取消后文件仍在、confirm=yes 后消失+read 400；409 overwrite 语义（04 中 409）；错误 toast/行内呈现、删除/上传 busy 禁用 + ⏳ 提示（代码） |
| TC-S5-10 大文件截断/loading | ✅ 数据面+代码 | 冒烟 ③ big.log truncated：content 恰 256KB、totalBytes=300KB、行数标注；FilesView 预览 loading 态「⏳ 正在读取预览…」（代码，TC-S5-10） |

## 2. FilesView 本轮改动要点（相对基线 FilesPanel）

1. **改名收口**：FilesPanel.tsx → FilesView.tsx（组件/Props/文件/接线/README 同步），对齐拆解产出「workbench/src/components/FilesView.tsx」。
2. **预览 loading 态**（TC-S5-10）：新增 previewLoading，读取中预览区显示「⏳ 正在读取预览…」；超大/慢读期间 UI 不假死、按钮态正常。
3. **防乱序覆盖**：previewSeq 请求序号——目录切换/回根/再点文件时作废在途响应，杜绝陈旧预览内容串显。
4. **绑定目录后自动列根**（TC-S5-07 收尾）：localDir 进入 effect 依赖——面板内经「打开空间设置」绑定目录、关弹窗即自动拉根列表（原实现停留空列表）。
5. **busy 反馈**：上传/删除/建目录/改名期间头部显示「⏳ 处理中…」并禁用操作按钮。
6. mtime 兜底「—」（服务端异常空值不显示 1970-01-01）。

## 3. 真实执行过的验证命令与输出要点

| 命令（worktree 根） | 结果要点 | 原文 |
| --- | --- | --- |
| node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit | **exit 0，0 错误** | 01-typecheck.txt |
| node workbench/scripts/files-api.test.mjs | tests 34 / pass 34 / fail 0，exit 0（S3/S4 回归未破坏） | 02-files-api.txt |
| node workbench/scripts/web.test.mjs | tests 12 / pass 12 / fail 0，exit 0（S6 回归） | 03-web-regression.txt |
| node workbench/scripts/files-s5-smoke.mjs | **32/32 PASS，exit 0**（真实 serve.mjs 路由进程内监听 + UI 同款序列 + XSS/未绑定夹具） | 06-s5-smoke.txt |
| 真进程 L1（Start-Process node serve.mjs --port 53991 + DSH_WORKBENCH_SPACES_JSON + 静态 dist junction） | index 200 text/html；list/read/download 全 200 且下载 SHA256 一致；PUT 上传 200 后 list 立即可见；未绑定 scope 400 | 07-l1-realserver.txt / 07-l1-server.log |
| pnpm build（= tsc && vite build） | tsc 环节过 → **vite/esbuild spawn EPERM（named-pipe 沙箱拦截）**，exit 1；需宿主补跑 | 04-build-attempt.txt |
| grep dangerouslySetInnerHTML workbench/src | 仅 2 处注释（ChatView/FilesView），**无任何使用**；FilesView/App 无 innerHTML/insertAdjacentHTML/document.write | 05-security-grep.txt |

环境注记：本会话 DSH 沙箱禁 Node child_process 经 named-pipe 的 spawn（stdio:'pipe' → EPERM；probe：pipe 抛 EPERM、inherit 可跑），
且无提权通道（approval 禁用）——esbuild 服务进程依赖 pipe 通信故 vite build 无法在本会话完成，与 T-042/T-047 记录同因。
node_modules 与 dist 为指向主 checkout 的 junction（gitignore，不入库），未联网、未安装任何新依赖。

## 4. L2 浏览器手工验收清单（供将军在 :5173 勾选；数据面等价证据见 §1.2/§3）

启动（README §2.1 生产法）：1) node team-hub/server.mjs（:8787 中枢，未绑定的空间需先经空间设置绑定本地文件夹）
2) cd workbench && pnpm build（宿主补跑，junction 就位）3) node scripts/serve.mjs --port 5173（另需 node scrum/serve.mjs --port 4820 供看板数据）。

- [ ] 侧栏「📁 文件中心」→ 进入；QuickTools「📁 文件浏览」卡 → 同一面板（接线成功，非 toast）
- [ ] 选中已绑定空间 → 显示该空间 local_dir 根内容（目录在前/大小/时间/含 .git 目录标「（repo）」）
- [ ] 点目录逐层进入 → 面包屑可回上级/根
- [ ] 点文本文件 → 预览出现（先短暂「⏳ 正在读取预览…」）；点大文件 → 截断提示（前 N 字符 / 共 M 行）
- [ ] 点二进制（如 png）→ 「二进制文件不可预览」
- [ ] 上传文件到当前目录 → 上传完成 toast + 列表立即可见（无整页刷新）；同名再传 → 弹覆盖确认（取消不动、确认覆盖）
- [ ] 点「下载」→ 浏览器拉回文件且字节与源一致
- [ ] 未绑定空间打开文件中心 → 引导卡「尚未绑定本地文件夹」+「⚙ 打开空间设置」；绑定后关闭弹窗 → 自动列出根目录（TC-S5-07 增强）
- [ ] 预览含 <script>alert(1)</script> / <img onerror=…> 内容的文件（如 xss-inject.txt 夹具）→ 纯文本显示、脚本不执行（TC-S5-08）
- [ ] devtools：无 dangerouslySetInnerHTML 相关告警；删除/上传时头部「⏳ 处理中…」可见、按钮禁用

## 5. 假设与边界

- 假设 1：交付口径 = S5 拆解 AC1..AC5 + TC-S5-01..10；基线 S5 首版（FilesPanel）已在，本任务以「改名收口 + 硬化缺口 + 复验 + 证据」交付，不重写等价实现（T-047/S2 同法）。
- 假设 2：Windows 文件系统禁止 < > : " \ / | ? * 等文件名非法字符——TC-S5-08 的「文件名含 <script>」样本只能在 POSIX 构造；本机以「内容 XSS」夹具 + React 文本节点静态保证覆盖，文件名 XSS 由 text 节点渲染 + 转义保证。
- 假设 3：QuickTools「文件浏览」/ Sidebar「文件中心」接线在基线已存在（S2 域），本轮只做静态核对 + 数据面等价验证，未改动 Sidebar/QuickTools（避免跨域并行冲突）。
- 假设 4：拆解目标里的「目录树」以**文件表 + 面包屑层次导航**实现（目录在前/点入/上级/回根），与 TC-S5-02 判据一致（无折叠树控件用例）。
- 遗留：vite build 最终绿证需宿主执行（本会话沙箱 EPERM + 无提权），命令 cd workbench && pnpm build。
