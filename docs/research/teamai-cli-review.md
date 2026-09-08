# teamai-cli（Tencent）研报：值得借鉴的设计与实践

> 评估对象：https://github.com/Tencent/teamai-cli 本地 checkout `D:\project\multi-agent\teamai-cli`
> 评估基准：package.json v0.22.0；git HEAD `a991038`（608 commits，main，2026-09-06，含 #422 skip-hooks 等近期合并）
> 范围与方法：通读 README / usage-guide（1431 行）/ docs/designs / AGENTS.md / CLAUDE.md / .coding-ci.yaml 及核心源码；另以 4 个并行深挖会话分别覆盖【A 分发与同步引擎】【B 会话经验与知识飞轮】【C codebase 知识图谱】【D 治理·评审·CI·产品化】。
> 引用约定：`[teamai:src/pull.ts:387]` 指外部仓库文件与行号（基准 a991038，复核以该基准为准）；`[legion:...]` 指本仓库文件。本报告为外部项目研报，非 Legion 任务流水线产物，不套用 RESEARCH.md 任务模板。
>
> **结论一句话**：teamai-cli 是"以 git 为唯一后端、覆盖 10+ 种 AI 编码工具的团队控制平面"——`push→MR 评审→pull` 分发团队 Harness 资产，会话 hook 依据"摩擦"自动提示沉淀经验，recall 子代理 + 置信度闭环让团队知识自进化。与我们（Legion + DSH）问题相邻而互补：**它最值钱的是"把个人会话经验变成团队资产的完整闭环"与"agent 无关的资产分发协议"**；部分机制（codebase 图谱）方向对但工程未完成，应修正后借鉴而非照搬。

---

## 0. 结论速览（TL;DR）

| 优先级 | 借鉴项 | 一句话理由 | 落地对象 |
| --- | --- | --- | --- |
| **P0** | recall 子代理协议（precheck 快速失败 + 双语查询 + ≤2500 字结构化输出 + doc-id 声明） | 零成本、立刻让"士兵开工前带上团队经验"，DSH 子代理注册表可直接承载 | DSH agent preset |
| **P0** | 摩擦=值得沉淀的信号模型 | Legion 的将军纠正/验收打回就是天然 friction，比 transcript 更干净 | legion 守护插件 |
| **P0** | 置信度晋升管线（votes→confidence→promote/prune） | 把"经验草稿→正式 skill/rule"做成显式、可追溯流程 | team-hub 知识面 |
| **P1** | 资产版本化分发：marker 所有权 + 幂等 reconcile + tombstone + scope 模型 | "团队 rules/skills/预设怎么改、怎么评审、怎么落地"的完整协议 | legion/team-hub + DSH |
| **P1** | doctor 式诊断（查实际注入路径、附修复命令） | 对应"预设是否真 mount"的自检 | DSH/legion 诊断命令 |
| **P2** | codebase 图谱（AST+启发式双轨、file:line 证据、gaps 诚实记录） | 方向对；但**存在 3 处实测缺陷**（见 §3.1），须自建身份模型后再做 | teamwiki 类能力 |
| 不抄 | 全工具 hook 适配矩阵 / 命令膨胀 / 检索朴素性 / 腾讯系 provider 绑定 | 见 §3 | — |

---

## 1. 项目画像与定位

### 1.1 它是什么

- **一个 CLI（`teamai`），团队侧"AI Harness 控制平面"**：管理员在团队 git 仓里维护 skills / rules / docs / agents / env / hooks / mcp / learnings，成员 `teamai pull` 把它们幂等注入到本机每个 AI 工具（Claude Code、Codex、Cursor、CodeBuddy、WorkBuddy、Qoder、OpenCode、JoyCode、Hermes、OpenClaw、**DeepSeek Harness**…），`teamai push` 走"建分支 + 开 MR + 评审合并"回传改动。
- **不止分发**：产品是**一个循环**而非三个产品——Team Execution（让每个 agent 按团队方式干活）→ Team Context（让每个 agent 理解团队：learnings/teamwiki/codebase 图谱）→ Team Improvement（让每次执行反哺团队：摩擦提示分享、sessions、digest、dashboard）。README 自述："Agents are strong as personal tools, but their learning stays personal"。
- **git 是唯一后端**：无中心服务、无数据库（HTTP 只读模式是后加的旁路）。知识 = `learnings/*.md`（frontmatter）+ `votes/<user>.yaml` 文件；索引 = 本地 `search-index.json`（pull 时重建，不进 git）。

