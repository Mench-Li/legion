# F-02 权限治理阶段交付

本阶段提供 team-hub 统一权限决策内核、SQLite 策略/审批持久化和审批箱 API。

## 使用方式

1. `POST /api/permissions/rules` 由 `general` 创建规则。
2. `POST /api/permissions/check` 检查操作；`ask` 会返回 `requestId` 并进入审批箱。
3. `GET /api/permissions/inbox?scope=<scope>` 查看请求。
4. `POST /api/permissions/decide` 以 `approve` 或 `deny` 决定请求。
5. 一次性决定需在业务重试时携带 `permissionRequestId`，消费后不可重复使用。

无人值守技能跨空间授权示例：首次 grant 请求返回 202；审批批准后，使用同一 requestId 重试即可完成授权。不可逆文件删除、仓库 push、凭据写入等硬性底线动作始终拒绝。

## 后续范围

代码合并、外部连接器、自动化创建和高风险命令仍需逐个业务接入权限检查；本阶段不宣称已覆盖所有写接口。
