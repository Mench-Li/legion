# P2 经验知识库闭环 — 验收方案

> 运行核对：重启 DSH web 后 `node plugins/tests/accept-p2.mjs`（自动核对 ①②③④⑤）。
> 下方是各子项的手动验收步骤与判定标准。

## P2-① 经验形态分流（procedure → skill / declarative → learnings）

| 步骤 | 操作 | 预期 | 通过标准 |
|---|---|---|---|
| 1a | 重启后把一张 friction 高分草稿（如 T-110 declarative 类）frontmatter 的 `createdAt` 前移 ≥4 天，并注入达线票（同 P1 演练法） | 守护 sweep 触发 promoteDraft | 日志出现「晋升为 learning:learning-t110」或 skill |
| 1b | 检查 `docs/experience/learnings/` | 出现 `<taskId>.md` | frontmatter 含 `kind: declarative` + `taskId` + `promotedAt` 溯源；正文为提炼后的陈述性条目 |
| 1c | 检查草稿原件 | `status: promoted` + `promotedTo: learning-t110` | 溯源完整，原件保留 |
| 1d | procedure 类对照 | 把 T-092 类草稿（若还原）走同样触发 | 走 skill register 路径（exp-<id> pending）——两出口分流正确 |

## P2-② 统一检索面（kb-recall 覆盖 drafts/learnings/skills）

| 步骤 | 操作 | 预期 | 通过标准 |
|---|---|---|---|
| 2a | 开一个 kb-recall preset 会话，输入「回归复跑防空转」类查询 | kb_recall 命中 `~/.dsh/skills/exp-t092/SKILL.md` | skills 根进入检索面 |
| 2b | 查询 learnings 主题词（若有 declarative 资产） | 命中 `docs/experience/learnings/*.md` | learnings 资产可检索 |
| 2c | 在指挥台 publish 一个新 skill（或改动现有）后**不手动建索引**直接再查 | 新/改 skill 可被检索到 | 新鲜度自动重建生效（不再依赖手动 kb_build_index） |

## P2-③ 派工自动召回（注入 + recalled 回灌晋升管线）

| 步骤 | 操作 | 预期 | 通过标准 |
|---|---|---|---|
| 3a | 观察任一真实派工任务（看 worker 提示词或日志） | 提示词含「相关团队经验（自动召回…）」段 | 注入段在 norms 之后、共享技能之前 |
| 3b | 检查注入后该任务的草稿 recalled | 跨目标命中草稿 recalledBy 出现该任务 id | 自动召回确实产生 recalled 事件 |
| 3c | 同目标防噪：同目标兄弟任务命中 | 注入段照常有，但 recalledBy 不增加 | countableRefs 同目标排除生效 |
| 3d | 闭环：有 recalled 的草稿随观察窗到期待 promote | 无需士兵手写「参考 T-xxx」也积累 recalled | 真实语料 recalled 信号稀缺问题缓解 |

## 验收入口

1. 重启 DSH web（加载新 lib）
2. `node plugins/tests/accept-p2.mjs` 跑自动核对
3. 手动走 1a-1d（declarative 真实 promote）
4. 手动走 2a-2c（kb-recall preset 会话）
5. 等真实派工走 3a-3d（观察日志 + 草稿账）