### 1.2 工程形态（值得注意的信号）

- 608 commits、多人外部 PR（近期合并 #420 Qoder、#413 JoyCode、#374 worktree 数据分区等），迭代非常活跃；`.coding-ci.yaml` 有 validate/build/e2e/publish 四段，e2e 用**真实 fixture git 仓**跑完整生命周期。
- 测试：`src/__tests__/` 下 215+ 个单测文件 + `e2e/` 独立配置（vitest.e2e.config.ts：60s、fileParallelism:false 顺序跑、retry:1）；`hooks-golden.test.ts` 用 `fixtures/hooks/*.json` 断言**字节级一致**；大量 issue 编号回归测试。
- `docs/designs/*` 是由 plan-ceo/plan-eng 流程产出的决策记录：统一"决策表（#/Decision/Choice/Rationale）+ Phase 实施 + NOT-in-Scope 显式排除 + Scope Decision（ACCEPTED/SUPERSEDED/DEFERRED）"格式（[teamai:docs/designs/data-directory-layout.md]、[teamai:docs/designs/team-intelligence-platform.md]）。
- **自举**：AGENTS.md/CLAUDE.md 本身就是给代理看的规范（必须用 worktree、PR 前真实 CLI 端到端验证且测试报告贴进 PR、"奥卡姆剃刀：非必要不加新命令"、行为变更必须同步 docs/designs），CI 用自家产品跑自家 e2e。

### 1.3 与我们（Legion/DSH）的关系

- Legion 解决"将军→班组智能体→worktree 任务→evidence→验收"的**任务执行组织**；teamai 解决"团队资产如何版本化、评审、分发"与"会话经验如何变成团队知识"——**相邻互补**。
- **teamai 已把 DSH 列为受支持 agent**：`[teamai:src/known-agents.ts:109-113]` 注明 dsh 的 skill-filesystem provider 扫描 `~/.dsh/skills`（rank 400）与 `.agents/skills`（rank 500），故同步目标为 `~/.dsh/skills`；`[teamai:src/types.ts:250-253]` toolPaths 仅 `dsh: { skills: '.dsh/skills' }`。**已在 DSH 源码验证属实**（[legion 外：deepseek-harness/packages/skill/skill-filesystem/src/index.ts:246-255] roots 含 project/user 两档 `.dsh/skills` 与 `.agents/skills`）。
- README 能力矩阵中 DSH 行：skills/docs/learnings/codebase/teamwiki ✓，rules/env/agents/hooks/mcp/usage/sessions/dashboard —。**即 teamai 对 DSH 只做 skills 同步，其余全空白**——这是双向机会点（§4）。

---

## 2. 值得借鉴的机制（每条：机制 → 源码锚点 → 落地建议）

### 2.1 理念层

#### 2.1.1 摩擦 = 值得沉淀（不是工作量）

**机制**：一段会话"值得沉淀"不是因为工具用得多，而是人机之间发生了"搏斗"。评分信号（[teamai:src/contribute-check.ts]、[teamai:src/types.ts:876-892] 注释、[teamai:src/dashboard-collector.ts:163-287] transcript 流式扫描）：

- ESC 打断（interrupt）×20、拒绝工具（toolReject）×20、Stop 后 60s 内纠错 prompt（correction）×20（纠错窗口与关键词见 [teamai:src/types.ts:856-861]，**来自事件推导不来自 transcript**）；
- 工具真失败重试（toolError）用阶梯：≥3→10、≥5→18、≥8→25（要多次才算"真挣扎"）；
- 规模加成封顶 ~10 分（Skill 使用 +5、工具多样性 ≤5），**永不单独触发**；
- 硬门槛 toolCount≥15 + SMART_THRESHOLD=20（单个强信号即过线）；Phase2 追加：recall 全 miss → 知识缺口 +20、有 hit 但 topScore<5.0 → +10。

