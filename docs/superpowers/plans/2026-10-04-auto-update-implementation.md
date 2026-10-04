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

## 6. 明确**还没有做**的部分

设计 §10 说「每阶段记录实际证据；**测试替身通过不能替代 Windows 真机升级
验收**」。据此如实列出：

- **阶段 D 未执行**：没有签名真实安装包，没有干净机器首次安装 + N-1 → N
  实测，没有文件占用/断电故障注入/撤回演练。§10 的九行验收表里，
  第一、三、五、六、七、九行都**需要真机**才能给出结论。
- **自动更新尚未在真实托管上跑通一次**。`scripts/update/verify-host.mjs`
  可以对 117.72.146.36 运行，但那里目前只有空目录（计划文档：
  「未发布任何版本、安装包或生产清单」）。
- **没有生产 HTTPS 入口**。设计 §11 的"部署时填写"（域名、存储供应商、
  签名发布者、公钥、责任人）仍未填写；仓库里只有
  `product/release/update-config.example.json` 与 `update-trust.example.json`。
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

## 6.0 一个反复出现的模式（三个缺陷同源）

⑪ 与 ⑫ 是同一个模式的两次出现，而 ⑧（`{teamHubPort}` 未展开）也是它的
变体：**一个判据的输入在真实链路上不存在，而测试夹具把它补上了。**

它们的共同症状是"测试全绿、真实链路一次都跑不通"，而共同的表现是
**fail-closed 到永远失败**——安全，但功能为零。三处的处置也都是同一条：
把读数**从真实来源派生**（不是手写清单、不是猜默认值、不是从本机推断），
并在缺失时给出**说得出原因**的失败。

所以本文件的"仍未验证"一节要按这条模式读：凡是"有生产方吗"这个问题的
答案只是"某个测试给了它"，那一条就还没有被验证。

## 6.1 一次发布的完整顺序（现在都有落点）

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

## 6.2 仍缺的接线（按上面那条模式逐条问"有生产方吗"）
- **`desktop/main.mjs` 的单实例互斥未与 helper 协调**。一次升级期间如果
  用户手动再开一次 Legion，第二次启动会被 Launcher 的维护闸门挡住（那是
  对的），但界面只会显示维护状态，不会提示"正在升级，请稍候"。
- **未接 CI 的真实 Electron 运行**。桌面端用例全部不依赖 Electron
  （`update-service.mjs` 延迟导入它），所以"面板窗口真的能加载"这件事
  没有自动化证据。

## 7. 复现证据

```bash
# 全部自动更新相关用例（130 条）
node --test product/update/*.test.mjs desktop/update-*.test.mjs \
  scripts/update/*.test.mjs product/launcher/update-gate.test.mjs \
  desktop/scripts/shell-files.test.mjs

# 各模块的装载期自检汇总（17 层）
node -e "import('./product/update/index.mjs').then(async m => console.log(JSON.stringify(await m.selfCheckAll(), null, 2)))"

# 打包闭包判据
node --test desktop/scripts/shell-files.test.mjs
```
