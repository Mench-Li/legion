<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# PRT-212～215 强制面证据

**切片**：PRT-212（工具强制面接线）/ PRT-213（沙箱后端与实际管制探测）/ PRT-214（DSH 组合补丁层）/ PRT-215（启动自检）
**日期**：2026-09-11
**分支**：`codex/prt-phase0-1`
**产物**：`runtime/dsh-composition/`（`patch-layer.mjs` / `enforcement.mjs` / `selfcheck.mjs` / `render.mjs` / `legion-host.patch.yml`）

---

## 1. 本次交付了什么，以及**刻意没交付**什么

| 交付 | 状态 |
| --- | --- |
| 补丁层**声明**（行组成、锚点、判据、`dshCompositionPatchVersion`） | ✅ |
| 三个强制点**原语**（hard floor guard / fail-closed 策略门 / 双段超时 answerer） | ✅ |
| canonical operation **哈希**（§6.8 的授权绑定基础） | ✅ |
| 沙箱**实际管制**探测（`enforcement: full` 判据） | ✅ |
| 启动**自检**门禁（三查逐项归因 → `incompatible` 即禁自动执行） | ✅ |
| 落盘 `legion-host.patch.yml` 片段（生成物 + 新鲜度用例） | ✅ |
| **把补丁层写进运行中的 profile** | ❌ **刻意不做**，理由见 §2 |
| 把 HTTP/SSE 接到真实 team-hub 审批箱 | ❌ 未接线，理由见 §5 |

---

## 2. 为什么没有把它装上去（这一条比代码本身重要）

**DSH 用户 profile 层的 `patchReload` 是 `'live'`——组合改动热生效，不需要重启**
（实测记录见 `docs/superpowers/prt/PRT-010-dsh-composition-baseline.md` §2.1）。

这意味着：往 `$DSH_HOME/profiles/web/cordis.patch.yml` 写入这一层，会**立刻改变正在运行的
这个 harness 的强制面**，包括当前这个会话自己。把这一步做成一个随手可调的函数或
一条 CI 步骤，等于给一次误调用准备了「把当前进程的沙箱降级」的能力。

因此本批次交付**可独立审阅、可独立测试**的三件东西（声明 / 原语 / 自检），
把「写进 profile」留成一次需要显式决策的动作。`runtime/dsh-composition/index.mjs`
的文件头把这条理由写在了代码里，而不是只写在文档里——文档会被跳过，文件头不会。

---

## 3. 从实测读到的 DSH 强制面（本批次的事实基础）

以下是探测**运行中** harness 得到的，不是从文档抄的。

### 3.1 真正的强制点

| 机制 | 实际形态 | 关键性质 |
| --- | --- | --- |
| `ctx.tools.guard(fn)` | `fn: (exec) => string \| undefined` | **只有降级语义、没有 allow 返回值**，故与 listener 顺序无关 |
| `'tools/pre-execute'` | waterfall → `{kind:'allow'} \| {kind:'deny',reason} \| {kind:'ask',reason?}` | 异步；可被后续 listener 覆盖 |
| `'approval/request'` | waterfall → `'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` | 闭集；`unavailable` 必须 fail closed |
| `ctx.approval` | `setPolicy(agent, policy)` / `request(req)` / `overrideOf(session)` | 策略在 answerer 之前生效 |
| `ctx.permissionPresets` | `current` / `resolve` / `set` / `selectFor` | 自有表经 `config.presets` 注入 |
| `ctx.sandbox` | `confine(argv, policy) → ConfinedArgv` | **见 §3.2，这是本批次最有价值的一条** |

### 3.2 `enforcement: 'full' | 'partial'` —— spec「仅有配置名不算生效」的落点

`ConfinedArgv` 的实际形状：

```ts
interface ConfinedArgv {
  argv: string[]
  enforcement: 'full' | 'partial'
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}
```

spec §6.8 要求「必须探测实际后端和 enforcement；**仅有配置名不算生效**」。
这条要求此前只是一个原则，现在有了可判定的落点：

- `enforcement` 必须是 **`full`**。`partial` 的字面含义是「这条 argv 只被部分管制」，
  也就是**存在不被管制的路径**；把 `partial` 当可用，等于在已知有漏洞的沙箱上宣称已限制。
- 返回的 `argv` 必须**真的变了**。原样返回输入 = 没有做任何包装，
  这是「配置了沙箱但没生效」最直接的证据。
- `denialSignatures` 必须非空。为空意味着沙箱拒绝了也认不出来，
  拒绝会**退化成普通失败**——而这两者的修复动作完全不同。

三条都写成用例（`composition.test.mjs`），且**四条用例断言的都「不生效」**。

### 3.3 两个与原设计假设不同的地方

