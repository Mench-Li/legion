# Legion 界面参考原型

打开 `legion-workbench.html` 即可预览。单文件包含样式、脚本和只读数据快照，无网络请求。新增设计与现有能力分开表达，所有操作都只在浏览器中演示，不会写入数据库或调用执行服务。

## 内容来源与入口映射

| 导航 | 内容 | 仓库依据 |
| --- | --- | --- |
| 概览 | 空间统计、多目标、共享上下文、目标暂停 / 恢复 / 取消、团队场景 | `CenterPanel.tsx`、`GoalsBoard.tsx`、`Scene3D.tsx`、`KpiBar.tsx` |
| Agent | 按空间分组的岗位、工作状态、任务清单、默认模型；空间会话 | `RosterAgent`、`AgentTasksModal.tsx`、`ChatView.tsx` |
| 任务 | 六泳道；全部、工作中、待我决定、待办、已完成；岗位过滤、任务搜索 | `TaskCenterView.tsx` |
| 任务详情 | 描述、验收标准、Agent 工作流 / 实际运行、执行过程、改动 / diff、测试 / 文档、反馈、交付、调度操作 | `TaskDetailModal.tsx` |
| 任务操作 | 发布目标、任务调度、新建任务、导出日报 | `CommandBar.tsx`、`GoalModal.tsx`、`HubSchedulerModal.tsx`、`NewTaskModal.tsx` |
| 日程日历 | 月 / 周、独立日程条目、起止时间、重复、任务 / 目标关联 | `CalendarView.tsx` |
| 资源 | 文件中心、技能中心、规范 | `FilesView.tsx`、`SkillsPanel.tsx`、`RulesPanel.tsx` |
| 动态 | 通知分类与已读、活动流、上下文快照及导出 | `NotifyView.tsx`、`ActivityFeed.tsx`、`SnapshotView.tsx` |
| 设置 | 空间管理、持续执行、全局暂停 / 继续、Agent 工作流、模型与凭证、连接与令牌、浏览器助手 | `SpaceSettingsModal.tsx`、`Sidebar.tsx`、`CommandBar.tsx`、`AgentWorkflowConfigurator.tsx`、`ModelConfigModal.tsx`、`KpiBar.tsx`、`BrowserView.tsx` |

上述组件位于 `workbench/src/components/`。字段依据 `workbench/src/types.ts`；模型与凭证保留五个原有标签：快速分配、模型档案、岗位绑定、配置搬家、凭证库。

Agent 点击即进入聊天、聊天页内任务抽屉及任务详情“联系 Agent”属于本次新增交互，不能据此认定实际 Agent 回复接口已经接通。聊天中不伪造回复、送达或已读状态。快照不包含密钥、消息正文和执行上下文，未知在线状态不展示为在线。

## 数据与生成

生成器以 `readOnly:true` 读取 `team-hub/team.db` 中空间、岗位、任务、目标、阶段、技能和会话标题等界面字段，文件列表取仓库根目录。任务描述为限制长度的摘要。状态与计数只表示生成时快照，不代表当前运行状态。目录为仓库根的有限预览，不是每个空间绑定目录的完整列表。

修改 `legion-workbench-content.js` 后运行：

```powershell
node docs/prototypes/build-legion-reference.mjs
```

生成器将脚本及快照嵌入原 HTML，并保留已有视觉样式。未使用退役的 `scrum/tasks.json.archived` 作为事实源。

## 验证

`check-legion-reference.cjs` 使用本机 Chrome 与当前环境提供的 Playwright，检查导航子页、Agent 搜索、六泳道、任务详情、草稿、演示消息、模型标签与窄屏布局，同时捕获浏览器脚本错误。运行依赖路径按本机环境配置。

```powershell
node docs/prototypes/check-legion-reference.cjs
```

验证截图：`legion-reference-desktop.png`、`legion-reference-mobile.png`。