**防误报/防骚扰**：5 分钟 debounce 缓存、`hinted`/`contributed` 双 flag 保证**一次会话最多提示一次**（写入前 re-read 最新态防并发覆盖，[teamai:src/contribute-check.ts:636-658]）；codebuddy/workbuddy 等 Stop stdout 无法送达的工具把 hint stash 到下次 UserPromptSubmit 接力（[teamai:src/contribute-check.ts:655-657]、[teamai:src/hook-handlers.ts:216-244]）。

**→ 落地建议**：Legion 的摩擦数据比 transcript 更干净——**将军验收打回、in_review 次数、evidence 重试、士兵被纠正**都可从任务状态/评论推导。在守护插件 done 结算处加一个"任务摩擦评分"，高分任务的将军评语+evidence 自动进入"经验草稿"通道。

#### 2.1.2 置信度闭环：用量 → 质量 → 保鲜 → 升格

**机制**（单一 votes/ 数据源驱动排序、保鲜、升格三件事）：

- 计票双通道、**防幻觉**：recall 返回即自动记 recalled（autoUpvote）；upvoted 由 Stop hook 解析 transcript 后**只对"本次会话确实 recall 过且模型最终回复里实际声明引用"的 docId 交集**上票（[teamai:src/hook-handlers.ts:264-371]、[teamai:src/transcript-parser.ts]）——模型只是"召回过但没真用"不算采纳。本地 votes/<user>.yaml 只存 deltas，随 pull 增量合并（每人一文件、纯加法、成功才清空 → **git 零冲突**，[teamai:src/votes.ts]、[teamai:src/team-push.ts]）。
- confidence（[teamai:src/maintenance/confidence.ts:25-41]）= base(recalled×0.1+upvoted×0.3)×0.4 + recency(距上次 recall 天数，180 天线性衰减)×0.3 + ratio(upvoted/recalled)×0.3；差异 >0.05 才回写 frontmatter。
- **hot/cold 沉底而非删除**：低置信/失活条目检索分 ×0.3，让"团队真实用量"驱动热度（[teamai:src/maintenance/hot-cold.ts:11-26]）。
- **promote 升格为正式资产**四门槛：conf≥0.90、≥5 upvotes、≥2 个不同用户、age≥14 天（[teamai:src/maintenance/promote.ts:25-28]）；执行时 AI 把个人经验改写成"无日期无人名、可复用"的正式格式，拷入 skills/rules/docs 并在原件 frontmatter 留 `promoted_to` 溯源；**全程人工触发 + dry-run 列表**。
- **prune** 跳过无投票数据的新文档（防冷启动误杀）、默认 `--archive` 归档而非删除（[teamai:src/maintenance/prune.ts]）。
- **quality-update**：找"高 recall 低采纳"（recalled≥5、≥2 人、upvoted≤1）的 docs/rules/skills，喂 AI 结合同期真被采纳的 learnings 生成 `.draft.md`，人工 review 后改名生效。

**→ 落地建议**：这是 Legion 最缺的一环——验收证据目前是终态。可把"将军验收通过"当 upvote、把"被后续任务引用"当 recalled，做同款"草稿→正式 skill/rule"晋升管线，全部落在 team-hub 或 git 均可。

#### 2.1.3 recall 子代理协议 = 上下文卫生教科书（建议逐条抄）

这是全项目**提示词工程最精致**的部分，见 [teamai:agents/teamai-recall.md]（395 行，建议完整精读）：