1. **`ctx.sandbox` 是「抽象进程沙箱」，不是「文件沙箱」。** 它只有 `confine(argv, policy)`，
   即按 argv 包装子进程。文件读写走的是另一条链（`fs-sandbox` 行 + `ctx.fs` 的
   `sandboxPolicy` 参数）。因此「探测沙箱是否生效」不能用一次文件读来判断，
   只能用 §3.2 的 `confine` 探针。
2. **组合行里 `sandbox` 与 `approval` 是独立旋钮，由 `permission` 行捆绑。**
   DSH 的 `permission` 行默认表把 `workspace-write↔ask`、`danger-full-access↔never` 绑定。
   这直接解释了 §6.9 那条警告为什么成立：按默认表实现「无人值守 = `never`」，
   会**同时**把沙箱升级为 `danger-full-access`。用例
   `补丁层：无人值守 preset 保持 workspace-write…` 把这条钉死。

---

## 4. 判定「生效」的四类隐蔽失效

这一层的危险之处在于：**失效时看起来和成功一样**。四种都在组合树或返回值里长得像正常：

| 隐蔽失效 | 为什么看起来正常 | 判据 |
| --- | --- | --- |
| 行挂上了但**未激活**（等待依赖服务） | 组合树里「行存在」 | `activated !== false` |
| `permission` 行在，但表**没被覆盖** | 行存在且激活 | 生效表里必须能解析出 `legion-*` |
| 沙箱返回 **`partial`** | 返回了合法对象、有 argv | `enforcement === 'full'` |
| `confine` **原样返回**输入 argv | 返回了合法对象、字段齐全 | 返回 argv 必须与输入不同 |
| `denialSignatures` 为空 | 字段存在 | 必须非空 |
| **未探测**运行时 | 没有报错 | 「没探测」≠「没问题」→ 判不通过 |

每一条都有对应用例。`reconcilePatchLayer` 对「读不到 preset 表」返回
`PRESETS_UNOBSERVED` 并判**不生效**——把「没观察到」当作「已生效」是这类检查最常见的写法错误。

---

## 5. 本次**未**完成的部分（明确列出，不含糊）

| 缺口 | 具体是什么 | 为什么没做 |
| --- | --- | --- |
| 落盘与应用 | 把 `legion-host.patch.yml` 合并进 `$DSH_HOME/profiles/web/cordis.patch.yml` | §2：live reload 会立刻改变当前运行进程的强制面 |
| 真实审批箱接线 | `createApprovalAnswerer` 的 `request` 端口接 team-hub 的审批写入 | 需要 PRT-316 先把 team-hub 的路由层提取出来；现在直连会把新代码焊死在 `server.mjs` 上 |
| 无依赖的 DSH 版本窗 | `SUPPORTED_RUNTIME.supportedMajor` 仍是占位 | 属 PRT-802/809，需要真实兼容矩阵 |
| token/费用/资源的执行期采集 | 与 PRT-009 的未结项相同 | 转写记录不含进程资源，见 PRT-009 证据 §4 |

**`createApprovalAnswerer` 与 `createPreExecutePolicy` 目前只被自己的用例驱动，没有生产调用方。**
这一点必须说清楚：它们**已在 CI 中受测**，但**尚未在任何真实路径上生效**。
把「有测试」当成「已生效」是这一类工作最容易犯的错。

---

## 6. 可复核的判据

```bash
cd <repo>

# 原语与自检的单测（无需 DSH，任何机器可跑）
node --test runtime/dsh-composition/enforcement.test.mjs   # 34 例
node --test runtime/dsh-composition/composition.test.mjs   # 28 例

# 补丁层 YAML 与声明是否一致（不一致 exit 1）
node runtime/dsh-composition/render.mjs --check

# 本目录对 DSH 的依赖必须为 0（棘轮对新文件允许 0 处）
node scripts/ci/dsh-boundary.mjs --check
```

**「本目录 DSH 记号为 0」是一条实测性质**，不是设计意图：
`dsh-boundary --check` 通过，且 3 文件 / 26 处的基线与本批次之前**完全一致**。
棘轮里给适配器留的 `adapterPrefixes` 豁免**存在但未被使用**——
与 `runtime/adapters/dsh/port.mjs` 同一立场：豁免存在但不消耗，比「用了再讨论是否合理」更安全。

---

## 7. 由谁接手

- **落盘与端到端生效验证** → 需要一次显式决策 + 一次 profile 写入 + 重启校验，建议与 PRT-011（分发形态）一起排。
- **审批箱接线** → 排在 PRT-316（team-hub 路由层提取）之后。
- **`advanceTask` 旁路裁决**（PRT-316 另一项，见 PRT-005 证据 §3.1）→ 与本批次无依赖，可独立决策。
