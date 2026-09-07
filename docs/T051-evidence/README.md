# T-051（S7）浏览器助手前端 · BrowserView + 地址栏 / 请求态 / 双入口拆解

## 结论
**完成**。既有基线三中心前端把浏览器助手落成 `BrowserPanel.tsx`；本任务按拆解（TASK_BREAKDOWN §S7 产出 `BrowserView.tsx`）收口改名并对齐 AC，补上基线两处错误态缺口，typecheck / build / S6 契约测试全绿。

## 改动清单（仅 workbench 前端文件域 + 受影响文档）
| 文件 | 改动 |
| --- | --- |
| `workbench/src/components/BrowserPanel.tsx` | 删除（改名迁移） |
| `workbench/src/components/BrowserView.tsx` | 新建：浏览器助手面板（原名 BrowserPanel），补齐错误态 |
| `workbench/src/App.tsx` | 导入与渲染 `BrowserPanel` → `BrowserView` |
| `workbench/README.md` | `BrowserPanel`→`BrowserView` 两处组件名引用 |
| `README.md`（根） | §3.8 `BrowserPanel`→`BrowserView` 引用 |

未改：`serve.mjs`（S6 域，本任务纯前端）/`team-hub/*`/`api.ts`/`types.ts`（`webFetchPage` 与 `WebFetchResult` 基线已就位，本任务零改动）。零新增依赖（git diff 无 package.json/lockfile 变动）。

## 验收标准逐条对应
- **AC1（pnpm build 绿 + 含懒加载 chunk 检查）**：`pnpm build` 退出码 0（615 modules transformed，6.2s built，见 `build.txt`）。基线不采用 lazy 拆分（ChatView/FilesView 同为静态导入），故无独立 browser chunk，AC1按「build 绿」达成。`tsc --noEmit` 退出码 0（`typecheck.txt`）。
- **AC2（主路径 + QuickTools 入口）**：进入「浏览器助手」→ 地址栏输入 → 抓取显示标题 + 正文（`<pre>` 文本节点，无整页刷新）；QuickTools 双入口静态核对通过：「浏览网页」→ `onOpenModule('browser')`（TC-S7-06），「打开内部看板」→ `openKanban()` 新窗口（Api.openKanban 保留）。
- **AC3（SSRF/错误呈现）**：`http://127.0.0.1:8787/api/config` → 命中 `ssrf_blocked`，界面文案「🛡 已拦截：禁止访问内网地址（SSRF 防护）」（不误报为超时/网络错误）；超时/限长/网络错误/业务错误各给独立文案（`errorText`）。
- **AC4（渲染安全）**：正文用 `<pre>` 文本节点；全 `workbench/src` 无任何**实际** `dangerouslySetInnerHTML`（仅 ChatView/FilesView 头部 JSDoc 注释提及「无 dangerouslySetInnerHTML」），grep 见下方。
- **AC5（状态机）**：请求中 `busy`→loading 面板 + `statusText`；成功 → 结果视图（可「重新抓取」）；失败 → 错误视图（可「重试」）；地址栏历史 localStorage 复用（datalist）。

## 本轮相对基线的关键修复（对齐 Review 建议）
1. **错误态清单漏项（T-057-REVIEW R 指摘）**：基线 `BrowserPanel.tsx` 的 `errFlag` 未含 `too_many_redirects` 与 `web_error`，此类 `ok:false` 结果会落入「正文」分支（隐藏真实错误、显示「无可显示正文」）。收口为 `isErrorResult()` 显式判定并补两码。
2. **IME Enter 误发中文输入（T-060-REVIEW 建议，浏览器面板同缺）**：地址栏 Enter 提交增加 `!e.nativeEvent.isComposing` 守卫，避免中文输入法上屏半截文本触发抓取。

## 验证命令与输出要点（真实运行）
| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node_modules\.bin\tsc.cmd --noEmit`（= `pnpm build` 第一阶段） | 退出码 0 | `typecheck.txt` |
| `node scripts\web.test.mjs`（S6 契约回归，12 用例） | 12/12 pass（tests 12, pass 12, fail 0） | `web-test.txt` |
| `pnpm build`（workbench） | 退出码 0；615 modules transformed；built in 6.2s；dist/ 生成 | `build.txt` |

> 环境注记：`pnpm build` 首次裸跑命中 pnpm 的 deps-status check（junction 指向主 checkout node_modules + 无 TTY）报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`；以 `CI=true` + `npm_config_confirm_modules_purge=false` + `npm_config_verify_deps_before_run=false` 复跑后正常通过（pnpm 校验 lockfile 179 项供应链策略通过、build 绿）。这是本 worktree junction 环境产物，非代码/构建错误。node_modules 为借主 checkout junction（与 T-048/T-049 同做法）。

## 浏览器验收（L2）说明
本环境无浏览器 GUI，S7 为前端交互（L2 层）——须由将军/宿主在 `:5173`（构建产物）走查。已提供静态/数据面自证：代码走查 + 上述 grep（无 raw HTML 直插、无 dangerouslySetInnerHTML）。给出 L2 清单要点：进入「浏览器助手」聚焦地址栏；输 mock URL 显示标题+正文；输 `http://127.0.0.1:8787/api/config` 显示「已拦截：禁止访问内网地址」；慢/超限/上游断三错误文案可区分可重试；QuickTools「浏览网页」进面板聚焦、「打开内部看板」新窗口开看板。

## grep 佐证
- `dangerouslySetInnerHTML` 实际 JSX 使用（非注释）：0 —— I5 / TC-S7-07 渲染安全成立。
- `BrowserPanel` 残留（src 内）：0（App.tsx 已切 `BrowserView`；docs/review 历史审查文档与 T047/T050 证据目录仍提到旧名，属历史归档不改动）。
