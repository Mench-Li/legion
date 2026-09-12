# 当前状态入口（STATUS）

> **这是判断「Legion 现在是什么状态」的唯一入口。** 全仓所有 `docs/**-evidence/`、`docs/G-*/`
> 目录内的文档都是**历史快照**（顶部带 `⚠️ 历史快照` banner），其中的测试数量、端口、命令与
> 结论只代表当时基线，**不得作为当前状态依据**。

**最近一次全量基线**：2026-09-12　`run-ci --only test` **PASS**；其中 `test` **76 套件 / 1969 用例**
（**须设 `DSH_CHECKOUT`**：不设时 `plugins/board-plugin` 按纪律 SKIP，计数为 74 通过 + 1 跳过 / 1747 用例）
—— 以本文件所在提交为准；证据 `.ci/2026-09-12T04-57-48-486Z/`
⚠️ `test` 阶段耗时**不是稳定值**：同一提交上空载约 **4.5 分钟**，而在 `gf001` 守护
（`scrum/daemon-gf001.json`，`intervalMs: 15000`）同时运行时实测 **31 分钟**（约 7 倍）。
**因此不要把耗时当回归基线**——只有套件数/用例数/通过与否可用于判定。

> ### ⚠️ 运行期状态：所有 AI 守护已停用（2026-09-11 起）
>
> `$DSH_HOME/profiles/web/cordis.patch.yml` 里 4 个 `dsh-scrum-worker` 实例
> —— `legion-scrum-worker`（scope=software）、`legion-scrum-worker-ozon`、
> `legion-scrum-worker-gf001`、`legion-mediator` —— 均已加 `disabled: true`。
>
> - **影响**：没有任何空间会自动认领或派工。看板与健康页的「守护」卡片会停在最后一次
>   sweep 的时间不再刷新 —— 这是「已停」的可见形态，**不是故障**。
> - **动阶段 2.5 之前必须先恢复至少一个空间守护**（阶段 2.5 含「设计伙伴真实任务」，
>   否则目标链会一直停在 `todo`）。恢复方式：去掉对应行的 `disabled`。
> - 停用理由逐行写在该 yml 每行上方（含「software 行 repoRoot 指向主仓库且 maxWorkers=2」
>   这一条）；改前备份 `cordis.patch.yml.bak-20260911`（该文件不在 git 下）。
> - 顺带修掉一处**既有**缺陷：静态守护行都没声明 `primaryScope`，而 `statusFileNames()`
>   把空值视为「我就是主 scope」，于是**每个**实例都去写 `daemon.json`
>   （看板/健康页唯一认的状态文件）并互相覆盖 —— 实测在 `software ↔ ozon` 之间
>   每 20~30s 跳变一次。gf001 的 15s 间隔原本最快、通常最后一个写，把这场竞争掩盖了；
>   停用 gf001 后立刻显形。现已在这两行显式声明 `primaryScope: 'software'`。
> - `gf001` 空间非终态任务数为 **0**；T-141 已由将军于 `14:00:32Z` 转 `canceled`
>   （产物从 patch 记录逐字恢复为 `53d9d15`，需求已由 `G-mtwxx7an-2` 交付，无需重做）。

