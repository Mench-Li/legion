# tests/contract — 可执行契约测试

> 由 test-designer（T-012）产出。把 REQUIREMENTS §3.2/§3.3/§6.2 中的**纯逻辑**部分
> 固化为零依赖、可运行的规格断言，供 coder 阶段直接移植或对照实现。

## 运行

```bash
node --test tests/contract/          # 当前 56 用例全绿（0 fail）
```

零第三方依赖（仅 Node 内置 `node:test` / `node:assert` / `node:crypto`），禁网环境可跑。

## 文件

| 文件 | 内容 |
| --- | --- |
| `contracts.mjs` | 可执行参考契约（**非生产实现**，是行为边界声明） |
| `contracts.test.mjs` | 56 个断言，覆盖正常/边界/异常路径 |

## 契约 → 下游子任务映射

| 契约函数 | 下游落地位置 | 对应子任务 / TC |
| --- | --- | --- |
| `validateElement` / `sampleElement` / `HEX_COLOR_RE` | `packages/shared/src/schema.ts` | S2；TC-S2-01..06 |
| `stateHash` | `packages/shared/src/hash.ts` | S2/S12；TC-S2-08/09；收敛断言口径 |
| `distPointSegment` / `hitTestRect/Ellipse/Line/Freehand/Box/Text/Element` | `apps/web/src/interaction/hitTest.ts` | S6；TC-S6-01..09 |
| `validateViewport` / `worldToScreen` / `screenToWorld` | `apps/web/src/viewport/*` | S8；TC-S8-01..05 |
| `createThrottle`（20Hz） | `apps/web/src/presence/*` | S4；TC-S4-03 |
| `createHistory`（redo 语义） | `apps/web/src/history/*` | S9；TC-S9-04..06 |
| `escapeHtml`（XSS 门禁） | `apps/web/src/render/*` | S5；TC-S5-02 |
| `createPresence`（TTL） | `apps/web/src/presence/*` / server | S4/S11；TC-S4-02/04/05 |

## 契约口径说明（coder 必须遵守）

1. **schema lenient**：未知字段忽略（不报错、不抛异常）；必填字段缺失、类型错误、非法枚举拒绝。
   `strokeWidth` 必填正有限数；`stroke` 必填 `#rgb`/`#rrggbb`；`fill` 可选（空串=无填充）。
2. **stateHash 三性质**：顺序无关（元素集）、键序无关（字段）、`freehand.points` 顺序**有意义**。
   生产实现若改用其他哈希（如 xxhash）只要满足这三性质即可；但收敛断言必须用**同一实现**。
3. **命中容差**：`tolerance = strokeWidth/2 + slop`（slop 为 UI 手感外扩，默认 0）。
   `hitTestElement` 自数组末尾（最上层）向下遍历，返回第一个命中 id。
   ellipse 用「半轴外扩 tolerance」近似，rect 用 bbox 外扩（**填充语义**；仅描边（无 fill）的命中边界由渲染层补充，见 TEST_CASES.md TC-S6-09）。
4. **视口**：`screen = world * scale + t`；`scale` 必须 >0 且有限，否则抛错。
5. **redo 语义**：默认 `clear-on-remote`（6/8 方案）；`keep-replay` 为少数方备选。二者行为均已固化，
   将军若裁决「保留重放」，coder 只需切换 `createHistory('keep-replay')` 对应实现，契约测试双分支均保留。
6. **XSS**：任何可能落 DOM 的文本路径必须先 `escapeHtml`；Canvas `fillText` 本身不执行 HTML，
   本函数是「编辑态覆盖层/DOM 回退」等路径的强制门禁。

## 集成/e2e/性能用例

依赖 yjs / y-protocols / ws / better-sqlite3 / vite 的用例（同步收敛、presence 门禁、崩溃恢复、
压测）**无法在禁网环境运行**，其规格详见 `docs/TEST_CASES.md`（TC-S3-*、TC-S4-06、TC-S10-*、
TC-S12-* 等），由 coder 在 S1/S3 装依赖后按规格落成 `.test.mjs`，tester 在 S12 执行。
