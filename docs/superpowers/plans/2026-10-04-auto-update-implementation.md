# 自动更新实施记录

> 日期：2026-10-04
> 分支：`feat/desktop-auto-update`（工作区 `.legion-worktrees/auto-update`，基于 `main` @ `a8ff20de`）
> 依据：[自动更新设计](../specs/2026-10-02-legion-desktop-auto-update-design.md)、[更新文件托管部署计划](2026-10-04-update-host-bootstrap.md)

## 1. 这份记录回答什么

设计文档 §11 有一句要求，它是这份记录存在的理由：

> 「实施前必须确认现有升级编排是否提供真实的跨进程事务、写入屏障、一致备份及
> 可替换 Windows 版本目录；缺失部分按本文件补齐，**不能仅接一个"检查更新"
> 按钮后宣称完成**。」

所以下面按设计的四个实施阶段（§10）逐条记录：做了什么、证据在哪、
**哪些还没有做**。

## 2. 阶段 A：协议 schema、签名固定向量、发布产物闭包、静态托管与回读脚本

| 设计条目 | 落点 | 证据 |
| --- | --- | --- |
| §5 签名 envelope、固定前缀、keyId 信任表 | `product/update/envelope.mjs` | `ENVELOPE_CHECKED`（9 条拒绝用例） |
| §5 拒绝重复键 / 非法数字 / 超大输入 / schema | `product/update/canonical.mjs` | `CANONICAL_CHECKED`（4 组固定向量 + 10 条拒绝 + 原型污染） |
| §5 跨发布端/客户端的固定向量 | `CANONICAL_VECTORS` | 向量的 `canonical` 是**字面量**，不是算出来的 |
| §5 公钥轮换（先预置新公钥） | `signTrustUpdate` / `applyTrustUpdate` | 自检覆盖 sequence 回退与吊销 |
| §5 有效期、时钟异常 | `checkValidityWindow` | 过期与"本机时间偏差"分开报码 |
| §6 修正预发布段的字典序 | `product/update/semver.mjs` | `precedenceDifferences()` 列出两种口径**结论不同**的 4 对（`rc.9` vs `rc.10`、`beta.2` vs `beta.11`） |
| §4 目录布局与平台词干 | `product/update/host.mjs` | `win32` → `win` 的映射只有一处；`HOST_CHECKED` |
| §4 缓存策略核对 | `evaluateResponse` | 通道清单必须**只**是 `no-store`（`no-cache, max-age=600, no-store` 被拒） |
| §4 HTTP 只用于测试 | `createHostConfig({ allowInsecureHttp })` | 未显式声明时 `http:` 被拒（计划文档收尾原话的可执行形式） |
| §5 发行清单 | `product/update/release.mjs` | 20 条拒绝用例：绝对地址、穿越、`%` 编码、反斜杠、跨 origin |
| §9 发布流程离线部分 | `scripts/update/publish.mjs` | 写出去之后**回读再算摘要**，不一致就抛 |
| §4 line 76 ZIP 含"产品文件闭包"与"目标产品版本清单" | `desktop/scripts/update-payload.mjs` | 载荷根 = `<stage>/resources/legion`（与打包后的 `installRoot` 同源）；清单版本必须与发行一致 |
| §9 公开回读验证字节与签名 | `scripts/update/verify-host.mjs` | 走**客户端同一套**代码；端到端用例见 `scripts/update/publish.test.mjs` |
| §5 发布密钥工具 | `scripts/update/keygen.mjs` | `new` / `trust` / `rotate` 三个子命令 |

**为什么回读要与客户端同源**：如果回读用另一套实现，那么"我上传的东西客户端
能不能验过"就仍然是一个未验证的假设——而它恰恰是这一步要回答的问题。

## 3. 阶段 B：检查调度、下载缓存、桌面状态与用户确认

| 设计条目 | 落点 | 证据 |
| --- | --- | --- |
| §6 可交互后 30–90 秒首检 | `schedule.mjs` 的 `planNextCheck` | 纯函数，`random` 注入；自检覆盖端点 |
| §6 6 小时 ±20% 抖动 | `withJitter` | 抖动下限**夹住**（配置写错时不能产出非正间隔） |
| §6 唤醒只补一次、不累计 | `planResumeCatchUp` | 未到期时返回 `due: false`，且不重排 |
| §6 手动检查共享一次请求 | `createCheckScheduler` + `client.check` | 并发 3 次检查只产生 **1** 次通道清单请求（有断言） |
| §6 退避 15/30/60 分钟 → 6 小时上限 | `describeBackoff` | 阶梯递增与上限夹住 |
| §6 空闲 60s / 清单 30s / 256 KiB | `transport.mjs` | 边收边判，超限立刻 abort |
| §6 `.part` 流式下载与原子改名 | `transport.mjs` + `cache.mjs` | 改名**在验签之后**，由调用方显式提交 |
| §6 解压前后校验闭包、拒越界/链接/重复/炸弹/未知可执行 | `product/update/extract.mjs` | 25 条用例，含**语法合法但恶意**的归档（自带 ZIP 构造器） |
| §6 闭包的载体与可信来源 | `product/update/closure.mjs` | 包内 `closure.json`，摘要在签过名的发行清单里（逐文件闭包放不进 256 KiB） |
| §6 落盘字节的确定性 | `product/update/zip.mjs` | 同输入 → 逐字节相同的包（内部排序、时间戳钉死） |
| §8 第 8 步"服务健康验证" | `product/update/health.mjs` | 声明式回环 HTTP 检查；**只允许回环**；身份断言（`expectJson`） |
| §8 健康检查用**实际**端口 | `desktop-bridge.mjs` 透出 `port` → `readLauncherPorts` | 拿不到读数就不写规格（fail-closed），**不**拿默认值凑 |
| §7 line 150 安装确认显示在途任务 | `product/upgrade/task-state.mjs` + `task-readings.mjs` + bridge `tasks` + `update.tasks` | 词表从**两套真实词表**派生（读源码比对）；读不到 ≠ 没有任务 |
| §6.3 补丁层成对判据的读数来源 | `product/update/release.mjs` 的 `dshPatchBindings`（签名覆盖） | 发布方声明；空表 = 没测过 → 客户端硬拒；不从本机推断 |
| §6 磁盘余量判据的读数 | `readFreeBytes`（`statfsSync` 的 `bavail`）+ `directoryBytes` | 读不到 → `null` → 拦；**不**估一个乐观的数 |
| `minWindowsBuild` 门禁 | `product/update/platform-build.mjs` | 三态；读不出本机 build 是**失败**不是跳过；`hostPlatform` ≠ 目标 `platform` |
| §4 line 121「固定迁移计划」 | `migration.mjs` 的 `migrationPlanDigest` + `EMPTY_MIGRATION_PLAN_DIGEST` | 发布端与客户端用**同一个函数**；不符 → `install-migration-plan-mismatch` |
| §6 line 132 自动检查的开关 | `createCheckScheduler({ automatic })` ← `config.checkOnStartup` | 关掉时不安排任何定时器；手动检查不受影响 |
| **全链路联合守卫** | `product/update/integration.test.mjs` | 不注入任何业务读数：发布 → 托管 → 检查 → 下载 → 事务 → helper → 提交 |
| **接线层守卫** | `desktop/update-wiring.test.mjs` | 断言写进事务文件的那六个读数；夹具的清单必须能过真实 `validateRelease` |
| 端口读数（⑱） | `install()` 开始时取一次，`spawnHelper` 用那次读数 | 用例断言 `status` 出现在 `stop` **之前** |
| §6 重启后复用前重新校验 | `cache.verifyReady` | 篡改缓存文件的用例证明它真的重算摘要 |
| §6 取消不影响当前程序 | `cache.discard` | 只删 `.part`；取消不进失败退避 |
| §7 有界操作表 | `desktop/update-service.mjs` + `update-preload.cjs` | 17 条 IPC 面用例：路径/URL/多余字段一律拒 |
| §7 窗口来源校验 | `windowOriginAllows` | 子框架、外部 URL、面板未打开都拒 |
| §7 状态脱敏投影 | `projectState` | 白名单投影；凭据类字段进门就丢 |
| §7 关于 Legion 界面 | `desktop/update.html` + `update-panel.mjs` | 23 条界面规则用例；源码扫 `innerHTML` 等注入入口 |
| §7 稍后 24 小时 | `client.snooze` | 稍后**不隐藏**设置页、不改主状态 |
| §7 关闭/退出不自动安装 | `main.mjs` | 退出路径只停调度器，不触碰安装 |

## 4. 阶段 C：维护屏障、独立 helper、事务持久化与恢复

| 设计条目 | 落点 | 证据 |
| --- | --- | --- |
| §8 意图先于动作、逐行刷盘 | `product/update/journal.mjs` | 每一步都有 intent/result 一对（用例逐个断言） |
| §8 断电后恢复依据磁盘证据 | `planRecovery` | 六条判定：无事可做 / 收尾 / 切换前 / 切换后+指针矛盾 / 切换后未迁移 / 迁移后 |
| §8 日志被外力改动 | `readJournal` | 中间坏行 → `recovery-required`（不跳过继续） |
| §8 半截尾行 = 未完成 | `truncatedTail` | 前面完整记录仍可读 |
| §8 建立维护屏障 | `barrier.mjs` | **排在停服务之前**（顺序有断言） |
| §8 备份失败立即停止 | `install.mjs` | 且**释放屏障**——此刻真的什么都没改 |
| §8 停认领/等待/停服务失败 | `install.mjs` | 保持维护状态（不放行一个"少了几个服务"的 Legion） |
| §8 句柄未释放则安全中止 | `verifyExit` | 句柄未释放时**不交接** helper |
| §8 一次性事务凭证 | `credential.mjs` | HMAC 绑定 txnId/目标版本/包摘要；改动任一字段即失效；消费一次即失效 |
| §8 helper 在待切换目录之外 | `isOutsideSwitchTarget` | 目录关系判据 + `helperClosure` 闭包判据 |
| §8 helper 启动前核对程序摘要 | `verifyProgramDigest` | 不符 → `recovery-required`，屏障保持 |
| §8 解压并验证目标版本目录 | `helper.mjs` | 目录不完整 → 回退，**不切换指针** |
| §8 迁移后健康检查、失败回退 | `helper.mjs` | 健康失败 → 自动回退程序 |
| §8 提交**之后**才解除屏障 | `helper.mjs` | 提交记录的下标必须小于解除屏障（有断言） |
| §8 不能自动恢复时保持维护 | `helper.mjs` | 含 contract 迁移 + 回退被拒 → 屏障**不放** |
| §8 新旧 Launcher 识别未完成事务 | `product/launcher/launcher.mjs` 的 `preflight` | 闸门排在**所有**检查之前（5 条用例） |