> **本轮（PRT-501 ModelProfile 数据模型与 API：模型配置的存储面与对外契约）**：
> 新增 `team-hub/model-store.mjs`（仓储：**CAS 版本**、**墓碑删除**、
> 审计脱敏守卫）与 6 条路由（`GET/POST /api/model-profiles`、
> `GET/PATCH/PUT/DELETE /api/model-profiles/<id>`）；两组套件
> `model-store`（**20 例**）、`model-routes`（**14 例**）。
> 阶段 5 由 **0/11** 到 **1/11**。
>
> **四条判据**：
> ① **校验只有一处**——写入复用 PRT-102 的 `validateProfile`，API 层不再写一遍。
> 重复的后果不是多一道防线，而是两处判据会漂移，而漂移的那一次就是把明文
> 密钥写进库的那一次。
> ② **读出去的东西不含 `secretRef`**——连**引用名**都不给（只给
> `hasCredential`）。引用名也是可枚举的攻击面，而它没有必要出现在界面上。
> 用例在**序列化后的原始响应字节**上断言这一点：在解析出来的对象上断言是不够的，
> `JSON.stringify` 会把 `undefined` 字段丢掉，于是一个"字段名写错所以过滤没生效"
> 的实现也能通过。
> ③ **更新用 `version` 做 CAS，不给就拒绝（400）**——不默认成"最后一版"。
> 默认成最后一版时两个界面同时保存会静默覆盖而两边都显示成功，用户只会觉得
> "我改的东西自己变回去了"；配置类的 lost update 尤其难查，因为没有任何报错
> 指向那个方向。冲突时返回 409 **并带上 `currentVersion`**——不带的话调用方
> 只能反复盲试，"重新读取后再改"就变成了猜。
> ④ **删除是墓碑，不是物理删除**——一次 Run 会记着 `modelProfileRef`，硬删除会让
> "当时用的哪个模型"永远答不上来（与 §6.6「后续价格表更新不得重算历史
> `usage_records`」同一条纪律）。墓碑与"不存在"分开报（409 / 404）：混成一个
> 会让「删掉再用同名建」看起来像一次干净的首次创建。
>
> 审计只记非敏感事实（provider / model / 字段名清单 /「引用变了没有」），
> 并在写入器**之前**过一道守卫：含疑似明文密钥就**拒绝写**（fail closed），
> 不脱敏后照写——脱敏逻辑漏一处就等于把密钥永久留在库里。
>
> **这条路抓到三个真实缺陷**：
> ① `findPlaintextSecrets` **只看键名不看值**，于是 `limits.maxTokens` 被判成
> "检测到疑似明文密钥"。后果不是一个误报，而是**任何带 token 限额的模型档案
> 根本写不进去**，而报错把人送去查一个不存在的事故。`team-hub` 既有写入路径
> 只有 provider/model 两列、从不传 `limits`，所以这个缺陷一直躺在没人走过的
> 那条路上。修法与回归例见 `PRT-501-model-profile-api.md` §6，**验过会变红**。
> ② **契约基线看不见运行面建的表**：`dbTables` 只扫 `server.mjs`，于是
> `run_attempts` / `run_attempt_events` / `run_validations` / `run_handoffs` /
> `model_profiles` **五张表对基线完全不可见**——`--check` 报"无漂移"，而真实
> schema 已经多了五张。一个看不见某类变更的棘轮比没有棘轮更坏：它给出
> "已核对过"的错觉。基线由 **101 路由 / 22 表** 变为 **107 路由 / 27 表**
> （新增的 5 张表不是本次新增的，是 PRT-301/307/308 就建好的）。
> ③ **正则形态的路由对契约基线不可见**：`extractRoutes` 只认
> `path === '…'` 与 `path.startsWith('…')`，我最初用
> `/^\/api\/model-profiles\/(.+)$/.exec(path)` 写的三条路由在 diff 里
> 根本不出现，可以不经评审地增删。这一条恰好被我自己撞上（diff 只显示 2 条
> 而不是 6 条），否则会一直躺着。
>
> 详见 `docs/superpowers/prt/PRT-501-model-profile-api.md`。
>
> **本轮（PRT-306 workspace/worktree 隔离：真正的 `git worktree`，以及"没有隔离"必须可见）**：
> 新增 `orchestrator/workspace/index.mjs`（真 `git worktree`：规划期拒绝、
> 先落意图再做副作用、删除是拒绝边界）、`worktreeStages()`、
> `LEGION_WORKSPACE_DIR`、`resolveWorkspaceStages`、worker 状态文件
> `workspaceMode` 四态；两组套件 `workspace`（**24 例**，跑真 git）、
> `workspace-wiring`（**9 例**）。阶段 3 由 **12/16** 到 **13/16**，
> 余 PRT-304/315/316（提取类）。
>
> **在它之前"准备 workspace"是一个空函数**（`inPlaceStages()`，明记"这一步什么都没做"）。
> 它留下的是这个局面：**两个 worker 认领同一仓库的两条任务时，在同一个目录里改文件**。
> 由此产生的失败没有一个是报错——"我改的东西莫名不见了"、"上次改坏了这次却通过了"、
> "崩了之后不知道它在哪个目录干过活"。三条纪律各对付一种：
> ① **按 Attempt 分配**（不按 Task）：按 Task 时重试继承上一次的半成品改动，
> 于是"上次改坏了"的东西这次看起来是"已经改好了"；
> ② **先落意图再做副作用**；
> ③ **删除是拒绝边界**。
>
> **worktree 不进仓库**：落在仓库内部时它会出现在主仓库的 `git status` 里，
> 另一个 worker 的 `git add -A` 会把它整棵树提交走。本模块**拒绝**这种嵌套布局，
> 不靠"记得加 .gitignore"来防。目录落在 `DataDir/worktrees/`（spec §6.11 把
> `Workspace/` 定义为用户授权的项目目录，worktree 是运行面派生物）。
>
> **抓到两个真实缺陷**：
> ① **Attempt id 是 `att:<taskId>:<n>`，含冒号**，而冒号在 Windows 上是非法
> 文件名字符——"id 直接当目录名"不是"偶尔遇到脏数据"，而是**每一真实 Attempt
> 都会**走不通。必须有显式且**单射**的编码：把冒号换成连字符会让 `att:T-1:2`
> 与 `att-T-1-2` 撞进同一个目录（一次重试覆盖另一次的工作区且不报错）。
> 同时拒绝路径分隔符与 `..`（不编码——它们说明调用方传的是**路径**，
> 编码只会把错误变成"看起来正常但指向别处"）。
> ② **worker 调 `prepareWorkspace`/`buildContext` 时是 `await run()`，不传 lease**。
> `execute` 是单独调的、拿到了租约，而这两个阶段一直是无参调用。
> 一直没被发现的原因很具体：**做空的 `inPlaceStages()` 不需要租约**——
> 它的返回值是常量，跟是哪条任务毫无关系。一个恰好不需要该能力的实现，
> 把框架的调用点缺陷藏到了下一个真正需要它的实现出现为止。
> 修法是 `await run(claimed)`。
>
> **「git 说成功」≠「工作区可用」**：`createWorkspace` 建完会**重读登记表**核验，
> 没有登记就报错——没有登记，回收与恢复都找不到这个目录，而 `git` 的退出码是 0。
> 建失败时收拾的只限于**本次调用自己**刚造出来的残壳并 `worktree prune`；
> 不收的话下次会报 `already exists`，这个槽位就永久坏掉，而它看起来只是"又失败了一次"。
>
> **`workspaceMode` 四态，判据是提供者的显式声明**而不是猜"有没有
> `prepareWorkspace`"：`inPlaceStages()` **同样提供**那个函数，靠推断会让原地执行
> 被写成 `enabled`——状态文件说"有隔离"，而实际没有。这是这类代码里最坏的一种错。
> `disabled` 还带 `workspaceNote`（理由），因为结论本身不能据以行动。
> 没有 `LEGION_WORKSPACE_DIR` 时**不自动退回原地执行**，只给理由；
> 要原地执行必须显式铺 `inPlaceStages()`——一个具名的调用点。
>
> **删除是不可逆的，因此回收全是拒绝**：有未提交改动就拒绝（列出文件），
> `force` 也不越过（一个布尔开关不该成为丢掉别人唯一一份成果的入口）；
> 陌生目录一律拒绝覆盖；读不出改动状态也拒绝（不能假定它干净）。
>
> 验证过会变红：把 `REF_OVERLAP` 检查与脏检查分别换成 `if (false)`，
> 对应用例立刻红（3 处失败），恢复后 24/24。
> 详见 `docs/superpowers/prt/PRT-306-workspace-worktree.md`。
> PRT-007 基线已按新 env 键重录（topology 清单 +1 键：`LEGION_WORKSPACE_DIR`）。
>
> 上一轮（PRT-305/308 岗位与流水线 + 打回与交接）：
> 新增 `orchestrator/pipeline/index.mjs`（**纯函数**：岗位索引、流水线结构读法、
> `resolveNextPost`、`buildHandoffTask`）、`run_handoffs` **只追加**表、
> `runStore.handoff/handoffsOf`、路由 `POST /api/runtime/handoff`、
> `GET /api/runtime/handoffs`、`GET /api/runtime/next-post`；三组套件
> `prt-pipeline`（16 例）、`handoff-store`（12 例）、`handoff-routes`（8 例）。
> 阶段 3 由 **10/16** 到 **12/16**（301/302/303/305/307/308/309/310/311/312/313/314），
> 余 PRT-304/306/315/316（提取类）。
>
> **spec 第 333 行要的是「原子创建」，不是「状态走到 Completed」**：
> `HandingOff` 的定义是「当前 Task 收口并**原子创建/释放下一岗位任务**」。
> 两个分句各自能独立失败，而第二种最坏——上一环收口了、下一岗位的任务
> **不存在**，库里看起来一切正常（无报错、上一环 `Completed`），
> 而链已经断了，要等整个目标停住才被发现。
>
> **「链断」与「链尾」在数据上长得一模一样**——这是本批最核心的判定。
> `space_stages.next` 是**没有外键约束**的字符串，查不到下一岗位有四种成因：
> ① 就是链尾（正常）；② `next` 拼错一个字母（配置坏了）；③ 下一岗位被停用
> （后果与拼错一样）；④ 任务上记的 `role` 已改名/停用。混成一个"没有下一岗位"
> 就是**静默掐断任务链**。因此 `ok: false`（配置错误）与 `hasNext: false`（正常）
> 刻意不复用同一个字段，`pipelineView` 也把 `tailRoles`（故意的链尾）与
> `brokenEdges`（坏的）分开报。同理，读不出流水线时**抛错**而不当成空：
> 当成空会让**所有**任务都被判成链尾，一次读失败静默掐断所有链。
>
> **幂等靠两处，且都在同一事务里**：① 先查 `run_handoffs`；② `successor_id` 上
> 建**唯一索引**。第 ② 条不是冗余——只在应用层查重时，两个并发进程会各查一次、
> 各建一条，这与 `ensureColumn` 那次的失败模式**一样**。重放是**正常路径**
> （崩后重扫一定重放同一次交接），因此它必须成功并返回**同一条** `successorId`。
> 交接的幂等键是 `parent`（上一环任务 id）：标题在交接时会被改写、
> 创建时间在重放时必然不同，只有它是重放时不变的事实。
>
> **原子性的可验证形态写进了用例**：让 `createTask` 插一条真任务、再返回一个
> **已被占用**的 `successor_id` 去撞唯一索引，断言那条刚插进去的任务
> **也被回滚**——否则库里会留下一条没人认领的孤儿后继。
>
> **`run_handoffs` 同时是 `HandingOff → Completed` 要的证据**：
> 没有交接记录就收口 → 409 `EVIDENCE_MISSING`。「交接发生了」的证据是
> **后继任务真的被创建了**，不是调用方说"我交接了"。这条闸门上线时
> **弄红了一条老用例**（`acceptance-store` 的用例③）：它原来断言"打完验收
> 之后就能推进到 `Completed`"——那是**较弱的契约**。修法不是放松闸门，
> 而是把用例改成断言"没有交接记录时会被拒绝，且状态原地不动"。
>
> **这条路抓到一个真实缺陷**：`server.mjs` 与 `run-store.mjs` **各有一个**
> `withTx`，两个闭包各记各的 `txDepth`。server 的 `createTask` 进到运行仓储
> 已开启的事务里时以为自己在最外层，于是又发一次 `BEGIN IMMEDIATE`，报
> `cannot start a transaction within a transaction`。看起来像"夹具写错了"，
> 实际是"两处各自记账"的必然结果——而后果不只是报错：若改成"检测到已在
> 事务里就跳过 BEGIN"，建任务就不会被回滚，**伪原子的交接会在崩后留下孤儿后继**。
> 修法是把函数体拆成 `createTaskInTx`，由调用方声明自己已在事务里。
> 另两处红：`getTask` 对不存在的任务**抛异常**，于是"任务不存在"变成 **500**
> 而它明明是 **404**（用异常做正常流程控制会让状态码失去意义）；
> 以及我的夹具让 `claim` 抢先领走了第一次交接建出的后继。
>
> 详见 `docs/superpowers/prt/PRT-305-308-pipeline-handoff.md`。
> PRT-007 基线已按新路由重录。
>
> 上一轮（PRT-307 机器验收：执行成功 ≠ 交付完成）：
> 新增 `orchestrator/acceptance/index.mjs`（**纯函数**：判据核验 + 结论到去向的映射）、
> `run_validations` **只追加**表、`runStore.recordValidation/validationsOf/criteriaOf`、
> 路由 `POST /api/runtime/validate` 与 `GET /api/runtime/validations`；三组套件
> `acceptance`（24 例）、`acceptance-store`（16 例）、`acceptance-routes`（10 例）。
> 阶段 3 由 **9/16** 到 **10/16**（301/302/303/307/309/310/311/312/313/314），
> PRT-308 记为 🟡（打回与完成已落地有用例，交接的下游任务链未交付）。
>
> **为什么它是一道独立关卡**：PRT-312 的强杀演练留下过一个当时只能如实记录的现象——
> 执行成功落在 `Validating`，而**没有任何东西能把它推到 `Completed`**。当时我的断言
> 写的是 `Completed`、它超时失败了，修的时候有个真实的诱惑：为了让用例变绿，
> 把"执行完"直接写成"已完成"。那正是完成标准里「不伪装成功」要禁的事。
> 本批把落点补上：「执行成功了」与「做出来的东西满足验收判据」是两件事——
> 前者由运行面知道（`outcome: completed`），后者只能拿任务自己声明的判据去核。
>
> **四种结论口径**（每条都有用例，且都不是"看起来对"）：
> ① **三种结论而不是布尔**——`accepted`/`rejected`/`needs-human`。合成一个 `false`
> 时，"机器确认不满足"（该打回重试）与"机器判不了"（该交人工）只能走同一条路，
> 而两条路选哪条都是错的：当失败会让本来正确的交付被反复重做（外部写已发生时
> 就是重复副作用），当通过就是伪装成功。
> ② **判据清单封闭**——不在已登记四种里的一律算"判不了"而**不是**通过。
> 一个"总是通过"的核验比没有核验更糟，因为它让验收看起来是被保证的。
> ③ **散文判据 = 人工判据**。接入运行面时才发现 `tasks.acceptance` 的真实形态：
> 由 `stage-standards.mjs` 生成的**散文**（"每条关键结论可验证：有真实依据，不得虚构"）。
> 机器核不了它，而它又必须被核验过才能算完成。因此字符串判据被当成一类**正当的**
> 判据：任务只带散文判据时结论必然是 `needs-human`——这是**对的**，从没人说过
> "什么叫做完了"。把字符串当"形状不对"也能得到同样结论，但错误信息会指向
> "调用方传错了"，**排查方向完全相反**。
> ④ **`requiresPersist` 从"一段 JSON"变成真的闸门**。状态机为
> `Validating → Completed` 声明了 `requiresPersist: ['attempt','validation']`，
> 而在此之前它只被记录、从不被核验——一条任务可以带着"从未被验收过"的事实
> 进入 `Completed`，而事件流里那句话看起来像是在保证它。现在 409 `EVIDENCE_MISSING`。
> 闸门放在 UPDATE **之前**：之后发现就只能回滚，而"已经写进去过"本身会留下痕迹。
>
> **这条路抓到一个真实缺陷**：交付级审批（`Validating → AwaitingApproval`）的任务
> 在看板上显示为 `in_progress` 而不是 `in_review`。根因是投影读的是**边**的
> `taskStatusHint`，而 `AwaitingApproval` 有两个入口、走不同的边；正确的事实来源是
> 刚写进那一行的 `returnTo`。后果不是报错，而是**一条等着交付审批的任务显示为
> "进行中"**——审批人以为活还在干，于是它既不在待办里、也没人在跑。
> 修完把旧写法临时改回去验证过：用例立刻红（`actual: 'in_progress'`,
> `expected: 'in_review'`），然后复原，`TEMP-REGRESSION-CHECK` 标记 0 残留。
>
> 错误码刻意把 4xx 与 5xx 分开：`tasks.acceptance` 那一行坏了是 **500**
> `BAD_ACCEPTANCE_CRITERIA`（数据问题），`NOT_VALIDATING`/`EVIDENCE_MISSING` 是 409
> （请求合法、状态不允许）。混成 400 会让运维去查调用方，而真正要修的是数据。
>
> 详见 `docs/superpowers/prt/PRT-307-machine-acceptance.md`。
> PRT-007 基线已按新路由重录（diff 恰好是 2 条路由 + `server.mjs` 哈希）。
>
> 上一轮（PRT-312 真实进程被强杀的整链路演练 + 进度表派生数字自检）：
> 新增 `orchestrator/worker/scripts/kill-drill-worker.mjs`（可注入"卡住阶段"的**真 worker 进程**）
> 与套件 `run-kill-drill`（**2 例**）。它逐条验阶段 3 完成标准（spec 第 885 行）的三个分句：
> 真 worker 进程对真 team-hub 说话、写真状态文件、写真 marker，然后被 `SIGKILL` 强杀。
> 阶段 3 达成 **9/16**（301/302/303/309/310/311/312/313/314）。
> 加上进度表自检套件后为 **66 套件 / 1815 用例**（本块交付时是 65 / 1803）。
>
> **为什么这个演练必须存在，而且必须是真进程**：在此之前所有"崩后回收"的用例
> 都是在同一个进程里调用 `recoverExpired`——它们验证的是"回收函数写对了"，
> 而不是"一个进程真的被杀掉之后，**磁盘上留下的东西**会让回收做出正确判断"。
> 完成标准问的恰恰是后者。同一进程里模拟"被杀"只能靠不调用某个函数，
> 而真实强杀的语义是"函数执行到一半，进程没了"，两者留下的痕迹不同。
>
> **三条判据分别对应完成标准里的三个分句**：
> ① **不丢任务**——在外部写边界**之前**（`PreparingWorkspace`）被杀：回收新建 Attempt，
>    另一个 worker 接手并执行完，历史 Attempt 完整保留。
> ② **不伪装成功**——被杀那一刻 Attempt 绝不是 `Completed`、`finished_at_ms` 仍为 null；
>    状态文件必须判为**不新鲜**（Windows 上强杀不走信号处理器，文件停在最后一刻的值，
>    "文件存在"与"worker 还活着"是两件事）。
> ③ **不重复执行已确认的外部写**——在外部写边界**之后**（`Running`）被杀：
>    回收进 `UnknownOutcome` 等人工而**不是**自动重试；随后再起两个 worker 跑几秒，
>    marker 文件里"外部写"的记录必须**自始至终恰好一次**。
>    最后人工对账确认"已发生"→ `Validating`，**仍然不得新建 Attempt**。
>
> **两处让演练是真的演练、而不是碰巧通过的细节**：
> ① 回收前先断言"租约仍有效时不得回收"——证明回收是由**租约**驱动的，
>    而不是"看到某个状态就动手"（抢占一个可能还活着的持有者正是同一任务被执行两次的来源）。
>    为此在租约过期前就先调一次 `recover` 并要求它一无所获。
> ② 把"租约过期"这个前提**直接摆好**（改库）而不是等 120 秒 TTL——
>    这里验的是"租约已过期时回收判得对不对"，不是"120 秒有多长"（TTL 语义由 run-store 用例覆盖）。
>
> **这条用例抓到的第一件事**（也正是它该抓的）：执行成功的落点是 `Validating`
> 而**不是** `Completed`——机器验收（PRT-307）是执行成功之后的一道独立关卡，本批次未交付。
> 我最初的断言写的是 `Completed`，它暴露了一个真实的诱惑：若为了让用例变绿而把
> "执行完"直接写成"已完成"，那正是完成标准里那句"不伪装成功"要禁的事。
> 现在断言 `Validating`，并在注释里写明理由。
>
> **同时验证这条用例本身会红**：把回收的「已越过外部写边界」判错（说 `Running` 不算越过），
> 用例③立刻失败（`retry-new-attempt` ≠ `mark-unknown-outcome`）——即它会因为
> "外部写要变成两次"而红。一个无论实现对不对都通过的演练没有价值。
>
> 三条门禁均绿：`scan --check` PASS（244 个疑似字面量）、`dsh-boundary` PASS（3 文件 / 26 处，未增长）、
> `topology-inventory --diff` 无漂移。
> 详见 `docs/superpowers/prt/PRT-312-kill-drill.md`。
>
> **附带：进度表的派生数字不再靠人算**（`scripts/prt/progress-check.mjs` + 套件 `prt-progress` 12 例）。
> 我在这两批里把阶段 3 的计数**写错过两次**（一次 6/4/6、一次 11/16 而实际 9/16）——
> 手写派生数字就是会错：它要求每次改动都完整重做一遍加法，而人只会更新自己刚改的那一行。
> 现在阶段标题的 `(n/m)`、汇总表各列、合计行都必须等于明细，`--fix` 用明细重算。
>
> 它**立刻查出 11 处历史不一致**，其中 6 处是阶段标题：
> 阶段 0 写 `(11/11)` 而明细是 10✅+1🟡、阶段 2 写 `(15/15)` 而明细是 10✅+5🟡、
> 阶段 6 写 `(0/20)` 而明细已有 1✅、阶段 7 写 `(6/13)` 而明细是 5✅。
> 这些**都是"把有交付物写成已完成"的宽松说法**——正是那份文件头声明要防的事
> （「⚠️ 有用例不等于已生效」）。汇总表的阶段 3 与阶段 7 两行也已按明细改正，
> 合计从 `44/19/80/2` 修正为 `46/15/82/2`（**总数 145 不变**）。
> `--fix` 的 diff 经逐行核对：**只有数字变化**，且自检器自己也验证这一点
> （`--fix` 的输出与输入抹掉数字后必须逐行相同——一个会改文档的工具，
> 解析错一行的后果不是报错，而是把内容吃掉）。
>
> 顺带：钻探夹具的三个参数原本是环境变量（`DRILL_BLOCK_IN` 等），
> 被 `scan --check` 与 `topology-inventory --diff` 同时拦下（未声明的 env 键）。
> 两条路都不该走——声明进产品 schema 会让运维以为它们可以设置，
> 而开"夹具不用声明"的例外会削弱那条门禁本身。改为走 **argv**：
> 夹具的参数留在夹具的命令行上，环境变量只留给 worker 的真实配置。
>
> 上一批（PRT-314 多 worker 并发语义验证 + 原子迁移原语提取）：
> 新增 `team-hub/scripts/claim-probe.mjs`（**真实子进程**并发探针）与套件
> `run-concurrency`（**5 例**），验证四件事：WAL 的**跨进程**可见性、
> `busy_timeout` 在锁争用下按预算等待（而不是抛 SQLITE_BUSY 把并发问题伪装成随机故障）、
> **6 个进程同时抢同一条任务恰好一个赢**（这正是"不重复执行已确认的外部写操作"在数据面上的保证）、
> 以及两个进程并发补列不崩。并发建表/补列的原子原语提取到 `team-hub/schema-util.mjs`
> （`BEGIN IMMEDIATE` 内重读列名再 ALTER），`server.mjs` 的 30 多处调用点改为薄包装，
> 实现**只有一份**。阶段 3 达成 **8/16**（本块交付时 63 套件 / 1801 用例）。
>
> **为什么必须是真的操作系统进程**：同一进程内的两条连接共享同一份 `node:sqlite`
> 模块实例、同一次 PRAGMA 设置、同一个事件循环——而且**两条 `BEGIN IMMEDIATE`
> 不可能真的同时发出**（JS 是单线程）。因此「并发领取只有一个赢家」在那种测法下
> 几乎必然成立，它证明的是"我把条件更新写对了"，而不是"两个进程抢的时候不会都赢"。
>
> **这一组当场抓到一个真实缺陷**：`ensureColumn` 在提取成共享模块时写成了
> 「先 `PRAGMA table_info` 再 `ALTER TABLE`」——两个并发启动的进程都会读到「列不存在」，
> 于是都执行 ALTER，后者拿到 `duplicate column name: idempotency_key` 并在
> **模块加载期**崩溃。真实形态是 8787 独立进程与 3080 宿主外壳同时启动时其中一个起不来，
> 表现为 `/team-hub` 路由缺失 + 一条加载失败日志，**看起来与数据库迁移毫无关系**。
> 用例是把这条缺陷钉住的：先按非原子写法跑了一遍确认它会红（`duplicate column name`），
> 再恢复原子实现确认变绿——一个无论实现对不对都通过的用例没有价值。
>
> 顺带修掉两处**测试脚手架自身**的缺陷（都不是产品问题，但都会伪装成故障）：
> ① 父进程 `BEGIN IMMEDIATE` 后**同步**等子进程，两个一起等到超时——
>    那是脚手架死锁，会把"写锁确实生效"误报成"连接失败"。改为用定时器异步放锁。
> ② 一处断言写成「子进程应能读到父进程已建的库与表」却断言 `claimed !== null`，
>    与注释正好相反。跨进程可见的正确判据是**子进程正常退出（code 0）**：
>    表不可见时探针会报错退出，而"队列空"才是它看到同一个真相的证据。
>
> 三条门禁均绿：`scan --check` PASS（244 个疑似字面量）、`dsh-boundary` PASS（3 文件 / 26 处，未增长）、
> `topology-inventory --diff` 无漂移；`server.mjs` 重构后刷新平台契约基线的源文件哈希
> （**路由与数据表零变化**——diff 只有那一行哈希，正好证明这次重构没有动契约）。
>
> 上一批（PRT-309/310/311 重试退避与 Dead Letter、恢复扫描与人工处置、外部副作用幂等）：
> 新增运行面路由 `POST /api/runtime/fail`（失败结算的**唯一**入口）、`GET /api/runtime/held`
> （等人工清单）、`POST /api/runtime/resolve`（人工处置）、`GET /api/runtime/budget`（额度读数）；
> `run-store.mjs` 新增 `failAndRetry` / `scheduleRetry` / `listHeld` / `resolveAttempt` / `retryBudgetOf`、
> `run_attempts` 的 5 个新列（含**幂等键**与**退避闸门**，对老库用 `ALTER TABLE` 补齐）；状态机为
> `UnknownOutcome` 补上 `Validating` / `RetryableFailure` 两条出边与两个新守卫。
> 61→**62** 套件、1702→**1796** 用例（`run-plane` 63→**87**、`orchestrator` 51→**58**）。阶段 3 达成 **7/16**（本块交付时）。
>
> **这一批补的是「不会报错的四类静默失败」**：
> ① **无限重试**——没有任何上限时，一个持续失败的任务只是安静地永远跑下去，
>    把模型配额、日志和外部系统调用次数一起吃掉。现在有额度（默认 5 次）、
>    退避（2s 起指数上升、有上限）、以及终点 `DeadLetter`。
> ② **任务停在中间态**——`transition({to:'RetryableFailure'})` 只把尝试标成失败就结束了，
>    「接下来怎么办」没人做：它既没有可领的队列，也不在等人工清单里，
>    从任何界面看都只是"失败了"，而没有人会去处理它。现在失败只有一条路径
>    （`failAndRetry`），它必然把任务送到「重试中」或「DeadLetter」其中之一。
> ③ **静默消失**——`DeadLetter`/`UnknownOutcome` 若只是历史里的一行记录，
>    用户会以为它还在跑。`/api/runtime/held` 把它变成一份可结清的待办清单，
>    并标出哪一条才是当前需要处理的（历史条目不再反复出现）。
> ④ **重复副作用**——`UnknownOutcome` 原来只能进 `DeadLetter` 或 `Cancelled`，
>    于是一个**真的已经交付**的结果只能被当失败重做或静默丢弃。现在对账的
>    两个确定结论都能被记下来：确认已发生 → `Validating`（按成功走验收，绝不重跑）；
>    确认未发生 → `RetryableFailure`（降级为普通可重试失败）。
>    两个守卫都要求**显式**布尔值，缺省报「缺输入」而不是默认某一个方向。
>
> **幂等键刻意不含 `attempt_no`**：含了就等于没有——每次重试一个新键，
> 外部系统无法判断"这是同一次操作的重试"，去重照旧失效。
> **退避是服务端写进队列的闸门**（`next_attempt_at_ms`），不是 worker 自己 sleep：
> 漏掉它时 `retryDelayMs` 只是一段没人调用的纯函数。
> **租约过期回收不叠退避**（等待已由租期付过），但**照样查额度**——
> 否则「每次快失败就被杀」的任务会永远重试下去，而这条路径上没有任何失败日志。
>
> **自审又抓到一处不报错的缺陷**：在一条**已经结算过**的尝试上再报一次失败，
> 会再触发一次 `RetryableFailure → Queued`，于是一次失败被结算两次、排出两条排队尝试，
> 之后同一条任务会被两个 worker 各领一条。现在 `RetryableFailure`/`UnknownOutcome`
> 上的重复上报是 no-op（后者还额外返回 `awaiting-human-reconciliation`：
> 挂起等人工的尝试绝不能因为"又报了一次失败"就重跑）。
>
> **计数口径**：`DSH_CHECKOUT` 未设时 `plugins/board-plugin` 按纪律 SKIP
> （本套件不伪造通过），此时为 60 通过 + 1 跳过 / 1574 用例；上表数字是设了它的完整配置。
>
> 三条门禁均绿：`scan --check` PASS（**244** 个疑似字面量）、`dsh-boundary` PASS（3 文件 / 26 处，未增长）、
> `topology-inventory --diff` 无漂移；新增 4 条路由后按 PRT-007 棘轮刷新平台契约基线
> （diff 恰为那 4 条路由 + `server.mjs` 哈希）。
> 详见 `docs/superpowers/prt/PRT-309-310-311-retry-and-reconciliation.md`。
>
> 上一批（PRT-302/303/313 运行实体落库：租约 + 权威时间 + Attempt 不可覆盖 + epoch 拒写）：
> 新增 `team-hub/run-store.mjs`（`run_attempts` / 只追加的 `run_attempt_events` / `claim` /
> `heartbeat` / `transition` / `release` / `recoverExpired`）、`server.mjs` 的 7 条**运行面**路由
> （`/api/runtime/{claim,heartbeat,transition,release,recover,status,attempt}` 与 `/api/config` 的
> `runPlane` 能力位）、worker 接线（§6.4 四阶段「先落库意图再做副作用」+ 心跳遇 `LEASE_EPOCH_STALE` 停手）、
> 以及套件 `run-plane`（**63 例 = 仓储 34 + HTTP 契约 19 + 真 team-hub 端到端 10**）。
> 61→**62** 套件、1702→**1765** 用例。阶段 3 达成 **4/16**（301/302/303/313；本块交付时）。
>
> **三条判据各自的落点**（spec 第 885 行）：不丢任务 → 过期租约回收与**释放后立刻可被再领**；
> 不伪装成功 → 执行完成落 `Validating` 并投影到看板 `in_review`（执行完成 ≠ 交付被接受）；
> 不重复执行 → ① 过期 worker 的写入被 `LEASE_EPOCH_STALE` 拒掉（错误里带**真实** epoch）、
> ② 可能已产生外部副作用时挂 `UnknownOutcome` 等人工而不是自动重跑、
> ③ 并发领取下同一条任务只有一个赢家（用两条**独立 SQLite 连接**验证）。
>
> **端到端这一层抓到了前两层结构上看不见的缺陷**：worker 的 hub 客户端把
> `{ok, claimed}` 信封当成 claim 对象用，于是 `taskId === undefined`——而 `undefined`
> 恰好就是 worker 判断「没领到」的条件。结果是**任务已被服务端领走（Leased、租约在跑）而
> worker 以为队列是空的**。仓储单测不经过 HTTP 信封、worker 单测的假 hub 已经解过包，
> 因此两边都自洽。这类缺陷只有真 hub + 真 worker 一起跑才会现形。
>
> **自审改掉 4 处不报错的缺陷**：`Object.assign` 让附加数据静默覆盖错误码（拆成
> `code` / `stateMachineCode` 两个字段）；`release` 只终结当前尝试而**不排队新尝试**，
> 于是「让别人接」仍要等租期自然过期——而释放的全部意义就是不等；
> 领取的 Queued 分支漏检查任务 `status`/`hold`，「将军拦截优先于队列」静默失效；
> `openNextAttempt` 直接 `UPDATE` 终结状态，绕过状态机校验（回收是无人值守路径）。
>
> **两处测试脚手架教训**（都已修，写在 PRT-302 文档第 10 节）：全局 `fetch` 的 undici
> keep-alive 连接会让 `node --test` 跑完不退出（实测卡死 90s+，产品代码不改，测试侧改用无池客户端）；
> 更隐蔽的是**一个失败的断言会把「失败」伪装成「卡住」**——断言失败后 worker 未被停止，
> 心跳循环每 10s 续一次、永远不停，于是进程不退出、`ℹ fail N` 永远不打印。
> 现在起 worker 的用例一律走 `withWorker()`（`finally` 里 `stop()`）。
>
> 三条门禁均绿：`scan --check` PASS（**237** 个疑似字面量）、`dsh-boundary` PASS（3 文件 / 26 处，未增长）、
> `topology-inventory --diff` 无漂移；新增 7 条路由后按 PRT-007 棘轮刷新平台契约基线
> （`prt-007-baseline.json`，diff 恰为那 7 条路由 + `server.mjs` 哈希）。
> 详见 `docs/superpowers/prt/PRT-302-303-313-run-entities.md`。
>
> 上一批（PRT-301 持久化运行状态机 + Orchestrator worker 入口）：新增
> `orchestrator/state-machine/`（13 态、CAS 迁移、具名拒绝码、失败分类、恢复判定）、
> `orchestrator/worker/`（循环 / 状态文件 / 进程外壳）、入口 `product/orchestrator/worker.mjs`、
> 配置面 `orchestrator/config-schema.mjs` 与套件 `orchestrator`（**51 例**，含 **1 例真实进程**）。
> 60→**61** 套件、1651→**1702** 用例。阶段 3 启动。
>
> **清单里最后一个入口缺口关掉了，而且是门禁先变红再改文档**：
> 新建 `product/orchestrator/worker.mjs` 后，`MANIFEST_KNOWN_GAPS` 的对账用例立刻失败，
> 报出 `actual: [ENTRY_UNRESOLVED:runtime]` / `expected: [ENTRY_MISSING:orchestrator, …]`。
> 这正是它在 PRT-258 被设计出来要做的事——缺口补上时必须有人回头改清单，
> 否则清单会继续宣称一个已经不存在的缺口。现在 `--check` 只剩 `runtime` 一条。
>
> 三条判断：
> **① 状态机的价值全在「拒绝」上。** 30 条用例里 19 条断言的是拒绝。
> 因为状态机最危险的失效方式不是「写错一个状态」，而是「本该拒绝的迁移被接受了」——
> 被接受之后没有异常、没有日志，只有很晚才被发现的现象：用户看到「已完成」变回「进行中」、
> 任务链在某处静静断掉、或者**外部写操作被执行两次**。因此每条拒绝都返回**具名**错误码：
> `UnknownOutcome → Queued` 报 `UNKNOWN_OUTCOME_NOT_RETRYABLE` 而不是笼统的 `ILLEGAL_TRANSITION`，
> 具名才能被单独统计与告警。
> **② 未登记的失败码不默认可重试。** 对一个我们还不认识的错误自动重试，
> 最好的情况是浪费一次额度，最坏的情况是重复付费/重复推送。同理，
> 崩溃恢复时「lease 过期」必须显式回答「外部副作用是否可能已发生」，
> 缺这个输入就**拒绝判定**（`EXTERNAL_EFFECT_UNKNOWN`）——判错的代价不对称。
> **③ worker 不认领自己执行不了的任务。** 没有执行引擎时一次 `claim` 都不发。
> 一个「积极」的 worker 会照常认领然后立刻失败，把重试额度烧光，
> 外部表现是「任务在跑但全都失败了」，而真因只是「没配执行引擎」。
>
> **自查改掉了四处不会报错的问题**，最值得记住的是第 ② 条——
> 入口原写成 `const { runPromise } = await runWorkerProcess()`，而起不来时它返回数字 `8`：
> 解构得到 `undefined`，`await undefined` 通过，退出码被设成 0，
> **Launcher 会认为「worker 起来了」，而它什么都没做**。已改为判别式联合，
> 从类型上让这种写法不可能再出现。另三处：`heartbeatIntervalMs` 被接收却从未使用
> （缺心跳不会让任何用例失败，只会让长任务在租期后被**第二个 worker 重跑**——
> 对已调用过外部写的步骤就是重复副作用，已实现执行期心跳）、
> `isMainModule()` 只有自己的用例在用、`stop()` 里一个空 `if` 块。
> 心跳之所以不是「保活优化」而是「不重复执行」的前提，见 PRT-301 文档第 6 节。
>
> **一条实测出来的平台事实**：真实进程用例断言 `child.kill('SIGTERM')` → 状态写 `stopped` → 退出码 0，
> 实测得到 `{ code: null, signal: 'SIGTERM' }`——**信号处理器一次都没被调用**。
> Windows 上「终止」是无条件终止（Node 文档明确写了），因此：
> 优雅停止在 Windows 上可能一次都不执行，**释放 lease 不能依赖 worker 自己走完收尾**；
> 状态文件会停在最后一刻的值，于是「文件存在」与「worker 还活着」必须分开判定
> （新增 `isStatusFresh`：过期/缺时间戳/时间戳在未来一律报「不新鲜」——
> 宁可说「不确定」，也不要把可能已死的 worker 报成在跑，后者的代价是任务永远没人认领）。
> 用例按平台分支断言，并把这条结论写成注释：哪天 Windows 上真的出现了 `stopped`，
> 这条结论就需要重新验证，用例会立刻告诉我们。
>
> ⚠️ **未交付**：lease 的**落库**实现（`leaseEpoch` / team-hub 权威时间 / 过期 epoch 拒写，
> 属 PRT-302/313，目前只有语义与判定；心跳能发现「lease 可能已易主」，
> 但**还不能中断正在执行的 executor**——那需要把 `AbortSignal` 穿到 RuntimeAdapter）、
> attempt 仓储（PRT-303）、
> 从 `plugins/src/index.ts` 的提取（PRT-304~308）、重试队列与恢复扫描（PRT-309/310）、
> **worker 尚未接上 RuntimeAdapter**（`executor` 注入点就绪但生产路径传 `null`，
> 因此真实运行时它报 `no-executor` 且不认领——这是**如实上报**，不是缺陷）、
> **数据面路由 `/api/runtime/*` 不存在**（team-hub 侧未实现，
> 因此即使是配置完整的 worker 也还认领不到任务）、
> 状态文件尚未被 Launcher 消费（`readiness` 仍是 `kind: 'none'`，接线属 PRT-711）。
> 详见 `docs/superpowers/prt/PRT-301-run-state-machine.md`。
>
> 上一批（PRT-706 首次运行初始化 + 产品配置读取）：新增 `product/config.mjs`、
> `product/init.mjs` 与套件 `product-config`（**27 例**，全部跑真实文件系统的临时目录）；
> CLI 新增 `--init` / `--dry-run` / `--no-config`。59→**60** 套件、1617→**1651** 用例。
> 阶段 7 由 4 完成 → **6 完成**。
>
> 这一批针对的是同一类问题的两个面：**用户以为生效了、其实没有**。
> 配置面——文件里多一个逗号 / 键名拼错 / 类型写成 `"8787"`，整份配置被忽略、
> 所有值悄悄回到默认值；字符串端口尤其坏，它让端口比较**永远不成立**，
> 症状是「起不来」而真因是类型。因此原则是**能确定的问题一律报诊断，绝不静默退回默认值**：
> 一份坏配置比没有配置更危险——没有配置时用户知道自己在用默认值，
> 有一份坏配置时用户以为自己的设置生效了。
> 初始化面——从没建过目录时，各进程各自报「打不开数据库」，
> 或者更糟：把库建在安装目录里，升级时一起消失。
>
> 三条判断：
> **① BOM 不是洁癖。** `JSON.parse` 拒绝 `U+FEFF`，而 Windows 上
> `Set-Content -Encoding utf8`（以及记事本）保存的配置就带 BOM——
> 本批次开发中**真实触发过一次**：文件在用户眼里完全正常，产品说「不是合法 JSON」。
> **② dry-run 暴露了一个真实缺陷。** 「要不要写配置」原本用 `exists(dataDir)` 判定，
> 而 dry-run 不建目录，于是它安静地少报两个文件。判据已改成「这一步成没成」——
> 拿文件系统当代理时，任何不落盘的模式都会让报告失真；而首次运行向导
> 恰恰靠 dry-run 回答「点下去会发生什么」。
> **③ 不可逆动作要有拒绝边界。** 布局有 error 时**一个目录都不建**（部分初始化会伪装成
> 「装好了」）；不替用户创建工作区（那会让「工作区选错了」在很晚才暴露，那时已经写过东西了）；
> 不覆盖已有配置（用户在向导里填的东西会无声消失）。
> 顺带删掉一个**不可达**的分支：同一件事判两次就会有两个口径，两处不一致时两份都不可信。
>
> ⚠️ 上一批未交付（仍然成立）：首次运行**向导界面**（`--init --dry-run` 是它的地基）、
> 日志轮转与磁盘保护（`directorySize()` 已提供前置读数）、配置的原子写入。
> **`services-plugin` 仍未替换**——配置与初始化都接在**新** Launcher 上，接线属 PRT-252。
> 详见 `docs/superpowers/prt/PRT-706-config-init.md`。
>
> 上一批（阶段 7 Product Launcher：PRT-251 / 701~704）：新增 `product/launcher/`
> （`launcher.mjs` / `supervisor.mjs` / `readiness.mjs` / `ports.mjs` / `allowlist.mjs` /
> `cli.mjs`）与套件 `product-launcher`（**57 例**，含 **3 例真实进程**）。
> 交付物是**一个能如实报告自己起不来的启动器**：
> `node product/launcher/cli.mjs --check` 会报出真实入口缺口并返回 4。
> 58→**59** 套件、1559→**1617** 用例。
>
> 三条值得单独记住的判断：
> **① 端口能连 ≠ 就绪。** 就绪判据加了**身份断言**（`/api/config` 返回的 `port` 必须
> 等于本次启动的端口），而这条断言立刻抓到一条真实缺陷：workbench 的 hub 上游默认指
> 8787，于是它去代理了**别的** hub 实例，而 `/hub/api/config` 照样返回 200——
> 没有身份断言就会报「就绪」，而用户看到的界面数据来自另一个数据库。
> **② 子进程环境不继承宿主。** 改为白名单（`allowlist.mjs`），替代 `services-plugin` 的
> `{ ...process.env }` 打底；后者让白板与 workbench 也拿到了模型密钥，
> 而 spec §6.7 要求密钥只进需要它的进程。
> **③ 启动期崩溃必须熔断。** `supervisor.mjs` 按**存活时长**决定退避是否归零，
> 连续快速失败则进 `circuit-open` 停手；原实现没有熔断，会以 30s 周期永远重启。
>
> ⚠️ 上一批未交付（仍然成立）：**托盘/日志轮转/诊断包**（PRT-708~710）、
> **`incompatible`/`upgrading` 两态无判据来源**（需 PRT-801 版本清单）、
> 退避参数尚未配置文件化。`--include=` 是显式受限范围，
> 且受限范围的产品状态**永远不会是 `ready`**。
>
> 上一批（阶段 2.5 产品层契约）：**① PRT-258 前三份契约**——
> 新增 `product/`（`paths.mjs`、`process-manifest.mjs`、`index.mjs`、`index.d.mts`）
> 与套件 `product-runtime`（**29 例**）：五进程清单与启动波次、per-user 目录布局不变量、
> 配置优先级合并（带 provenance）、「普通配置文件不得含明文密钥」写入门禁。
> **② PRT-505 密钥库**——新增 `security/secrets/` 与套件 `secret-store`（**9 例**，
> 含 **1 例真实 DPAPI 往返**）：断言集中在两类**不会抛异常**的失败上——
> 元数据接口把值/密文带出去，以及受保护后端不可用时**退化**为明文。
> 56→**58** 套件、1521→**1559** 用例。
> **密钥库目前没有任何生产调用方**（接线点是 `PRT-501` 与 `PRT-254`）；
> `MANIFEST_KNOWN_GAPS` 把两处入口缺口写成机器可读事实，
> 并由用例与**真实仓库**对账——缺口补上时用例会**变红**。
> 详见 `docs/superpowers/prt/PRT-258-product-contracts.md`、
> `docs/superpowers/prt/PRT-505-secret-store.md`，以及
> **`docs/superpowers/prt/PRT-PROGRESS.md`（全 145 项任务的唯一进度入口）**。
>
> 上一批（阶段 2 完成标准 PRT-210/211）：新增 `dsh-parity`（**36 例**）与
> `dsh-session-boundary`（**20 例**）。54→**56** 套件、1465→**1521** 用例。
> 阶段 2 的完成标准原文是「同一任务通过两条路径得到等价任务状态、结构化结果和产物，
> 且敏感信息不出现在输出中」——这两套用例就是它的可执行形式。
>
> **① 对拍（PRT-210）**：旧调用在 `plugins/src/index.ts:2219`，而 Global Constraints
> 规定阶段 3 之前不碰该文件，因此 `parity.mjs` **复刻**旧语义而非调用它。
> **复刻会腐化，而失去意义的对拍会静默通过** —— 所以配了漂移检测，实测 `drifted = false`。
> 差异按四类分开（violations / intended / improvements / bounded）：把有意变更混进违规
> 会让对拍恒红、最后被人关掉；当作不存在则是自欺。实测 violations = **0**。
> `intended` 里最典型的一条：**旧路径不做 schema 校验**，只看 `structured === undefined`，
> 于是「模型返回字段名拼错的对象」会被当作**完成**写进交付物；新路径判 `INVALID_RESULT`
> 是 PRT-204 的交付内容。用例把旧路径这个行为**钉住**，防止有人"顺手修好"复刻件
> 而让对拍退化成「拿新路径和新路径比」。
>
> **② 边界（PRT-211）**：DSH 有整套 continuable session 能力（15 条签名，逐字抄自运行中
> 的 Inspect 注册表），但阶段 2 的适配器是**一次性**的。最危险的不是「没实现」而是
> **看起来实现了**：契约的可选能力表里有 `session-resume`，照抄 DSH 上报能力就会对外
> 宣称支持恢复，而 `recover()` 只会说「继续等同一个 run」——**那是等待，不是恢复**。
> 按这个宣称实现「崩溃后接着跑」会得到**重跑**（副作用翻倍）。判据对**真实**适配器运行，
> 不是合成的 capability 对象。
>
> **证据分级**（写进了代码，不只在文档里）：接口面 `api-surface-verified`；
> continuable session 的**运行时行为 `behavior-unverified`** —— 没跑过就是没跑过。
>
> ⚠️ **`dsh-boundary` 仍是 3 文件 / 26 处**，与本批次之前完全一致。`parity.mjs` 里出现的
> `ctx.subagents` 全是注释/报错文案/测试夹具里的**字符串**（模块 `import` 的执行面包为 **0**），
> 一度让棘轮涨到 5 文件/33 处并因豁免前缀而**判 PASS**。已改为三段拼接并加用例自证贡献为 0：
> 豁免一旦开始被消耗，就再没有信号能区分「适配器真多依赖了 DSH」与「有人写了句注释」。
> `scripts/ci/dsh-boundary-baseline.json` **未被改动**。
>
> 上一批（阶段 2 强制面 PRT-212~215）：新增 `dsh-enforcement`（**34 例**）与
> `dsh-composition`（**28 例**），落在 `runtime/dsh-composition/`。52→**54** 套件、
> 1403→**1465** 用例。那一批交付的是**声明 + 原语 + 自检**，补丁层**尚未落盘应用**——
> 因为 DSH 的 profile 层是 `patchReload: 'live'`，写入会**立刻改变正在运行的 harness
> 的强制面**（包括当前会话自己）。详见 `docs/PRT-212-evidence/verify-evidence.md` §2 与 §5。
>
> ⚠️ 跑全量基线需设 `$env:DSH_CHECKOUT`，否则 `plugins`（185 例）与 `board-plugin`（37 例）
> 两组外部宿主回归会 **SKIP**（不伪绿），套件数会少 2、用例数会少 222 —— 这是有意设计。
>
> PRT-009 的六项「待采集」已结清四项（token 用量 / 端到端耗时 / 旧路径实测状态序列 /
> 人工介入率），靠的是**读取一次已经发生的真实执行**（受控隔离空间 `gf001`，目标 `G-mtwxx7an-2`），
> 不是重新跑一次。证据见 `docs/PRT-005-evidence/verify-evidence.md` 与
> `docs/PRT-009-evidence/verify-evidence.md` §3。**费用与峰值资源仍未采集，且原因已不是
> 「需要真实执行」**——两项各有不同的阻塞原因，见上述证据文档 §4。

