# F-02 Permission Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 team-hub 中建立可审计、可持久化、fail-closed 的统一权限决策引擎，并将技能跨空间/跨成员授权接入审批流程。

**Architecture:** 新建纯函数决策模块负责规范化操作、规则匹配、硬性底线和状态迁移；server.mjs 负责 SQLite 初始化、HTTP 路由与现有 audit 集成。技能授权只在跨空间或指定其他成员时调用引擎，同空间兼容路径保持不变。

**Tech Stack:** Node.js ESM、node:sqlite `DatabaseSync`、node:test、现有 team-hub HTTP/SSE/audit 设施。

**Spec:** `docs/superpowers/specs/2026-09-10-f02-permission-engine-design.md`

## Global Constraints

- 所有权限写操作要求现有 `general` 身份门禁。
- 未知模式、缺失必填字段、过期规则及非法状态迁移必须 fail closed。
- 旧 SQLite 数据库通过幂等 `CREATE TABLE IF NOT EXISTS` 自动升级。
- 不改动现有 F-01 事件流协议与同空间技能授权兼容行为。

---

### Task 1: 决策内核纯函数

**Files:**
- Create: `team-hub/permission-engine.mjs`
- Test: `team-hub/permission-engine.test.mjs`

**Interfaces:**
- Produces `normalizeOperation(input)`, `matchRule(operation, rules, now)`, `evaluatePermission(operation, rules, context)`, `consumeDecision(decision, operation)`。

- [ ] 编写覆盖五种 mode、规则优先级、硬性底线、task 隔离和 fail-closed 的失败测试。
- [ ] 运行 `node --test team-hub/permission-engine.test.mjs`，确认测试失败。
- [ ] 实现纯函数和明确的结果结构 `{allowed, decision, mode, reason, matchedRule}`。
- [ ] 运行同一测试文件，确认通过。
- [ ] 提交 `feat: add permission decision engine core`。

### Task 2: SQLite 持久化与权限 HTTP API

**Files:**
- Modify: `team-hub/server.mjs`（建表、规则/请求 CRUD、路由和 audit）
- Test: `team-hub/permissions.test.mjs`

**Interfaces:**
- Produces `POST /api/permissions/check`、`GET /api/permissions/inbox`、`POST /api/permissions/decide`、`POST /api/permissions/rules`、`DELETE /api/permissions/rules/:id`。

- [ ] 编写 HTTP 合约失败测试：allow、deny、ask、批准/拒绝幂等、过期和规则撤销。
- [ ] 运行 `node --test team-hub/permissions.test.mjs`，确认失败。
- [ ] 添加三张幂等 SQLite 表及索引，接入权限模块和现有 `general` gate。
- [ ] 实现审批请求复用、CAS 状态迁移、一次性/任务级决定消费和审计事件。
- [ ] 运行权限合约测试及 `node --test team-hub/skills.test.mjs`，确认通过。
- [ ] 提交 `feat: expose permission policy and approval APIs`。

### Task 3: 技能授权高风险路径接入

**Files:**
- Modify: `team-hub/server.mjs`
- Modify: `workbench/src/api.ts`
- Modify: `workbench/src/components/SkillsPanel.tsx`
- Test: `team-hub/skills.test.mjs`

**Interfaces:**
- `grant/revoke` 接受可选 `permissionRequestId`；跨空间或他人目标在 `ask` 时返回 `202`，批准后凭请求 ID 重试。

- [ ] 添加跨空间/他人授权的失败测试，验证未批准不会产生 grant。
- [ ] 运行技能测试确认失败。
- [ ] 在 grant/revoke 路径构造规范化操作并调用引擎，保留同空间即时路径。
- [ ] 增加 Workbench API 类型和最小审批列表/决定调用封装。
- [ ] 运行 `node --test team-hub/skills.test.mjs` 与 `npm --prefix workbench run build`。
- [ ] 提交 `feat: guard cross-scope skill grants with permissions`。

### Task 4: 文档与回归验证

**Files:**
- Modify: `docs/CONTRACT-V1V2.md`
- Modify: `docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`
- Modify: `scripts/ci/run-ci.mjs`（新增 `permissions` 测试组并纳入 `--only test`）

- [ ] 记录权限 API、模式语义、审批状态和技能接入行为。
- [ ] 将 F-02 标记为已实现阶段及剩余全量接入范围。
- [ ] 运行权限、技能、事件流、空间、聊天相关测试和 Workbench 构建。
- [ ] 提交 `docs: document F-02 permission governance`。