## 5. 实施过程中发现并修掉的真缺陷

写下来是因为它们的形状比"改对了"更值得留下来。

一共二十九条。①～⑩ 是各层实现里的具体错误（错读一个头、前缀不一致、跨不过
进程边界、手写清单漏了文件……）；**⑪～㉓ 属于同一类**，它们不是"某个函数
写错了"，而是**判据/承诺与它的输入之间那条线从来没有接上**——⑪～⑱ 与
⑲～㉓ 都是这一类，区别只在于**被谁发现**：⑪～⑯ 是全链路用例与接线层用例
发现的，⑰⑱ 是补完那两类用例之后发现的，而 ⑲～㉓ 是**按设计逐条对照**发现的
（见 §5.2）。

**① `Content-Length` 缺失被读成 0。** `Number(lookupHeader(...))` 在头缺失时是
`Number(null) === 0`，于是一次正常下载得到"Content-Length 0 与清单声明的 N
不一致"。判据对着、输入是 `null`。

**② `hashFile` 带 `sha256:` 前缀。** `product/upgrade` 的 `hashFile` 返回
`sha256:<hex>`，而设计 §5 的 `package.sha256` 是 64 位裸十六进制。直接比较
**永远不相等**，而错误信息看起来像"包被换了"。

**③ helper 的迁移存储跨不过进程边界。** 事务文件是 JSON，而迁移存储是一个
活的数据库句柄。早先读 `transaction.migrationStore` 会让"有迁移要跑"这条
分支在真实部署里**永远进不去**——helper 会安静地报 `no-migrations`、跑完
健康检查、然后提交一次**数据库没有迁移**的升级。那是一次成功的假象，
比迁移失败危险得多。

**④ `journal.begin` 少给一个字段会让整条记录丢失。** `canonicalJson` 拒绝
`undefined`（那是对的），但事务日志是"不可逆动作的唯一记录"。一次
"因为某个字段忘了给，整条 intent 没写进去"会让崩溃恢复失去那一步的证据。

**⑤ 打包壳清单是手写数组。** `stage.mjs` 的 desktop 文件清单里没有本批次
新增的文件，于是打包出来的应用会在启动时报 `ERR_MODULE_NOT_FOUND`，而开发机
上一切正常。现在清单在 `desktop/scripts/shell-files.mjs`，并由
`shell-files.test.mjs` 用**闭包判据**钉住。

**⑥ 样例产品清单的字段名不对。** 样例里写的是 `format`，真实清单用
`manifestFormat`。因为 `validateRelease` 只检查"是个对象 + 摘要对得上"，
样例一路通过，直到发布脚本真的去调 `validateManifest` 才暴露。

**⑦ 健康检查 fail-open。** 早先的 helper 把 `unsupported`（没有探针）当成
通过，于是一次**没有任何健康证据**的升级会一路提交。它与设计 §10 那句
「不能把未知状态显示成升级成功」是同一类问题，只是它出现在"验证缺席"
而不是"崩溃"上。现在默认 fail-closed：没有探针 → 按失败处置（尝试回退；
回退被拒则保持维护模式），只有事务文件显式写 `allowUnverifiedHealth: true`
才放行。

**⑧ 展开占位符的两连错。** `{teamHubPort}` 没有被展开（占位符名字与 ports
的 key 对不上），于是期望端口号是字面量 `"{teamHubPort}"`——一个**永远
不可能成立**的断言，而它能顺利通过规格校验。修它时新写的 `expandStrict`
又只处理字符串，而调用点传进去的是 `{ port: '{teamHubPort}' }` 这个
**对象**——于是"严格展开"一次都没发生。只有"用真实进程清单派生一遍"那条
判据发现了第二个错。

**⑨ 闭包来自包内时，内容摘要一次都没被检查。** `extractArchive` 原先按
调用方传进来的 `closure` 参数核对逐文件摘要，而闭包来自包内
（`closureEntry`）时那个参数是 `null`。于是"闭包来自包内"这条路径上，
大小与条目集合的判据全部通过，**而每一条内容摘要都被跳过**。发现它的是
`zip.test.mjs` 的「内容被替换」用例——一个只测"注入闭包数组"的套件不会
碰到它，因为那条路径上 `closure` 恰好不是 null。

**⑩ 闭包条目被当成"闭包之外的条目"。** 闭包不可能列出自己的摘要（自指，
sha256 没有不动点），所以 `closure.json` 必须**跳过**成员判定，它的可信度
由签名清单里的摘要保证。第一版没跳，于是每一份合法的包都被判成
"含闭包之外的条目"。

**⑪ 在途任务的词表与真实生产方对不上（最严重的一个）。**
`preflight.mjs` 手写的 `ACTIVE_TASK_STATES` / `TERMINAL_TASK_STATES` 与产品里
两套真实词表（看板 `in_progress`/`done`/`canceled`，运行尝试 `Running`/
`Completed`/`DeadLetter`）**交集为空**。两个方向同时错：

- 真实"在跑"的状态被当成认不出 → 按活跃处理（侥幸安全，靠的是"认不出按
  活跃"那条判据写得好）；
- 真实"已完成"的状态**也被当成认不出** → 同样按活跃 → **一台有过任务历史
  的机器升级被永久拦下**，而被点名的 id 全是早就做完的。

`product/update/install.mjs` 是**真的**把 `tasks` 传给 `runPreflight` 的，
所以自动升级在真实机器上一次都进不去。**这也解释了为什么此前没有任何生产方
写这个读数**：接上就永久阻塞，于是那一头一直是 `null`（同样拦）——两头都拦。

修法：词表从真实源码**派生**（`task-state.mjs`，载入时读源码比对漂移），
并补上第三档"已知但不执行"（`backlog`/`todo`/`in_review`/`blocked`）——
把它们按活跃处理会让**一个被遗忘的评审永久阻塞这台机器的所有升级**。

★ 这一处还有一个"测试与代码共享同一个错误假设"的教训：
`preflight.test.mjs` 与模块自检用的都是 `'running'`/`'completed'`（**非真实**
字面量），所以它们在旧词表下**恰好**通过。测试改真实值之后，缺陷才现形。

**⑫ 补丁层成对表的来源（第二个"每一次真实安装都撞上"的缺陷）。**
与 ⑪ 同一类：预检需要一个读数，而那个读数没有生产方——这里连**载体**都
没有，发行清单里没有它的字段。`patchPairOf(target, null)` 恒为 `'unverified'`
→ 预检 `unknown` → pre-switch 拦。桌面上从不传 `patchBindings`，于是每一次
真实安装都停在 `preflight-patch-pair-unverified`。

★ 这一处最值得记住的是**为什么没被发现**：`install.test.mjs` 的 `baseArgs`
自己给上了这一对，而它上面那段注释**早就写明**了"缺任何一个预检都会拦"。
写注释的人知道这个要求，却没有去看生产路径有没有给——50 条用例全绿，
真实安装一次进不去。这是"夹具补上了生产缺失的东西"那一类。

修法：它是**发布方的断言**（只有发布方知道自己测过哪些组合），所以放进
**签过名的发行清单**（`dshPatchBindings`，必须存在、可为空数组）。
不从本机推断的理由是硬的：客户端只能算出"目标与本机是不是同一对"，
而**正常的 DSH 升级本来就会换掉这一对**。

**⑬ 磁盘读数（`freeBytes`）没有生产方。** 预检在 `stage: 'pre-switch'` 跑，
而那一档对没有磁盘读数的处置是 `unknown` → 拦。桌面上从不传它，于是结论恒为
`preflight-disk-unobserved`。修法：用 `statfsSync` 读**实际**可用空间
（用 `bavail` 而不是 `bfree`——后者含保留块，方向是错的），读不到返回 `null`
（仍然拦），**不返回一个乐观的估计值**（那会放行一次必然写到一半就没空间的
升级）。

**⑭ Windows 版本门禁从未生效（fail-open）。** `minWindowsBuildRequired` 无
调用方 ⇒ `validateRelease` 里那条「需要 Windows build N，本机是 M」**不可达**；
同时 `install.mjs` 传给 `runPreflight` 的 `windowsBuild` 是**死参数**。
于是一份声明只支持 Win11（22000）的发行会在 Win10 19045 上被接受并安装。
修法：新增 `platform-build.mjs`，从 `os.release()` 取真实 build，三态判据，
**读不出本机版本是失败而不是跳过**。

★ 这一处还逼出一条设计判据：`hostPlatform`（正在跑代码的机器）与目标
`platform`（发行清单声明的）是**两件事**。Linux CI 上声明 `platform: 'win32'`
的用例，`os.release()` 是 `6.8.0-45-generic`——把"读不出 Windows build"当失败
会让每一条这样的用例红，而它们测的是别的东西。

**⑮ 迁移计划被静默跳过（fail-open）。** `migrationPlanDigest` 只校验**格式**，
全仓没有一处拿它去比对；`release.mjs` 的 `BAD_MIGRATION_PLAN` **从未被 emit**；
桌面侧从不传 `migrations`，于是 `[]` 一路走到 helper，报 `no-migrations` 并
**提交**。一份声明了迁移计划的发行，它的迁移会被跳过——"升级成功、数据库结构
从未迁移"，而每一句成功读数都是真的。

修法：`migrationPlanDigest(migrations)` 可算（摘要覆盖 `up` 的源码，所以
"版本号没变、实现变了"也会被发现），客户端核对"声明 == 将要执行的集合"，
不符则 `install-migration-plan-mismatch`。发布端与客户端用**同一个函数**。

**⑯ `checkOnStartup` 被静默忽略（fail-open）。** 这个键在 `config.mjs` 的
JSON 示例里是文档化的、被解析、被给默认值，而**全仓没有消费者**：用户关掉
自动检查之后，首次检查与每 6 小时的周期检查照常发出网络请求。

修法：`createCheckScheduler({ automatic })` 在 `automatic === false` 时
**不安排任何定时器**，并把 `automatic` 与"自动检查已关闭"作为**读数**报出来
（界面要能说出"为什么什么都没安排"）；手动检查不受影响。