> 说明：上句之前基线为 **P4-6** 之后的全量运行（含 `doc` 阶段），证据 `.ci/final-main4/`；
> 彼时 `test` 为 **48 套件 / 1315 用例**。
> 此前各基线：P4-3 之后、P4-2 之后为 **981 用例**、
> P4-1 之后 `test` 阶段为 **39 套件 / 950 用例**，P3-4 收尾为 **38 套件 / 943 用例**（详见下方 §2 基线表）；
> 各轮证据见 `docs/P4-6-evidence/verify-evidence.md`、`docs/P4-5-evidence/verify-evidence.md` §3、
> `docs/P4-3-evidence/verify-evidence.md` §3、`docs/P4-2-evidence/verify-evidence.md` §3.5、
> `docs/P4-1-evidence/verify-evidence.md` §3。

> ✅ **基线可单命令复现**（2026-09-10）：`test` 阶段此前会因 `notify-hub-smoke` 泄漏 hub 子进程
> 而**永不结束**（零输出、永久等待），P2-7 / P2-8 / P3-1 / P3-2 之后新增或扩充的套件只能用「逐套件单跑」
> 拼基线。现已修掉根因并由全量运行验证，表中数字全部来自**同一次** `--only test` 运行。
> 同一轮把此前未覆盖的**并发启动缺陷**也补齐了：双进程同时启动时的启动期迁移竞态、以及
> **WAL 切换不受 `busy_timeout` 保护**——二者都会让后到进程在模块加载期崩溃（宿主侧表现为
> `/team-hub` 路由缺失直到重启）。详见 `docs/CI-TEST-STAGE-evidence/verify-evidence.md`、
> `docs/DUAL-WRITE-RACE-evidence/verify-evidence.md`。

