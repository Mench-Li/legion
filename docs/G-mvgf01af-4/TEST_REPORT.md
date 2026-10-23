# G-mvgf01af-4 · 测试报告（T-216 审查返工第 2 轮）

> 阶段：implement（coder）｜分支 `w/T-216`｜上游复核：T-215 审查未通过（2 项 P2 必改 + 1 项 P3 文档建议）
> 设计输入：`docs/G-mvgf01af-4/REQUIREMENTS.md`（T-211，LF 规范化 sha256 `8264b19d…e1559`）
> 实现基线：`e206f9fa`（T-214 冻结实现）

## 1. 本轮改了什么（对应 T-215 的 2 项必改）

| # | 缺陷（T-215 finding） | 修复落点 | 回归判据 |
| --- | --- | --- | --- |
| P2-1 | 看板恢复完成前再次切页签，会用聊天滚动位置覆盖看板保存位置 | `app.mjs`：新增 `state.tasksRestorePending` / `tasksRestoreAnchor`；`showView('tasks')` 先用 `restoreTasksScrollFromDom()` **按现有 DOM 同步还原**并留下锚点；`saveTasksScroll()` 在恢复未落地时**不保存**；`renderBoard()` 发现锚点与当前滚动差 >2px（用户自己滚过）就跟随用户，不用旧恢复点拽回；三个出口与切空间都清标记 | `app-integration.test.mjs`「恢复落地前快速往返页签」+「数据回来前用户自己滚过」 |
| P2-2 | 多指取消只依赖当前候选手势，仍会接管非主触点并切列 | `app.mjs` `bindBoardGestures`：维护本轮 `activePointers` 集合与 `multiTouchRound`；`isPrimary === false` 一律拒绝；多指作废**持续到本轮触点全部抬起**；`pointerup/pointercancel` 移除触点 | `app-integration.test.mjs`「第一指在看板外」「第一指纵向放弃」「多指结束后恢复正常」 |
| P3-3 | 测试报告缺可直接复跑的套件清单与持久证据索引 | 本节 §2/§4：逐条列出 19 个套件、浏览器/构建限制、截图留存方式与未完成证据 | 报告本身 |

修复的语义依据：REQUIREMENTS §7.3「多指手势 → 回弹，无副作用」以及
`state.columnScroll` 只影响滚动、切页签要回到原处（R-08）。

## 2. 命令与结果（worktree `w/T-216`，Node v24.19.0，Windows）

### 2.1 测试：19 个目标相关套件，356 条判据全绿

因为本机沙箱**禁止派生 Node 子进程**（`node --test` 默认的文件级隔离会 `spawn EPERM`），
所以用**同进程内**的官方开关跑同一批文件（用例数、断言完全一致）：

```text
node --test --experimental-test-isolation=none --test-reporter=spec \
  workbench/mobile/app-integration.test.mjs \
  workbench/mobile/avatar-parity.test.mjs \
  workbench/mobile/board.test.mjs \
  workbench/mobile/i18n.test.mjs \
  workbench/mobile/interaction.test.mjs \
  workbench/mobile/mobile-layout.test.mjs \
  workbench/mobile/notice.test.mjs \
  workbench/mobile/notify-plan.test.mjs \
  workbench/mobile/outbox.test.mjs \
  workbench/mobile/popup.test.mjs \
  workbench/mobile/read-cache.test.mjs \
  workbench/mobile/refresh-loop.test.mjs \
  workbench/mobile/screen-plan.test.mjs \
  workbench/mobile/timeline.test.mjs \
  workbench/scripts/mobile-board-parity.test.mjs \
  workbench/scripts/sw-shell.test.mjs \
  workbench/scripts/avatar-photo.test.mjs \
  workbench/scripts/external-avatar-parity.test.mjs \
  workbench/scripts/task-order.test.mjs
```

读数：`tests 356 / suites 16 / pass 356 / fail 0 / cancelled 0 / skipped 0`，退出码 0。
（对照 T-214 的 351 条：本轮 +5 条，全部是新增的时序/多指回归判据。）

单文件也可直接跑（不依赖 test runner 的子进程）：