**⑰ 补丁层成对表的第二次失误：校验了，但不携带。** 这是 ⑫ 修完之后留下的
半个洞——`validateRelease` 逐项检查了 `payload.dshPatchBindings`（还配了长
注释说明它是那条判据的唯一来源），而它返回的**投影不包含这个字段**。于是
客户端拿到的 `release.dshPatchBindings` 是 `undefined` → `patchPairOf(target,
null)` → `'unverified'` → **每一次真实安装仍然被拦**。

  > 一个只被校验、不被携带的字段，与一个不存在的字段，
  > 在调用点上是同一个东西。

各层的单测都过（夹具自己给了 `patchBindings`），只有全链路集成用例发现它。
修法：把它放进投影，并逐项投影成只含 `dshVersion`/`compositionPatchVersion`
的冻结对象。

**⑱ 健康规格的端口读数发生在停服务之后（靠一个没写下来的事实）。**
`readLauncherPorts({ bridge })` 原先在 `spawnHelper` 里调用，而事务文件是在
**停服务之后**写的（设计 §8 的顺序）。今天这条路能用，靠的是一个没写在任何
地方的事实：`supervisor.status()` 只给出 `key/state/pid/…`，端口是
`launcher.status()` 从 `plan.processes` 上补出来的，而那个 plan 在停止之后
**仍然在**。

一个"不再列出已停止进程"的清理（很自然的一个改动）会让健康规格**静默地**
派生不出来 → helper fail-closed 到永不提交 → **每一次升级都失败**，而原因
看起来像"服务没起来"。

修法：在 `install()` 开始时取一次（那时服务还在跑，端口一定读得到），
`spawnHelper` 用那次读数；接线层用例断言 `status` 出现在 `stop` **之前**。
这一条是写那条用例时发现的——**用例不只是守卫，它也是探针**。

**⑲ 安装前重查通道这一步完全不存在（fail-open）。** 设计 §9 line 204：

> 撤回坏版本时签发更高 sequence 的清单，指向当前安全版本……**已下载目标安装前
> 必须重新检查通道；目标被撤回时禁止安装。** 撤回清单允许取消旧候选，但不能
> 授予降级权限。

而 `client.install()` **不读通道**：它只核对 `readyIdentity` 与调用方给的身份
一致，然后直接交接给安装事务。后果：撤回只能挡住**还没下载**的人；而"下载完成"
与"用户点安装"之间可以隔很久，发布端在那段时间里完全可能撤回那个版本。

撤回通常恰恰是因为那个包会弄坏数据——所以"挡不住已经下载的人"≈ **没撤**。
而 §10 的验收表里明写着「已下载撤回包被**阻止安装**」。

修法：`install()` 交接之前重读通道并比对 `releaseId` + `manifestSha256`。
不一致 → `update-target-recalled` 并**取消旧候选**（设计那句"撤回清单允许取消
旧候选"）；读不到通道 → `update-recall-unverified` **同样不装**（能证明"它没被
撤回"的只有通道本身），但**不丢候选**（那可能只是一次网络抖动，丢了会让用户
白等几百 MB）。为此把 `check()` 的"读通道"抽成 `readChannelFeed()` 供两处共用。

**⑳ `stop-claiming` 是一个 Launcher 不认的命令。** 接线层一直在发它，而
`desktop-protocol.mjs` 的 `TYPES` 里没有这个类型 ⇒ `UNKNOWN_TYPE` ⇒ 桌面抛错 ⇒
安装事务判 `install-services-refused` 并进维护态。**每一次真实安装都停在第三步。**

它没被发现，是因为接线层用例的**假 bridge 自己实现了** `stop-claiming`
（替身比真货更能干），而全链路用例注入了一个 stub `stopClaiming`——两者都替
生产补齐了缺失的能力。

> 一个比真货更能干的替身，测出来的是替身，不是系统。

修法：把能力真的做出来。"认领"在进程清单里有明确承担者——`orchestrator`
（`kind: 'worker'`，label 就是「扫单 / **认领** / 派工」）。所以新增
`launcher.suspendClaiming()` / `resumeClaiming()`（**只停/起那一个进程**，
数据面服务继续跑——第 4、5 步夹在中间，停服务是第 6 步）、协议两个类型、
bridge 两个分支，外加 `LAUNCHER_CHECKED` 装载期自检（那个 key 必须真在
`PROCESS_SPECS` 里且必须是 worker）。

**㉑ 顺序反了：备份发生在"还有人在写"的时候。** 设计的 3→4→5→6 是「停认领、
等在途任务 → 建立屏障 → 备份 → 停服务」，实现是「屏障 → 备份 → 停认领 →
等在途 → 停服务」。

后果不是"顺序不好看"，而是**那份备份不再是设计要的那一份**：屏障是一个闸门
**文件**，它拦得住"之后还来写的进程"，**拦不住一个已经跑起来、正在写 SQLite
的任务**；而"在途任务"恰恰就是那些写入者。于是备份是**边写边拷**的——
`team.db` 与它旁边的 `-wal` 在两个不同时刻被复制，正是设计第 4 步明确禁止的形状。

备份是整次升级的**回退源**，而不一致的回退源会让失败表里「切换后、未改数据库
→ 回到旧版本」这一行落在一个坏掉的库上。

★ 这次改动有一份**本仓已有的实测证据**支撑，值得引一下：`docs/DEPLOY.md` §6.1
（由 `scripts/prt/backup-restore-verify.mjs` 实测得出）写着「**只复制 `team.db`
会静默丢数据**。WAL 模式下已提交的数据可能仍只在 `-wal` 里。实测现场库：只复制
`.db` 的副本比真实状态**少了 253 条 audit 记录**（9984 → 9731），而副本自身
`integrity_check` 报 **ok**——没有任何报错，备份看起来完全正常。」

也就是说：这份仓库**已经知道** WAL 让"备份看起来成功"与"备份真的完整"是两件事，
并把结论写进了运维文档。而 ㉑ 是**同一个失效模式的另一半**——那一半讲的是
"少拷一个文件"，这一半讲的是"两个文件不是同一时刻的"。

> 「先立屏障、所以快照是一致的」里的"一致"指的是**之后没人再写**，
> 而不是**此刻没有人在写**。这两件事在"备份"这个动作上不是一回事。

**㉒ `drainInFlight` 是假的，而且假得有两层。** 接线层那个实现：① 把
`install.mjs` 传进来的 `{ timeoutMs, pendingTasks }` **全部丢掉**，然后去问进程
读数——从来没看过任务；② 它挑的状态是 `'running' | 'starting'`，而
`supervisor.mjs` 的取值里**没有 `running`**（正常服务的进程报 `ready`），所以
"活跃进程数"恒为 0，它**无条件**回报"已收敛"。

合起来：**它在服务最忙的时候宣布"已经收敛"**。方向是 fail-open，而这正是要在
备份之前确保"没有写入者"的那一步。

修法：按设计**轮询任务读数**直到收敛或超时，用 `classifyTaskState`（同一个词表
判据）区分 `active`/`unrecognized`（都要等）与 `waiting`（**不等**：它们不在写库，
而预检那边已经同意放行了——两处必须一致）。读不到读数时 fail-closed。

**㉓ 在途任务超时把用户锁进维护态。** 设计 §7 line 150：「默认等待任务结束；
**超时回到可选择界面，不默认强杀**」；§8 失败表把"任务等待"与"下载/校验/预检/
备份"归在同一档：「当前版本继续运行；不改变活动指针」。而实现判成
`maintenance-required`——用户只是因为**有一个任务在跑**，就得到一台"起不来、
要人工处理"的 Legion，而这次升级**一个字节都没改**。

> 把一次"什么都没发生的取消"渲染成一次故障，
> 会让用户去做只有故障才需要做的事。

修法：超时 → `not-started` + **恢复认领** + 不放屏障。并新增 `resumeClaiming`
参数与 `resumeClaimingAfterAbort()`：第 3 步停了认领之后，第 4、5 步仍可能放弃，
而那些失败的设计落点都是"当前版本继续运行"——**而"继续运行"必须包含"还能领活"**。
否则用户得到一个服务都在、界面能开、只是再也领不到活的 Legion，而没有任何界面
读数会提示他。

**㉔ 上传计划把远端根写死成生产树（与通道无关）。** `publish.mjs` 的
`renderUploadPlan` 签名是
`{ remoteRoot = 'root@117.72.146.36:/srv/legion-updates/production/legion' }`
——一个**写死的生产路径**；回读命令里的 `--prefix /legion` 也是写死的。所以一次
`--channel internal` 的测试发行会生成一份**指向生产树**的上传指令，而 internal
通道的订阅前缀其实是 `/test/legion`（仓库的 `update-config.example.json` 就是
这么映的）。

这不是"默认值选得不好"，而是**生成了一条把测试物写进生产目录的操作指令**：
照它执行的人会做对每一步，却把东西放错地方；而 `verify-host` 随后要么 404、
要么核到另一棵树——两种结果都不会告诉他"你传错了树"。

> 一份把目标猜错的部署指令，比一份要求你填目标的指令危险得多：
> 前者会被人照着执行。

修法：目标必须**显式**给（`--target test|production`，或 `--remote-root` +
`--prefix` 一对），**没有默认值**；两者都缺 → 拒绝并说清为什么没有默认值；
`target` 拼错 → 拒绝；另加一条通道/目标一致性判据（`internal` 发到生产树 → 拒绝，
因为那个 feed 会被配好的客户端**永远读不到**）。`writePublish` 仍然总是写产物，
但没有目标时写出的是一份**一行可执行命令都没有**的拒答。

★ 这一条是**在真实托管联调里撞出来的**（见 §7.3）：读代码看不出来，是把它跑
起来、看到生成的那份计划才发现的。

**㉕ 屏障的"只有持有者能解"可以被"少传一个参数"绕过。** `releaseBarrier` 的
持有者判据是

```js
if (state.barrier !== null && typeof txnId === 'string' && txnId !== ''
    && state.barrier.txnId !== txnId) { …拒… }
```

三个条件**串在**一起。于是 `releaseBarrier(dataDir)`（不传 `txnId`）让中间两个
条件为假 ⇒ 整个 `if` 短路 ⇒ 代码直接走到 `rmSync` ⇒ **一次不声明身份的调用把
正在进行的升级屏障删掉了**。而这个函数自己的注释写的是「**只有持有者能解**」，
文件头还专门解释了为什么"谁都能解"是危险的：

