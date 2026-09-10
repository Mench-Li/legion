# F-01 可恢复事件流第二阶段设计

> 日期：2026-09-10  
> 状态：待实现  
> 对应功能：`docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md` F-01

## 1. 背景

Legion 当前 v2 `team-hub /api/events` 已具备以下基础：

- `audit` 表以全局单调 `seq` 保存业务审计事件。
- REST `/api/activity` 与 SSE `/api/events` 共用 `auditEvent()`。
- 事件数据同时保留旧平铺字段，并提供 `id/event/scope/seq/ts/payload` 兼容字段。
- SSE 帧包含 `id: <seq>`，支持浏览器原生 `Last-Event-ID` 重连。
- 未提供游标时回放最近 30 条；提供合法 `Last-Event-ID` 时回放 `seq > N`。
- 15 秒 heartbeat 与连接关闭清理已经存在。
- workbench 已有按 `seq` 去重的纯函数。

现有实现仍有三个缺口：

1. 页面刷新或浏览器重启后，原生 EventSource 不会保留上一实例的 `Last-Event-ID`。
2. `/api/events` 只能全局订阅，前端收到其他 scope 的事件后再自行过滤。
3. 各消费者只共享数组级去重函数，没有共享的持久游标和单调消费规则。

## 2. 目标

本阶段实现一个向后兼容的、按 scope 可订阅、跨页面刷新可恢复的 hub 审计事件流：

- 服务端支持显式 `sinceSeq` 游标。
- 服务端支持可选 `scope` 过滤，并同时作用于回放和实时事件。
- 客户端按 `hubBase + scope` 持久化最近成功接收的序号。
- 客户端重建 EventSource 时把游标放入查询参数。
- 客户端在所有 hub SSE 消费者之前统一校验事件信封并丢弃陈旧或重复事件。
- 保持旧客户端、无 scope 订阅和原生 `Last-Event-ID` 行为不变。

## 3. 非目标

本阶段不实现：

- 通知、聊天或外部渠道的 `delivery_attempts` 状态机。
- audit 数据保留期、归档或删除策略。
- v1 `/api/board/events` 与 `/api/activity/events` 协议改造。
- 多标签页之间的单连接复用。
- WebSocket 替换 SSE。
- 基于 `seq + 1` 的缺口判定。`seq` 是全局序号，按 scope 过滤后出现不连续是合法现象。

可靠投递状态机作为 F-01 后续阶段单独设计，避免把传输恢复与业务投递语义耦合在一次改动中。

## 4. 服务端设计

### 4.1 请求接口

接口保持为：

```http
GET /api/events?scope=<scope>&sinceSeq=<non-negative-integer>&token=<token>
```

所有查询参数均可省略。

### 4.2 游标优先级

服务端按以下优先级解析游标：

1. 合法的 `Last-Event-ID` 请求头。
2. 合法的 `sinceSeq` 查询参数。
3. 最近 30 条默认回放。

这样既保留原生 EventSource 同实例重连，又支持页面刷新后由客户端显式恢复。

规则如下：

- `Last-Event-ID` 保持现有宽容行为：非法值视为未提供，以兼容旧客户端。
- 显式 `sinceSeq` 若存在但不是非负整数，返回 HTTP 400；显式参数错误不得静默退化成最近 30 条。
- `Last-Event-ID` 合法时忽略 `sinceSeq`，防止代理或浏览器原生游标被较旧查询参数覆盖。
- 游标为 `0` 合法，表示回放所有 `seq > 0` 的事件。

### 4.3 scope 过滤

- 未提供 `scope`：保持现有全局回放与全局实时订阅。
- 提供非空 `scope`：回放 SQL 增加 `scope = ?`，实时广播也只写入相同 scope 的客户端。
- 空白 `scope` 返回 HTTP 400。
- scope 比较沿用数据库现有精确字符串语义，不增加大小写归一化。

`eventClients` 从 `Set<ServerResponse>` 调整为保存 `{ res, scope }` 的订阅记录。`broadcastAudit()` 对无 scope 订阅全量广播，对有 scope 订阅精确过滤。

### 4.4 回放顺序

- 有游标：查询 `seq > cursor`，按 `seq ASC` 输出。
- 无游标：查询最近 30 条后反转，仍按 `seq ASC` 输出。
- scope 过滤在 LIMIT 之前完成，确保“最近 30 条”指该 scope 最近 30 条，而不是全局最近 30 条再过滤。

### 4.5 生命周期

保持现有生命周期契约：

- 首帧仍为 `retry: 2000`。
- 每条业务事件仍写 `id: <seq>` 和单个 JSON `data:`。
- heartbeat 仍为每 15 秒写入 `:hb`。
- 请求关闭时清除 heartbeat 并删除准确的订阅记录。

## 5. 客户端设计

### 5.1 HubAuditEvent 类型

`HubAuditEvent` 补齐统一信封字段，同时保留兼容字段：

```ts
interface HubAuditEvent {
  id: number
  event: string
  scope: string
  seq: number
  ts: string
  payload: Record<string, unknown>
  action: string
  member: string
  taskId: string | null
  goalId: string | null
  detail: Record<string, unknown>
}
```

### 5.2 持久游标

新增无 React 依赖的事件流辅助模块，负责：