---

## 1. 当前形态与拓扑

| 层 | 组件 | 默认地址 | 说明 |
| --- | --- | --- | --- |
| 指挥台 | `workbench/` | `http://127.0.0.1:5173` | 空间/编队、目标、任务中心（单一 Scrum 泳道 + 将军视角过滤）、3D 总览、调度验收、对话/文件/浏览器、规范/技能/日历/通知 |
| 数据面 | `team-hub/server.mjs`（v2） | `http://127.0.0.1:8787` | **唯一业务实现**：SQLite（`team-hub/team.db`）、HTTP API、任务状态机、审计与 SSE 事件流 |
| 宿主外壳 | `team-hub/src/index.ts` | 宿主 `:3080` 的 `/team-hub` | 仅做该前缀路由注册 + env 转接，业务全部委托 `server.mjs`；与 8787 **同库** |
| 看板面板 | `board-plugin/` | 宿主 `:3080` 的 `/scrum-board` | DSH 会话内 iframe 面板；配置 `hubUrl` 或探测同宿主 `/team-hub` 后走 v2（hub 模式），否则退回本地文件模式 |
| 执行面 | `plugins/` | DSH 宿主内 | 扫单、认领、派工、隔离 worktree、自动交接、合入调解、对话回复、经验召回 |
| 生命周期 | `services-plugin/` | DSH Desktop 内 | 随 Desktop 自启停 8787 / 5173；**`:4820` v1 看板已退役**（不再托管） |
| v1 兼容面 | `scrum/` | — | 保留 v1 协议引擎与 `serve.mjs`（供契约测试与本地自托管）；**任务库 `tasks.json` 已归档**，日常入口不再使用 |
| 独立应用 | `whiteboard/` | `http://127.0.0.1:8080` | 零第三方依赖的多人实时协作白板，不属 Legion 核心三件套 |

