# 军团看板（KANBAN）

## Goal 进度

**（未填写目标）**

`███████████████░░░░░` **75%**（3/4 完成）· 阶段 unknown · 已完成 0 轮


## 士兵统计

| 士兵 | 进行中 | 待验证 | 完成 | 受阻 | 总计 |
| --- | --- | --- | --- | --- | --- |
| coder | 0 | 0 | 0 | 0 | 3 |
| general | 0 | 0 | 1 | 0 | 1 |
| soldier-a | 0 | 0 | 1 | 0 | 1 |
| soldier-auto | 0 | 0 | 0 | 0 | 1 |
| soldier-b | 0 | 0 | 1 | 0 | 1 |

## Backlog（未批准）（0）

_空_

## Todo（已批准）（1）

- **T-004** 验证士兵守护：为 legion/scrum/README.md 补写『写回接口与远程访问』一节（🟢低）
  - 验收：README.md 包含 POST /api/transition 说明；README.md 包含 --token 与 --host 0.0.0.0 用法；内容准确对应 serve.mjs 实现

## In Progress（进行中）（0）

_空_

## In Review（待验证）（0）

_空_

## Blocked（受阻）（0）

_空_

## Done（完成）（3）

- **T-001** 实现士兵直连消息总线（dsh-tool-mesh）（🔴高 @soldier-a 第3轮认领）
  - 验收：typecheck 通过；19 个测试全绿；覆盖率 100%；Agent Note 齐
- **T-002** 编写军团 Scrum 看板协议（@soldier-b 第4轮认领）
  - 验收：taskctl 可用；状态机验证 19/19 通过；协议文档就绪
- **T-003** 看板接入将军轮次循环（@general 第5轮认领 依赖:T-002）
  - 验收：COMMAND.md 更新；每轮跑 render；kanban.html 可打开

_生成于 2026-09-06T09:46:04.352Z；运行 `node legion/scrum/render.mjs` 刷新_