1. **relevance precheck 快速失败**：`teamai recall --check "<3-6 关键词>"` 输出 `NOT_RELEVANT`（语料无覆盖 → 只回一行即停，不读文件不检索）或 `RELEVANT score= threshold= matched= missing= [title= sources=]`；阈值为**语料规模自适应** `max(idfBaseline×1.35, 4.0)`（[teamai:src/recall.ts:20-114]），RELEVANT 只表示"值得读文件"，**不代表覆盖你的主题**（matched/missing 是判断依据）。
2. **低复杂度快捷通道**：单文件/改字段类任务且 check 带 title/sources → ≤500 字符直接返回，跳过全流程。
3. **双语查询扩展**：词法检索不会跨语言匹配，故领域词中英各扩一份进查询；专名/代码标识/错误码/版本号**保持不译**（翻译反而伤匹配）；通用排查词（排查/failed/issue）占比受限（高频词 IDF 权重低），但不可全删（条目常恰好用这些词打 tag）。
4. **按任务类型选检索深度**：feature/edit → `--depth lookup`（符号级锚点）；bugfix/diagnose → `--depth context`（省 token，输出 ≤1500 字）。
5. **诚实审计**：`Matched:` 不代表相关（子串/分词幻觉，CJK 尤甚）、`Missing:` 不代表缺失（可 Grep 正文）；**没有覆盖就明说"无条目覆盖"并列出 rejected matches，严禁用邻近代答**；有 gap 就报告 gap，禁止猜。
6. **输出纪律**：固定结构、总量 ≤2500 字符、codebase 命中附"模块依赖 + top5 组件 + 改动入口点(forward 边)"让主对话**无需二次检索**；末尾 `<!-- teamai:recalled-doc-ids: [id, ...] -->` HTML 注释。
7. **doc-id 协议闭环**：主对话最终回复另声明 `teamai:referenced-doc-ids`（**剪枝而非凭记忆重建**）；Stop hook 用正则解析 transcript 拿"真被引用"的 docId 上票（防幻觉计票），并对"召回过却没声明"的会话 nudge AI 补声明（[teamai:src/hook-handlers.ts:354-364]）。

**→ 落地建议**：做成 DSH 的一个知识召回 agent preset（§4.1），协议 1/4/5/6 直接可用；doc-id 协议可映射到我们自己的"evidence 引用"格式。

#### 2.1.4 诚实审计纪律（贯穿全部 AI 生成内容）

图谱/知识库生成全程带证据与置信度标注，禁止凭空发明：每条关系 `EXTRACTED(1.0)/INFERRED(0.4~0.9)/AMBIGUOUS(0.1~0.3)`、**禁用 0.5 默认值**；结论必须 `file:line` 可回溯；`[UNVERIFIED]` 不得隐藏（>20% 文档顶部加警告）；质量数字完整展示不挑通过项；知识库 README 必须声明覆盖/不覆盖边界，让 AI 知道何时该说"不确定"（[teamai:skills/team-wiki-codebase/SKILL.md:191-202] 十条核心原则）。

### 2.2 分发 / 同步层

#### 2.2.1 scope 模型与"目录三概念"

- 四种后端收敛于同一拉取接口：`git`（独立团队仓）/ `http`（只读消费，report/sync/ack 按会话交付）/ `self`（业务仓即团队仓）/ `--scope user|project`（落地位置）——`[teamai:src/pull.ts:56-120] refreshTeamRepo` 按 kind 分派。
- **目录三概念正交**（[teamai:src/types.ts:1164-1276]、[teamai:docs/designs/data-directory-layout.md]）：knowledge dir（知识，随 git）/ resolveBaseDir（AI 工具资源落地根）/ data home（机器本地数据）。设计文档详述了 worktree 的"两个锚点"：`projectAnchor`（git worktree list 首行=主 checkout，共享身份）vs `workspaceRoot`（当前 checkout，资源必须落这里——AI 工具只向上扫到当前仓库根，不跟 git-common-dir）；`realpath` 归一防 macOS /tmp→/private/tmp 双身份。
- 组合：项目 scope 默认隔离；`--inherit-user-scope` 只继承"安全读路径"（skills/rules/docs/agents + 检索），env/MCP/hooks/source/上报**不继承**（[teamai:docs/usage-guide.md:243-257]）。

**→ 落地建议**：Legion 的 space/global 分层注入（LEGION.md 分层总纲）与它同构，可借鉴"只组合读路径、控制面保持隔离"的精确边界定义，以及 worktree 双锚点语义（legion 的 `.legion-worktrees` 已有类似物）。

#### 2.2.2 资产格式适配：toolPaths 数据表 + 双向渲染 + marker 所有权

