# G-mvgf01af-4 · 测试报告（T-214 审查返工第 1 轮）

> 阶段：implement（coder）｜分支 `w/T-214`｜上游复核：T-213 审查未通过（3 项必改 + 真机证据缺口）
> 设计输入：`docs/G-mvgf01af-4/REQUIREMENTS.md`（T-211，LF 规范化 sha256 `8264b19d…e1559`）

## 1. 本轮改了什么（对应 T-213 的 3 项必改）

| # | 缺陷 | 修复落点 | 回归判据 |
| --- | --- | --- | --- |
| P1 | 切 Agent 沿用旧滚动位置，并把历史算成新消息 | `resetConversationView()` + `chatFollowPending` + `refreshTimeline` 的 `firstLoad` | `app-integration.test.mjs` 前 3 条 |
| P2 | 全部看板切页签丢当前列滚动 | `saveTasksScroll()` + `interaction.mjs` 的 `boardScrollRestore()` | `app-integration.test.mjs` 第 4/5 条 + `interaction.test.mjs` 新增 3 条 |
| P2 | 手势取消仍提交切列、多指遗留轨道偏移 | `cancelBoardGesture()` + `pointercancel` 独立处理 + 多指作废 | `app-integration.test.mjs` 后 4 条 |
| P1 补充 | 启动屏后台预载历史时提前消耗首次滚底，首屏把旧消息算作新消息 | `applyTimelineScroll()` 等待应用屏可见；`showView()` 落屏后执行首次滚底 | `app-integration.test.mjs` 启动屏回归判据 + Chrome UI 检查 |

顺带（审查 P3 建议）：更正 `docs/MOBILE-ACCESS-RUNBOOK.md` 与 `docs/FEATURES.md` 里
「下拉关闭详情」这句不实的文案；`scripts/qa/mobile-ui-check.mjs` 原来**主动点掉**首载浮标，
把「首载把历史算成新消息」这个缺陷抹平了，现改为断言。

## 2. 命令与结果（worktree `w/T-214`）

```text
node --test --test-reporter=tap <14 个 mobile 测试文件及 5 个 workbench/scripts 测试文件>
npm run build --prefix workbench
node scripts/qa/mobile-ui-check.mjs
```

结果：**19 个套件 351 条判据全部通过**，0 失败；TypeScript 与 Vite 构建成功。
真实 Chrome 的移动设备仿真 UI 检查全部通过，包括 7 档宽度无横向溢出、
点击命中区、看板手势、详情焦点、首次载入历史不显示新消息提示，及后续 5 条新消息的计数和返回底部。
其中本轮新增 13 条（`app-integration` 10 条 + `interaction` 3 条）。

先前受限执行环境中的 `esbuild spawn EPERM` 不再出现，本次本地构建 exit 0。

## 3. 破坏性验证（判据真的抓得住缺陷）

把 `git show 61a10991:workbench/mobile/app.mjs`（修复前）放进临时目录，跑同一批
`app-integration.test.mjs`：**9 条里 7 条失败**，失败点正是三个缺陷——
`已经在可见状态落过底` / `等对话可见再落底` / `Expected values to be strictly equal` /
`取消不提交切列` / `第二指按下后第一段手势作废` / `切页签要清手势`；
2 条通过的是「正常 pointerup 仍然提交」「列已经变了退回该列位置」这类对照项。

## 4. 没做到的（不冒充）

- **实体手机走查未执行**：上述 UI 检查在真实 Chrome 的移动设备仿真中执行，
  不等同于实体手机的触屏和软键盘检查。
- **根目录 `node --test`** 的失败/超时仍是上游已披露缺口，本轮未触碰。
- 软键盘/地址栏变化、200% 缩放、读屏走查仍缺设备证据（与 T-213 的观察一致）。

## 5. 参考的团队经验

- T-213 审查报告：三项必改的复现口径（内存桩执行冻结源码原函数）被固化成 `app-integration.test.mjs`。
- T-212 经验草稿：真机证据与自动回执要分开写，没有真机跑步就不写「真机通过」。