关键约定：

- **单一数据池**：宿主 `/team-hub` 与独立进程 8787 共用 `team-hub/team.db`（`team-hub/src/index.ts` 默认
  `dbPath=''` → server.mjs 默认库）。因此两者是**多进程写同一库**：`audit.seq` 等分配必须在写事务内读库
  取号（回归见 `scripts/ci/dual-write-smoke.test.mjs`，已入 CI）。
- **单一事件流**：写操作一律经 `audit()` 落库并广播 SSE；`/api/events` 带 `id:` 行（seq）与信封字段
  `{seq, event, id, payload}`，支持 `Last-Event-ID` 断线续传（契约见 `docs/CONTRACT-V1V2.md`）。
- **部署链**：`~/.dsh/profiles/web/node_modules/@dsh-external/*` **必须是 junction（指向本仓源码目录）**，
  否则宿主会加载陈旧复制副本而不生效：
  ```powershell
  Get-Item ~/.dsh/profiles/web/node_modules/@dsh-external/* | Select-Object Name, LinkType   # 应全为 Junction
  ```
- **v1 独有动作**：`/api/reject`、`/api/promote`（v1 worktree git 语义）在 v2 hub 模式下返回 **501 降级指引**，
  请改用 `transition` + `comment`（v2 分支合入由 worker 完成）。
- **插件配置面**：三个 DSH 插件（`plugins/` 守护、`board-plugin/` 看板、`services-plugin/` 托管）在宿主进程内运行，
  **主配置来自宿主 composition**（`~/.dsh/profiles/web/cordis.patch.yml` 的 `config:` 块）；它们从**进程环境**
  读取的少数项（提示词预算、hub token 回落）已纳入统一配置体系（P3-4，`docs/CONFIG.md` §3.4–3.6）。
  改这些环境变量后需**重启宿主**才生效。

## 2. 测试基线与复跑方式

全量门禁（单命令）：

```powershell
cd D:\project\DSH\legion
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'   # 宿主面测试需要 DSH checkout
node scripts/ci/run-ci.mjs --only test --out .ci\<run-name>
```

产物：`.ci/<run-name>/ci.log`（全量输出）、`summary.json`（阶段结论）、`suites/<套件>.log`（失败套件的原始输出）。

