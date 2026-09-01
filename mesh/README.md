# 消息总线协议（mesh）

军团通信由 `@deepseek-ai/dsh-tool-mesh` 插件提供：三个工具 `mesh_register` / `mesh_send` / `mesh_recv` 基于共享存储（`roster.json` + `messages.jsonl` + `cursors.json`）实现**角色寻址、游标投递**的消息总线。士兵之间**内容直连**，将军只负责"唤醒"。

## 部署前置

在 Agent 组合（cordis.yml / agent preset）中挂载插件，`dir` 指向军团共享目录（所有角色共用一个总线）：

```yaml
- id: tool-mesh
  name: '@deepseek-ai/dsh-tool-mesh'
  config:
    dir: 'D:\project\dsh\legion\mesh\store'
```

## 角色与地址

- `general`（将军）：主 Agent，先 `mesh_register('general')`；唯一常驻角色，由 goal 驱动器自动续轮。
- `soldier-*`（士兵）：持久后台 subagent，部署后先 `mesh_register('<角色名>')`；每个士兵有独立 agent id（工具从 `exec.agent` 解析，不靠自报）。
- 角色名规则：小写字母/数字开头，可含连字符，最长 64 字符。一个角色只能绑定一个 Agent。

## 通信规则

1. **注册**：每个角色使用总线前必须 `mesh_register`；已被其他 Agent 占用的角色会被拒绝。
2. **士兵 → 将军（上行）**：`mesh_send({ to: 'general', type: 'report' | 'question', body })`。需求版本变更仍写 `orders.md` 并 bump 版本。
3. **将军 → 士兵（下行）**：`mesh_send({ to: '<角色>', type: 'order' | 'relay', body })`，然后 `send_message` 唤醒该士兵（消息内容已直达，唤醒只负责叫它起来拉取）。
4. **士兵 → 士兵（内容直连）**：`mesh_send({ to: '<目标角色>', type: 'relay', body })` 直接把消息投递给目标，**不需要将军中转内容**；将军每轮用 `mesh_recv({ inbox: 'all' })` 查看总线动态，只负责唤醒需要处理新消息的士兵。
5. **广播**：`mesh_send({ to: 'all', ... })` 投递给所有已注册角色。
6. **拉取纪律**：士兵每次被唤醒的第一件事是 `mesh_recv()`（只返回自己未读、游标自动推进、每条恰好一次）；将军每轮第一件事是 `mesh_recv({ inbox: 'all' })`（协调视图，不动游标）看谁有新消息需要唤醒。
7. **版本纪律**：需求变更写 `orders.md` 递增版本；士兵报告里注明遵循的版本，版本不一致视为需要重新对齐。

## 消息类型（type）

`order`（命令）/ `report`（成果报告）/ `question`（受阻求援）/ `relay`（协作转交）/ `ack`（确认）/ `btw`（非紧急旁注）。正文上限 16384 字符，投递上限每次 200 条。

## btw 侧线程（不打断旁注）

`btw` 是**非紧急旁注**类型：发送方用它投递「不着急、不阻塞主任务」的补充信息或问题（背景补充、可选优化建议、低优先级疑问），**不期待即时回复**。它对应 agent-network 的 `/btw` 侧线程：在主对话之外开一条旁路，绝不打断正在跑的一轮。

- **发送**：`mesh_send({ to: '<目标角色>', type: 'btw', body })`——与 `report`/`question` 同样直达投递，无需将军中转。
- **读取**：接收方**只在当前一轮结束后、下一轮开始前**读 `btw`。士兵被唤醒后先 `mesh_recv()` 再干活——btw 消息只进视野、**不触发即时行动**；将军在 `mesh_recv({ inbox: 'all' })` 协调视图里看到 btw 也不为其专门唤醒任何人。
- **与 `question` 的区别**：`question` 是阻塞求援（希望尽快处理、可能要暂停手头活）；`btw` 是可延后旁注（有空再看、不回也没关系）。
- **纪律**：关键信息（命令、需求变更、验收口径）**禁止**用 btw 传递（可能被延后读取）；btw 只承载锦上添花的补充信息。存储层不区分类型，`btw` 与其余类型同样写入 `messages.jsonl`，由接收方按上述约定延迟消费。

## 实时性说明

"实时"由轮次驱动：将军在 goal 的每个续轮里完成一次"读总线 → 唤醒 → 发令 → 收报"心跳，士兵被唤醒后 `mesh_recv` 拉取并按固定流程行动。刷新节奏 = 轮次节奏；轮次之间没有后台常驻进程。