- 生成稳定存储键：由规范化后的 `hubBase` 与订阅 scope 组成。
- 从 `localStorage` 读取非负整数游标；损坏值按无游标处理。
- 只允许游标单调增大，较小值不能覆盖较大值。
- storage 不可用或抛错时降级为当前 EventSource 实例的内存行为，不阻断订阅。

全局订阅使用固定 scope 标识 `*`，与具体 scope 游标隔离。

### 5.3 EventSource URL

`subscribeHubAudit` 接受可选配置：

```ts
type HubAuditSubscriptionOptions = {
  scope?: string
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}
```

URL 构造顺序固定包含：

1. `scope`（若提供）。
2. 持久游标 `sinceSeq`（若存在）。
3. `token`（若存在）。

参数使用 `URLSearchParams` 生成，避免已有查询参数与 token 拼接冲突。

### 5.4 单调消费

收到 `message` 后按以下顺序处理：

1. 解析 JSON。
2. 校验 `id/event/scope/seq/ts/payload` 的必要形状，以及 `id === seq`。
3. 若订阅指定 scope，拒绝 scope 不匹配的帧，作为服务端过滤的纵深保护。
4. 若 `seq <= lastSeq`，丢弃重复或陈旧帧。
5. 更新内存游标并尽力写入持久存储。
6. 调用业务回调。

不要求 `seq === lastSeq + 1`，因为全局序号经过 scope 过滤后允许跳号。

### 5.5 现有消费者迁移

- `ChatView` 使用当前空间 scope 订阅。
- `NotifyView` 使用当前空间 scope 订阅。
- `TaskCenterView` 使用当前空间 scope 订阅。
- 无明确空间的调用方保持全局订阅。

消费者现有的数组合并与去重逻辑保留，作为 SSE、REST 轮询和组件重挂载之间的第二层幂等保护。

## 6. 错误处理

- 损坏 JSON 或信封不完整：忽略该帧，不更新游标。
- localStorage 读取或写入失败：吞掉存储异常，事件流继续工作。
- EventSource 断线：依赖浏览器原生重连；同实例使用 `Last-Event-ID`，页面重建使用 `sinceSeq`。
- 非法显式 `sinceSeq`：服务端返回 400，不建立 SSE 连接。
- 客户端收到错误 scope：忽略，不污染该 scope 游标。

## 7. 测试策略

### 7.1 team-hub 契约测试

先写失败测试，再实现服务端改动：

- `sinceSeq=N` 只回放 `seq > N`。
- 合法 `Last-Event-ID` 优先于较旧的 `sinceSeq`。
- 非法、负数和小数 `sinceSeq` 返回 400。
- scope 回放只包含目标 scope。
- scope 实时订阅不接收其他 scope 事件。
- 无 scope 和无游标行为与现有最近 30 条契约一致。
- 关闭连接后准确清理对象化订阅记录。

### 7.2 workbench 单元测试

在 Node `--experimental-strip-types` 测试中覆盖：

- 存储键按 hub 和 scope 隔离。
- 损坏 storage 值降级。
- 游标只单调增加。
- URL 同时正确编码 scope、sinceSeq 和 token。
- 重复、倒序、错误 scope 和损坏信封不会进入回调。
- storage 抛错不影响事件处理。

### 7.3 回归验证

- team-hub SSE 契约测试。
- workbench 事件流与既有 dedupe 单元测试。
- team-hub 相关测试组。
- workbench TypeScript build。
- 仓库 CI 门禁中与 SSE、team-hub、workbench 相关的测试。

## 8. 文件范围

预计修改：

- `team-hub/server.mjs`
- `tests/contract/v1v2-contract.test.mjs` 或新增聚焦的 team-hub SSE 测试
- `workbench/src/api.ts`
- `workbench/src/types.ts`
- `workbench/src/components/ChatView.tsx`
- `workbench/src/components/NotifyView.tsx`
- `workbench/src/components/TaskCenterView.tsx`
- `workbench/scripts/dedupe.test.mjs` 或新增聚焦的事件流测试
- `scripts/ci/run-ci.mjs`

预计新增：

- `workbench/src/hubEventStream.ts`
- `workbench/scripts/hub-event-stream.test.mjs`

不修改任务状态机、聊天回复状态机、通知生成规则或 v1 SSE 服务实现。

## 9. 兼容性

- 旧客户端仍可不带任何查询参数连接 `/api/events`。
- 旧事件字段继续保留，不强制所有消费者同步迁移。
- 原生 `Last-Event-ID` 优先级最高，现有浏览器重连行为不变。
- token 查询参数继续支持，并改为统一 URL 参数构造。
- audit 表继续作为事件事实源，不新增重复事件表。

## 10. 完成标准

本阶段只有在以下条件全部满足时才算完成：

1. scope 过滤同时覆盖回放和实时广播。
2. 页面刷新后能从持久游标继续接收 `seq > cursor` 的事件。
3. 相同或倒序事件不会二次进入业务回调。
4. 非法帧和存储异常不会终止订阅。
5. 旧无参数订阅、heartbeat、关闭清理和最近 30 条回放不回归。
6. 新增行为均经历测试先失败、实现后通过的 TDD 过程。
7. 相关测试、类型检查和构建全部通过。