**当前基线：76 套件 / 1969 用例，`--only test` 整体 PASS** —— 2026-09-12 实测（设 `DSH_CHECKOUT`）
（PRT-501 模型档案：`model-store`（**20 例**，CAS + 墓碑 + 审计守卫）、
`model-routes`（**14 例**，真 HTTP，响应体与审计均无密钥）；
PRT-306 工作区隔离：`workspace`（**24 例**，跑真 git）、`workspace-wiring`（**9 例**，接线）；
PRT-305/308 岗位与流水线 + 交接：`prt-pipeline`（**16 例**，纯函数）、
`handoff-store`（**12 例**，事务语义）、`handoff-routes`（**8 例**，真 HTTP + 真 `createTask` 接线）；
PRT-307 机器验收：`acceptance`（**24 例**，纯函数）、`acceptance-store`（**16 例**）、
`acceptance-routes`（**10 例**，起真 HTTP 服务）；
PRT-312 真实进程被强杀：`run-kill-drill`（**2 例**，真 worker 进程 + 真 team-hub + `SIGKILL`）；
进度表自检 `prt-progress`（**12 例**）；PRT-314 多进程并发 `run-concurrency`（**5 例**）；
`run-policy`（**14 例**：PRT-309/310/311 的重试额度、退避、Dead Letter、人工处置、幂等键）。
`DSH_CHECKOUT` 未设时 `plugins/board-plugin` 按纪律 SKIP，计数为 74 通过 + 1 跳过 / 1747 用例。
上一批基线 74 套件 / 1934 用例（PRT-306 工作区隔离）。
再上一批基线 72 套件 / 1901 用例（PRT-305/308 岗位流水线与交接）。
再上一批基线 69 套件 / 1865 用例（PRT-307 机器验收）。
再上一批基线 66 套件 / 1815 用例（PRT-312 强杀演练 + 进度表自检）。
再上一批基线 65 套件 / 1803 用例（PRT-312 强杀演练）。
再上一批基线 63 套件 / 1801 用例（PRT-314 多进程并发 + 原子迁移原语）。
再上一批基线 62 套件 / 1796 用例（PRT-309/310/311 重试退避与 Dead Letter + 人工处置 + 幂等）。
再上一批基线 61 套件 / 1702 用例（PRT-301 运行状态机 + worker 入口）。
再上一批 60 套件 / 1651 用例（PRT-706 首次运行初始化 + 产品配置读取：新增 `product-config`（**27 例**：
`config.test.mjs` 16 + `init.test.mjs` 11，全部跑真实文件系统的临时目录）。
这一组问的是同一句话——**这件事有没有被报出来**：
坏 JSON、读不出来、类型写成 `"8787"`、键名拼错、明文密钥、UTF-8 BOM，
以及初始化会**建目录、写文件**这三件不可逆的事（不写安装目录 / 不替用户建工作区 /
不覆盖已有配置）。其中 BOM 那条是开发中真实触发过的：文件在用户眼里完全正常，
`JSON.parse` 说「不是合法 JSON」。另一条 dry-run 缺陷是判据拿文件系统当代理所致——
用 `exists(dataDir)` 判断「要不要写配置」，而 dry-run 不建目录，于是安静地少报两个文件。
前一批（阶段 7 Product Launcher：新增 `product-launcher`（**57 例**：PRT-251 / 701~704，含
**3 例真实进程**——真 team-hub + 真 workbench，临时端口 + 临时 DataDir）。
这一组的核心断言分三层：
**① 就绪判据**——「端口能连」不是就绪，`/api/config` 返回的 `port` 必须等于本次启动的端口；
身份不符要**只探一次就立刻失败**，因为「重试」这个动作本身在暗示它会变好。
这两条断言各自抓到一条真实缺陷（workbench 代理了别的 hub；期望值被字符串化后与 number
严格比较永远不成立，把类型问题伪装成安全问题）。
**② 子进程环境不继承宿主**——白名单（`allowlist.mjs`）替代 `{ ...process.env }` 打底，
并有断言钉住「哪些进程拿得到凭证键」。
**③ 退避按存活时长重置 + 连续快速失败熔断**——原实现没有熔断，
启动期崩溃的进程会以 30s 周期永远重启，症状是最像「什么都没发生」的那种故障。
59→**60** 套件、1617→**1651** 用例）
前一批（阶段 2.5 产品层契约：新增 `product-runtime`（**29 例**：PRT-258 前三份契约）与
`secret-store`（**9 例**：PRT-505 密钥库 = 第四份契约，含真实 DPAPI 往返）。
前者的核心断言是**启动之前就能判定的事实**——依赖顺序、端口唯一、入口存在性、
目录不变量与配置优先级。其中「入口不存在」这一类还被做成与真实仓库的**对账**：
缺口补上时用例变红，逼文档与清单一起更新。
后者的核心断言是**六条出口各自脱敏**与**不退化**——元数据接口带出密文、
明文后端被当成真实密钥库，这两件事都不会报错，只会让「密钥受保护」这句话变成空话。
56→**58** 套件、1521→**1559** 用例）
`product/` 与 `security/` 均属 `mustBeZeroPrefixes`，本批次对执行面依赖为 **0 处**。
上一批（阶段 2 完成标准：新增 `dsh-parity`（**36 例**：PRT-210）与 `dsh-session-boundary`（**20 例**：PRT-211）。
对拍的核心不是「逐字节相同」而是**四类差异分开归因**——旧调用是复刻件，
复刻会腐化，而**失去意义的对拍会静默通过**，故漂移检测本身就是一条受测的判据。
边界的核心不是「没实现续接」而是**没有假装实现了**：`session-resume` 是可选能力，
照抄 DSH 上报能力就会宣称支持恢复，而 `recover()` 只是「继续等」——按这个宣称实现
「崩溃后接着跑」会得到**重跑**（副作用翻倍）。判据对真实适配器运行。
`dsh-boundary` 仍是 **3 文件 / 26 处**（本批次三个新文件贡献 **0**）。
54→**56** 套件、1465→**1521** 用例）。
上一批（阶段 2 强制面：新增 `dsh-enforcement`（**34 例**：PRT-212）与 `dsh-composition`（**28 例**：PRT-213~215）。
这一组的核心断言**几乎全是「不生效」**——因为强制面最危险的失效方式是
**看起来生效了**：组合行挂上了但没激活、`permission` 行在但 preset 表没被覆盖、
沙箱返回 `partial`（有未被管制的路径）、`confine` 原样返回输入 argv（没做任何包装）、
`denialSignatures` 为空（沙箱拒绝退化成普通失败）。五种都在返回值里长得像成功。
52→**54** 套件、1403→**1465** 用例。
`runtime/dsh-composition/` 对 DSH 的依赖为 **0 处**。
⚠️ 那一组交付的是**声明 + 原语 + 自检**；补丁层**尚未落盘应用**，
因此那些原语目前只被自己的用例驱动、**还没有生产调用方**，详见 `docs/PRT-212-evidence/verify-evidence.md` §2 与 §5）。
上一批收口：新增 `prt-usage`（**14 例**：PRT-009 会话用量提取——DSH 会话转录是
**多帧拼接 zstd**，整段一次性解压只得到第一帧（会话头），工具会「成功」报出 0 token；
用例把逐帧解码与 token 口径钉死）与 `prt-measure`（**8 例**：单价缺失时费用必须是 `null`
而不是 `0`——`0` 会让预算检查静默失效；以及「待采集清单必须随证据结清」）。
同时扩了三套既有套件：`prt-golden-flow` 18→**20**、`prt-old-path` 25→**30**、`prt-gf001` 23→**30**。
50→**52** 套件、~1385→**1403** 用例。
⚠️ 跑此基线必须设 `DSH_CHECKOUT`，否则 `plugins`（185）与 `board-plugin`（37）会 SKIP。
上一批收口：新增 `dsh-adapter`（**85 例**：PRT-201~209 的 DSH 适配器）。
全部用假宿主端口，覆盖真实 DSH 无法稳定复现的故障——`run.result` 永不结算、
abort 无效、畸形结构化输出、事件流中断。47→**48** 套件、1230→**1315** 用例。
该适配器**不 import 任何引擎包**（与 DSH 的耦合只在 `port.mjs` 的注入面），
因此 `dsh-boundary` 里适配层贡献为 **0 处**——是真正零耦合，不是靠
`adapterPrefixes` 豁免成 0。
上一批收口：新增 `prt-churn`（**13 例**：阶段 3 评审闸门的热点文件改动节奏探针，
含一条锁定「正确写法 vs 错误写法」差异的用例——`git log -n 40 -- <file>` 会先按
路径过滤再截断、恒返回 40，把「该开工」读成「不能开工」）；46→**47** 套件、
1217→**1230** 用例。
上一批 PRT-006：新增 `prt-backup`（**14 例**：三条备份路线 / 陈旧 WAL 危害 / 活写竞态 /
源库只读）；45→**46** 套件、1203→**1217** 用例。
上一批 PRT-001/003：新增 `prt-topology`（**20 例**：复用既有扫描器对账 / 越界写入判定 / 密钥聚合 /
数据产物分类 / diff 定位）；PRT-008/010：新增 `prt-composition`（**22 例**：patch 解析 /
失败要响 / 快照卫生 / 组合对账 / diff）；43→**45** 套件、1161→**1203** 用例（+42 = 20+22）。
再上一批 PRT-101~107 新增 `runtime-contract`（**62 例**）；PRT-004/007 新增 `prt-baseline`（**16 例**）
与 `prt-golden-flow`（**14 例**）；40→43 套件、1069→1161 用例。
本轮 PRT-002/PRT-108 交付 `dsh-boundary.test.mjs` **22 例**（记号识别 / 反误报 / 判定语义 / 棘轮真实性），
39→40 套件、1047→1069 用例，并让 `run-ci.mjs` 新增 **`boundary` 阶段**（紧随 `env`，纯静态秒级门禁）。
上一基线为 P4-6 之后的 `39 套件 / 1047 用例`（`.ci/final-main4/`））
（P4-6 之后：`dir-lock.test.mjs` 新增 **12 例**（7 纯函数 + 4 注册表联动 + 1 真实双进程），白板 199→**211**；
P4-5 之后：`audit-archive.test.mjs` 新增 **14 例**（10 纯函数 + 4 真实进程：重启/写入量量级），白板 185→**199**；
P4-4 之后：`static-serve` 6→**16 例**（新增导航/资源判定与缺失资源 404 契约）；
P4-3 之后：`e2e-browser` 7→**10 例**（新增连接未就绪窗口/切房间补发/单连接三条用例）、`whiteboard` 158→**185 例**
（新增 `pendingOps.test.mjs` 19 例队列/补发单测 + `notice.test.mjs` 8 例提示优先级单测）；
P4-3 与 P4-4 的全量门禁读数见 `docs/P4-3-evidence/verify-evidence.md` §3、`docs/P4-4-evidence/verify-evidence.md` §3；
P4-2 之后：`p13-host-injection` 9→14 例（含 5 例真实宿主负向诊断），并新增同组纯函数文件
`host-diagnostics.test.mjs` **25 例** → 该套件组 39 例；
P4-1 之后：新增 `e2e-browser` 真实浏览器 DOM 端到端 **7 例**；P3-4 之后：`plugins` 177→185、
`config` 28→36、`p13-host-injection` 7→8。
此前 `test` 阶段会因 `notify-hub-smoke` 泄漏子进程而**永不结束**，故长期只能用「逐套件单跑」拼出基线；
根因、修复与两处连带回归见 `docs/CI-TEST-STAGE-evidence/verify-evidence.md`）。
> `e2e-browser` 需要本机 Edge/Chrome：**找不到浏览器时整组 SKIP**（打印探测路径，不失败也不伪绿），
> 因此无浏览器的机器上它是「没跑」而不是「通过」。手册见 `docs/E2E.md`。