> 一个"谁都能解"的屏障在一次崩溃之后会被下一次启动顺手解掉，而那次崩溃可能
> 正停在"数据库已迁移、程序未验证"的位置。

今天**没有生产调用方**犯这个错（`install.mjs` 与 `helper.mjs` 的 8 处调用全传了
`txnId`），所以它是一个**潜伏的 fail-open**：判据在，但它的成立条件可以被
"少传一个参数"绕过。这类洞的危险不在于今天有人踩，而在于**下一个人写
`releaseBarrier(dataDir)` 时看起来完全合理**——"我只是想清掉它"。

> 一个"少传一个参数就失效"的守卫，与没有守卫的区别只在于
> **它让人以为有守卫**。

修法：有屏障（含**读不出来**）时必须声明身份，否则以 `barrier-no-txn-id`
拒绝；只有"本来就没有屏障"才是幂等成功（那时什么都没删）。"读不出来"也拒是
刻意的——一个损坏的屏障恰恰最不该被"我只是想清掉它"顺手删掉，而删它的后果
正是设计 line 21-29 那道判据要防的。

★ 这一条是**读代码读出来的**（`releaseBarrier` 的函数签名与它自己的注释不一致
本身就是线索），而且它落在 §5.2 那张表**第一张的右边**——没有任何用例会去测
"参数少传时会发生什么"。补上用例之后，把守卫去掉重跑，两条新用例都会红
（`没有 txnId 时居然解除了屏障（参数 []）`），所以它们不是空的。

**㉖ 公钥轮换只有生产者，没有消费者（`applyTrustUpdate` 生产里调用方数为 0）。**
设计 §5 line 128 把轮换的顺序写死了：

> 「换密钥需先通过**旧信任根签名的客户端更新**预置新公钥，再切换发布签名。」

于是有两个动作。而当时仓库里只有**第一个**：

| 动作 | 现状 |
|---|---|
| ① 用旧私钥签一份增量（`add` 新公钥） | `keygen rotate` 有实现、有用例、真的能产出文件 |
| ② 把增量应用到**随包信任表**上（"预置"） | **不存在** |

`envelope.applyTrustUpdate()` 是 ② 的机制，它写得很完整（三条约束：签名必须
来自表内钥匙、`sequence` 严格递增、吊销对象必须存在），但它**唯一的调用方是它
自己的装载期自检**。也就是说：`keygen rotate` 产出的那份文件，**没有任何代码会
读它**；而 §10 验收表第 8 行明确要求「**公钥轮换** → 旧客户端正确消费」。

这正是本仓反复出现的那一类：**一个被声明、被文档化、有实现、有用例、而生产里
没有任何调用方的能力**。它和 ⑪～㉕ 是同一个形状，只是这次"缺失的一端"是
**整条轮换路径的第二半**。

> 一个"有实现、有用例、而生产里调用方数为 0"的函数，
> 与一个不存在的函数在部署上是同一个东西——只不过前者的报告是绿的。

修法：新增 `keygen apply`（实现落在 `trust-file.mjs` 的
`applyTrustUpdateToTable`），把增量应用到随包信任表，产出下一版
`update-trust.json`；`lastSequence` 取**当前表的 sequence**（少了它，一份重放
的同号增量会被接受，而"用重放把信任表退回吊销之前"正是那条判据要防的）。

★ 端到端判据（`scripts/update/rotation.test.mjs`）走的顺序与设计一致，并且带
**三条负向对照**——没有它们，"新钥匙签的清单被接受"可能只是因为"什么都接受"：

| 步骤 | 期望 |
|---|---|
| ① 旧钥匙 A 在表里（sequence=1） | — |
| ② 用 **A 的私钥**签增量 add B | 成功 |
| ③ apply → sequence=2，表 `{A, B}` | 成功 |
| ④ **用 B 的私钥**签清单 → 客户端读③那份表验签 | **接受** |
| ⑤ 用不在表里的钥匙 C 签同一份清单 | `envelope-unknown-key` 拒绝 |
| ⑥ 把②的增量**重放**一次 | 拒绝（`不大于已接受的`） |
| ⑦ 用 B 的私钥签"add B"的增量（新钥匙给自己背书） | 拒绝 |

★ 已验证非空：把 `applyTrustUpdateToTable` 里的 `applyTrustUpdate(...)` 换成
一个恒失败的对象 → 两条用例都红（`增量没有被接受（unwired）`）。

★ 写这条用例时撞到一个"测试框架那一层"的坑，记一下：`keygen.mjs` 的 `fail()`
会把 `process.exitCode` 置成 2（对 CLI 是对的），而它在**同进程**里被调用会污染
测试进程，于是 `node --test` 把**整个文件**报成失败——而里面两条用例其实都过了。
报告里那一行是"文件失败"而不是"用例失败"，看起来像"用例根本没跑"。

**㉗ "稍后"丢掉了它的限定词，于是从"这一个发行"变成了"所有发行"。** 设计 §7
line 146 的原话是：

> 「稍后仅收起提醒，设置页仍可见；**同一发行**默认 24 小时内不重复主动提醒。」

限定词「同一发行」不是修饰语，而是这条规则的**全部内容**：24 小时的沉默只针对
用户看见并推迟的**那一个版本**。

而实现只存了一个时间戳：

```js
let snoozedUntilMs = null
function snooze() { snoozedUntilMs = now() + durationMs; … 
  return Object.freeze({ ok: true, snoozedUntilMs, releaseId: candidate?.releaseId ?? null }) }
function shouldNotify() {
  if (candidate === null) return false
  if (snoozedUntilMs !== null && now() < snoozedUntilMs) return false   // ← 与"是哪一个发行"无关
  return state === 'available'
}
```

后果：用户对 1.1.0 点了"稍后"，而 1.2.0 在几小时后发布 ⇒ **1.2.0 被静默吞掉**，
用户不会被告知，直到那个窗口过完。而"有更新可用"正是这个功能存在的全部理由。

★ 注意 `snooze()` 的返回值里**一直**带着 `releaseId`——写的人知道发行是有关系的，
只是那个读数没有被判断用上。与 ⑪～㉖ 同一个形状。

> 一条带限定词的规则，如果实现里丢掉了那个限定词，
> 它的作用范围就从"那一个"变成了"全部"——而这两种写法在代码上只差一个字段。

修法：`snooze()` 记下 `snoozedReleaseId`；`shouldNotify()` 只在**同一个发行**
且在窗口内时沉默，换了发行就重新提醒。快照里也给出 `snoozedReleaseId`，这样界面
能把"已推迟 1.1.0 的提醒"与"任何发行都别烦我"分开显示。

★ 顺带自查出一处**同一形状**的漏字段：客户端 → 界面之间有一层显式投影
（`desktop/update-service.mjs` 的 `projectState`），它带 `snoozedUntilMs` 而**不**
带 `snoozedReleaseId`。只带时间戳的话，界面永远拿不到"是哪一个发行"。
这正是 ⑰ 的形状（算了/校验了，但没有携带到调用方读的那个对象里）——
而它是我**刚加上那个字段时**顺手查出来的，不是别人发现的。补了字段与判据。

★ **这条用例第一版是空的，值得把原因记下来。** 我一开始用**两个客户端实例**来
比较（A 对 1.1.0 点稍后，再用另一个客户端看 1.2.0）。那是错的——一个新客户端
**根本没有稍后状态**（`snoozedUntilMs === null`），所以它当然会提醒。把修复整个
撤掉重跑，那条用例**照样通过**：它测的是"新客户端会提醒"，而不是"换了发行就不再
沉默"。

  > 一个"两个对象各测一半"的用例，测不出"同一个对象上的状态变化"。

正确的构造是**同一个客户端**先后看到两个发行（为此给夹具加了
`productVersion`/`releaseId`/`sequence`/`keys` 四个参数——第二个发行必须**由同一把
钥匙签名**，否则它会被"未知钥匙"拒掉，那会掩盖这条用例真正要测的东西；还必须用
**更高**的 sequence，否则会被"同 sequence 换摘要"拒掉，而那条判据是对的）。
改对之后，撤掉修复重跑 ⇒ 这条用例红。

★ 门禁里 `product/update/feed.test.mjs` 那一组（见 §7.4 的覆盖图）与这条是同一次
审计的产物。

**㉘ 数据备份恢复：一个"没有任何人能敲出来"的能力（设计 §8 line 190）。**
设计 §8 失败表最后一行要求维护态下「提供向前修复**或明确的数据备份恢复入口**」。
而当时的现状是：`restoreSnapshot()` 导出、有用例、逐文件对账、连"写回 `.db` 前
先删掉旁边的 `-wal`/`-shm`"那条纪律都写得很清楚——**而用户侧唯一的入口是
`docs/DEPLOY.md` §6 的手工步骤**（停 hub → 删 `-wal`/`-shm` → 换 `team.db`）。

同一类缺陷在本仓已经出现过一次（PRT-257 的运行时安装器：判据齐全、用例全绿、
而没有任何人能敲出来），当时的结论一字不改地适用：

> 一个"判据齐全、用例全绿、而没有任何人能敲出来"的能力，
> 与一个不存在的能力在部署上是同一个东西——只不过前者的报告是绿的。

修法：新增 `product/update/recovery.mjs` + 三条 CLI 开关
（`--recovery-plan` / `--restore-backup=<id>` / `--confirm-restore`）+ 退出码
12/13。§8 line 192 的三条约束各自落成一条判据：

| line 192 的要求 | 实现 |
|---|---|
| 自动恢复**仅限**已证明无写入的**未提交**事务 | `safe-automatic` 档要求"有未提交事务"**且**"日志里有 `barrier-acquire` 的**完成**记录、且它在 `backup` **之前**"；其余一切落到"要问" |
| 提交后恢复可能丢新写入 → **必须明确告知并取得确认** | 已提交（从**日志终态记录**读，见下）→ `needs-confirmation`；没有 `confirm: true` 时**一个字节都不写**并退 12 |
| 工作空间**永远**不作为目标 | 目标只能是快照自己记的 `dataDir` + 配置路径；另有一条判据断言"恢复写过的每个路径都在那两者之下" |

★★ 这一轮里我自己撞进两次**同一个形状**，都值得留下来：

