<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P2-7 文件中心增强 · 验证证据

**切片**：P2-7 文件中心增强（批量操作与搜索 / 上传冲突策略 / 大文件分片与断点续传 / git 状态与差异展示）
**日期**：2026-09-10
**代码位置**：`workbench/scripts/serve.mjs`（后端 `/api/files/*`）、`workbench/src/filesUi.ts`（前端纯判定层）、
`workbench/src/components/FilesView.tsx`（界面）、`workbench/src/api.ts`（客户端）、`workbench/src/index.css`（样式）
**测试**：`workbench/scripts/files-p27.test.mjs`（36 例）、`workbench/scripts/files-ui.test.mjs`（19 例）

---

## 1. 交付内容与验证方式

| 子项 | 实现 | 验证 |
| --- | --- | --- |
| ① 上传冲突策略 | `UPLOAD_STRATEGIES` / `normalizeUploadStrategy` / `resolveUploadConflict`（冲突决策**单一实现**，函数级与流式两条上传路径共用） | 函数级 6 例 + HTTP 真路由 2 例（skip 零副作用 / rename 递增 / 未知策略 400 / `overwrite=1` 兼容） |
| ② 分片上传与断点续传 | `initChunkedUpload` / `appendUploadChunk` / `completeChunkedUpload` / `abortChunkedUpload`（会话只落磁盘） | 函数级 8 例 + HTTP 端到端 4 例（跨片字节一致 / offset 409 带 received / 未收齐保留会话 / token 门禁） |
| ③ 搜索与批量 | `searchFiles` / `batchFileOp` + `GET /api/files/search`、`POST /api/files/batch` | 函数级 6 例 + HTTP 2 例（大小写不敏感 / 递归 / 截断标注 / 逐项成败 / 参数校验） |
| ④ git 只读 | `gitStatus` / `gitDiff` / `gitLog` + `parsePorcelainZ`（只跑只读子命令） | 函数级 8 例 + HTTP 1 例（标记 / 两态 diff / 二进制 / 截断 / 已删除 / **只读保证**） |
| 前端 | 搜索栏、多选批量栏、策略下拉（localStorage 记忆）、分片进度条、git 标记列与差异面板、最近提交 | `files-ui.test.mjs` 19 例（判定层）；`vite build` 通过；改动文件 tsc 零错误 |

## 2. 关键设计决策（与证据）

1. **冲突决策单一实现**：`resolveUploadConflict(abs, strategy)` 同时被函数级 `uploadBytes` 与路由层流式
   `receiveUploadBody` 调用，避免两条上传路径的冲突语义各自演化（P2-6 已出现过「同一语义两份实现」的教训）。
2. **断点续传不依赖内存**：会话状态只有 `<根>/.dsh-uploads/<uploadId>.json`（目标/大小/策略）与 `<uploadId>.part`；
   「已收字节」= `.part` 的文件长度。因此进程重启、页面刷新、服务重部署都不丢进度。
   测试用「重新 init 拿到同一 uploadId 且 received=20000」直接钉住这一点。
3. **顺序语义换简单性**：`offset` 必须等于服务端已收字节，不匹配返回 **409 + received**。前端按收到的
   `received` 校正后继续——比并发分片简单得多，且失败恢复路径明确（不会出现乱序空洞）。
4. **进度不撒谎**：`received > 0` 时文案固定为「续传中」，而不是「上传中 0%」；
   文件名冲突改名后，提示显示**服务端回传的实际落盘名**。
5. **git 面板只读**：只跑 `status/diff/log/rev-list`，不提供 stage/commit/checkout。
   这是产品定位选择（文件中心不是 git 客户端），也把越权风险留在外面。

## 3. 反向断言（证明「没做」的事）

| 断言 | 位置 | 意义 |
| --- | --- | --- |
| 调用 `gitStatus`/`gitDiff`/`gitLog` 前后 `git status --porcelain -z` **逐字节一致**，且无 `.git/index.lock` 残留 | `files-p27` ④ | 只读端点确实没有写仓库 |
| `skip` 策略上传既有文件后，文件内容与上传前**完全相同** | `files-p27` ① | skip 零副作用 |
| 分片未收齐时 `complete` 失败，且目标文件**不存在**（不留半写文件），会话仍在 | `files-p27` ② | 不产生坏文件、可续传 |
| `.dsh-uploads` 不出现在列表、不被搜索命中、显式访问返回 403 | `files-p27` ② | 内部状态不可被文件操作破坏 |
| `uploadId` 取 `../../evil` 等畸形值一律 400，且根外无文件产生 | `files-p27` ② | 白名单校验生效 |
| 批量移动时目标同名冲突项失败，且既有文件内容未被覆盖 | `files-p27` ③ | 批量操作不静默覆盖 |

## 4. 本轮修掉的真实缺陷

