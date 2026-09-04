# T-083 切片 S4 证据 —— 浏览器前端收口：合入 w/T-051 为 BrowserView（R-A6）

文件域（仅此 3 文件改动，边界遵守）：workbench/src/components/BrowserView.tsx、BrowserPanel.tsx（删除）、workbench/src/App.tsx
本目录仅沉淀验证证据（新增文档，非源码模块改动）。

## 验收标准逐条对应

### 1) 合入 w/T-051（a524951）→ BrowserView.tsx 存在 / BrowserPanel.tsx 移除 / App.tsx 浏览器分支渲染 BrowserView —— ✅
- 分支 w/T-051 可用（worktree .legion-worktrees/T-051 @ a524951）。提交 a524951 共动 8 文件
  （README.md、docs/T051-evidence/×4、workbench/README.md 均在切片文件域之外），故按边界只应用
  文件域内 diff（cherry-pick 全量会带出域外文档；等价性以哈希核对保证）：
  - git hash-object 当前 BrowserView.tsx == git rev-parse w/T-051:workbench/src/components/BrowserView.tsx == ff76acb0614ff6af73e967ebf4555d11ab19b095
  - 当前 App.tsx == w/T-051:workbench/src/App.tsx == ccf21cf0edf354ce18001fa9f1d1fab4ec19cc3c
  - w/T-051 树中 BrowserPanel.tsx 不存在（rev-parse 报 fatal）——本树已删除，一致
  - 工作树清单：App.tsx 改 2 行（import BrowserPanel→BrowserView；active==='browser' 分支 <BrowserPanel/>→<BrowserView/>）、
    BrowserPanel.tsx 删除、BrowserView.tsx 新增（= w/T-051 版本 186 行）
- 无法本地 git commit：共享 .git 位于工作区之外，写索引被沙箱拒（git add → fatal: Unable to create
  index.lock: Permission denied）。改动保留在工作树，由守护捕获 diff（与既有工作流一致）。

### 2) pnpm build —— ⚠️ 受限记录 EPERM + tsc 0 诊断（见 build.txt / typecheck.txt）
- pnpm exec tsc --noEmit → exit 0，零诊断
- pnpm build：vite 加载配置 spawn esbuild 原生服务被沙箱拒 → spawn EPERM 复现记录于 build.txt（非代码问题）
- 无新增依赖、未改配置；3 文件与 a524951 验证过的内容逐字节一致

### 3) grep/评审：无 BrowserPanel 引用；错误态归口；errorText 全映射；可区分可重试 —— ✅
- grep 'BrowserPanel' 全 workbench：仅命中 BrowserView.tsx:55 注释（说明基线缺陷）+ workbench/README.md/CSS 注释
  （文档域，本切片不可改）；App.tsx 零引用
- isErrorResult（BrowserView.tsx:56-63）：http_* 前缀、too_many_redirects、web_error、timeout、too_large、
  ssrf_blocked、protocol_blocked、dns_error、invalid_url、fetch_error、!ok&&!code → 错误态（true）
- errorText（:37-52）：ssrf_blocked/protocol_blocked/timeout/too_large/too_many_redirects/web_error/dns_error/
  invalid_url/fetch_error/http_*/unsupported/empty_content + 兜底，全错误码 → 文案
- 成功/失败可区分可重试：成功 → 正文分支 + 「↻ 重新抓取」（:168-172）；错误 → ⚠ 文案 + 「↻ 重试」（:173-177）；
  fetchUrl 顶层 try/catch 兜底（:99-102），失败不误入正文

### 4) IME 中文输入中间态按 Enter 不触发抓取 —— ✅
- BrowserView.tsx:130  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
  （composition 中间态 Enter 的 keyCode 229 时 isComposing=true → 不 submit；确认候选后上屏再按 Enter 才抓取）
- 另按钮 disabled={busy || !url.trim()} 兜底空输入

### 5) QuickTools「浏览网页」与侧栏「浏览器助手」同一面板（active=browser）—— ✅
- QuickTools.tsx:22  click：id==='web' → onOpenModule('browser')
- Sidebar.tsx:19  MODULES { id:'browser', name:'浏览器助手' }；:70-72 clickModule → onNavigate('browser')
- App.tsx:340  onNavigate={setActive}；:366  <QuickTools … onOpenModule={setActive} />；:355-357
  active==='browser' ? <BrowserView /> —— 两入口汇聚同一 active 状态与同一渲染分支

### 6) 浏览器主路径冒烟（地址栏→正文/错误态）无回归 —— ✅（静态评审 + 契约级验证；沙箱无浏览器可点）
- 服务端契约：web.test.mjs 21/21 pass exit 0（正文 /page、http_404/500、重定向循环、timeout 三种、too_large、
  审计/枚举）—— BrowserView 映射的每个错误码均有服务端真实返回并被断言
- 组件级：BrowserView 与 w/T-051 a524951 逐字节一致（该版本当时 pnpm build/tsc/S6 全绿）；
  App.tsx 仅在原 <BrowserPanel/> 槽位换 <BrowserView/>（无 props），渲染面零结构变化；tsc 0 诊断
- 环境说明：沙箱禁 spawn（vite dev/build 均不可起）、无浏览器自动化；地址栏交互冒烟以
  「契约测试 + 渲染分支静态评审 + tsc」组合覆盖

## 验证命令清单（均可复跑）
- pnpm exec tsc --noEmit                    （workbench/，exit 0）
- pnpm build                                （workbench/，vite 段 spawn EPERM 受限，复现见 build.txt）
- node workbench/scripts/web.test.mjs       （worktree 根，21/21 pass exit 0）
- git hash-object workbench/src/components/BrowserView.tsx / workbench/src/App.tsx（对照 w/T-051 哈希）
- grep -n 'BrowserPanel' workbench/src/App.tsx（零命中）
