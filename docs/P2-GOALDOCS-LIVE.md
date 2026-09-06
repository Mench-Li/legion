# P2 现场验收 Runbook —— 沙箱 scope 双目标并行「目标级分析文档目录」实弹验收

> 状态：**✅ 已于 2026-09-06 执行完毕**（沙箱 scope `docacc-sandbox` + 真实守护/worker），
> 原始证据 `D:\tmp\docacc-acceptance-evidence.txt`，证据链路见文末。
> 背景：ORCHESTRATION-V3.md §12 —— 目标记录新增 `docsDir`（`docs/<goalId>`），阶段产物文档按目标隔离，
> 不同目标写各自目录 → 跨目标分析前缀（requirement → researcher 人工闸门）可安全并行，不再互踩根 `docs/` 槽位。

## 目标

证明两个目标在各自链的 analysis 前缀阶段**真正并行推进**，且阶段文档只落在各自的
`docs/<goalId>/REQUIREMENTS.md`、`docs/<goalId>/RESEARCH.md`，互不覆盖、闸门注释指向目标目录。

## 执行路径（复跑用）

1. 准备隔离栈（**不要**在共享 ~/.dsh 上开第二个 DSH 实例——两实例共用同一 DSH_HOME 会让 worker 插件
   卡在 sweep 前的首个 await，心跳停在 uptimeMs=1；必须给第二实例独立 DSH_HOME）：
   - hub2：`TEAM_HUB_PORT=8799 TEAM_HUB_DB=D:\tmp\docacc-team.db node team-hub/server.mjs`（新代码，自带 docsDir 迁移）
   - 沙箱仓库 `D:\tmp\docacc-repo`：git init + 提交，复制 legion 的 roles.json + LEGION.md
   - 空间/编队：`POST /api/spaces {id:'docacc-sandbox', localDir:D:\tmp\docacc-repo}` + 逐个 `POST /api/agents`（8 岗）
   - 隔离 home：复制 `~/.dsh/settings.yaml`、`.credentials.yaml`、`.agent-presets` 到 `D:\tmp\dsh-home-docacc`，
     `profiles/web` 用 junction 指回真 home
   - overlay `D:\tmp\docacc-overlay.yml`：disable legion-team-hub/scrum-board/services/mediator；worker 行
     scope=docacc-sandbox / hubUrl=8799 / scrumDir+repoRoot=D:\tmp\docacc-repo / maxWorkers=2 / intervalMs=6000
   - 第二实例：`DSH_HOME=D:\tmp\dsh-home-docacc node --import tsx/esm apps/cli/src/bin.ts web
     --patch D:/tmp/docacc-overlay.yml --no-open --port 3093`
     ⚠ 冷启动约 3.5 分钟（tsx 全量编译），勿过早判定失败；以「心跳 mtime 连续 ≥2 次推进」为就绪判据
2. 发布两个 chain 目标（objective 各写一份独立分析主题，mode=chain）
3. 观察：两目标 requirement 任务同时 in_progress → done → in_review（闸门注释带 `docs/<goalId>/REQUIREMENTS.md`）
4. `POST /api/advance {id, by:'requirement'}` 放行两个闸门 → researcher 并行开工 →
   `docs/<goalId>/RESEARCH.md` 各自 promote 到主分支 → 双双 in_review
5. 暂停两目标 → 收栈（kill 3093 与 hub2）→ 记录证据

## 验收信号（本跑实测）

- **双 researcher 真并发**：T-002（G-mtpflk2o-1）与 T-010（G-mtpflk3q-2）同时 in_progress 43 个连续 10s 采样
  （15:40:54 → 15:48:00）
- **文档按目标落位**：主分支上 `docs/G-mtpflk2o-1/{REQUIREMENTS,RESEARCH}.md` 与
  `docs/G-mtpflk3q-2/{REQUIREMENTS,RESEARCH}.md` 并存；根 `docs/` 无同名槽位文件
- **闸门注释目标化**：T-001/009/002/010 的自动验收注释均为「方案文档 docs/G-<id>/X.md 已合入主分支」
- **语义隔离**：两份 RESEARCH.md 头部自述「本文档为本目标目录版本…上游依据：docs/G-<id>/REQUIREMENTS.md」，零交叉

## 收尾

- 沙箱数据保留在 `D:\tmp\docacc-team.db`（独立库，随时可删）；两目标已暂停
- 生产未受影响：software scope、DSH 主实例（~/.dsh）、8787 hub、4820/5173 全程未动
