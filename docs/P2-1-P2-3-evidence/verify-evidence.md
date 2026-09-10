<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-09**（commit `1c21ab6`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P2-1 / P2-3 v1/v2 语义统一 + SSE 生命周期统一 — 验证证据

> 时间：2026-09-09　基线：`main`（REMAINING-TASKS.md P2-1/P2-3）
> 运行环境：Windows，Node v24.19.0（本机未配置 `DSH_CHECKOUT`，board-plugin 宿主套件按纪律 SKIP）

## 结论

P2-1 与 P2-3 验收标准全部达成（契约表入库 + v1/v2 低风险对齐 + SSE 统一信封/Last-Event-ID +
共享 fixture 对比测试 + 前端去重单测），已接入发布门禁：

1. ✅ 建立 v1/v2 统一接口契约表：`docs/CONTRACT-V1V2.md`（任务公共字段、写接口、错误分类、
   SSE 生命周期、登记差异 R1-R10，逐条 file:line 引用）。
2. ✅ 同一业务场景 v1/v2 公共字段与错误分类一致：`tests/contract/v1v2-contract.test.mjs` 14/14
   （真实双服务 + 临时库 fixture 双打）。
3. ✅ 保留 v1 兼容字段、不再新增语义分叉：v1 仅对齐 activity limit cap 500 与 404 JSON 形态
   （R3/R7）；任务字段面零改动。
4. ✅ SSE 统一序号（seq 单调 + `id:` 行 + Last-Event-ID 增量回放）、heartbeat（15s `:hb`）、
   断线清理（close → clearInterval + Set 删除）与前端去重（dedupe.ts 三口径纯函数 + 9 用例）。

## 改动清单

- `docs/CONTRACT-V1V2.md`（新）：统一接口契约表/字段表，P2-1 范围对齐基线。
- `scrum/serve.mjs`（v1）：`/api/activity` limit cap 500（对齐 v2）；未知路径/静态缺失 404 统一
  JSON `{error}`（对齐 v2/board-plugin）。
- `team-hub/server.mjs`（v2）：
  - `auditEvent()`（audit 行 → 对外事件对象）：REST `/api/activity` 与 SSE `/api/events` 共用；
    补 `event`/`id`/`payload` 兼容信封字段，既有字段不动。
  - `/api/events`：SSE 帧加 `id: <seq>` 行；读 `Last-Event-ID` 头 → `seq > N` 增量回放（升序），
    无/非法回退最近 30 条。
- `workbench/src/dedupe.ts`（新）：`dedupeSeqDesc`/`mergeById`/`activityFingerprint`/
  `dedupeByFingerprint` 纯函数。
- `workbench/src/components/NotifyView.tsx`、`ChatView.tsx`、`App.tsx`：私有去重逻辑改为复用
  dedupe.ts（组件行为不变）。
- `workbench/scripts/dedupe.test.mjs`（新）：9 用例（seq 去重降序/乱序收敛、消息 id 合并保序、
  内容指纹去重 + seen 播种回传）。
- `tests/contract/v1v2-contract.test.mjs`（新）：14 用例（写契约/公共字段/错误矩阵/未知路径 404/
  activity limit 尾部与 cap/board 语义登记/v2 SSE 信封 + Last-Event-ID 续传 + 心跳实测/
  v1 双流既有形态锁定）。
- `scripts/ci/run-ci.mjs`：test 阶段新增 `v1v2-contract`、`dedupe` 套件组。
- `docs/REMAINING-TASKS.md`：P2-1/P2-3 标记完成 + 范围说明同步。

## 复跑记录

### 1) run-ci test 阶段（门禁全链路，含新套件）

```
node scripts/ci/run-ci.mjs --only test --out .ci/p2-13-test-run
  PASS chat（对话中心契约）: exit=0 tests=42 pass=42 fail=0
  PASS skills（共享技能回归）: exit=0 tests=20 pass=20 fail=0
  PASS calendar（日程日历契约）: exit=0 tests=13 pass=13 fail=0
  PASS spaces（空间删除级联）: exit=0 tests=5 pass=5 fail=0
  PASS goal（目标生命周期）: exit=0 tests=14 pass=14 fail=0
  PASS rules（规范数据面）: exit=0 tests=7 pass=7 fail=0
  PASS artifact（产物读取）: exit=0 tests=16 pass=16 fail=0
  PASS security（监听安全配置）: exit=0 tests=6 pass=6 fail=0
  PASS read-auth（远程读面鉴权矩阵）: exit=0 tests=14 pass=14 fail=0
  PASS files-api（文件中心契约）: exit=0 tests=41 pass=41 fail=0
  PASS web（浏览器助手契约）: exit=0 tests=24 pass=24 fail=0
  PASS doc-render（文档产物契约）: exit=0 tests=11 pass=11 fail=0
  PASS skill-importer（技能导入契约）: exit=0 tests=4 pass=4 fail=0
  PASS hub-board（v2 看板投影）: exit=0 tests=1 pass=1 fail=0
  PASS artifact-policy（共享路径策略）: exit=0 tests=3 pass=3 fail=0
  PASS scrum（任务生命周期与产物）: exit=0 tests=25 pass=25 fail=0
  PASS contracts（平台契约基线）: exit=0 tests=56 pass=56 fail=0
  PASS v1v2-contract（P2-1 双服务契约对比 + P2-3 SSE 信封/续传）: exit=0 tests=14 pass=14 fail=0
  PASS dedupe（P2-3 前端去重纯函数）: exit=0 tests=9 pass=9 fail=0
  PASS whiteboard（7 文件含真实服务 e2e）: exit=0 tests=70 pass=70 fail=0
  SKIP plugins/board-plugin（未配置可用 DSH_CHECKOUT；外部宿主测试不伪造通过）
[test] -> PASS (50837ms)
```

