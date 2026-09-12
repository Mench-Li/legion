# DSH 侧装配入口：PRT-215 落地与 PRT-257 的应用自检 + 修复入口

> 交付物：`runtime/dsh-composition/bootstrap.mjs`、
> `runtime/dsh-composition/bootstrap.test.mjs`（20 例）、
> `runtime/dsh-composition/index.mjs`（新增出口）
>
> 相关：PRT-213（沙箱实际管制探测）、PRT-214（补丁层）、PRT-215（启动自检）、
> PRT-253（宿主端口注册口）、PRT-257（Launcher 安装/自检/修复）

---

## 1. 补的是什么：三件东西都没有调用者

`startupSelfCheck()`、`probeSandbox()`、`bindDshRuntime()` 此前**各自孤立**：

| 符号 | 所属 | 在此之前谁调用 |
| --- | --- | --- |
| `startupSelfCheck()` | `selfcheck.mjs`（PRT-215） | 无 |
| `probeSandbox()` | `selfcheck.mjs`（PRT-213） | 无（`startupSelfCheck` 内部会调，而它自己没被调） |
| `bindDshRuntime()` | `orchestrator/worker/executor-binding.mjs`（PRT-253） | 无 |

后果有两条，**第二条更重**：

1. worker 的 `executor` 永远是 `EXECUTOR_HOST_PORT_REQUIRED`——
   PRT-253 的执行引擎与 PRT-510 的预算闸门**都不会被激活**；
2. **「强制面未生效时禁止自动执行」这条保证从未被行使过。**

> 一个宣言从没被行使过，与这个宣言不存在，在行为上完全一样。

第 2 条是这一批真正的理由。第 1 条只是它顺带修好的。

## 2. 装配是两段的，顺序不能反

```
① 运行时探测（版本 + 必需能力）
② 启动自检（组合补丁层 / 运行时 / 沙箱管制）→ 判定 autoExecutionForbidden
③ 只有 ② 通过，才注册宿主端口
```

反过来（先注册再自检）会留下一个**已注册的端口**——
而 worker 在**独立进程**里、可能已经开始认领任务了。自检失败时**什么都不注册**。

所以本批最要紧的一条断言不是「自检算得对不对」（那有自己的套件），
而是**自检没过时端口到底有没有被注册**。变红探针 ⑫① 正是把这一条拆掉，
它红了 3 条用例。

## 3. 沙箱一律要求 `full`

沿用 PRT-213 的判据，`probeSandbox` 判生效要同时满足：

| 条件 | 不满足时为什么不能算生效 |
| --- | --- |
| `enforcement === 'full'` | `partial` 的字面意思是「存在不被管制的路径」 |
| 返回的 argv **真的变了** | 原样返回输入 = 没做任何包装 = 「配置了沙箱但没生效」最直接的证据 |
| `denialSignatures` 非空 | 空集合意味着沙箱拒绝无法被识别，**拒绝会退化成普通失败** |

把 `partial` 当可用，等于在一个已知有漏洞的沙箱上宣称「已限制」。

## 4. 端口不完整 → 当场拒绝（本轮最有价值的发现）

第一版把 `runtimeHost` 直接当端口注册。我的假件只有 `probeRuntime`
（探测只需要它）——于是注册**「成功」了一个用不了的端口**。

失败被推迟到 worker 构造执行引擎时，那里报：

```
EXECUTOR_HOST_PORT_REQUIRED: DSH 宿主端口不合法：宿主端口缺少必需方法：startRun
```

报得不算差。但**层级错了**：装配这一步明明可以当场说清「这个端口不完整」，
却让它变成一个「worker 起不来」的现象——排障会从 worker 那边开始找，
而真因在装配这里。

> 一个注册得上、却没人能用的端口，与一个没注册的端口，
> 只在「状态显示已接线」这一点上不同——而那是更坏的一种。

现由 `assertHostPort`（适配器已有的函数，此前只在适配器内部用）在注册前把关，
具名码 `BOOTSTRAP_PORT_INCOMPLETE`，消息里点名缺哪个方法。

## 5. 修复入口

`repairPlanFor(check)` 把失败项翻成 `{check, action, label, why, reasons}`。

**「修不了」往往不是因为没有修法，是因为报告只说了哪一项没过、没说下一步做什么**，
于是用户能做的只有把产品重装一遍。

