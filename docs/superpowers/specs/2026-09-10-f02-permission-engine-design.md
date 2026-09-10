# F-02 权限治理引擎设计

## 背景

当前 team-hub 对技能授权已有 `general` 身份门槛，但权限判定与业务写操作耦合，缺少统一的策略、审批、一次性决定、任务范围授权和审计闭环。F-02 第一阶段建立可复用的服务端权限内核，并将高风险的技能跨空间/跨成员授权接入该内核。

## 目标与非目标

目标：

- 用统一的操作描述表达 `scope`、`actor`、`action`、`target`、`taskId` 和无人值守上下文。
- 支持 `deny`、`ask`、`allow-once`、`allow-for-task`、`allow-by-policy` 五种决定模式。
- 持久化策略、审批请求和决定，审批消费采用原子状态迁移，保证一次性决定不重复使用。
- 对不可逆/高风险动作设置硬性底线；普通策略不能越过底线。
- 通过审批箱 API 支持查看、批准、拒绝和过期处理，并将生命周期写入现有审计流。
- 技能授权保持现有同空间兼容行为；跨空间或针对其他成员的授权先走权限引擎。

非目标：

- 第一阶段不重写所有 API 的身份认证和授权逻辑。
- 不在服务端执行任意命令，也不引入外部连接器。
- 不改变现有数据库文件位置或破坏已有技能/空间数据。

## 决策模型

操作请求规范化为：

```text
{ scope, actor, action, target, taskId?, unattended?, metadata? }
```

策略规则绑定 `scope + actor + action + exact target`，字段为空表示通配。规则按以下优先级求解：硬性底线 > 精确目标 > 动作级 > scope 级 > 默认模式。默认模式为 `ask`（无人值守请求默认 `deny`）。

决定结果包含：`decision`、`mode`、`allowed`、`requestId`、`matchedRule`、`decider`、`reason`、`expiresAt` 和规范化操作证据。

规则模式语义：

- `deny`：立即拒绝。
- `ask`：创建或复用待审批请求。
- `allow-once`：创建一次性决定，消费成功后失效。
- `allow-for-task`：仅对同一 `taskId` 生效。
- `allow-by-policy`：在规则有效期内生效；硬性底线除外。

审批状态为 `pending`、`approved`、`denied`、`expired`、`consumed`。批准/拒绝接口使用版本或状态条件更新，重复提交返回当前最终状态，不重复产生副作用。

## API 第一阶段

- `POST /api/permissions/check`：检查操作并返回决定；`ask` 会写入审批箱。
- `GET /api/permissions/inbox?scope=...`：列出待审批及最近决定。
- `POST /api/permissions/decide`：批准或拒绝审批请求。
- `POST /api/permissions/rules`：创建/更新策略规则。
- `DELETE /api/permissions/rules/:id`：撤销策略规则。

所有写操作要求 `general` 身份，并写入 audit。未知模式、缺少 scope/actor/action/target、过期规则和非法状态迁移均 fail closed。

## 技能授权接入

`POST /api/skills/grant` 与 `revoke` 保持已有 `general` gate。若授权目标属于当前空间且为当前操作者自身，沿用原有即时路径；跨空间或指定其他成员时调用权限引擎，操作被 `ask` 时返回 `202` 与 `requestId`，批准后由客户端重试并携带决定标识完成授权。原有调用未提供决定标识时不绕过权限检查。

## 持久化

在现有 SQLite 数据库新增 `permission_rules`、`permission_requests`、`permission_decisions` 表，采用 JSON 保存规范化操作和元数据，必要索引覆盖 `scope/status`、`request_id` 与规则匹配字段。初始化必须幂等，旧数据库自动升级。

## 验证与兼容

- 单元测试覆盖规则匹配、优先级、硬性底线、一次性消费、任务隔离、审批幂等和过期。
- HTTP 合约测试覆盖正常、拒绝、待审批、重复决定及技能授权回归。
- 保留 F-01 事件流测试与现有技能/空间测试。
