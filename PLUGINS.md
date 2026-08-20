# 军团插件族（Legion Plugin Family）—— 插件化架构路线图

军团协作体系的目标形态是一组**可组合、可插拔的 DSH 插件**，而不是散落的脚本与文档。每一层与 DSH 插件类型一一对应，按需挂载。

## 现状（已完成）

| 插件 | 类型 | 状态 | 用途 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-tool-mesh` | host 工具插件 | ✅ 已发布 | 角色寻址消息总线：`mesh_register` / `mesh_send` / `mesh_recv`，士兵内容直连 |
| `@deepseek-ai/dsh-client-ui-kanban` | client UI 插件 | ✅ 已实现 | Web GUI 侧栏看板操作项（iframe 嵌入实时看板，SSE 推送） |
| `@deepseek-ai/dsh-tool-taskctl` | host 工具插件 | ✅ 已实现 | 任务库工具化：`task_create` / `task_claim` / `task_transition` / `task_comment` / `task_link` / `task_list`，模型直接调用（复用 taskctl 状态机/乐观锁/认领/依赖纪律） |

## 待插件化（路线图）

| 组件 | 现在的形态 | 目标插件 | 说明 |
| --- | --- | --- | --- |
| 看板服务 | `scrum/serve.mjs`（独立进程） | `dsh-kanban`（host 服务插件） | 把静态服务 + `/api/board` + SSE 移入 DSH 进程：注册路由或独立端口，数据由进程直接提供；ui-kanban 改为消费它，不再依赖外部进程 |
| 纪律 / 提示词 | `COMMAND.md`、`workflows/soldier-prompt.md` | skill 插件（`.agents/skills/`）或 system-prompt 贡献 | 将军/士兵的固定流程与纪律随部署自动注入，无需手工复制提示词模板 |
| 轮次循环 | 文档约定 | goal 驱动器 + preset 组合 | 将军的"读总线→发令→验证→刷新看板"轮次由 preset/goal 配置固化 |

## 组合方式（按部署选择）

```
基础：dsh-tool-mesh（总线）+ dsh-tool-taskctl（任务）        → 纯模型协作
+ dsh-kanban（host 数据）+ ui-kanban（GUI 侧栏）            → 可视化监控
+ skill 插件（纪律/提示词）                                   → 自动纪律
```

每个插件独立可卸：`cordis.patch.yml` / preset 中删除对应行即卸载。全部遵循 DSH 插件规范（per-file 100% 覆盖率、README Model Experience、Agent Note、doc-sync）。

## 桌面版适配（DSH Desktop portable）

军团插件族已适配桌面版安装（`dsh-desktop-portable` + profile `web`）：

| 插件 | 适配方式 | 状态 |
| --- | --- | --- |
| `dsh-tool-taskctl` | junction 到 `~/.dsh/profiles/web/node_modules` + 桌面版 `standard` preset 加行（`dbPath` 指向 `D:/project/dsh/legion/scrum/tasks.json`，`LEGION_TASKS_DB` 可覆盖） | ✅ 已验证（新会话直接可用） |
| `dsh-tool-mesh` | 同上（`dir` 指向 `legion/mesh/store`，`LEGION_MESH_DIR` 可覆盖） | ✅ 已验证（register/send/recv 全链路） |
| `dsh-client-ui-kanban` | junction + profile `cordis.patch.yml` 加 `ui-kanban` 行 | ⏳ 需桌面版重启后生效（modules roster 启动时构建） |

适配文件：桌面版 `standard` preset（`resources/app/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml`）、profile `cordis.patch.yml`、profile `package.json`（link 依赖）。第三方插件与 web 产物不兼容时，优先为其补 `slots.inject`（balance/float-window 已修补）。

## 原则

- **工具进 Code Mode**：所有模型可操作能力（总线、任务）做成 `defineTool` 注册的工具，模型用工具而非命令。
- **数据落盘不变**：`tasks.json` / `board.json` 是唯一权威，插件只是操作/投影它们的界面。
- **UI 不持有状态**：ui-kanban 只嵌 iframe；原生渲染与 host 数据管道留待后续。