| 套件 | 用例 | 套件 | 用例 |
| --- | --- | --- | --- |
| chat | 42 | contracts | 56 |
| skills | 20 | v1v2-contract | 17 |
| permissions（F-02 权限内核与审批，3 文件） | 7 | team-hub-parity | 1 |
| calendar（P2-5 含重复展开/更新/冲突/关联） | 29 | dedupe | 9 |
| spaces | 5 | calendar-ui（P2-5 前端纯函数） | 12 |
| pipeline（SP-P0 空间流水线数据面） | 19 | chat-ui（P2-6 对话前端纯函数） | 8 |
| goal | 14 | notify（P2-4 含真实 hub SSE 断线重连） | 15 |
| rules | 7 | hub-event-stream（F-01 scope/游标/信封） | 5 |
| artifact | 16 | dual-write（P1-1 双进程写同库竞态 + 迁移竞态） | 4 |
| security | 6 | p13-host-injection（P1-3 真实宿主注入 + P3-4 配置摘要 + P4-2 导入失败诊断，2 文件） | 39 |
| read-auth（鉴权矩阵 + 回环开放，2 文件） | 14 | whiteboard（含 P3-1 治理端到端、P4-3 待发队列/提示优先级单测、P4-5 审计归档跨重启、P4-6 单实例目录锁与前端静态契约，18 文件） | 211 |
| files-api | 41 | plugins（含 P2-6 chat-context、SP-P0 space-pipeline、P3-4 配置） | 185 |
| files-p27 / files-ui（P2-7） | 36 / 19 | web-p28 / browser-ui（P2-8） | 21 / 21 |
| web | 24 | static-serve（静态托管 404/SPA 回退/穿越 + P4-4 导航与资源判定） | 16 |
| doc-render | 11 | board-plugin | 37 |
| skill-importer | 4 | scrum | 25 |
| hub-board / artifact-policy | 1 / 3 | config（P3-2 统一配置 + P3-4 插件族） | 36 |
| web-history（P2-8 抓取历史） | 1 | e2e-browser（P4-1 真实浏览器 DOM 端到端 + P4-3 重连补发，10 例） | 10 |

（上表**全部**为 `--only test` 单次全量运行的实测值；不再存在「未入全量基线」的套件。）

其他阶段：`--only doc`（文档新鲜度 + 历史 evidence banner 覆盖）、`--only boundary`（PRT-108 DSH 执行面边界棘轮，秒级）、`--only build|smoke|env|deps|stage`。
部署与回滚：`docs/DEPLOY.md`。现场（真实宿主）验收脚本：`scripts/live/p11-step2-verify.mjs`。

## 3. 文档地图（按可信度分层）

| 层级 | 文档 | 用途 |
| --- | --- | --- |
| **当前状态（权威）** | 本文件 `docs/STATUS.md` | 形态/拓扑/测试基线/约定；状态变化先改这里 |
| | `README.md` | 产品总览与快速上手 |
| | `docs/FEATURES.md` | 功能操作手册 |
| | `docs/DEPLOY.md` | 部署、验证、回滚 |
| | `docs/CONFIG.md` | 统一配置参考（优先级、三进程字段清单、校验命令、脱敏规则、已知边界） |
| | `docs/E2E.md` | 浏览器端到端手册（CDP 基座用法、写用例纪律、覆盖范围与未覆盖项） |
| | `docs/REMAINING-TASKS.md` | 未完成事项与优先级 |
| | `.ci/<run>/summary.json` + `ci.log` | 最近一次机器证据 |
| **契约（权威）** | `docs/CONTRACT-V1V2.md` | v1/v2 语义统一表（状态机、分页、SSE 信封） |
| | `runtime/contracts/`（`index.mjs` + `index.d.mts`） | **PRT Runtime Contract**：`RuntimeAdapter` 七方法、16 个标准错误码与重试分类、`RunRequest`/`RunEvent`（13 种）/终态契约、能力协商。**对 DSH 依赖为零**（`--only boundary` 强制）。用 `node --test runtime/contracts/*.test.mjs` 跑 |
| | `docs/REQUIREMENTS.md`、`docs/ORCHESTRATION-V3.md` | 需求与编排设计 |
| **迁移基线（可 diff）** | `docs/superpowers/prt/prt-007-baseline.json` | PRT-007 旧系统平台契约基线：85 路由 / 22 表 / 7 任务状态 / 20 迁移边。`node scripts/prt/baseline-snapshot.mjs --diff` 查漂移 |
| | `docs/superpowers/prt/prt-009-baseline.json` | PRT-009 成本/延迟/资源基线。**「已由 GF-001 真实执行采集」段的数值不在本文件里**，而是运行期从证据文件读出（抄一份进来就多一处会与源漂移的副本）。`node scripts/prt/baseline-measure.mjs --pending` 看六项各自结清状态 |
| | `docs/superpowers/prt/PRT-004-golden-flow.md` | 黄金流程 GF-001 定义（固定夹具哈希 `9d4d958c…`、3 段岗位交接、**五项**机器可判定验收）。§5 记录**对拍基准被实测修正**：字面预期序列只被 4/76 个任务走过，现行基准是「模态序列 + 可接受集合 + 已登记旁路」 |
| | `docs/superpowers/prt/prt-009-gf001-execution.json` | **GF-001 真实执行证据**（`node scripts/prt/gf001-run.mjs report --out=…`）：独立重算的验收结果、逐岗位 token 用量、端到端耗时，以及**模型分工未生效**的对拍偏差（声明 `pro`、实跑 `flash`） |
| | `docs/superpowers/prt/prt-009-execution-evidence.json` | 生产空间 `software` 的旧路径执行证据：状态序列 / 耗时分布 / 人工介入 / **可用性空窗**。数值全部来自 `audit` 表只读提取 |
| | `docs/superpowers/prt/prt-009-gf001-controlled-evidence.json` | 受控空间 `gf001` 的同一组指标（**旧路径**，含两次中止轮次），与上一行**不可互相冒充**——两者是不同总体 |
| | `docs/superpowers/prt/PRT-001-topology-inventory.md`、`prt-001-003-inventory.json` | PRT-001/003 拓扑与配置密钥清单。**4 个 path 字段默认落在安装目录内**（越界写入，PRT-505/257 输入）；仓库内明文凭证 0 处 |
| | `docs/superpowers/prt/PRT-010-dsh-composition-baseline.md`、`prt-010-composition-baseline.json` | PRT-008 术语冻结 + PRT-010 组合分层基线：`dsh-base` → `dsh-web-app` → 用户层，Legion 6 行 / 4 个 `file:` 依赖。`--diff` 无需 DSH_HOME |
| | `docs/superpowers/prt/PRT-011-dsh-distribution-decision.md` | PRT-011 分发形态**已裁决：路线 C**（依赖 `@deepseek-ai/dsh` npm 包 + Launcher 装进 DataDir）；DSH 已是 MIT npm 包，当前部署是 244 个 junction 的开发布局，checkout ≈ 1845 MB |
| | `docs/PRT-006-evidence/backup-restore-evidence.md` | PRT-006 备份/恢复验证：只复制 `.db` **静默丢 253 条 audit**；陈旧 `-wal` 混用**被重放且 integrity_check 仍 ok**。恢复步骤与发布检查单已回写 `docs/DEPLOY.md` §6.1 |
| | `docs/PRT-005-evidence/verify-evidence.md` | PRT-005 旧路径执行状态证据：状态序列（**含「声明的状态机不是被强制执行的状态机」——`advanceTask` 绕过 `TRANSITIONS` 且不需将军**）、耗时、人工介入、**可用性空窗**（旧路径没有独立守护：两个独立空间同时断流 1.98h，无任何外部告警） |
| | `docs/PRT-009-evidence/verify-evidence.md` | PRT-009 成本/延迟/资源基线证据：逐项口径、结清状态、费用模型（**单价缺失返回 `null` 而非 `0`**）与未覆盖项 |
| | `runtime/dsh-composition/` | **阶段 2 强制面**（PRT-212~215）：补丁层声明（`patch-layer.mjs` + 生成物 `legion-host.patch.yml`）、三个强制点原语与 canonical operation 哈希（`enforcement.mjs`）、沙箱实际管制探测与启动自检（`selfcheck.mjs`）。**不 import 任何 DSH 包**——对 DSH 依赖 0 处，棘轮豁免存在但未使用 |
| | `docs/PRT-212-evidence/verify-evidence.md` | 强制面证据：从**运行中** harness 实测读到的强制点（含 `ConfinedArgv.enforcement: full\|partial` 这条判据的落点）、四类「看起来生效了」的隐蔽失效、以及**刻意未落盘**的理由（profile 层 `patchReload: live`，写入会立刻改变当前进程的强制面） |
| | `runtime/adapters/dsh/parity.mjs` | **阶段 2 完成标准**（PRT-210）：旧调用语义复刻 + 漂移检测 + 四类差异归因（violations/intended/improvements/bounded）。不 import 任何引擎包 |
| | `runtime/adapters/dsh/session-boundary.mjs` | PRT-211 continuable session 边界：15 条真实签名（运行中注册表）、五面归属划分、`session-resume` 未兑现能力的拦截判据、`resume-same-run` **是等待不是恢复**的归类。含 `EVIDENCE_LEVEL` 证据分级 |
| | `docs/PRT-210-evidence/verify-evidence.md` | 阶段 2 完成标准证据：对拍的四类归因与漂移检测实测、continuable session 的接口面结论与**行为未验证**的显式声明、以及棘轮假阳性的处置 |
| **设计规格** | `docs/superpowers/specs/2026-09-11-legion-product-runtime-design.md` | Product Runtime 设计（17 节 + **附录 A 阶段 0～1 已落地指针**）。附录只回填落地位置，不改设计 |
| **计划与闸门** | `docs/superpowers/plans/2026-09-11-prt-phase0-1.md` | 阶段 0～1 计划与逐任务结论。含**阶段 3 评审闸门**：热点文件最近 40 个提交仅触及 1/2 次（历史峰值 9/7）→ 已降温 |
| **历史快照（非当前依据）** | `docs/**-evidence/**`、`docs/G-*/**` | 各任务/目标的当时验证记录，顶部均有 `⚠️ 历史快照` banner（含生成日期与基线 commit）；含 `docs/PRT-005-evidence/`、`docs/PRT-009-evidence/`、`docs/PRT-210-evidence/`、`docs/PRT-212-evidence/` |
| **历史交付文档** | `docs/TEST_REPORT.md`、`docs/TEST_CASES.md`、`docs/TASK_BREAKDOWN.md`、`docs/RESEARCH.md`、`docs/P0-CONFIRMATION.md` 等 | 立项期交付物，测试数字以本文件 §2 为准 |
| **运维叙事（过程）** | `docs/P1-LIVE-ROLLOUT.md`、`docs/P2-GOALDOCS-LIVE.md`、`docs/P3-PROD-ROLLOUT.md`、`docs/P1-1-DECISION.md`、`docs/P1-1-step2-runbook.md` | 当时决策与现场步骤；结论已并入本文件 |

## 4. 已知限制（诚实登记）

1. Workbench 部分面板为功能基础版（通知分类/批量已读、日历冲突检测、文件批量与续传、
   对话真实模型通道 E2E 等仍在 `docs/REMAINING-TASKS.md` 待办；浏览器助手的缓存/正文提取/截图已按 P2-8 增强）。
2. 白板为**单实例多房间**模型（P3-1 已落地房间隔离/权限/限流/指标审计）；
   **不承诺横向扩展**，多实例共享存储未实现（ADR-0008 记录了被否理由与转 v2 触发条件）。
   **P4-6 已把该约束从注释升级为可执行守卫**：房间目录独占锁 `.whiteboard.lock`，
   第二个实例指向同一目录**启动即失败**并给出处置建议（实测旧行为是**静默数据分裂**：
   两边视图分别停在 2 与 3 而真值 4，两侧日志无任何错误）；陈旧锁可自动接管，不会把服务锁死。
   锁是**建议性**的（只防误操作），且不覆盖审计目录；验证见 `docs/P4-6-evidence/verify-evidence.md`。