- 每个 agent 的落地路径/格式是一张 **zod 校验的数据表**（[teamai:src/types.ts:220-269] toolPaths：claude/codex/cursor/joycode/qoder/codebuddy/openclaw/hermes/dsh/workbuddy/opencode，含 opencode 的 userScope 特例、codex 无 project mcp 等"已验证才填"纪律——**不对未验证路径瞎猜，宁可不写**）。
- 团队侧是**中立模型**（AgentSpec/HookDef/McpServerDef），落地到各工具时 forward/reverse **双向渲染**（如 Cursor 规则 `.mdc`：机器派生 frontmatter + 只搬 body，保证 pull→push 往返不被判为改动；push 时只把 body 传回上游，`paths:` 作用域永不丢，[teamai:docs/usage-guide.md:1204-1218]）。
- **marker = 所有权声明**：CLAUDE.md 注入段包在 `<!-- [teamai:culture:start/end] -->` 之间；hook 用 `[teamai:hook:...]` / `[teamai:agent-hook:<slug>]` 命名空间区分"内置/团队/远端注入"三类，reconcile 幂等、互不误删（[teamai:src/section-patcher.ts]、[teamai:src/utils/claudemd.ts]）。
- 同步收敛：`.removed` tombstone + desired-set 收敛删除（只删"团队确有其名/曾由本工具安装"的项，个人内容保留）；`uninstall` 只清自己管的东西（[teamai:docs/usage-guide.md:1348-1388]）。
- **hook 注入的健壮工程**（[teamai:src/builtin-hooks.ts]、[teamai:src/hook-handlers.ts:41-72]）：GUI 工具（WorkBuddy/CodeBuddy）hook 子进程无 PATH → 写 `~/.teamai/bin/teamai` wrapper 找到 bundled Node；`/bin/sh` 缺失检测防 ENOENT；**前台 handler 统一 <4.5s 预算**（实测宿主 ~10s 杀 hook，CodeBuddy 报 error 3003 打断 IDE），副作用全部后台 detached；错误吞掉永不影响会话。

**→ 落地建议**：若给 Legion/DSH 做"团队资产版本化"，直接抄这一整套协议（marker 所有权 + desired-set 收敛 + 幂等 reconcile + golden 字节锚点测试）。注意：**适配新 agent 的成本 = 数据表一行 + 渲染器一个分支**——这个抽象值得保留，但"适配全宇宙 agent"的目标不必学（§3.2）。

#### 2.2.3 同步正确性：快速路径 / 三方比对 / 应用层记账 / 跨进程锁

- **增量快速路径**：`state.lastPullRev + lastPullTargets`，rev 未变跳过资源重扫（但仍重部署内置规则/hooks）；文件级 sha256 比较；`writeJsonAtomic` temp+rename（[teamai:src/pull.ts:387-423]、[teamai:src/utils/fs.ts]）。
- **三方比对消歧"队友改 vs 我改"**（[teamai:src/utils/pre-push-sync.ts]，多机共享资产**最大误报源**的解法）：本地文件 ≠ 团队 HEAD 时，若本地内容 == 上次 pull 记录 rev 处的旧版本 → 判为"队友改的"，覆盖本地（否则你会把队友更新反向推回滚）；若本地异于新旧两版 → 判为用户亲改，留给 scan 上报；歧义（旧 rev 无此文件）宁可不做。
- **应用层记账实现"同 PR 原地更新 + 去重"**（[teamai:src/utils/pending-push.ts]、[teamai:src/push.ts]）：分支名带时间戳 → git 无法天然幂等；`pendingPushes{branch, prUrl, items, namespace}` 记在 scope state；prune 双判据（远端分支消失=已合并/关闭，或资源不再出现在新扫描=已上 default 分支），**网络失败保守保留**防 flaky 复活重复 PR；同 MR 更新 = 全量覆盖选中后对记录分支 `checkout -B` + `--force-with-lease`，并复用记录的 namespace 防 skill 被静默挪走。
- **跨进程锁**（[teamai:src/update.ts:199-329]、[teamai:docs/designs/data-directory-layout.md] P0）：原子 O_EXCL 创建 + JSON `{pid, owner}` + 过期 reclaim（dead pid 检测）串行在 sentinel 后 + 原子 rename-into-place + 释放时校验 owner token（非 owner 释放是 no-op）；`pull` 争锁整体跳过（幂等），`push` 争锁直接报错；`.sync-lock` 以 projectAnchor 为 key 跨 worktree 共享。DSH 侧可复用同款设计（单进程多实例/多 worktree）。

#### 2.2.4 过滤叠加与诊断

