# Agent 对话与进展首版交付记录

日期：2026-10-01。实施分支：`codex/agent-conversations-progress`，基线 `50bbf64e`。先提交设计和计划（`7108857c`），再实施功能。主工作区的未提交改动未带入本分支。

## 使用方法

在空间编队点击 Agent，默认打开对话；任务详情也有“与负责 Agent 聊天”。详情保留任务列表，并新增产物、空间规范和技能目录、运行记录入口。

1. 询问“做到哪里了”或“进度”，立即从持久化任务、Attempt 和最近事件回答。普通解释问题进入现有聊天回复队列，需要启用空间回复设置并运行回复守护。
2. 选择具体任务，再选“追加要求”。立即得到保存回执；只有下一份实际快照含有该反馈，才得到纳入回执。预算截断会单独说明。
3. 待决策问题可以用输入框回答。问题版本和执行身份不符会拒绝；决定同时进入反馈来源和旧评论路径，旧士兵守护仍可带答复续做。
4. “暂停后续调度”保留当前运行；“停止本次执行”写入控制请求并等待 Runtime 终态。执行端未绑定或旧租约不能控制新运行。
5. 确认停止后可追加新要求，再点“核对后按新要求重跑”。核对运行工具记录及外部系统，填写未发生外部写入的依据。服务端记录人工处置，然后恢复到待认领；后续认领创建新 Attempt 和新快照。未知结果不能自动重跑。
6. 刷新可补读持久消息。上翻历史时不强制滚到底部；新消息显示计数，可分页读取更早记录。已读游标单调更新并保存在中枢。

原生运行中热追加、原生暂停/恢复未开放。停止和调度暂停是两个不同操作。运行结束、待验收、任务完成分别显示。

## 实现与恢复边界

- SQLite 保存稳定的空间/岗位 Agent 身份、唯一会话绑定、请求收据、反馈与纳入记录、问题、控制命令、运行绑定、汇报投影及已读游标。
- Agent API 使用现有中枢写令牌及可信客户端 `by` 边界；共享令牌不是独立用户登录。跨空间的 Agent、会话、任务绑定由服务端校验，客户端不能指定汇报来源或冒充 Agent 作者。
- 模板汇报读取真实 Attempt 状态、关键 RunEvent 和验收状态。报告唯一键与消息写入同一事务；定时对账补偿重启和离线缺口。每三秒对账，普通 token/tool delta 不生成逐条聊天通知。未声明达到设计中的 P95 延迟目标。
- Worker 在生产 Executor 内发布 Run 事件并轮询控制命令，绑定 runId、attemptId、workerId 和 leaseEpoch。认领响应已补充真实 Worker 身份。事件先通过 RunStore 的事务持久化，再登记绑定和领取命令；中途退出可幂等重放，避免跨仓储嵌套 BEGIN。
- 取消调用返回不直接表示停止成功。中枢依据 Attempt 的取消终态结算；租约过期显示 unknown，迟到终态可补充确认。人工 hold 会撤销本通道的自动恢复所有权，未确认命令不能通过普通放行绕过。
- 反馈沿用生产 `task.feedback → SourceLoader → collectCandidates → assembleContext` 路径。来源的 `comment:` 前缀被正确映射到反馈身份；未纳入、跨任务或跨空间来源不会得到纳入回执。快照落库后缺失的回执可由对账补偿。
- 普通解释复用现有回复守护，并按 Agent 岗位优先选择模型；`toolFilter.allow=[]` 限制子代理全局工具，不能写任务或仓库。宿主不支持此过滤时会拒绝启动。宿主本地/hosted 工具能力仍须在真实 Runtime 中核验。
- 新增八条 flat 路径、九个接口操作，保持现有中枢路由形式：`/api/agents`、`/api/agent-detail`、`/api/agent-conversations`、`/api/agent-messages`、`/api/agent-commands`、`/api/agent-read-cursors`、`/api/agent-runtime`、`/api/agent-questions`。其中 commands 同时支持 GET 查询和 POST 提交。实现没有照搬设计稿中的动态 REST 路径。

## 验证结果

Windows，Node 24.19.0，pnpm 11.7.0。

| 检查 | 结果 |
| --- | --- |
| Agent/Worker/Executor/SourceLoader/旧聊天/上下文仓储/RunStore 回归 | 240 项通过，0 失败、0 跳过 |
| 任务生命周期、上下文路由、聊天路由回归 | 81 项通过，0 失败、0 跳过；包含与上行重复的旧聊天测试 |
| 插件聊天回复、状态机、Worker 回归 | 58 项通过，0 失败、0 跳过 |
| 插件构建 | 通过，使用本地 DSH 检出 `D:/project/DSH/dsh/deepseek-harness` |
| Workbench TypeScript + Vite、whiteboard 构建 | 通过 |
| CI syntax、DSH boundary、文档检查 | 通过 |
| 配置扫描 | 未通过：本次新增错误码已登记；仍有 97 项既有配置/错误码登记问题 |
| 全仓 CI | 尝试执行，环境配置扫描未过；全仓测试长时间未结束后已终止，不计作通过 |
| 真实 Runtime | DSH Headless CLI 已实际调用模型并完成一次运行；Legion 分支 Worker 尚未接入该 Runtime，生产探测仍返回 `EXECUTOR_HOST_PORT_REQUIRED` |
| 浏览器交互验收 | 未执行自动浏览器验收；已通过前端编译及真实 HTTP 集成验证 |

真实 HTTP 集成使用一次性 SQLite 和 `listen(0)`，验证会话创建、消息幂等、跨空间拒绝、追加要求经真实 SourceLoader 读取、服务端装配并冻结快照、纳入回执，以及删除回执后的对账恢复。测试同时覆盖重复事件投递、取消前的等待状态、过期租约、部分反馈截断、问题重复回答和人工恢复依据。

2026-10-02 通过 DSH 官方 Headless CLI 命令 `pnpm dsh --profile headless --json "仅输出 READY。不要调用任何工具、不要读取或修改文件。"` 启动了一次真实模型运行。模型返回 `READY`，Run 状态为 `completed`，用量为 11,583 tokens（输入 11,196，输出 3，缓存读取 384）。这证明本机 DSH 与模型凭证可用，但 Headless 探针没有载入 Legion 分支 Worker，也没有测试本功能的生产执行器路径。

当前桌面 DSH profile 的模块路径指向主工作区，且配置了现有 Hub；直接启动它会运行主工作区代码并可能认领真实任务，因此没有拿它冒充功能分支验收。完整的真实模型编码闭环仍未验证：还需要一个指向该分支的隔离 DSH profile、一次性 Hub 数据库和临时执行目录，然后执行“实际模型开工 → 运行中查询 → 取消 → 新 Attempt → 新模型产物 → 用户验收”。没有改动正式数据库、启动生产守护或自动合并主分支。

测试命令及证据保存在工作区 `.ci/agent-regression-final.log`、`.ci/agent-route-tests.log`、`.ci/agent-plugin-tests.log`、`.ci/agent-final-gates-2/summary.json`、`.ci/agent-config-final.log`。这些是本次运行产物，不进入源码提交。

## 后续扩展

首版保持一个空间/岗位一个逻辑 Agent。大规模历史的对账索引优化、编队列表的全局未读聚合、独立登录权限、答问费用单独归集，以及原生热追加/暂停恢复仍需后续扩展。当前规则页显示空间规范和技能目录，实际岗位授权与已生效规则以运行输入快照为准。