| # | 缺陷 | 后果 | 修复 |
| --- | --- | --- | --- |
| 1 | `gitDiff` 对**文件路径**执行 `git -C` | 必然失败 → `isRepo:false` → 前端会隐藏整个 git 面板（功能看似"未实现"） | 新增 `gitProbeDir`：按文件所在目录探测仓库根；`gitStatus`/`gitLog` 同口径 |
| 2 | `gitDiff` 对已删除文件在 `resolveInsideRoot` 抛 400 | 前端拿到错误而非「文件不存在（可能已删除）」的可读说明 | 捕获该错误并返回 `note`，保留仓库上下文 |
| 3 | `.dsh-uploads` 会话目录可被文件中心浏览/删除 | 一次列表操作即可静默破坏断点续传（分片被删 → `received` 归零） | 与 `.git` 同级拒绝（403） |

> 缺陷 1 尤其值得记录：实现"存在但永远返回 false"，测试若只断言「HTTP 200」就会全绿放行。
> 本套件对 git 的断言直接落到 `isRepo`、标记内容与 diff 文本上，才把它暴露出来。

## 5. 复现命令

```powershell
# 后端契约（36 例）：函数级 + 进程内 HTTP 真路由 + token 门禁 + 真实 git 仓库夹具
node --test workbench/scripts/files-p27.test.mjs

# 前端纯判定层（19 例）
node --test --experimental-strip-types workbench/scripts/files-ui.test.mjs

# 既有文件中心契约不回归（41 例；overwrite=1 作为兼容别名保留）
node --test workbench/scripts/files-api.test.mjs

# 全量门禁（在 worktree 内）
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'; node scripts\ci\run-ci.mjs --only test --out .ci\p27-test
```

## 6. 已知边界（诚实登记）

- **批量下载不打包**：逐个触发浏览器下载，未实现 zip（避免为零依赖引入自研 zip 写入器）。
- **分片是顺序的**：不做并发分片、不做逐片哈希校验（仅校验总长度等于声明 size）。断线恢复依赖
  服务端 `received` 校正。
- **搜索只匹配文件名**：不含文件内容全文检索。
- **「移动到」仅支持已存在目录**：沿用服务端 `renamePath` 语义（目标目录不存在 → 该项失败）。
- **git 面板只读**：无 stage/commit/checkout；`ahead/behind` 依赖本地存在的 upstream 引用（无 upstream 时为 null）。
- **`.dsh-uploads` 无自动回收**：中止/完成会清理；进程被强杀留下的残留会话需管理端按需清理（本期未做 TTL 回收）。
- **前端验证深度**：`files-ui` 是判定层测试（不引入 jsdom/react 渲染设施），界面本身未做 DOM 断言；
  端到端证据是「HTTP 真路由 + vite build 通过 + 改动文件 tsc 零错误」。

## 7. 环境说明与并发事故（与本切片无关但需知情）

本切片在**独立 worktree**（`.legion-worktrees/P2-7`，分支 `w/p2-7`）中完成：主工作目录当时被并发协作者
的 `reset` / `clean` / `stash pop` 反复打断（`workbench/scripts/serve.mjs` 一度含 24 处冲突标记），
本人在该目录的未提交改动被销毁两次；其中 P2-7 后端实现还曾被 `35b3472`（F-01 合并，由对方以全量暂存
方式生成）扫入其提交——该提交内的 P2-7 代码**没有任何测试**，本次的修复与测试即为补齐。

**两个由并发合并引入、与本切片无关的问题**（均已定位并留证；代码归属 F-01/F-02 分支）：

1. **构建门禁一度失败（已由对方修复）**：`35b3472` 起 `workbench` 的 `tsc --noEmit` 失败——
   `NotifyView.tsx` 引用全仓不存在的 `dedupeDesc`、未导入 `isNotifyAction`/`setList`，
   `ChatView.tsx` 另有未使用变量（`setSseStatus`）。发现方式：在本切片 worktree 里跑构建门禁时
   逐条 locale 到文件行号，并用 `git log -1 -- <file>` 确认来源提交。main 的 `94f8cad`
   （"修复 F-01 合并留下的半成品"）已修复；本次合并演练的集成态 `tsc --noEmit` **全量零错误**。
2. **`test` 阶段永久挂起（截至本文件撰写仍未修）**：`workbench/scripts/notify-hub-smoke.test.mjs`
   在 `fcbc1bd` / `3339642` 上运行 2 分钟以上**无任何输出**（同时有两个 hub 子进程存活），
   而同一文件在 `1203f52`（pre-F-01）上 **2/2 通过并正常退出**（约 50s，用独立对照 worktree 复现）。
   `git log fcbc1bd..main -- team-hub/server.mjs` 为空 → 该挂起自 `fcbc1bd` 引入后未被改动，
   而 `1203f52..fcbc1bd` 期间对该文件的改动来自 F-01/F-02 合并。
   后果：`run-ci --only test` 会一直等待（不是失败，而是**不结束**），全量基线无法产出；
   本切片的 3 个套件因此改用单文件方式逐一验证（见 §5），未伪造全量基线数字。