- 拉取侧过滤链：roles（namespace 目录，`skills/<namespace>/<skill>`）→ tags（订阅取并集）→ exclude（本地名单，最后生效）→ 清理只删"repo 确有其名"的项；角色失效安全降级为全量同步并提示换角色（[teamai:src/pull.ts]、[teamai:src/roles.ts]、[teamai:src/tags.ts]）。
- `teamai doctor`：逐项 ✔/✖+fix 清单——config/team repo/yaml 可解析、按 provider 分支查 gh/gf/gitlab/gitcode 认证、逐个已装工具查 hook 注入完整性、env 是否注入 shell profile（按 resolveHookScope 查**实际注入路径**而非假定路径）、packages 声明与 Codex trust-gate 提醒；`--json` 供机器消费（[teamai:src/doctor.ts]）。

### 2.3 知识层

#### 2.3.1 learnings 检索（务实认知，勿神化）

- learnings/docs/rules/skills 索引实为**带 IDF 的加权词项打分**而非经典 BM25：title×3 / tag×2 / body×1、idf=`log((N+1)/(df+1))+1`、查询长度归一 ÷√词数、投票加分 `min(votes×0.5, 5)`、类型加成 skills/rules×1.1、**查询域感知权重矩阵**（查询推断为 ops 类时 ops 文档不再被压分，[teamai:src/utils/search-index.ts:683-826、116-148]）。
- **真 BM25 在 codebase 图谱路径**（K1=1.5/B=0.75 + graph-boost）。
- CJK 分词：Intl.Segmenter + 单字连续段内拼 bigram，**不跨已识别词边界**（防"推理+服务→理服"幻影 token）；camelCase 拆分（getUserById→get/user/by/id）；报告 matched/missing 用原始词形（AppID 不拆）（[teamai:src/utils/tokenizer.ts]）。
- 多语言匹配交给 agent 协议层做查询扩展（2.1.3-3），不依赖索引本身。

**→ 结论**：这套检索的"工程取舍文档化"（为什么不用 embedding、IDF 边界条件、阈值自适应）值得抄进任何知识库实现；算法本身朴素，不必神话。

#### 2.3.2 codebase 图谱（方向对、工程有缺陷 → §3.1）

- 双轨抽取：启发式正则（全语言 facts）+ tree-sitter WASM AST 轨（TS/JS/Python/Go 的 import/call/implements），AST 结果按 file:line 覆盖启发式；AST 加载失败只记 `AST_UNAVAILABLE` gap 不阻断，`TEAMAI_SKIP_AST=1` 可强制启发式（零原生工具链，纯 JS WASM 依赖）。
- 图谱反哺检索：BM25 + 图邻接 boost（命中入口节点 +8、1-hop 按边类型 DEPENDS_ON×3/REFERENCES×2/... ×0.8、2-hop ×0.4）；`Sources:` 文件锚点 + "Candidate change files"（命中页 forward-dep 边推改动入口）；检索深度 route/context/lookup 控 token 预算。
- lint 与 gap 记录：连通性/孤立节点/60 天陈旧；`gaps/detected.md`（5 类启发式 gap + AST gap）。
- **AI 文档生成方法论值得抄**（[teamai:skills/team-wiki-codebase/SKILL.md] 909 行）：确定性图谱(evidence)与 AI 增强文档解耦、以 `_manifest.json` 为契约；分阶段（采集→架构逆向→分类型文档→图谱 G1-G9→质量）带**两次人工确认点**防系统性错误扩散；`progress.json` 断点续传 + 文件 sha256 增量；每批展示 token 消耗与 [UNVERIFIED] 统计；Phase K4 用**标准问题集做 E2E 验收**（用户出题优先于 AI 自问自答——"AI 自己出题容易考自己已知的领域"），准确率目标 ≥80%。

#### 2.3.3 CI 评审即知识门禁（extract-mr）