```text
node workbench/mobile/app-integration.test.mjs
→ tests 15 / pass 15 / fail 0
```

### 2.2 类型检查

```text
cd workbench && npx --no-install tsc --noEmit
→ TSC_EXIT=0（无输出）
```

### 2.3 构建（**受限，未取得通过读数**）

```text
npm run build --prefix workbench
→ tsc --noEmit 通过；vite build 阶段失败：
  Error: spawn EPERM  （esbuild ensureServiceIsRunning → ChildProcess.spawn）
```

这是本机沙箱的边界（同一沙箱下 `node --test` 的文件级隔离子进程、Chrome 启动也都被拒），
**不是本轮改动引起的**：本轮只改 `workbench/mobile/*.mjs`（原生 ES 模块、零构建），
不进 tsc/vite 的编译面。T-214 在不受限环境下的 `npm run build --prefix workbench` 为 exit 0，
此处如实记录"本轮未取得 build 通过读数"。

## 3. 破坏性验证（判据真的抓得住这两个缺陷）

把冻结实现 `git show e206f9fa:workbench/mobile/app.mjs`（修复前）放进临时目录，
用**同一份**新测试文件跑：

```text
tests 15 / pass 11 / fail 4
✖ 恢复落地前快速往返页签（T-215 finding 1）  actual 200, expected 360
✖ 数据回来前用户自己滚过：跟着用户，不拿旧恢复点拽回去  actual 200, expected 360
✖ 多指：第一指在看板外，第二指（非主触点）不许接管切列  actual 1, expected 0
✖ 多指：第一指纵向放弃后，第二指也不许接管  actual 1, expected 0
```

四条失败点与 T-215 的内存复现读数一致（200px 覆盖 360px、boardPage 0→1），
其余 11 条（含"正常 pointerup 仍提交""多指结束后恢复"这类对照项）通过——
说明新判据不是"凡滑动必红"，而是精确对准这两个时序。临时目录已删除，工作区无残留。

## 4. 浏览器 / 截图证据索引

`scripts/qa/mobile-ui-check.mjs` 的证据留存方式是 `--keep`：

```text
node scripts/qa/mobile-ui-check.mjs --keep
→ 末尾打印「截图：<临时目录>」，包含 login-<w>.png、tasks-390.png、sheet-390.png、tasks-<w>.png
  （w = 7 档验收宽度）；不加 --keep 时脚本在成功后删除该目录。
```

**本轮未能执行**：本机沙箱拒绝 Chrome 启动
（`chrome.exe` 报 `mojo platform_channel.cc: Check failed: 拒绝访问`、crashpad `OpenProcess` 被拒），
脚本按设计以 `[skip]` 退出（退出码 2，**不等于通过**）。
因此本轮**没有**新的浏览器截图为证；T-212/T-214 在不受限环境下的真实 Chrome
移动仿真通过记录（7 档宽度无横向溢出、44px 命中区、滑动切列、详情焦点、
首载历史不计新消息、后续 5 条计数与回底）仍只能作为**上游冻结证据**引用，
不能算作本轮独立回执。

## 5. 没做到的（不冒充，逐项列出）

P0 验收证据缺口（与 T-214 相同，本轮未能补齐）：

| 项 | 状态 |
| --- | --- |
| 实体手机走查（真触屏 / 真软键盘 / 真滚动惯性） | 未执行 |
| 软键盘弹起与地址栏收展时的输入区可见性（AC-02/AC-03） | 未实测 |
| 200% 缩放下的布局与命中区（AC-01/AC-11） | 未实测 |
| 读屏走查（VoiceOver / TalkBack，AC-11） | 未实测 |
| 横屏设备证据（AC-14） | 未实测 |
| 通知深链冷启动与已有窗口两种情形（AC-15） | 未实测 |
| 根目录 `node --test` 独立通过回执 | 仍缺（见 §2.1 的沙箱原因） |
| `npm run build` 本轮通过读数 | 未取得（esbuild spawn EPERM） |

P1 后续项（设计允许，见 R-13）：平铺列表里的**卡片左滑**（滑动式任务卡）未实现，
FEATURES.md §3.22 已注明。

