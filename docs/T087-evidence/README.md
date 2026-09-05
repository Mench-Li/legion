# T-087 · 切片 S6 编码证据 —— 日程日历前端（自研月视图 + 接线）

任务文件域：`workbench/src/components/CalendarView.tsx`（新增）、`workbench/src/App.tsx`、`workbench/src/components/Sidebar.tsx`、`workbench/src/index.css`
分支：`w/T-087`（未 push，改动仅在本 worktree）

## 0. 环境与命令

- node 依赖：worktree 无 node_modules（禁网安装），以目录 junction 复用主库 `workbench/node_modules`（gitignore 内，不入 diff）后直接调 tsc / vite：
  - typecheck：`node node_modules/typescript/lib/tsc.js -p tsconfig.json --noEmit` → 0 诊断（见 typecheck.txt）
  - build：`node node_modules/vite/bin/vite.js build` → dist 产出（见 build.txt；Scene3D >500kB 为既有 chunk 警告，与本切片无关）
  - pnpm 未在 PATH（受限），等价命令记录如上。
- 浏览器闭环：`node scripts/serve.mjs --port 5273`（worktree 构建产物；DSH_HUB_UPSTREAM=stub）+ 无头 Chrome(CDP) 驱动（drive.mjs 在系统 temp，非交付物）。:5173 已被主库既有 serve.mjs 占用（勿扰他人），故用 :5273 等价验证，其余依赖不变（数据源 :4820、真实中枢 :8787 均保持原样运行中）。
- 数据面 = team-hub `/hub/api/calendar/events`（契约见 docs/TEST_CASES.md §4.5 TC-S5-*；S5 后端任务合入前，浏览器验收用**临时 stub hub**（按 TC 契约实现 GET/POST/delete + 校验 + JSON 持久化，进程内存/storage 均在系统 temp，非交付物、不进仓库）。前端对 GET 信封做裸数组/{events} 兼容解析，S5 合入后无需改前端。

## 1. 验收标准逐条对应

| 验收标准 | 证据 | 结论 |
| --- | --- | --- |
| pnpm build 全绿（受限时记录+tsc） | typecheck.txt（tsc 0 诊断）+ build.txt（vite ✓ built in 8.06s）；pnpm 不在 PATH，等价命令已记录 | ✅ |
| 侧栏「日程日历」点击进入真实月视图面板（非 toast）：当月 7×N 网格、今天高亮、可跨月切换，未选具体空间给引导（与对话中心一致） | 浏览器驱动 PASS：S6-未选空间引导；S6-月网格/今天高亮/标签（wd=7、列=一二三四五六日、cells=35、当月格=30、today 高亮、标签 2026年9月）；S6-跨月切换/回到当月（2026年9月→8月→回来，今天高亮恢复、当月条目复原） | ✅ |
| 最小闭环浏览器验收：新建（标题+日期必填、时间可选）保存后网格出现，删除需二次确认，刷新后仍在（数据=GET /api/calendar/events，scope=当前空间） | S6-新建全天条目入网格（toast「日程已创建（全天）」+ 今天格 chip）；S6-新建带时间条目入网格（date=2026-09-05 10:30 chip 含 10:30）；S6-删除二次确认（取消→无删除仍存在；确认→消失）；S6-刷新持久（Page.reload 后 GET 拉回 [验收评审会, 技术方案评审]，前端无 localStorage 存事件） | ✅ |
| 切换空间事件随之切换互不串 | S6-空间切换互不串：marketing 初始=[]（看不到软件部条目）、建后=[市场发布会]、切回 software=[技术方案评审] 且不含 市场发布会；后端 GET scope=marketing/software 各自只回本空间 | ✅ |
| hub 不可达/校验失败 toast 错误提示 | S6-hub不可达toast/恢复重试成功：杀 stub 后保存 → toast「创建失败：502：hub proxy error…」且面板 .cal-grid 未崩；重启 hub 后同弹层再点保存 → 「已创建」+ 条目入格（TC-S6-03③ 语义） | ✅ |
| 条目文本纯文本渲染（grep 无 dangerouslySetInnerHTML 直插服务端数据） | render-safety.txt：CalendarView 无任何 dangerouslySetInnerHTML JSX 属性（源码 3 处命中均为注释自述「无 dangerouslySetInnerHTML」，同 ChatView/FilesView 惯例）；标题/时间均为 React 文本节点 | ✅ |
| chat/files/browser 面板无回归 | 本片 diff 仅 4 个文件域内文件（git diff --stat 见下）；ChatView/FilesView/BrowserView 源零改动；tsc/build 全绿；既有 :5173（主库）与 :4820/:8787 服务全程未动、验证后仍在运行 | ✅ |

## 2. 本切片改动

```
workbench/src/App.tsx                     |  3 +++
workbench/src/components/Sidebar.tsx      |  8 ++++----
workbench/src/index.css                   | 30 +++++++++++++++++++++++
workbench/src/components/CalendarView.tsx | 482 +++++++++++++++++++（新增）
docs/T087-evidence/*                      | 本证据目录
```

实现要点：
- CalendarView 自研月视图：周一起始 7×N grid（月首补位/月末补位/整周收尾），今天格高亮（当月才标 today，TC-S6-07 语义）；‹ 上月/今天/› 下月导航；事件按月窗 GET（from=月初 to=月末 闭区间，scope=当前空间）。
- 新建条目弹层：标题（必填 ≤100）+ 日期（必填，type=date）+ 时间（可选，type=time；不填=全天 allDay:true & start 用 date-only）；前端校验 + 后端 400 双保险均 toast。
- 删除二次确认弹层：确认才 POST /api/calendar/events/delete {id, confirm:'yes', scope, by}；取消不发请求。
- 错误路径：hub 不可达/校验失败 → toast + 网格内错误提示行（带重试），面板不白屏；成功路径 toast ok、无整页刷新。
- 竞态防护：拉取序号作废在途响应（防月份/空间快速切换串显）+ scope 身份守卫（await 期间切空间不回写，R-A5 语义）。
- 渲染安全：标题/时间全部 React 文本节点；无 dangerouslySetInnerHTML。
- 接线：App.tsx 渲染链加 active==='calendar' 分支；Sidebar clickModule 把 calendar 加入 onNavigate 面板分支并更新注释（notify 仍为 S7 占位）。

## 3. 假设与限制（如实记录）

1. S5 后端（team-hub /api/calendar/events）未合入当前 main（git log 至 promote T-083 无 S5 提交；真实 :8787 服务亦无 calendar 路由）——浏览器闭环在**契约级 stub hub** 上完成（非交付物，临时进程）；前端 GET 信封兼容解析，S5 合入后可直接联调无需改前端。
2. L2 浏览器验收在 :5273 执行（:5173 为主库既有服务占用）；app 内 apiBase 默认 :4820（数据源）、hubBase 默认 /hub（serve.mjs 同源代理 → stub）。
3. pnpm 不在 PATH → 以等价 tsc + vite build 记录（同 T-083 先例）。
4. 遗留文档同步：`workbench/README.md:42` 与根 `README.md:140` 仍写「日程日历为占位」——超出本切片文件域，建议由文档/收尾切片（S8/TEST_REPORT 或将军侧）统一更新（通知中心 S7 落地后一并改）。
5. 无头浏览器截图（11 张，含月网格/删除确认/hub-down toast 等）在系统 temp（C:\Users\11150\AppData\Local\Temp\T087-cal\shots），如需可拷入看板。
