# Legion Workbench —— 军团指挥台（独立 Web 应用）

把 legion 的 scrum 看板数据投影为「AI Office 式」作战仪表盘。**引擎零改动**：只消费
`serve.mjs` 的既有接口（`/api/board`、`/api/activity`、SSE、写接口），全部数据实时来自看板。

## 快速开始

```bash
# 1) 先启动数据源（legion 看板服务）
cd D:\project\DSH\legion
node scrum\serve.mjs --port 4820 --host 0.0.0.0 --token legion-kanban-4820

# 2) 启动工作台
cd D:\project\DSH\legion\workbench
pnpm install
pnpm dev          # 开发模式 → http://127.0.0.1:5173

# 生产模式
pnpm build        # 产出 dist/
node scripts/serve.mjs --port 5173   # 独立静态服务 → http://127.0.0.1:5173
```

## 数据源配置

- 默认 `http://127.0.0.1:4820`；可在右上角「⚙ 数据源」修改（存 localStorage）。
- 页面刷新后可用 `?api=http://其他主机:4820` 覆盖（跨机器/局域网）。
- 写操作（新建任务、验收、打回、评论）需令牌：右上角「🔑 令牌」填入 `--token` 值。

## 与转型路线图的对应

| 截图元素 | 本应用实现 | 状态 |
| --- | --- | --- |
| 顶部 KPI（任务/完成/待处理/AI 员工/资源） | `KpiBar`，资源为客户端本机指标 | ✅ |
| 左侧模块 + 工作空间 | `Sidebar`：中枢模式下工作空间 = 全部空间 + team-hub 真实分区（`/api/scopes`），真分区切换 | ✅ |
| 右侧「当前任务集」泳道 | `MissionPanel`：中枢模式走 `/api/missions?scope=`（scopeAware=true）；v1 回退 serve.mjs 或客户端聚合 | ✅ |
| 右侧「实时动态」 | `ActivityFeed`：SSE 实时流 | ✅ |
| 快捷工具 | `QuickTools`（打开浏览器→看板；其余待 DSH 工具面） | ✅/⏳ |
| 技能中心 | `SkillsPanel`：team-hub v2 技能库真实接入——列表（含待审/被拒复审视角）、注册新技能（提交即 pending）、将军发布/驳回、按成员或 scope 授权；随当前空间过滤，15s 轮询刷新 | ✅ |
| 中央智能体状态 | `CenterPanel`：**中枢模式下智能体 = 当前工作空间的专属编队**（每空间不同职业，team-hub `/api/roster`）；首页 = 3D 办公场景（编队绕会议桌、状态色实时投影），「智能体」模块 = 2D 状态总览；v1 回退看板聚合 | ✅ |
| 底部命令栏 | 新建任务/任务调度/导出日报可用；**全部暂停/继续已真实接入**（`/api/pause`/`/api/resume`，守护扫单前读取 control.json）；安排会议待引擎 | ✅/⏳ |
| 中央 3D 办公场景 | `Scene3D.tsx`（three + @react-three/fiber v9 + drei，懒加载独立 chunk）：等距办公室、会议桌 + 空椅一圈、AI 员工发光头部随状态变色（🟢进行中/🟡待验收/🔴受阻/🔵待命）、头顶名牌带任务数、目标进度环、轨道控制 + 自动旋转 | ✅ |

## 服务端配套（第 2 步，legion 引擎侧）

- `serve.mjs` 新增 `GET /api/missions`（服务端任务集聚合，`?scope=`）、
  `POST /api/pause` / `POST /api/resume`（全局暂停/继续，写 `scrum/control.json`）、
  `/api/config` 增加 `paused` 字段。
- `dsh-scrum-worker`（`plugins/src/index.ts`）每轮扫单前读取 `control.json`：
  `paused:true` 时跳过认领/派工但保留心跳（`daemon.json` 带 `paused` 字段）。
  **守护插件已重新编译（`plugins/lib/index.js`）；正在运行的 Desktop 需重启一次才能加载新逻辑。**
- 真 scope 分区（工作空间数据隔离）由 team-hub v2（SQLite `tasks.scope`）提供；
  v1 文件模式 `scopeAware=false`，任何 `?scope=` 均返回全部任务。

## 真 scope 分区（team-hub v2，SQLite）

- **中枢模式**：工作台挂载后自动探测 `http://127.0.0.1:8787`（右上角「🧭 中枢」可改地址/清除）。
  探测成功 → 「工作空间」列出 team-hub 真实分区（`/api/scopes`），「当前任务集」走
  `/api/missions?scope=`（`scopeAware=true`，真分区），「新建任务」写入当前分区（`/api/create` 带 `scope`）。
- **team-hub v2 侧新增**：`GET /api/missions?scope=`（SQLite 按 tasks.scope 聚合，响应与 serve.mjs 同构）、
  `GET /api/scopes`（tasks+members 的 distinct scope）。