- MR open/update → CI `extract-mr --mode comment`：AI 读 MR 元数据+commits+diff（**50KB 截断，不读评论**）产出 learning/图谱建议，发 MR 评论；reviewer 用 GitHub 👎 / TGit ☝️ **reaction 逐条否决**；MR merge → `--mode write` 把未被否决的建议写入团队知识仓（learning 带 source_mr 溯源）。
- 防重复三件套：评论内 HTML marker 锚点幂等更新（`<!-- teamai:ci-extract -->`，同 MR 反复触发只更新不新增）；write 仅 merge 事件触发一次；learning 落库前关键词重叠 ≥0.6 标 `supersedes`。
- 另有 mr-hint：SessionStart 注入"近 7 天已合未提炼 MR"提示（闭环的补漏环节）。

**→ 落地建议**：对应 Legion"将军验收"环节——验收通过的任务其 evidence/评语可自动提炼入库，评审成本被复用，而非只存原始 evidence。

#### 2.3.4 用量分析的产品化（session save / digest / dashboard / KB Health）

- 设计决策记录在案（[teamai:docs/designs/team-intelligence-platform.md] 决策表）：collect-then-summarize（Stop hook 不直接调 LLM 防递归）、JSONL 追加防并发竞争、按月聚合 MD（10 人 90 天 ≈30 文件）、上报成功才截断、所有 I/O try-catch + graceful degrade（"零静默失败"）。
- **隐私姿态是结构而非补丁**："counts only, no prompt text"贯穿接口注释与默认值；自由文本离机前过 `redact()` 双层掩码（env 字面值 + 形状正则 → `<REDACTED:label>`，[teamai:src/utils/redact.ts]）；prompt 原文行要 `--include-prompt` 才随 `session save --push` 走；本地 events.jsonl 含 prompt 前 200 字摘要但**永不上传**。
- 干预指标三信号（interrupt/toolReject/correction）只记次数；digest 从 `stats/<user>.yaml` 聚合出"Session Autonomy"榜单，用于验证"某 skill/rule 上线后干预率是否下降"——**把度量接到改进闭环上**。

### 2.4 两处易误解的事实澄清（来自深挖报告）

1. `teamai review`（[teamai:src/review-cmd.ts]、[teamai:src/review-store.ts]）审的是 **AI 拟写入知识的内容队列**（`.teamai/pending-review.jsonl`：kind=codebase-section/domain-drift/multi-source-conflict，risk 自动推断——命中"架构决策与权衡/模块依赖/external-knowledge"等章节黑名单为 high，否则 medium），apply 经 section-patcher 落盘；**不是 skill/rule 语法评审**。skill/rule 质量判断分散在 MR 审批、votes→confidence、`maintenance --update-quality`(.draft.md)、skill-health 使用率评分。
2. `contribute-check.ts` 是 friction 驱动的分享提示打分（§2.1.1）；`repo-list/*` 是代码批量导入白名单——均与 MR 知识提取无关。

---

## 3. 实测缺陷与不宜照搬项

### 3.1 codebase 图谱的 3 处机制级缺陷（深挖 C 逐行验证）

1. **图身份分裂**：[teamai:src/wiki-engine/code-knowledge/code-graph.ts] 的 DEPENDS_ON/REFERENCES/IMPLEMENTS 边端点是**文件路径**，而节点是 `kind/name` 实体 slug（component/Foo）——边不指向任何节点，`validateGraph` 必报 missing_node，N 跳遍历与健康度指标失真（只有 CONTAINS/MAPS_TO 页级边是完整的）。
2. **跨仓边空转（schema 漂移）**：[teamai:src/import-repo.ts] `detectCrossRepoEdges` 只认 `relation==='imports'`，但生产写盘路径只产出 DEPENDS_ON/REFERENCES/IMPLEMENTS/CONTAINS——'imports' 仅存在于测试 fixture，**生产下跨仓边几乎不会生成**。
3. **置信度语义混用**：启发式正则轨普遍直接标 `EXTRACTED(1.0)`，与 AST 轨 EXTRACTED（解析唯一命中）不等价，虚高"高置信"统计。

另有：全局聚合 entity slug 无项目前缀，跨仓同名类会 merge 覆盖。**结论：借鉴方法论与降级设计，但身份模型（统一 entity 为锚点、文件路径只作 evidence）需自建。**

### 3.2 不值得学的部分