> 补跑（2026-09-09，配置 `DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness` 后补齐宿主面，
> 确认 P2-1/P2-3 改动对 board-plugin/plugins 零回归）：
>
> ```
> $env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
> node scripts/ci/build-external-package.mjs board-plugin   # exit 0
> node --test board-plugin/tests/http-contract.test.mjs     # 32/32 pass
> node scripts/ci/build-external-package.mjs plugins        # exit 0
> node --test plugins/tests/*.test.mjs                      # 135/135 pass
> ```

### 2) run-ci build 阶段（Workbench tsc + vite 消费方改动门禁）

```
node scripts/ci/run-ci.mjs --only build --out .ci/p2-13-build-run
build: whiteboard PASS
build: workbench PASS（tsc --noEmit && vite build）
  ✓ 623 modules transformed.
  ✓ built in 6.39s
[build] -> PASS (13667ms)
```

### 3) run-ci doc 阶段（文档新鲜度校验）

```
node scripts/ci/run-ci.mjs --only doc --out .ci/p2-13-doc-run
doc: 文档新鲜度校验（check-docs.mjs）exit=0
check-docs: PASS（README.md + docs/FEATURES.md 结构/链接/索引一致，8 类校验项全绿）
[doc] -> PASS (123ms)
```

完整计数见 `ci-test-summary.json`（本目录）。`.ci/` 为可再生成运行时产物（gitignore），不入库。

## 验收映射（P2-1 / P2-3 原文）

| 验收 | 落点 |
|---|---|
| 建立 v1/v2 统一接口契约表 | docs/CONTRACT-V1V2.md（公共字段 22 项 + 错误矩阵 + R1-R10） |
| 同一 fixture 对比状态码/JSON 字段/错误语义/SSE event | tests/contract/v1v2-contract.test.mjs（create→comment→transition 场景双打） |
| 公共字段与错误分类一致 | 写契约 describe：{ok,task} 壳、公共字段值、缺参/非法迁移/乐观锁 409/404 矩阵 |
| 保留 v1 兼容字段，不再新增语义分叉 | v1 字段面零改动；仅 cap 与 404 形态对齐（R3/R7） |
| SSE 统一序号/heartbeat/断线清理 | v2 id: 行 + Last-Event-ID；:hb 15s 实测；close 清理契约锁定 |
| 统一事件字段 id/event/scope/seq/ts/payload | v2 data 帧 6 字段全（payload 兼容 detail） |
| 前端去重统一 + 单测 | dedupe.ts + 9 用例（Notify/Chat/App 三口径复用） |
| 断线重连和乱序事件测试 | Last-Event-ID 续传（seq=max+1 单条）+ 去重乱序收敛用例 |

## 诚实边界

- 首跑本机未配置 `DSH_CHECKOUT`，plugins/board-plugin 宿主套件按 P1-2 纪律 SKIP（不伪造通过）；
  随后配置 `DSH_CHECKOUT=D:\project\DSH\dsh\deepseek-harness` 补跑：board-plugin 构建 exit 0 +
  契约套件 32/32，plugins 构建 exit 0 + 135/135（见 §1 补跑记录），确认本批改动零回归。
- v1 activity 事件无全局 seq（activity.jsonl 追加模型）——Last-Event-ID 完整闭环在 v2/board-plugin-hub
  成立；v1 维持「连接回放 + 内容指纹去重」，契约表 S3 登记并有测试锁定行为。
- board-plugin hub 模式 SSE 桥接（契约表 R9：数据面走 hub、SSE 播本地文件）属跨宿主改造，需真实
  DSH team-hub 联调，登记移交 P1-3/P1-1，不在本批无回归保障地硬改。
- v1/v2 数据底座不同是架构事实；P2-1 统一的是契约面而非合并实现（P1-1 另立）。