- **数据迁移**：`node team-hub/scripts/migrate-tasks.mjs --scope software` 把 `scrum/tasks.json`
  导入 SQLite（幂等）；示例：`curl -X POST http://127.0.0.1:8787/api/create -H "Content-Type: application/json" -d '{"title":"…","scope":"marketing","by":"general"}'`。
- v1 模式（中枢不可达）：自动回退 serve.mjs /api/missions（`scopeAware=false`）→ 客户端聚合，空间切换仅透传并提示。

## 工作空间专属编队（team-hub v2 /api/roster）

- **每个工作空间（scope）有自己的智能体队伍**——任务分区 + 编队分区双管齐下，空间间智能体差异化、专业化：
  software=软件流水线 8 岗位（需求分析师/方案研究员/…/部署运维员）、marketing=市场部 5 岗（市场分析师/内容策划/投放优化师/用户增长/品牌文案）、
  product=产品部 5 岗、ops=运营部 4 岗、default=通用 3 岗。`node team-hub/scripts/seed-roster.mjs` 幂等播种/刷新。
- 切换左侧工作空间 → 中央 3D 场景 / 智能体总览随之换成该空间的编队（人数、职业、状态全不同）。
- **状态实时投影**：每人按该空间任务的 `soldier` 认领聚合（进行中/待验收/受阻/待命 + 任务清单）；
  未入编队但认领了该空间任务的执行者（含旧士兵名）以「⚙️ xxx · 执行中」合流展示——即使任务已完成也保留（标注「已完成 N」），切空间不丢信息。
- **「全部空间」视图**：`/api/roster` 不带 scope 时聚合全部分区（`scope=all`），每名智能体带 scope 标注，跨空间一目了然。
- 数据流：`GET /api/roster?scope=`；v1 模式（中枢不可达）回退从看板按角色聚合。

## 新建工作空间（侧边栏「＋ 新建空间」）

- 两步弹窗：① 空间 id（唯一）+ 中文名 → ② **配置编队**——从全局智能体目录勾选（`GET /api/agents`，
  25+ 类岗位按 role 去重、标注来源空间，支持搜索），或**内联新建智能体**（role/名称/职责/头像，`POST /api/agents` 直接写入本空间）。
- 提交 = `POST /api/spaces` 建空间 + `POST /api/spaces/{id}/agents` 选人入编；空间名、编队人数实时显示在侧边栏；
  创建后自动切到新空间（空任务 → 编队全员待命，新建任务即入该空间）。
- 旧空间（seed/迁移）未注册中文名时由 `GET /api/spaces` 推导合并显示原始 id；`seed-roster.mjs` 会补注册名。

## 技能中心（team-hub v2）

- 左侧「🧩 技能中心」→ 真实技能库（需中枢可达；不可达时面板给出启动提示）。
- 列表含**复审者视角**（`?include=pending`）：已发布/待复审/已驳回三态徽章、版本、scope、owner、prompt（折叠查看）、授权对象。
- 操作：`＋ 注册新技能`（id 须小写字母/数字开头，提交即 pending）、待审项可「✅ 发布 / 驳回」、已发布项可「🔑 授权」（成员 id 或 `scope:xxx`）。
- 数据流：`GET /api/skills`、`POST /api/skills/register|review|grant`，15s 轮询 + 操作后即时刷新；士兵/守护只读取已发布技能。

## 目录

```
workbench/
  src/
    api.ts            数据层：board/activity/config/missions + SSE 订阅 + 写接口 + team-hub 中枢（hub 探测/scopes/分区创建）
    missions.ts       任务集聚合视图（按角色泳道 + 状态统计，客户端兜底）
    components/
      Scene3D.tsx     中央 3D 办公场景（three + @react-three/fiber v9 + drei，懒加载 chunk）
      Sidebar / KpiBar / CenterPanel / MissionPanel /
      ActivityFeed / QuickTools / CommandBar / 弹窗 / Toast
  scripts/serve.mjs  生产静态服务（SPA 回退）
```

## 说明与边界

- 只读接口完全开放；写接口与 serve.mjs 的 `--token` 一致（Bearer / x-dsh-token / ?token）。
- 任务集（mission）= 按 `soldier`/role 聚合的任务泳道，命名优先 `/api/config` 的
  pipeline 中文标签，未匹配回退原始 role id；不改动 scrum 引擎数据模型。
- 中枢模式下 KPI/看板/动态仍来自 serve.mjs（v1 本地视图），任务集/空间/新建任务来自
  team-hub v2；两套数据源并存期间请只写其中一个（守护换 v2 后以 SQLite 为准）。
- 全局「全部暂停/继续」已真实接入（serve.mjs `/api/pause`/`/api/resume`）；「安排会议」待引擎。
