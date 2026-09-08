# P0 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复已确认的生产前置缺陷：聊天健康状态串空间、空间删除残留、默认鉴权 fail-open，以及 token 开启后 Workbench 写操作失效。

**Architecture:** 保持现有 SQLite/HTTP 架构，先在服务端边界修复 scope、鉴权和删除一致性，再让 Workbench 所有写请求统一走认证头。每个任务用已有 Node test 套件或新增最小回归测试覆盖，不在本轮重构 v1/v2 数据源。

**Tech Stack:** Node.js 24、node:test、SQLite、React/TypeScript。

**Spec:** 本轮依据仓库审查报告及 `README.md` 第 14 节已登记的生产前置问题。

## Global Constraints

- 不改变现有公开 API 的成功响应结构。
- 未配置 token 的本地开发模式继续可用；非本地监听的安全收紧留到下一项安全任务。
- 每项修改遵循 RED → GREEN → REFACTOR，并运行相关全量套件。

### Task 1: Scope-isolated chat health

**Files:**
- Modify: `team-hub/server.mjs`
- Test: `team-hub/chat.test.mjs` 或当前聊天健康回归测试文件

- [ ] 写失败测试：不同 scope 的 worker 心跳不能影响目标 scope 的 online/model，成功回复后 `lastFail` 清空。
- [ ] 运行测试确认按当前实现失败。
- [ ] 在查询和失败聚合中限定 scope，并以最新终态消息计算失败状态。
- [ ] 运行聊天套件和健康复现脚本确认通过。

### Task 2: Complete space deletion

**Files:**
- Modify: `team-hub/server.mjs`
- Test: `team-hub/spaces.test.mjs` 或新增空间删除回归测试

- [ ] 写失败测试：删除空间后所有 scope 表、技能来源、规则、聊天设置/附件记录及磁盘附件均不存在；impact 计数覆盖这些表。
- [ ] 运行测试确认失败。
- [ ] 扩展 impact 和事务删除清单，清理空间 uploads 目录并保持审计记录。
- [ ] 运行空间套件及相关迁移/聊天测试。

### Task 3: Secure token propagation for Workbench writes

**Files:**
- Modify: `workbench/src/api.ts`, `workbench/scripts/serve.mjs`
- Test: `workbench/scripts/files-api.test.mjs`、技能导入/同步测试

- [ ] 写失败测试：token 开启后文件写、技能扫描/导入/同步请求携带 Bearer token；错误 token 返回 401。
- [ ] 运行测试确认失败。
- [ ] 统一合并认证头，不覆盖调用方已有 Content-Type；技能上游请求显式传递 hub token。
- [ ] 运行 Workbench typecheck、文件、技能和端到端冒烟。

### Task 4: Fail-closed service defaults

**Files:**
- Modify: `team-hub/server.mjs`, `services-plugin/index.js`, `whiteboard/apps/server/src/index.js`, `whiteboard/apps/server/src/ws.mjs`
- Test: team-hub auth tests、whiteboard server tests、services-plugin tests

- [ ] 写失败测试：非回环监听且无 token 拒绝启动/拒绝写入；SSE/技能草稿按 scope 鉴权；白板 WebSocket 无认证不能升级。
- [ ] 运行测试确认失败。
- [ ] 实现安全默认值、身份绑定、scope 过滤和白板认证，不破坏显式本地开发配置。
- [ ] 运行完整 CI 和安全冒烟。