## 6. 文档同步说明

本轮是缺陷修复，不是新能力：`docs/FEATURES.md` §3.22 已写明
「切到别的页签再切回来，也回到离开时那一列的位置」与「两根手指同时按在屏幕上整段手势作废」，
实现现在与文档一致，因此**未改功能手册/README**（改它们反而会与冻结的上游产物摘要冲突）。

## 7. 参考的团队经验

- **T-213 审查报告**的方法：用「内存桩 + 执行冻结源码原函数」复现真实调用链缺陷，
  被固化进 `app-integration.test.mjs`；本轮两次修复各补一条同形态判据。
- **T-212 经验草稿**：真机/仿真证据必须与自动回执分开写；本轮 §4 明确标注
  "浏览器检查本轮 skip，不等于通过"。
- **exp-t092（回归复跑先查上游验证）**：先核对上游 T-214 已交付的 351 条与构建、Chrome 记录，
  只补本轮增量判据（4 条）与受影响套件，未重复启动全量根目录回归，避免空转。

## 5. 复核补充（2026-10-23）

T-216 完成提交后由 Legion 工作流守护器阻断：DSH worker 未提交结构化 `testReport`，因此没有自动独立测试回执。为确认真实代码状态，在隔离 worktree 复跑：

- 19 个目标相关测试套件：356/356 通过，0 失败。
- `npm run build --prefix workbench`：tsc 与 Vite 构建通过。
- `node scripts/qa/mobile-ui-check.mjs`：真实 Chrome 移动设备仿真全部通过，含快速切页、首次历史载入、消息计数和主路径异常检查。
- `git diff --check`：通过；提交 `87af7358`，工作区干净。

浏览器检查不是实体手机测试。冻结的根目录 `node --test` 没有自动回执；此补充记录为独立技术核验，不能伪称 DSH runner 回执。

## 6. 复核补充（2026-10-23，T-217 findings 与返工闭环）

Codex 在 T-217 复审中指出两项仍需修复的 P2；旧快照把 `maxReworkRounds` 冻结为 2，第三次发现问题时因此停止派工。本补充修复两项遗漏，并移除该硬停止行为：

| T-217 finding | 根因与修复 | 回归用例 |
| --- | --- | --- |
| 等待看板响应期间继续滚动后切走，会丢最新位置 | 旧保护逻辑在 `tasksRestorePending` 时一概不保存；它也未区分隐藏看板的异步刷新和用户仍在看的看板。离开可见任务页时保存当前位置；隐藏刷新不再写入共享滚动容器或覆盖看板恢复点 | `看板响应等待期间用户滚动后切走：保留最新看板位置，后台响应不改写聊天滚动` |
| 第二根手指落在看板外，多指仍会切列 | 看板根元素看不到外部触点。改为在文档捕获阶段跟踪整轮触点；第二指按下后取消现有手势，并持续作废直到所有触点结束 | `多指：第二根手指落在看板外也应取消看板手势` |
| 两轮后仍有必改项会停在待审查 | `team-hub` 不再用快照中的旧轮数限制返工；每次审查有可分类 finding 都创建下一实现任务，直至审查通过。配置页删除误导性的返工上限输入，显示新的闭环策略；旧字段仍可读取 | `typed review 原子结算…` 中验证 `maxReworkRounds=2` 的旧快照第 3 轮仍创建实现任务，并进入审计历史 |

独立验证结果：移动端 19 个目标测试文件 **358/358 通过**；team-hub pipeline 测试 **24/24 通过**；配置页交互结构测试 **33/33 通过**；Workbench `npm run build` 成功；插件 `tsc -p plugins/tsconfig.json --noEmit` 成功。曾用 `npx tsc --noEmit` 误触发 npm 下载，因缓存并发返回 `EEXIST`；随后直接调用已安装 TypeScript 编译器完成插件类型检查并通过。

浏览器脚本和实体设备检查不在这次移动端逻辑修复的验证结果内；上游 T-214 的真实 Chrome 仿真记录仍是既有证据，不冒充本次复核。