- **全工具 hook 适配矩阵的维护成本**：每个 agent 的格式/位置/限制都是手写数据表 + golden 字节锚点；新 agent（含 dsh）只做 skills。做"适配一切 agent"的目标对我们是负资产——**只做我们真正用的 agent 的深适配**（见 §4.5 反向机会）。
- **命令膨胀**：数十个子命令 + 大量为腾讯系内部场景服务的功能（iwiki、TGit/CNB provider、gf CLI）；CLAUDE.md 自己也立了"奥卡姆剃刀：非必要不加新命令"的规矩。功能面是"十人团队内部工具→开源"的典型形态。
- **依赖平台绑定**：多 provider 适配（github/gitlab/gitcode/cnb/tgit/自建）价值主要在腾讯系；对我们只需 git 一个后端 + 一个认证通道。
- 语言混杂（CLI 英文、文档中英、design docs 中文）带来维护摩擦——他们自己用 CLAUDE.md 规则强制双语同步，代价不小，不必学。

---

## 4. 对 Legion/DSH 的落地路线

### 4.1 P0：知识召回子代理 preset（零成本起步）

用 §2.1.3 协议做 DSH agent preset：`kb-recall` 子代理，输入=自然语言任务描述，行为=① 相关度 precheck（阈值随语料自适应）快速失败；② 双语关键词扩展（专名不译规则照抄）；③ 按任务复杂度选检索深度；④ 固定结构 ≤2500 字输出 + evidence 引用声明。首步动作：把协议 1/4/5/6 与"无覆盖就明说"转成 preset 提示词 + 一个本地轻量索引命令。

### 4.2 P0：摩擦信号 → 任务级经验沉淀

守护插件在 done 结算处打分：打回次数、in_review 轮数、evidence 重试、将军纠正评论 = friction；高分任务自动生成"经验草稿"（将军评语+关键 evidence），进"待晋升"队列。首步：在插件结算路径加打分 + 草稿落盘（复用 evidence 目录约定），先不做 UI。

### 4.3 P0：置信度晋升管线

对 4.2 的草稿队列实现 votes→confidence→promote 四门槛（可先简化为：被后续任务引用=recalled、将军点赞/采纳=upvoted、30 天衰减），promote 时 AI 改写成正式 skill/rule 并在原件留溯源。首步：给草稿加 recalled/upvoted 计数与 frontmatter。

### 4.4 P1：资产版本化分发 + doctor

把 Legion 的 rules/skills/roles 声明做成目录资产，按 §2.2 协议（marker 所有权 + desired-set 收敛 + 幂等 reconcile + tombstone）落地到每个 space 的士兵注入路径；配套 doctor 命令检查"规则是否真的进了士兵提示词"（对应 DSH 的 preset mount 诊断）。首步：选择 1 类资产（如 rules）做端到端原型 + golden 测试。

### 4.5 P1/P2：与 teamai 的双向集成机会

- teamai 目前只把 skills 同步进 `~/.dsh/skills`（已确认 DSH 原生扫描）。若 teamai 在团队内使用，可在 DSH 侧补 rules/agents 的落地（rules → 注入段落；agents → agent-presets 目录），或反向给 teamai 提交 dsh 适配增强。
- codebase 图谱（teamwiki）等能力成熟后再评估，须先修 §3.1 身份模型。

---

## 5. 证据与复核

- 评估基准：teamai-cli v0.22.0 / HEAD `a991038`。上表 [teamai:...] 行号基于该基准，为通读/深挖会话实测锚点，复核应以该基准 checkout 为准（仓库迭代快，main 已含 #422 后新提交）。
- 深挖范围：A=init/pull/push/bootstrap/update/status/uninstall/config/types/hook-dispatch/hook-handlers/hooks/builtin-hooks/resources 全族/exclude/roles/tags/source/utils(git|fs|home)；B=contribute*/recall*/session*/digest/dashboard-collector/usage-tracker/votes/maintenance 全族/deep-enrich/redact/tokenizer/search-index + share-learnings skill + teamai-recall agent；C=codebase*/import*/wiki-engine 全族 + team-wiki-codebase skill；D=push/team-push/review-*/ci 全族/doctor/skill-health/status/usage-guide/design docs/CI 配置。
- 反向验证：DSH 侧 skill-filesystem 扫描 `~/.dsh/skills` / `.agents/skills` 已在 deepseek-harness 源码确认（§1.3）。
