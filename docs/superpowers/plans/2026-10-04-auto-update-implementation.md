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
- **helper 的 `unpack` 未接线**。解压 ZIP 到版本目录需要与桌面打包闭包
  对齐，目前 helper 会明确报 `helper-unpack-failed`（也就是"没有假装完成"）
  而不是切换一个不完整的版本目录。
- **健康探针未接线**。`healthProbe` 是一个函数，跨不过进程边界，必须由
  helper 在进程内构造；目前留空，helper 会把健康检查报成 `unsupported`
  并按"通过"继续——这一条在真机验收前必须补上，否则"新版本起来了但不健康"
  不会被发现。
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
