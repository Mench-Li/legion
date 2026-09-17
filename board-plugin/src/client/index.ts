/**
 * @dsh-external/dsh-scrum-board — client 半。
 *
 * 本插件不再向 DSH GUI 注册任何界面：会话内固定的「Scrum 看板」面板
 * （`conversation.view`，id `dsh-scrum-board-panel`）与侧栏「🖥 总指挥部」常驻块
 * （`sidebar.footer.action`，id `dsh-scrum-console`）均已移除，看板与指挥总览
 * 由 Legion 指挥台承载（workbench 任务中心，:5173）。
 *
 * host 半不受影响：仍在 DSH webServer 上托管 `/scrum-board`（kanban.html / api / SSE），
 * 供 Legion 侧与直接 URL 访问。
 *
 * 保留空的 client 半是为了不改变插件的加载契约（package.json `dsh.client` 要求 `./client` 产物）。
 * 构建：npm run build:client（tsdown → lib/client.js）。
 */

/** 无界面贡献：client 半只保留可加载的 apply 形状，不声明任何服务依赖。 */
export function apply(): void {}