3. 配置面已统一（P3-2 + P3-4）：**6 个配置面**共用统一配置引擎
   （`packages/shared/src/config.mjs`，优先级 **CLI > env > 默认值**）——三个活跃进程
   （team-hub / workbench / whiteboard）与三个 DSH 插件族（plugins / board-plugin / services-plugin），
   共 64 个已声明字段；启动打印**脱敏**摘要；`node scripts/config/check.mjs` 提供校验、12 条跨进程
   一致性规则与进程内 schema 规则（含「services-plugin 会覆盖子进程端口」这类只有把两边摆在一起才看得出的结论），
   CI env 阶段跑 scan/sync/check 三项自检。**已知边界**：插件的主配置面仍是宿主 composition
   （`cordis.patch.yml` 的 `config:` 块，`check.mjs` 看不到）；`board-plugin` / `services-plugin` 只做声明与
   校验、未改运行时；配置**不支持热更新**（启动时解析一次，改 env 需重启宿主）；`check.mjs` 只做配置面一致性、
   **不发网络请求**；白板因 Docker 构建上下文隔离而使用根引擎的**同步副本**（逐字节校验）。
   插件族的非法值走「大声降级」（回退默认 + 打印错误行），不退出宿主。详见 `docs/CONFIG.md`。
4. board-plugin 的 hub 动态面板为轻量自渲染（覆盖看板主操作），未复刻旧静态页全部视觉细节；
   无 hub 时退回本地文件模式，此时不渲染 v1 静态产物。
5. 通知中心（P2-4）已具备分类/优先级/批量已读/统一跳转/断线补齐；**已读状态仅存本机
   localStorage**（跨浏览器与跨标签页不同步，服务端已读持久化未做——按 R-15 v1 取舍）。
   Node 侧 SSE 回归用的是最小 EventSource 实现（不覆盖浏览器全部行为：无 `retry:` 指令、
   无超时关闭），浏览器行为以现场为准。
6. 生产宿主 `/team-hub` 与 8787 双进程写同库：已通过事务内取号保证一致性，但两进程的
   `audit` 广播各自独立（事件流不跨进程合并）；消费方以 SSE 连接的那个实例为准。
7. 日程日历（P2-5）：**时间为字面本地时间，不做时区换算**（跨时区协作需人工换算）；
   重复仅支持简单规则（日/周/月 + 间隔 + 结束条件 + 例外日），不支持「单次修改」与按星期几的复杂规则；
   冲突检测只提示不阻断；单窗展开上限 400 实例（超出抛错，不静默截断）。
8. 对话中心（P2-6）：`/api/events` 带 `Last-Event-ID` 时只回放增量，**不带**该头时只回放最近 30 条
   （有界）→ 断线恢复倚赖「SSE 重连回调 + 本地 seq 水位缺口判据」两层叠加，仅靠服务端续传不保证完整；
   标签页被挂起（定时器冻结）时补齐延后到唤醒；UI 验证为判定层（DOM 文案无自动断言）；
   附件内容按 UTF-8 文本注入，二进制附件未支持。
9. 文件中心（P2-7）：批量下载**逐个触发不打包 zip**；分片上传为**顺序**语义（offset 必须等于服务端已收字节），
   不做并发分片与逐片哈希（仅校总长度）；搜索只匹配**文件名**（不检索内容）；「移动到」目标目录须已存在；
   git 面板**只读**（无 stage/commit/checkout，`ahead/behind` 依赖本地 upstream 引用，无 upstream 时为 null）；
   `.dsh-uploads` 上传会话**无自动 TTL 回收**（完成/中止会清理，进程被强杀可能残留，需管理端按需清理）；
   前端验证为判定层（`workbench/scripts/files-ui.test.mjs` 19 例，不引入 jsdom/react 渲染断言）。
10. 浏览器助手（P2-8）：抓取**缓存与配额计数都在进程内**（重启清零，非持久账目；缓存 TTL 默认 5 分钟）；
    截图**不自带浏览器**（探测本机 Edge/Chrome，未装则不可用；`DSH_WEB_SHOT_ENABLE=1` 才启用，默认关闭；
    无等待元素/交互脚本，自动化测试仅用假浏览器脚本验证服务端路径，**未在 CI 产出真实 PNG**）；
    正文抽取为**启发式**（样板词表 + 容器打分，无 DOM 语义理解，强 JS 渲染页仍只能报 `empty_content`）；
    空间抓取历史按空间**上限 200 条**裁剪（超出丢最旧，无分页游标），且依赖 team-hub v2 运行（否则界面明确报不可用）；
    限流默认值可用 `DSH_WEB_QUOTA_*` 调整，为**单进程**语义（无分布式限流）。
    前端验证为判定层（`workbench/scripts/browser-ui.test.mjs` 21 例）。
11. 白板治理（P3-1；**审计留存已由 P4-5 补齐**）：`/metrics` 的**运行计数器**仍为进程内（重启归零，这是刻意设计）；
    审计 JSONL 按大小轮转保留 3 份。P4-5 起**审计归档可读、可跨重启回溯**：
    `GET /api/rooms/<id>/audit?source=process|archive|all`（默认 `process` 保持 P3-1 语义不变），
    每条记录带跨重启单调递增的 `auditSeq`（启动时从归档尾部播种），响应永远附 `retention`
    （文件数/字节/**最早与最新时间**/跨重启轮转次数/`historyTruncated`），`/metrics` 同样暴露 `audit.retention`；
    进程内为空而磁盘有历史时会给出指向 `source=archive` 的 `hint`。同时补上两处**声明了却从未写入**的审计类型
    （`ops`、`presence`）——此前审计只记「谁来了/谁被拒」，恰恰缺「谁画了什么」，归档也不完整。
    验证见 `docs/P4-5-evidence/verify-evidence.md`（含真实进程**真重启**后查回历史的端到端读数）。
    **已知边界**：仍无**长期**归档（保留 3 份即滚出，`historyTruncated` 只报事实不做归档扩张）；
    `archive` 查询返回的是**最近的** N 条并标 `truncated`（不是全档精确总数）；轮转以单文件字节为界，
    **不按时间/天数**保留；append-only JSONL 中若半行后又被追加完整行会被拼成一行（记入 `malformed`，不可恢复）。
    角色只有 `rw`/`ro` 两档（无按元素/区域的细粒度权限，无操作级回放）；
    单 IP 连接上限为**粗粒度**防滥用且**不信任** `X-Forwarded-For`（反代 + 大量同出口用户的部署需在边界
    做真实客户端识别，否则同一出口会共享该额度）；房间空闲关闭依赖 tick 心跳；
    房间与单房间连接上限默认 50、全局 200（对齐 soak 承诺，`WB_*` 可调）；
    **多实例共享存储未实现**（ADR-0008 记录了被否理由与转 v2 触发条件）；
    **单实例约束已由目录锁强制**（P4-6，`dir-lock.test.mjs` 12 例：含真实双进程拒绝与陈旧锁接管）；
    前端房间/角色逻辑为判定层测试（`whiteboard/packages/shared/test/room.test.mjs` 12 例）+
    前端静态契约（`whiteboard/apps/web/test/ui-contract.test.mjs` 6 例：DOM id 与共享模块接线、
    CSS 类与只读态类名一致），**并有真实浏览器 DOM 端到端**（P4-1：`tests/browser/whiteboard-ui.e2e.test.mjs`
    7 例——进入房间的标签/标题/角色同步、真实绘制落库 + canvas 像素、只读态 UI 降级与零写入、
    切房间与 URL/token 语义、非法房间号提示、主路径无页面异常、限流提示）；
    真实文件型房间路径由临时生产路径脚本验证（18/18，未入库）。
    浏览器 E2E 的**覆盖边界**见 `docs/E2E.md` §6（workbench / board-plugin 前端、视觉回归、
    多浏览器矩阵、网络故障注入仍无自动化）；候选 #10「重连窗口内的绘制被静默丢弃」已于同日修复（P4-3）。
12. 静态托管（**P4-4 已修**）：`workbench/scripts/serve.mjs` 在产物缺失时返回 404 + 指引（不再断流），
    并且**按扩展名区分导航与静态资源**：只有导航请求（无扩展名 / `.html` / `Accept: text/html`）才回退
    SPA 入口，缺失的 `/assets/*.js`、`/data/*.json`、`/favicon.ico` 等现在回 **404 + 可读 JSON 体**
    （旧行为是 200 + 整页 HTML，前端只会看到「JSON 解析失败」/「MIME 类型不对」）。
    验证与边界见 `docs/P4-4-evidence/verify-evidence.md`（含真实浏览器 A/B 读数）。
    **已知边界**：浏览器加载缺失**模块脚本**时控制台仍报 MIME 类错误（404 体是 JSON，非 JS）——
    可诊断性来自诚实的 404 状态码；未覆盖 `HEAD`/`Range`/条件请求；
    `serve.mjs` 静态分支仍不分方法（与改动前一致）。静态根可用 `DSH_WORKBENCH_ROOT` 覆盖（测试用）。
13. 宿主插件诊断（P4-2）：`p13` 夹具现在把「插件条目导入失败」翻成点名到条目的结论
    （启动前预检 + 日志解析 + 路由 404 归因，见 `docs/P4-2-evidence/verify-evidence.md`），
    **已知边界**：① 只覆盖本地包行（`@dsh-external/*` 与 `file://`），裸包名行不判入口存在性（避免假阳性）；
    ② `pending`（服务无人提供）的日志形状取自 harness 源码、**未在真实宿主复现**；
    ③ 解析依赖 DSH `app-boot`/loader 的**文案**（`failed to import|apply loader entry <id> (<specifier>)`），
    harness 改文案会让模式失效——缓解是「健康宿主零误报」对照 + 匹配不到时如实报「未能识别」；
    ④ 诊断改善的是失败**可读性**，CI 的失败聚合方式不变。
14. 白板断线窗口补发（P4-3）：连接未就绪时的绘制现在**入队 + 提示 + 重连后补发**
    （`whiteboard/packages/shared/src/pendingOps.mjs`，见 `docs/P4-3-evidence/verify-evidence.md`），
    **已知边界**：① 入队 op 沿用原 stamp，并发修改按 LWW 取舍（操作送达了，冲突值可能保留对端）；
    ② 队列有界 **500** op，极端离线仍丢**最旧**（提示里报出丢弃条数）；
    ③ 「已写进 socket、未到服务端」的在途 op 仍会丢——需要 ack/重传协议才能解决，本轮不做；
    ④ 真实网络故障（TCP 半开）下前端拿不到 `onclose`，该场景未验证（E2E 用「真实关闭连接」制造窗口）；
    ⑤ 补发**只把真正写进 socket 的部分**算发出去（`sendInChunks`），未发出的回队重试（§2.8）；
    ⑥ 切房间不再连出第二个 socket（`connect()` 的陈旧连接守卫，§2.9）——旧行为是「3 个 socket、2 个同时 OPEN」；
    ⑦ 提示条按**优先级**占用（治理类 > 连接状态类，见 `whiteboard/packages/shared/src/notice.mjs`）：
    高优先级提示在场时，「已补发」这类过程信息不显示（信息被**延迟**，不是丢失）——
    该规则来自本轮自造的一次回归（队列提示顶掉了「操作过于频繁」，被既有 e2e 限流用例抓到）。

## 5. 维护约定

- **状态变化**（拓扑、端口、数据池、测试基线、已知限制）→ 更新本文件，并同步 `README.md` 的必要部分。
- **新增 evidence**：在 `docs/` 下建立 `*-evidence/` 目录后运行
  `node scripts/ci/evidence-banner.mjs` 补 banner（幂等）；CI `doc` 阶段会校验覆盖完整性
  （`node scripts/ci/evidence-banner.mjs --check`，由 `check-docs.mjs` 统一驱动）。
- **不要**把历史快照的结论回填进本文件；本文件只写当前可复现的事实与命令。