| `check` | `action` |
| --- | --- |
| `composition-patch-layer` | `reapply-composition-patch` |
| `runtime-probe` | `install-supported-runtime` |
| `sandbox-enforcement` | `fix-sandbox-backend` |
| （预置里没有的项） | `inspect-manually` |

最后一行是关键：**预置里没有的检查项也要出现在计划里**。
把它丢掉会让「三项没过」变成「修了这两项就好」——而第三项仍然拦着执行。

套件里有一条断言 `REPAIR_ACTIONS` **覆盖自检的全部检查项**，
它靠一次「全失败」的自检拿到全部项名再逐个要求有修法。
以后新增检查项却忘了给修法，那条会红。

## 6. 变红验证：12 处，12 处红

覆盖：自检未过照样注册、形状不对当作通过、探测抛错被吞、
探测返回 `undefined` 被当作已探测、端口不完整也注册、缺 `canRead` 给默认、
修复计划丢掉未知项、`why` 退化成复述、注册时重新探测、
拒绝结果不带修复计划、`REPAIR_ACTIONS` 漏一项、`probeFactory` 注入点失效。

### 两条第一轮没咬住，都是**瞄错了层**

| 探针 | 第一版改了什么 | 为什么没红 | 重新瞄准到 |
| --- | --- | --- | --- |
| ⑫⑨ | 自检实现（`run(...)`） | 「重新探测」要动的是**探测**实现，用例断言的是 `probeFactory` 被调用几次 | `bind` 时真的再调一次 `probeFactory` |
| ⑫⑩ | `refuse` 的兜底值 `extra.repair ?? ...` | 那条用例走的是**显式传入**的 `repair: repairPlanFor(check)`，兜底被绕过 | 把那一处显式传入拆掉 |

> 一条瞄错层的探针给出的「没变红」，与「实现是对的」完全同形。

这是本项目里第三次遇到同一形状的失败（PRT-253 的探针 ⑨②、PRT-510 的 ⑪④），
而每次的形态都不同——共同点是**探针改动的那一层与用例观察的那一层不是同一层**。

## 7. 未交付（如实记录）

### 7.1 出口被调用 ≠ 在真实部署里被调用

`bootstrapDshRuntime` 现在从 `runtime/dsh-composition/index.mjs` 导出了。
但**真正的调用点还没有**：它在「往运行中的 profile 写入这一层」那个
**需要显式决策的独立步骤**里。

`index.mjs` 顶部已经解释了为什么那一步被刻意留成独立步骤：

> DSH 的用户 profile 层是 `patchReload: 'live'` 的——**组合改动热生效，不需要重启**。
> 也就是说，往运行中的 profile 写入这一层会**立刻改变正在跑的 harness 的强制面**，
> 包括本会话自己。

那个步骤是 PRT-257「一键启动」的一部分，**本批没有交付**。
本批交付的是：它一旦发生，**有东西可调**，且调用的后果被用例钉住了。

### 7.2 修复计划只到「给出动作名」

`repairPlanFor()` 输出的是**计划**，没有任何东西去**执行**它。
`action` 是一串机器可读的名字（`reapply-composition-patch` 等），
谁来执行、执行前要不要用户确认、执行失败怎么办——都还没有。

### 7.3 其它

- **组合树观察结果（`composition.rows` / `permissionPresets`）没有生产来源。**
  本模块要求调用方注入它，而今天没有代码去读真实的组合树。
  测试里是手写的。也就是说：`composition-patch-layer` 这一项自检
  **在真实部署里只能拿到空观察** → 判未生效 → 禁止执行。
  这是**安全的默认方向**，但它意味着**今天真的装上也会被自己的自检拦住**。
- **`canRead` 没有生产来源**（与 PRT-253 同一个未交付项）。
- **`BOOTSTRAP_ALREADY_BOUND` 定义了但没有产生它的代码**：
  重复装配目前会被 `bindDshRuntime` 的幂等 `unbind` 处理，而不是报这个码。
  一个定义了却没人产生的错误码与一个不存在的错误码，在日志里是一样的。
- **没有把 `unbind` 接到任何进程退出钩子上**：一个装配过又退出的进程
  依赖 `bindDshRuntime` 的幂等性，而不是显式的清理。