**① "已提交"那条判据原本是死代码。** 我写的是
`if (active.phase === 'committed')`——而 `readActive()` **在提交之后返回
`journal-no-active`**（finish 的最后一步就是删描述符）。所以那个分支**永远
不成立**：它不报错，只是"提交后的那条约束没生效"。

> 一个"等我看到 phase==='committed' 再处理"的判据，
> 在提交之后永远等不到——**因为提交的动作本身就包含"把描述符删掉"**。

修法：从**日志的终态记录**（`kind: 'finish'`, `data.phase`）读"最后停在哪"，
活动描述符只回答"现在有没有未完成的事务"。用例用的是真 `journal.finish('committed')`，
撤掉修复重跑即红。

**② 我的自检喂了一个现实中不存在的输入。** 自检里我写的是
`journal: { records: [], active: { phase: 'committed' } }`——同样不可能发生。
它**通过了**，验证的却是"这个函数能处理这个不存在的形状"。
改用真实形态（`active: null` + 终态记录）之后才与生产一致。

> 一条用不可能输入做的自检，验证的是"这个函数能处理这个不存在的形状"。

★ 另外两处由**别的判据**抓出来的自己的错，也一并记下来，因为它们的形状有用：

- **`planRecoveryFromBackups` 的出口形状不一致**：早先"没有备份目录"那条少给了
  `activeTransaction`/`barrierHeld`/`restorableCount`，于是 CLI 渲染器读
  `.txnId` 时炸在**另一条**分支上——而"没有备份"恰恰是"一台还没升级过的机器"
  会走的路。
  > 一个"某个分支少给几个字段"的返回值，
  > 会在**读它的那一侧**变成一个看起来与这个分支无关的崩溃。
- **`EXIT_CODES` 的声明位置**：它原先在文件**末尾**，而 `if (isMain)` 在它之前
  **调用** `run()`。`const` 提升但不初始化，于是 `run()` 里任何
  `return EXIT_CODES.ok` 都抛 `ReferenceError: Cannot access 'EXIT_CODES'
  before initialization`——而报告把它显示成"恢复分支那一行"，读起来像恢复的
  代码有问题。已把声明移到 `run()` 之前，并把这条顺序约束写进注释。
  > 一个"用起来才知道"的顺序约束比一个写错的表达式难查得多，
  > 因为出错的代码与要改的代码不在同一个地方。

**㉙ 发布端没有"怎么知道该用几号 sequence"的方法（设计 §9 第 4 步的"更大的"）。**
设计 §9 第 4 步的原话是「对通道发布加锁；生成**更大的** sequence，最后通过单对象
替换通道 envelope」。而 `publish.mjs` 的 `--sequence` 是**显式给的**——所以
"更大的"这三个字要求发布端**先知道当前值**，而当时没有任何工具或脚本把那个值交到
发布流程里（`verify-host.mjs` 会把它打在 JSON 输出里，但那是回读核对，没人会把它
接进去）。

上传计划里只有"第 4 步：再次回读，确认 sequence 已经推进"——那是**事后**核对：
它能在传错之后告诉你错了，但拦不住你把错的那个传上去。而抄错的两个方向**都很安静**：

| 抄错 | 客户端读数 | 后果 |
|---|---|---|
| 抄小了 | `feed-sequence-regression` | **没有任何人去取这个版本**，而发布端看到的一切正常 |
| 抄了同号（摘要不同） | `feed-sequence-conflict` | 同样静默 |

两种都不会在发布端报错，只在客户端那一侧表现为"发了新版但没人更新"。

> 一条**事后**核对的读数，不能替代一条**事前**取值的方法。

修法：上传计划开头加"**第 0 步（发布前先做）**"——给出**一条真的能跑**的
`verify-host` 命令（**不带** `--expect-sequence`，因为这一步还不知道该是多少）、
说明"输出里的 sequence 就是当前值，本次请用**它 + 1**（或更大）"，并写出本次实际用的
号码供留档。判据钉住四点：存在、在第一步之前、不带 `--expect-sequence`（那是核对的
形状而非取值的形状）、写出当前值与本次数。

★ 仍未做：第 4 步前半句「**对通道发布加锁**」只写在文件头注释里，没有实现——
因为该脚本**不负责上传**（见它文件头"为什么上传不在本脚本里"），那把锁属于调用方
（CI 作业或发布机），而"发布流程的加锁"需要一个真实的发布作业才有落点。见 §6.1。

### 5.2 ⑲～㉙ 是怎么找到的：**逐条对照设计**
⑪～⑱ 是被用例逼出来的（写用例 → 发现生产缺东西）。⑲～㉗ 不全是——它们是**拿着
设计文档一行一行核对实现**找出来的。两种方法各有盲区：

| 方法 | 能发现 | 发现不了 |
|---|---|---|
| 写全链路／接线层用例 | 生产缺的**读数与能力** | 设计里有、而**两处都没提到**的要求（⑲ 的"安装前重查"就是这样：调用方和实现都没想起它） |
| 逐条对照设计 | 设计要求与实现之间的**整段缺失** | 那些"设计没写、而现场事实变了"的坑（⑱ 的端口读数就是这类） |

⑲ 与 ⑳ 落在第一张表的右边：**没有任何用例会去测一个谁都没实现的要求**。
所以下一步的验证方式也必须是"对照文档"，而不只是"再写点用例"。

## 5.0 一个反复出现的模式（十六个缺陷同源）

⑪ 到 ㉙ 里的十七个是同一个模式：**一个判据（或一个承诺）需要一个读数，
而那个读数在真实链路上不存在。**（⑧ 的 `{teamHubPort}` 未展开是它的变体。）

| # | 判据 / 承诺 | 缺的读数 | 症状 | 方向 |
|---|---|---|---|---|
| ⑪ | 在途任务 | `tasks` 无生产方，且词表与真实词表**交集为空** | 接上也永久拦 | fail-closed |
| ⑫ | 补丁层成对 | `dshPatchBindings` 连**载体**都没有 | 每次安装停在 `patch-pair-unverified` | fail-closed |
| ⑬ | 磁盘余量 | `freeBytes` 从不传 | 每次安装停在 `disk-unobserved` | fail-closed |
| ⑭ | Windows 版本 | `minWindowsBuildRequired` 无调用方、`windowsBuild` 是死参数 | 门禁**从未生效** | **fail-open** |
| ⑮ | 迁移计划 | `migrationPlanDigest` 无人比对，`migrations` 从不传；`BAD_MIGRATION_PLAN` 从未 emit | 迁移被**静默跳过** | **fail-open** |
| ⑯ | `checkOnStartup` | 键被解析、被文档化，无消费者 | 用户的"关闭"被静默忽略 | **fail-open** |
| ⑰ | 补丁层成对表（**第二次**） | `validateRelease` 校验了它，投影**不携带**它 | 客户端拿到的仍是 `undefined` → 仍被拦 | fail-closed |
| ⑱ | 健康规格的端口读数 | 读数发生在**停服务之后**，依赖"已停止的进程仍在 `processes` 里" | 一个自然的清理 → 规格静默派生不出 → 永不提交 | **fail-open**→fail-closed |

⑰ 值得单独一句：它是**同一个字段的第二次失误**——⑫ 把字段加进了签名清单，
而 `validateRelease` 的投影没有携带它。**加密清单里有它**，而**客户端会读的
那份对象里没有**。抓出它的是 `integration.test.mjs` 的全链路用例：各层单测
都过（夹具自己给了 `patchBindings`），而真实链路上客户端永远给不出。

  > 一个只被校验、不被携带的字段，与一个不存在的字段，
  > 在调用点上是同一个东西。

这也是本文件加 `integration.test.mjs` 的**直接理由**：这些判据各自的单测
做不到"联合守卫"，因为它们的夹具正是当年掩盖缺陷的东西。

它们共同的：

- **表现**：测试全绿，真实链路一次都跑不通（或反向：一次都拦不住）。
- **成因**：夹具替生产补上了缺失的入参。`install.mjs` 的注释甚至**三次**
  写明了"缺一个预检就会拦"，但没有人去看桌面调用点。
- **处置**：从**真实来源**派生（不是手写清单、不是猜默认值、不是从本机
  推断，也不是"声明了就算"），缺失时说得出原因。

方向上的分布值得单独记住：数下来是 **fail-closed 六例**（⑪⑫⑬⑰⑳㉒的一部分：
安全，但功能为零——每一次真实安装都被自己的安全判据挡住）与 **fail-open 七例**
（⑭⑮⑯⑱⑲㉑㉓：承诺没有兑现）。fail-open 的那几例都不是"校验写错了"，而是
"**校验/承诺从来没有接上**"——它们的共同形态是**一个被声明、被文档化、
而不产生任何效果的东西**。这类东西在代码 review 里几乎不可见，因为每一处
单独看都是对的。

⑳ 与 ㉒ 还各自多一层：它们**看起来是接上的**——接线层照着设计发了命令、
照着设计做了判断，而对面（协议表／进程状态取值）不认。也就是"接上了一根
接到空处的线"。

再往回看一层：**发现 ⑪～⑱ 的都不是这些判据自己的用例**。⑪⑫⑬⑭⑮⑯ 是全链路
集成用例与接线层用例发现的，⑰ 是全链路集成、⑱ 是接线层。这不是巧合——
一条判据的用例天然会替它补上入参，所以它**测不到自己的缺失**。

  > 一个判据的用例，是这个判据最不可能发现自己没接线的地方。

而 ⑲～㉓ 是被**另一种**动作发现的：逐条对照设计（见 §5.2）。两种办法必须都用，
因为它们的盲区互补。

所以本文件的"仍未验证"一节要按这条模式读：凡是"有生产方吗"这个问题的
答案只是"某个测试给了它"，那一条就还没有被验证。

## 5.1 一次发布的完整顺序（现在都有落点）

```bash
# 1. 打包桌面端（需要 desktop/node_modules 里的 Electron）
pnpm --dir desktop stage          # 产出 .desktop-build/stage-<ts>/{shell,resources}
# 2. 从暂存产物产出升级包（含包内 closure.json）
node desktop/scripts/update-payload.mjs \
  --stage-file .desktop-build/current-stage.json --out dist/update --product-version 1.1.0
# 3. 签名发行清单 + 通道 envelope（不可变文件与通道清单分开）
node scripts/update/publish.mjs --package-zip dist/update/legion-win-x64.zip \
  --product-manifest .desktop-build/stage-<ts>/resources/legion/product/release/runtime-manifest.json \
  --product-version 1.1.0 --from-version 1.0.0 --channel stable --release-id rel-1.1.0 \
  --installer <setup.exe> --notes <notes.txt> \
  --key-id <keyId> --private-key <key.pem> \
  --migration-plan-digest <sha256> --sequence 43 \
  --issued-at <iso> --expires-at <iso> --out dist/update
# 4. 按 upload-plan.txt 上传：先全部不可变文件，回读通过之后才替换通道清单
node scripts/update/verify-host.mjs --origin <生产 origin> --prefix /legion \
  --channel stable --trust product/release/update-trust.json
```

