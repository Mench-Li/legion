# T-213 代码审查（当前 Codex 会话手动接管）

- 审查对象：T-212 实现提交 `e56e25ac` 与验收脚本修正 `61a109919ce7a9fc4379b3989b890c39a3b8df1f`。
- 范围：移动端 PWA 的看板分页、详情抽屉、对话阅读位置，以及相关状态切换。仅静态审查；本次未运行新的测试。
- 执行来源：当前 Codex 会话。DSH `codex` provider 多次被 ChatGPT backend 拒绝，相关 Stage Attempt 已按实际失败记录，不能视为自动审查完成。
- 上游验收：T-212 为人工验收；冻结的根目录 `node --test` 未获得自动通过回执。审查未将其写成自动测试成功。

## 必须修改

### 1. [P1] 切换 Agent 后沿用上一会话的滚动位置，并把既有历史消息计为“新消息”

位置：`workbench/mobile/app.mjs:1072-1084`、`:1100-1104`、`:1131-1144`、`:346-352`。

`selectAgent()` 清空内存中的时间线与 `chatScrollTop`，但没有清空当前 `#timeline` DOM 或重置 `#main.scrollTop`。随后 `openConversation()` 调用 `refreshTimeline()`，默认 `forceFollow=false`。`renderTimeline()` 在替换 DOM 前读取的仍是旧会话的滚动位置；如果用户此前正向上阅读，就保持这个位置。新会话首次拉取的所有历史消息又被 `merged.entries.length - 0` 算作新增，显示误导性的“N 条新消息”。

复现路径：在 Agent A 的长对话中向上滚动 → 切换到 Agent B → B 的旧消息被提示为新消息，阅读位置也可能停在中间。建议在会话身份变化时明确重置 DOM/滚动并首次跟到底，且不将首次载入的既有历史计入新消息数；后续增量刷新才计算新增。

### 2. [P2] “全部”看板切换页签后丢失当前列的滚动位置

位置：`workbench/mobile/app.mjs:1003-1026`、`:530-558`。

离开任务页签时，`showView()` 把 `#main.scrollTop` 存入 `tasksScrollTop`。切回来时 `renderBoard()` 的 `restore=true`，但在默认的“全部”分页视角，它只读取 `columnScroll[当前列] ?? 0`。`columnScroll` 仅在切换列时写入（`:637-654`），所以用户在同一列向下阅读而没有横向切列时，这个值不存在，返回任务页签就跳到顶部。平铺视角才使用 `tasksScrollTop`，行为不一致。

复现路径：在“全部”看板某列滚到第 10 张卡片 → 切到 Agent 对话 → 返回任务 → 列滚动归零。建议在离开任务页签时同步保存当前列位置，或在恢复时优先使用 `tasksScrollTop`，再按列切换更新。

### 3. [P2] 切换空间后新空间继承旧空间的滚动位置

位置：`workbench/mobile/app.mjs:1276-1306`、`:492-498`、`:530-558`。

`switchScope()` 重置分页索引和 `columnScroll`，没有重置 `tasksScrollTop`、`scrollRestorePending` 或当前 `#main.scrollTop`。如果当前停在任务页签，随后 `refreshTasks()` 调用 `renderBoard()`，它把旧空间的 `main.scrollTop` 当成 `keepScroll` 应用到新空间。新空间任务足够长时，第一页直接显示在中段，用户看不到顶部任务。建议切空间时把两视图滚动位置与待恢复标记一起重置，并在新空间首次渲染后回到顶部。

## 审查限制与建议

- 这些结论来自代码路径推导，尚未在真机交互中复测；修复后应在切 Agent、切页签、切空间三条路径上做浏览器交互核验。
- T-212 的冻结独立测试命令仍缺自动通过回执；完成返工时应单独补齐或在验收中继续明确标注人工例外。
- 本记录只给反馈，没有修改 T-212 的实现代码，也没有代表 DSH provider 写入成功回执。