第 2 步与第 3 步的分工是刻意的：第 2 步决定**包里是什么**（并从
`stage.mjs` 的实际产物出发，所以它不会与装出来的树分叉），第 3 步决定
**怎么签名与怎么上传**（并强制"先不可变、后通道"这个顺序）。

第 3 步的 `--dsh-patch-bindings <dshVersion>:<n>[,…]` 是**必填的语义**：
不给就是空表，而空表意味着客户端判 `unverified` 并拒绝安装
（`preflight-patch-pair-unverified`）。发布一批没测过的补丁层组合，
发布流程本身不会失败——失败会出现在用户侧。所以这一步要在发布检查单上。

## 6. 明确**还没有做**的部分

设计 §10 说「每阶段记录实际证据；**测试替身通过不能替代 Windows 真机升级
验收**」。据此如实列出：

- **阶段 D 未执行**：没有签名真实安装包，没有干净机器首次安装 + N-1 → N
  实测，没有文件占用/断电故障注入。§10 的九行验收表里，第一、三、五、六、
  七、九行都**需要真机**才能给出结论。
  ★ 第 8 行（撤回）的**协议那一半已经做完并实测**了，见 §7.3；没做的是
  它在真机上的那一半（真装一个坏版本、真撤回、真验证已升级用户的处置）。
- ~~自动更新尚未在真实托管上跑通一次~~ → **已跑通，证据见 §7.3**。
  曾经的状态是：`verify-host.mjs` 可以对 117.72.146.36 运行，但那里只有空目录。
  现在测试树上有一份签名发行，且完成了「公网回读 + 真实客户端检查/下载/就绪 +
  负向判据 + 撤回演练」。
- **没有生产 HTTPS 入口**。设计 §11 的"部署时填写"（域名、存储供应商、
  签名发布者、公钥、责任人）仍未填写；仓库里只有
  `product/release/update-config.example.json` 与 `update-trust.example.json`。
  ★ 测试通道走的是 HTTP + `allowInsecureHttp`（计划文档允许的那条路），
  而**生产通道必须是 HTTPS**——这一点没有被这次联调改变。
- **helper 的打包闭包已接线，`unpack` 已用真实实现**（`extract.mjs`：
  越界路径/软链接/重复目标/解压炸弹/未知可执行五条判据，解压前后各核一次
  闭包；闭包来自包内 `closure.json`，摘要在签过名的发行清单里）。
  `desktop/scripts/update-payload.mjs` 从一次已暂存的桌面构建产出这种形状的
  包（载荷根 = `<stage>/resources/legion`，与打包后的 `installRoot` 同源），
  `publish.mjs --package-root` 也能现打。
  **发布出去的包里的文件树与桌面实际装出来的文件树现在有判据对齐了**
  （`update-payload.test.mjs` 逐文件比对 stage 与解压结果）。
  仍未验证的是**跑一次真实的 electron-builder**：`stage.mjs` 与
  `update-payload.mjs` 都已就位，但把两者串起来需要 `desktop/node_modules`
  里的 Electron 与 `@electron/asar`（本环境未安装）。
- **健康探针已接线且是声明式的**（`health.mjs`）：规格从
  `process-manifest.mjs` 派生、只允许回环、带身份断言；端口取**实际读数**
  （`desktop-bridge.mjs` 透出 `launcher.status()` 的 `port`，经
  `readLauncherPorts` 进规格），拿不到就不写规格（fail-closed）。
  仍未验证的是**在真实进程树**上跑一遍：真实端口读数这条链
  （Launcher `status()` → bridge `publicStatus` → `readLauncherPorts`）
  目前只有单元级证据，没有一次"真起来四个服务然后验它们健康"的实测。
- **在途任务读数已接线**（`task-state.mjs` + `task-readings.mjs`）；
  仍有的一步是**在真实 team-hub 上端到端跑一次**：真起一个带任务的
  team-hub，确认 `/api/board` 的响应形状与 `boardTasksFromPayload`
  的判据一致（目前这条用的是合成响应，形状取自 `read-models.mjs`
  的路由定义与 `server.mjs` 的 `STATUSES`）。
  这一次实测能一次性回答两件事：真实响应的字段名、以及"有任务在跑时
  升级确实被拦住"。

## 6.1 仍缺的接线（按上面那条模式逐条问"有生产方吗"）
- **`desktop/main.mjs` 的单实例互斥未与 helper 协调**。一次升级期间如果
  用户手动再开一次 Legion，第二次启动会被 Launcher 的维护闸门挡住（那是
  对的），但界面只会显示维护状态，不会提示"正在升级，请稍候"。
- **未接 CI 的真实 Electron 运行**。桌面端用例全部不依赖 Electron
  （`update-service.mjs` 延迟导入它），所以"面板窗口真的能加载"这件事
  没有自动化证据。
- **阶段 D 的全部内容**（签名真安装包、干净机器安装、N-1→N、文件占用与断电
  故障注入、召回演练，以及生产 HTTPS 源、存储商、签名发布方、公钥与责任人）。
  设计 §10 要求真机验收，而测试替身的成功**不能**替代它——详见 §6。
- ~~恢复没有面向用户的入口~~ → **已做，见 §5 的 ㉘**。
  曾经的状态是：设计 §8 失败表最后一行要求「保持维护模式；提供向前修复**或明确的
  数据备份恢复入口**」，而 `restoreSnapshot` 虽然导出了、有用例、逐文件对账，
  用户侧的入口却只有 `docs/DEPLOY.md` §6 的手工步骤（停 hub → 删 `-wal`/`-shm`
  → 换 `team.db`）——"**入口还没有做成产品里的一件事**"。
  本轮补上了 `product/update/recovery.mjs`（三档安全性判定）+ `--recovery-plan`
  / `--restore-backup=<id>` / `--confirm-restore` 三条 CLI 开关 + 退出码 12/13。
  早先那个"从来没被调用"的 `helper.mjs` 的 `restoreSnapshotImpl` 也已经删掉了
  （它的名字恰恰会让人以为这条自动恢复已经实现了）。
  ★ 仍然没做的是**界面上的那个按钮**（托盘/设置页里的"从备份恢复"）——
  现在它是一条 CLI 入口，而 §8 line 190 要的是"明确的数据备份恢复入口"，
  没有规定它必须在界面里。
- **公钥轮换只做了"发布期"那一半，没有做"运行期"那一半**。㉖ 补上的是
  `keygen apply`：把旧钥匙签的增量应用到**随包信任表**上，产出一份新的
  `update-trust.json` 供下一版客户端打包。**没有做**的是让一台**已经装好的**
  客户端从盘上某处读一份增量并原地应用（`envelope.applyTrustUpdate` 支持它，
  但没有任何运行期调用方）。
  ★ 这一条**不是**疏忽，而是一个需要明确授权的部署决定：设计 §5 line 128 同时
  写着「首期**不提供远程任意替换信任根**的入口」，而"从盘上哪个路径读增量、
  谁有权写那个路径"决定了它是不是一个远程入口。发布期那一半已经把轮换这条路
  走通了（新钥匙签的清单真的能被接受），运行期那一半等授权再定。
- **`releaseId` 被复用没有专门的读数**。设计 §5 line 78：「`releaseId` 唯一且
  不可覆盖；同版本不同字节也必须使用不同 `releaseId`，并**禁止客户端把它当成
  常规同版本更新**」。客户端持久化的只有**通道 sequence** 高水位
  （`channel-sequence.json`），而 `judgeSequence` 只在
  `sequence === previous.sequence` 时比对摘要——**sequence 一涨就不再比对**。
  所以"同一个 releaseId 换了字节"会在**装的那一刻**被 ⑲ 的重查拦下
  （`releaseId` 相同而 `manifestSha256` 不同 → 走 `update-target-recalled`），
  安全性成立，但**报出来的原因是错的**（说"被撤回"，而实际是"发布端复用了
  releaseId"）。

  ★★ **不要用"加一条 `releaseId → manifestSha256` 的绑定并拒绝变化"来修它。**
  那会把一个**合法**动作一起判红：设计 §9 line 206 明确允许「签名清单定期
  续签可由 CI 定时任务执行」——续签会改 `issuedAt`/`expiresAt`，
  于是**同一个 releaseId 的清单字节必然变**。一条"releaseId 的摘要不许变"的
  判据会让每一次正常续签都变成一次攻击告警，而告警疲劳正是这类判据最常见的
  死法。

  所以正确的修法是**把两件事分开**：续签（内容不变、字节变）与换包
  （内容变、releaseId 也该变）。前者要放行，后者要具名拒绝。而"内容有没有变"
  不能看清单字节——要看清单**内部**已经签名的那几个字段（`package.sha256`、
  `productManifestSha256`、`productVersion`）。那是一个需要新读数的小功能
  （把每次接受的 `releaseId → 内容摘要` 记在 `channel-sequence.json` 的同一
  条记录里，`judgeSequence` 在 sequence 前进时比它），本轮没有做——但**前提
  已经查清了**：值不值得做取决于"发布端会不会复用 releaseId"，而这不是本仓
  能回答的问题。

  > 一条"这个值不许变"的判据，在**这个值本来就会合法地变**的时候，
  > 收获的不是安全，而是把它关掉的理由。

### 6.1.1 "沉默的判据"：有开关、有实现、**没有要求**

下面这些是上面那条模式的**弱形式**。它们的形状一样（一个判据的输入在生产里
没有来源），但**方向相反**：这里没有"承诺没有兑现"，因为**没有任何承诺**——
设计要求里没有那一条，产品清单里也没有承载它的字段。所以修法不是"接上生产方"
（那会变成**发明**一条策略），而是**把它记下来**，让读代码的人不会以为它在生效。

| 位置 | 参数 | 现状 | 为什么**不是**缺陷 |
|---|---|---|---|
| `preflight.mjs` `checkCompatibility` | `minDshVersionMajor` | 默认 `null` = 不设下限，生产里无人传 | 设计 §里没有"最低 DSH 主版本"这条要求，也没有字段承载它。与 `minWindowsBuild` 的区别正在这里：后者**是**设计要求，且清单里有字段 |
| `preflight.mjs` `checkDiskSpace` | `diskPolicy` | 默认 `DEFAULT_DISK_POLICY`（3×/2×/64MiB） | 它是一条**策略**而不是一个读数：默认值本身就是"正确的那一个"，所以判据仍然成立 |

对照之下，⑭ 的 `minWindowsBuild` 之所以是真缺陷，恰恰因为设计**要求**了它、
清单里也**有**那个字段——**要求存在、载体存在，而链接不存在**。

  > "有开关没接线"与"没要求所以没线"，在源码里长得一模一样，
  > 而它们该做的事相反：前者要接上，后者只需要被说出来。

### 6.1.2 查过而**没有问题**的五处（写下来是为了下次不用再查）

审计里有五处看起来像缺陷、逐条查过之后确认是好的。记在这里，免得下一个人
（包括我自己）再花一次时间：

1. **桌面协议与 bridge 的覆盖是双向完整的。** 协议表里 12 个类型，bridge 逐个
   有分支；而"类型在表里、bridge 没有分支"的那条路也不会静默——它落到
   `desktop-bridge.mjs` 末尾一个**具名拒绝** `UNKNOWN_TYPE`，不是不回应
   （不回应会让客户端等到超时，症状会指向"Launcher 卡住"）。
   另一个方向由 `desktop/update-wiring.test.mjs` 的判据守着：**接线层发出的
   每一条命令都必须被真实协议认得**——⑳ 就是缺了这一条才没被发现。
2. **`releaseId` 与清单摘要的绑定不缺**（缺的是另一件事，见 §6.1 那一条）。
   `judgeSequence` 在 `sequence` **相同时**比对 `(releaseId, manifestSha256)`
   这一对，所以"同一个 sequence 原地换包"会被拒（`feed-sequence-conflict`，
   `feed.test.mjs` 有判据）。缺的是 `sequence` **前进时**的复用检测——而它的
   正确修法需要新读数，且**不能**写成"摘要不许变"（见 §6.1 与 §5 的 ㉖ 讨论）。
3. **设计 §8 line 189 的限定词「仅在旧版本兼容性**已被证明**时自动回退程序」
   是成立的**，而且是 fail-closed 的。这条我起初怀疑是 ㉗ 的同形（"丢限定词"）：
   `planRollback` 只把 `compatibility === 'breaking'` 的迁移算进"不能只回退程序"
   那一档，那么一份**根本没有声明** `compatibility` 的迁移会不会落进"全是
   additive"那一档、从而被允许回退？
   **不会**：`validateMigrationPlan` 在更早的地方就以
   `if (!COMPATIBILITY.includes(m.compatibility)) → PLAN_INVALID` 把它拒了
   （`migration.mjs` line 187，与 line 129 同一判据）。所以"没声明"既到不了
   `planRollback`，也不会被读成 additive——这正是"必填字段"该有的样子。
   ★ 这个方向值得学：**限定词的安全与否，取决于"缺失"落在哪一档**。
   落进"允许"就是漏洞，落进"拒绝"就是判据。
4. **设计 §8 line 192 的「用户工作空间**永远**不作为安装覆盖或自动恢复目标」
   是结构性成立的**：切换目标是 `installRoot` 下的版本目录，恢复目标是
   `DataDir`，而工作空间（`LEGION_WORKSPACE_DIR`）从来不是这两者任何一个的
   参数。另外 `isOutsideSwitchTarget()` 还挡住"helper 落在待切换目录里"
   （设计 §7 line 57），三个方向都有具名判据。
   这不是"某处写了 if"，而是"**那个值根本没有流到那两个操作里**"——
   对"永远不许"这类要求来说，这比一条 if 更强。
5. **设计 §5 line 114 的一致性循环里，有三个字段在真实链路上"到不了"——
   但**各自有更早的判据拦着**，所以不是缺陷。** 用探针把五个字段的分歧各造
   一遍，实测出**实际**的拦截者：

   | 分歧 | 实际拦截者 |
   |---|---|
   | `release.channel=canary` | `release-identity-mismatch`（**就是那个循环**） |
   | `feed.productVersion=1.2.0` | `release-identity-mismatch`（**同一个循环**） |
   | `release.platform=linux` | `release-bad-field`（`KNOWN_PLATFORMS` 白名单，更早） |
   | `release.arch=arm64` | `release-unsupported-platform`（更早） |
   | `feed.platform`/`feed.arch` | `feed-bad-field`（通道清单与本机平台/架构是否一致，更早） |
   | `releaseId`（两个方向） | `feed-bad-path`（`manifestPath` 里嵌了 releaseId，更早） |

   ★ 结论有两层。**第一层（安全性）**：五个字段全都被拦，没有裸的。
   **第二层（用例怎么写）**：只有 `channel`/`productVersion` 会真的走到那个
   循环，所以用例**只断言那两个**，另写一条把平台/架构的边界记清楚。

   把到不了的那三个也写进用例，会得到三条"由别的判据满足"的绿灯——
   它们看起来在守这条循环，实际没有：

   > 一条由**别的判据**满足的断言，比没有断言更糟：
   > 它让人以为这条路径被守住了。


★ 另外记一条**前存**观察（不是本次改动引入的，也不是缺陷）：
`product/launcher/desktop-protocol.mjs` 与 `desktop-bridge.mjs` 没有本仓约定的
装载期 `*_CHECKED` 自检。它们的对齐是由用例守着的（上面第 1 点）。
补自检是独立的一件事，顺手加会让这份改动的边界说不清。

## 7. 复现证据

```bash
# 全部自动更新相关用例（644 条）
node --test product/update/*.test.mjs product/upgrade/*.test.mjs \
  desktop/update-*.test.mjs desktop/main.test.mjs \
  scripts/update/*.test.mjs product/launcher/update-gate.test.mjs \
  product/launcher/desktop-bridge.test.mjs product/launcher/desktop-protocol.test.mjs \
  product/launcher/launcher.test.mjs \
  scripts/update/rotation.test.mjs \
  desktop/scripts/shell-files.test.mjs desktop/scripts/update-payload.test.mjs

# 全链路集成（发布 → 托管 → 检查 → 下载 → 事务 → helper → 提交）
node --test product/update/integration.test.mjs

# 接线层：六个读数的生产方 + 协议对齐
node --test desktop/update-wiring.test.mjs

# 错误码文案表的完备性
node --test product/update/errors.test.mjs

# 各模块的装载期自检汇总（22 层）
node -e "import('./product/update/index.mjs').then(async m => console.log(JSON.stringify(await m.selfCheckAll(), null, 2)))"

# 打包闭包判据
node --test desktop/scripts/shell-files.test.mjs

# 全量 CI（含九道门禁）。`--out` 省略时会落到 `.ci/<时间戳>/`，而 `.ci/` 在
# .gitignore 里——产出物不该进版本库。
node scripts/ci/run-ci.mjs
```

### 7.1 全量 CI 的实际读数（`723b36b5`，65 分钟）

```
syntax PASS   env FAIL   boundary FAIL   deps PASS   build PASS
test   FAIL   smoke PASS  stage PASS      doc PASS
```

**本分支自己的套件是全绿的**，包括门禁跑的那一份（不是我在本地挑着跑的子集）：

```
PASS product-update（自动更新：协议验签、下载缓存、状态机、事务与恢复）
     exit=0 tests=361 pass=361 fail=0 skipped=0
```

★ 那 361 条与我在本地按**同一份文件清单**跑出来的数字**逐字相同**。这一点值得
单独记：门禁跑的是它自己在 `run-ci.mjs` 里列的清单，而"我本地跑过了"通常指的
是另一个集合。两个数字对上，才说明"我验证过的"与"门禁验证的"是同一件事。

`test` 阶段在这一台机器上共 **45 个套件红**（242 个套件绿）。这 45 个**不属于
本分支**，判据分两层：

**① 与我的改动相邻的那些，逐条在基点 `a8ff20de` 上对过账，读数完全相同。**

| 文件 | 分支 | 基点 `a8ff20de` |
|---|---|---|
| `product/launcher/runtime-contract-wiring.test.mjs` | 3 过 / **9 失败** | 3 过 / **9 失败**（失败用例名逐条相同） |
| `product/launcher/enforcement-identity.test.mjs` | 22 过 / **1 失败** | 22 过 / **1 失败** |
| `scripts/config/config.test.mjs` | 47 过 / **6 失败** | 47 过 / **6 失败**（失败用例名逐条相同） |
| `scripts/ci/dsh-boundary.mjs` | **8 处**违规 | **8 处**违规 |
| `scripts/config/scan.mjs --check` | **187 项** | **187 项** |

`product-launcher` 这个套件（396 条、386 过、**10 失败**）里的 10 条正好就是上表
前两行那 10 条；而**本轮新加的两条 launcher 用例在这个套件里是过的**：

```
✔ suspendClaiming／resumeClaiming：只有真正**在跑**时才认为"停掉/恢复"成功
✔ suspendClaiming：本次启动**不含** orchestrator → skipped 而不是失败
```

这几条是"我可能碰到的地方"，所以**必须**逐条对账，而不是"看起来像环境问题"。
它们全部是**真进程／真 DSH 检出／真浏览器**那一类，在本机同时跑几十个真进程时
超时被杀（`test` 阶段 3 766 秒里有相当一部分是 300 秒超时）。

★ 另有一条**与门禁清单有关**的读数：`套件清单不完备：33 个 *.test.mjs 不会被
任何套件执行`。那 33 个里**没有一个是本分支新增的**——本轮新加的
`product/update/feed.test.mjs`、`product/update/errors.test.mjs`、
`product/update/integration.test.mjs`、`desktop/update-wiring.test.mjs`、
`scripts/update/rotation.test.mjs` 逐个查过，全部已登记。
"新增用例必须登记，否则它等于不存在"这件事这次做到了。

**② 其余的红灯分布在我**完全没有碰过**的目录**：`team-hub/routes`、
`workbench/scripts`、`runtime/contracts`、`run-plane`、`route-family`、
`role-pack`、`metrics`、`experience`…。本分支的 diff 只落在
`product/update/`、`product/upgrade/`、`product/launcher/`（三个文件）、
`desktop/`、`scripts/update/`、`scripts/config/scan` 的登记项与文档。

★ 这一条也解释了**为什么本地子集全绿不等于 CI 绿**：门禁会跑 287 个套件，
其中相当一部分要求真 DSH 检出、真浏览器、以及足够的机器资源。所以"我跑过了"
这句话在本仓里必须说清楚**跑的是哪一份**——本文件的 §7 命令是更新相关的子集，
而上面那 344 条是**门禁那一份**。

### 7.2 那两道静态门禁为什么红（前存债务，逐条对过账）

`env` 与 `boundary` 在本分支上是红的。逐条在
本分支的基点 `a8ff20de` 上核对过，**数量与内容完全相同**，所以它们是前存
债务，不是这次工作引入的：

| 门禁 | 现象 | 基点 `a8ff20de` | 本分支 |
|---|---|---|---|
| `env` | `scan --check`：未在 schema 中处理的字面量 | **187 项** | 187 项（修复前是 198） |
| `env` | `scripts/config/config.test.mjs` | 53 跑 / 47 过 / **6 失败** | 同左，且**失败用例名逐条相同** |
| `boundary` | `dsh-boundary.mjs` 边界违规 | **8 处** | 8 处 |

★ `env` 那 187 项里**曾经有 11 项是本分支的**（自动更新的错误码：七个网络
错误码、两个任务读数码、两个维护闸门码）。它们已登记进
`product/config-schema.mjs` 的 `nonEnvLiterals`，198 → 187 与本分支基点齐平。
剩下的 187 项分布完全在别处（`runtime/`、`plugins/`、`workflow-pack`、
`bundle` 等），处理它们是另一件事——顺手改会让这份改动的边界与理由都变得
说不清。

★ 核对方法（值得复用）：把基点检出一个临时 worktree，在上面跑同一条判据，
把两份输出逐行比对。**"我的改动让它变差了吗"这个问题，只有这个办法能回答。**

```bash
git worktree add --detach .tmp-basecheck a8ff20de
node scripts/config/scan.mjs --check    # 在两边各跑一次，取「未在 schema 中处理」那一行
git worktree remove --force .tmp-basecheck
```

### 7.3 真实托管上的实测（`117.72.146.36`，测试通道 `/test/legion`）

这是 `2026-10-04-update-host-bootstrap.md` 那台**已授权托管**上的第一次真实跑通。
在此之前本文件写的是「自动更新尚未在真实托管上跑通一次」。

**做法**（严格按设计 §9 的顺序：不可变文件先传、回读核对、**最后**换通道指针）：

```bash
# 0. 托管配置的实际验收（设计 §4 line 79「CDN 配置必须实际验收」）——纯只读
curl -sI http://117.72.146.36/healthz                    # 200 + cache-control: no-store
curl -sI http://117.72.146.36/test/legion/feeds/         # 404（目录索引已关）
curl -s -X POST http://117.72.146.36/test/legion/x       # 403（只允许 GET/HEAD）

# 1. 生成一对**测试用**密钥并出一份签名发行（与正式密钥无关）
node scripts/update/keygen.mjs new --key-id test-host-2026 --out ./keys --write-private
node scripts/update/publish.mjs --product-version 1.1.0 --channel internal \
  --release-id rel-hosttest-1.1.0 --from-version 1.0.0 \
  --dsh-patch-bindings 0.8.3:2 --package-root ./payload \
  --key-id test-host-2026 --private-key ./keys/….key.pem \
  --sequence 1 --issued-at <2 小时前> --expires-at <30 天后> \
  --target test --out ./dist          # ★ --target 必须显式给（见 §5 的 ㉔）

# 2. 先传不可变文件，回读核对，**最后**单对象替换通道清单
#    （命令由 dist/upload-plan.txt 给出，顺序写死在那份文件里）

# 3. 公网回读 + 真实客户端
node scripts/update/verify-host.mjs --origin http://117.72.146.36 --prefix /test/legion \
  --channel internal --allow-insecure-http --trust ./trust.json --expect-sequence 6
```

**结果**

| 项 | 读数 |
|---|---|
| `verify-host`（对真实托管） | **exit 0，14 项全 PASS**（含 `feed-cache-policy`、`release-digest`、`release-signature`、三个产物可达性） |
| 真实客户端 `check()` | `available`（`feed-newer-available`，发现 1.1.0 ← 本机 1.0.0） |
| 真实客户端 `download()` | `ok`，且**本地文件摘要 == 签名清单声明的摘要**（`54fb6f618e57…`） |
| 就绪状态 | `ready === true` |
| 安装交接（⑲ 的通道重查通过后） | `ok` |
| 负向：未知 keyId | `envelope-unknown-key`（拒绝）✓ |
| 负向：正确密钥 | 通过 ✓（证明上一条不是"什么都拒"） |
| 负向：篡改一个字节 | `envelope-bad-signature` ✓ |
| 负向：过期 | `envelope-expired` ✓ |
| **撤回演练** | 已下载目标点安装 → **`update-target-recalled`**，候选被取消、就绪清空；恢复通道后 check/download/install 全部恢复 ✓ |
| 托管缓存头（审计记录） | 通道清单 `no-store`；发行文件 `public, max-age=31536000, immutable` —— 与设计 §4 line 79 逐条一致 |
| **生产树** | **0 个文件**（本次只写测试树） |

**这次联调本身抓到一个缺陷（㉔）**：`publish.mjs` 的上传计划把远端根**写死**
成 `…/production/legion`，与通道无关。于是一次 `--channel internal` 的发行会
生成一份**指向生产树**的上传指令。这不是读代码能看出来的——是把它跑起来、
看到生成的那份计划才发现的。修法与判据见 `12ed27c3`。

  > 光读代码看不出来，是把它跑起来才看见的。

**留下的东西**：测试树上有 `rel-hosttest-1.1.0` 与 `feeds/internal/win-x64.json`
（由一把**测试密钥**签名，而那把密钥不在任何出厂信任表里，所以没有真实客户端
能消费它）。要清掉只需要删测试树下的 `releases/rel-hosttest-1.1.0` 与
`feeds/internal/win-x64.json`。**生产树没被动过。**

**这次联调没有改变的两件事**：① 生产通道仍然必须是 HTTPS（测试通道走 HTTP
+ `allowInsecureHttp`，是计划文档允许的那条路）；② 阶段 D 的真机验收仍然没做。

### 7.4 设计 §10 那九行验收表的覆盖图

这张表是**这份记录最该被读的一节**：它逐行说清"这一行现在有什么证据、
证据到哪一层、还差什么"。凡是没有证据的行，这里都直接写"需要真机"。

| §10 的行 | 现在的证据 | 还差什么 |
|---|---|---|
| ① 无更新、离线、超时、CDN 返回旧清单 | 用例：`feed.test.mjs`（回退/冲突/分键）、`client.test.mjs`（离线/超时/旧清单）；**真实托管**上验过"通道存在且可读到准确结果" | 真机上"CDN 真的返回旧清单"的端到端（需要能操纵 CDN 的部署） |
| ② 清单伪造、未知 keyId、过期、sequence 回退 | 用例 + **真实托管**：未知 keyId（`envelope-unknown-key`）、改一字节（`envelope-bad-signature`）、过期（`envelope-expired`）三条都实测拒绝 | sequence 回退只在用例层（真实托管上没造过回退清单） |
| ③ 包被替换、错误签名、错误平台、磁盘不足、ZIP 越界 | 用例：`client.test.mjs`（包被替换 → 不提交）、`publish.test.mjs`（回读发现包被换过）、`extract.test.mjs`/`zip.test.mjs`（越界/炸弹/摘要）、`preflight`（磁盘/平台）；**真实托管**上下载的字节摘要与签名清单逐字相符 | 真机上"托管真的被写坏"的演练 |
| ④ 重复点击、多个窗口、下载中发现新版 | 用例：`client.test.mjs`（一次事务、确认目标一致） | 真机上的多窗口交互 |
| ⑤ 有任务运行、不能安全取消、服务拒绝退出 | 用例：`install.test.mjs`（在途任务超时 → `not-started` + 恢复认领；服务拒绝退出 → 维护态）、`desktop/update-wiring.test.mjs`（drain 轮询与词表） | 真机上真起任务再升级 |
| ⑥ SQLite WAL、附件写入、迁移失败、补丁失效 | 用例：`install.test.mjs`（备份在停认领之后、WAL 一致快照、失败落点）、`upgrade/backup.test.mjs`、`migration` 摘要门禁；**本仓已有实测**（`DEPLOY.md` §6.1 / PRT-006）证明"只拷 .db 会静默丢数据" | 真机上真库真迁移 |
| ⑦ 切换或迁移期间断电、helper 崩溃、指针损坏 | 用例：`journal`/`install.test.mjs` 的恢复判定（`recovery-*` 五种 verdict 都有用例）、`helper.mjs` 的失败落点<br>**恢复入口**（§8 失败表最后一行要求的那一个）：`recovery.test.mjs` 16 条 + `cli-recovery.test.mjs` 9 条 + `--recovery-plan`/`--restore-backup`/`--confirm-restore` + 退出码 12/13 | **断电注入需要真机**（第 7 行是这一组里最硬的一条） |
| ⑧ 错误发布撤回、清单续签、公钥轮换 | **撤回**：真实托管上实测（已下载目标 → `update-target-recalled`，候选取消）<br>**续签**：`feed.test.mjs` 明确判为接受<br>**公钥轮换**：`rotation.test.mjs` 端到端（旧钥匙签增量 → 应用 → **新钥匙签的清单被接受**）+ 三条负向 | 运行期原地接受轮换（见 §6.1 里如实记下的边界）；真机上"旧客户端消费" |
| ⑨ 干净机器首次安装及 N-1 → N | **没有任何证据**——需要真机 | 全部 |

★ 这张表本身也是判据：它让"某一行其实还没有任何证据"变得**看得见**。
一个只在 §6 里写着"阶段 D 未执行"的清单，与一张逐行标出"第 ⑨ 行证据为空"的
表，对读者的作用完全不同。

★ §8 的失败表还有**最后一行**（它不在 §10 的九行验收表里，但同样是一条要求）：
「不兼容迁移、恢复证据不足或恢复失败 → 保持维护模式；**提供向前修复或明确的
数据备份恢复入口**」。这一行现在有了落点：见 §5 的 ㉘ 与 §7.4 的第 ⑦ 行。




