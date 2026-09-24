// scratch/_r87-correct.mjs —— 第 87 轮：**更正我自己第 75/76 轮的结论**（它只覆盖了一半，而且把一族当成了一个）
//
// ★★★ 这是本批最要紧的一次自我更正。第 75 轮我量到"产品只有一个 DataDir、派生表已把它派给
//     runtime 与 orchestrator、team-hub 只是没登记" ⇒ 得结论「#28 是接线，不是位置决定」，
//     并把它传播进了**四份文档**。
//
//     ★ 而 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14.7 说第 28 条要裁的是**两件事**：
//       (a) 目录由哪一个既有配置量**派生**；(b) **谁负责在按 Run 的缝上绑 runId**。
//     我只覆盖了 (a)。
//     ★ 而 §14.5 量到 (b) 是个真的设计问题：`onDecision` 是**装配期**给的，而 spool 是**逐 Run** 一份。
//     ★★ 而 §14.8 说 #28 **不是一个实例，是一族**（同族：第 18 项、第 4 项）。
//
//     ⇒ 所以我必须把这四处的结论**收窄**，而不是继续挂着一个过宽的读法。
import { readFileSync, writeFileSync } from 'node:fs'

const R = 'D:/project/DSH/legion'
const bad = []

// ── ① 人工清单：新一节 + 家族行 ──────────────────────────────────────────────
{
  const I = `${R}/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md`
  let t = readFileSync(I, 'utf8')
  const eol = t.includes('\r\n') ? '\r\n' : '\n'
  const sub = (from, to) => {
    const f = from.split('\n').join(eol), tt = to.split('\n').join(eol)
    const n = t.split(f).length - 1
    if (n !== 1) { bad.push(`  x[清单] 命中 ${n} 次：${from.slice(0, 40)}`); return }
    t = t.replace(f, tt)
  }
  sub('**第 86 轮结束时的读数**（全部可复跑）：', '**第 87 轮结束时的读数**（全部可复跑）：')

  const ANCHOR = '#### ★★★★ 第 86 轮：拿第 75 轮的方法去核 §5 第 16 条'
  const at = t.indexOf(ANCHOR)
  if (at < 0) bad.push('  x[清单] 找不到第 86 轮那节的锚点')
  else {
    const SEC = [
      '#### ★★★★★ 第 87 轮：**更正我自己**第 75/76 轮的结论 —— 它只覆盖了一半，而且把一族当成了一个',
      '',
      '第 75 轮我量到：产品**只有一个** DataDir（`LEGION_DATA_DIR`，落点由**冻结的目录布局**定），',
      '`product/config-schema.mjs` 的派生表已把它派给 **runtime** 与 **orchestrator**，',
      '而 `product/process-manifest.mjs:111` 显示 `team-hub` 是**同一份进程清单里的兄弟进程**、只是没登记。',
      '⇒ 我得结论「**#28 是接线，不是位置决定**」，并把它写进了**四份文档**。',
      '',
      '★ 本轮读 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14 才发现：**那个结论只覆盖了一半。**',
      '',
      '#### 一、第 28 条要裁的是**两件事**，不是一件',
      '',
      '§14.7 的原文：',
      '',
      '> 要裁的**不是**"实现什么"，是"**那条车道的目录由哪一个既有配置量派生、谁负责在按 Run 的缝上绑 runId**"。',
      '',
      '| 那一半 | 我第 75 轮量到了吗 | 它是不是裁决 |',
      '|---|---|---|',
      '| (a) 目录由**哪一个既有配置量**派生 | ★ 量到了（只有一个 DataDir） | **不是** —— 这一半我说对了 |',
      '| (b) **谁在按 Run 的缝上绑 runId** | ★★ **没有**（我根本没提 runId） | ★ **是真的设计问题** |',
      '',
      '#### 二、(b) 为什么是真的（§14.5 量出来的）',
      '',
      '`spoolDirFor({ dataDir, runId })` 是**逐 Run 一份**，而',
      '`runtime/dsh-composition/plugins/root-row.mjs:591`（`installEnforcementRoot` 全仓**唯一**的生产调用方）',
      '给 `onDecision` 观察点的时机是**装配期** ⇒',
      '',
      '> 观察点必须从**按 Run 安装**的那个缝（`runtime-host-registrar-row.mjs`，即 PRT-214 两遍先例的形状）',
      '> 读当前 runId，而**不是**在装配期绑死一个 Run。',
      '',
      '§14.5 末尾那句把这个错误写成了一句可认的话：',
      '',
      '> 一个「把观察点绑在装配期的 Run id 上」的接线，与一个「整个进程只往第一个 Run 的账本里写」的接线，',
      '> 是同一个东西——只不过后者的表现是"第二个 Run 的工具账不见了"。',
      '',
      '⇒ **我给 team-hub 补 `LEGION_DATA_DIR` 只解决 (a)。** (b) 一点都没碰。',
      '',
      '#### 三、而且它不是**一个实例**，是**一族**（§14.8）',
      '',
      '> 于是第 28 条的措辞要往上一层看：它问的**不是**"spool 放哪"，',
      '> 而是"**控制面的数据怎么到达执行面**"——一条**通用契约**。',
      '',
      '同族的还有：**第 18 项**（F-18/F-19 的执行面一半：`friction.mjs` / `graph.mjs` / `role-pack.mjs` 零生产调用方）',
      '与**第 4 项**（Pack 账：hub 有 `GET /api/packs/account`，生产里没有任何消费方）。',
      '',
      '#### ⇒ 更正后的结论（这才是我该写的）',
      '',
      '- ★ **我给 team-hub 补 `LEGION_DATA_DIR` 那一半仍然是施工**（不是裁决）；',
      '- ★★ **但 (b) 与那一族（第 18 项 / 第 4 项）仍然需要业主裁决** —— 它们卡在**同一个**通用契约上。',
      '- ⇒ 所以第 28 条**不是**"整条改判为施工"，而是"**一半是施工、一半仍是裁决**"。',
      '',
      '★★★★★ **而这次更正最值记的一点是它的形状**：',
      '',
      '> 第 86 轮我刚写下「第 75 轮那次改判是**对一个具体缺陷形状**的读数，',
      '> **不是**一条"所有裁决其实都是接线"的规律」——',
      '> 而**我自己早在第 75 轮就已经把那条读数推广出去了**，传播进了四份文档。',
      '>',
      '> ⇒ 一条正确的规律，我**写下来了**、也用在了**别人**的东西上（第 16 条），',
      '> 却没有**回头**用在自己已经发出去的那句话上。',
      '',
      '★ 一个"我刚总结出一条规律"的时刻，与一个"我该拿它回头核自己"的时刻，',
      '**不是同一刻** —— 而后者才是有用的那一刻。',
      '',
    ].join('\n')
    t = t.slice(0, at) + SEC + t.slice(at)
    console.log('  OK[清单] 已插入第 87 轮更正节')
  }

  if (!/^\| 87 \|/m.test(t)) {
    const ROW = '| 87 | ★★★★★ **更正我自己第 75/76 轮的结论：它只覆盖了一半，而且把一族当成了一个** —— '
      + '第 75 轮我量到产品**只有一个** DataDir（`LEGION_DATA_DIR`，落点由**冻结的目录布局**定）、'
      + '派生表已把它派给 runtime 与 orchestrator、`team-hub` 只是没登记 ⇒ 得结论「**#28 是接线，不是位置决定**」，'
      + '并写进了**四份文档**。★ 本轮读 `DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14 才发现**只覆盖了一半**：'
      + '§14.7 原文说第 28 条要裁的是「**那条车道的目录由哪一个既有配置量派生、谁负责在按 Run 的缝上绑 runId**」——'
      + '(a) 派生源 **我量到了**（只有一个 DataDir ⇒ 这一半确实是施工）；'
      + '(b) **按 Run 的缝上绑 runId** ★★ **我根本没提**，而 §14.5 量到它是**真的设计问题**：'
      + '`spoolDirFor({dataDir, runId})` 是**逐 Run** 一份，而 `root-row.mjs:591`（`installEnforcementRoot` 全仓唯一生产调用方）'
      + '给 `onDecision` 的时机是**装配期** ⇒ 在那绑死会让**整个进程只往第一个 Run 的账本里写**'
      + '（"第二个 Run 的工具账不见了"）。★★★ 而且 §14.8 说 #28 **不是一个实例、是一族**：'
      + '「它问的**不是**"spool 放哪"，而是"**控制面的数据怎么到达执行面**"」—— '
      + '同族还有**第 18 项**（`friction.mjs`/`graph.mjs`/`role-pack.mjs` 零生产调用方）与**第 4 项**（Pack 账：hub 有产出、无人接住）。'
      + '⇒ **更正后的结论：(a) 是施工；(b) 与那一族仍然需要裁决** —— 第 28 条是"一半施工、一半裁决"，不是整条改判。'
      + '★★★★★ 最值记的是这次更正的**形状**：第 86 轮我刚写下「第 75 轮那次改判是**对一个具体缺陷形状**的读数，'
      + '**不是**一条规律」，而**我自己早在第 75 轮就把它推广出去了** —— '
      + '> 一条正确的规律，我**写下来了**、也用在了**别人**的东西上（第 16 条），'
      + '> 却没有**回头**用在自己已经发出去的那句话上。'
      + '> ⇒ 一个"我刚总结出一条规律"的时刻，与一个"我该拿它回头核自己"的时刻，**不是同一刻**。 |'
    const lines = t.split('\n')
    const i86 = lines.findIndex((l) => /^\| 86 \|/.test(l))
    if (i86 < 0) bad.push('  x[清单] 找不到 | 86 |')
    else { lines.splice(i86 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK[清单] 家族表加第 87 行') }
  }
  writeFileSync(I, t)
  const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(t)
  const head = t.slice(0, m.index)
  const block = head.slice(head.lastIndexOf('结束时的读数'))
  let sum = 0
  for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
  console.log(`  [清单] 逐项求和 = ${sum}；声明 ${m[1]}  ${sum === Number(m[1]) ? 'OK' : 'x 不一致'}`)
}

// ── ② 交付物 §2.1 L 那一格：收窄 ─────────────────────────────────────────────
{
  const F = `${R}/docs/superpowers/prt/PRT-FINAL-REPORT-2026-09-18.md`
  let t = readFileSync(F, 'utf8')
  const FROM = '⇒ **这一格不再需要您裁决。** 详见 `./PRT-HUMAN-INTERVENTION-2026-09-20.md` §三之三（第 75/76 轮） |'
  const TO = '⇒ **这一格不再需要您裁决。** 详见 `./PRT-HUMAN-INTERVENTION-2026-09-20.md` §三之三（第 75/76 轮）。'
    + '★★★★★ **第 87 轮收窄上面这段（它只覆盖了一半）**：第 75 轮量到的是"**目录由哪一个既有配置量派生**"那一半'
    + '（产品**只有一个** DataDir ⇒ 不是裁决）；而 `docs/DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14.7 说这一条要裁的是'
    + '**两件事** —— 除了派生源，还有「**谁负责在按 Run 的缝上绑 runId**」。'
    + '★ (b) **第 75 轮完全没覆盖**，而 §14.5 量到它是**真的设计问题**：'
    + '`spoolDirFor({dataDir, runId})` 是**逐 Run** 一份，而 `root-row.mjs:591`（`installEnforcementRoot` 全仓唯一生产调用方）'
    + '给 `onDecision` 的时机是**装配期** ⇒ 在那绑死会让**整个进程只往第一个 Run 的账本里写**。'
    + '★★★ 而且 §14.8 说这一条**不是一个实例、是一族**：「它问的**不是**"spool 放哪"，而是"**控制面的数据怎么到达执行面**"」——'
    + '同族还有**第 18 项**（`friction.mjs`/`graph.mjs`/`role-pack.mjs` 零生产调用方）与**第 4 项**（Pack 账：hub 有产出、无人接住）。'
    + '⇒ **更正后的结论：(a) 是施工；(b) 与那一族仍然需要裁决** |'
  const n = t.split(FROM).length - 1
  if (n !== 1) bad.push(`  x[报告] 命中 ${n} 次`)
  else { t = t.replace(FROM, TO); writeFileSync(F, t); console.log('  OK[报告] §2.1 L 那一格已收窄') }
}

// ── ③ DECISION-BRIEF：#28 那两处收窄 ─────────────────────────────────────────
{
  const D = `${R}/docs/DECISION-BRIEF.md`
  let t = readFileSync(D, 'utf8')
  const FROM = '⇒ **这一条不需要您说话。** |'
  const TO = '⇒ **第 84 轮当时写的是"这一条不需要您说话"。**'
    + '★★★★★ **第 87 轮收窄它（只覆盖了一半）**：第 75 轮量到的是"**目录由哪一个既有配置量派生**"那一半'
    + '（产品**只有一个** DataDir（`LEGION_DATA_DIR`，落点由**冻结的目录布局**定）⇒ 那一半不是裁决）；'
    + '而 `DECISION-RUNREQUEST-EXECUTION-PLANE.md` §14.7 说这一条要裁的是**两件事**，另一件是'
    + '「**谁负责在按 Run 的缝上绑 runId**」。'
    + '★ 那一件 §14.5 量到是**真的设计问题**：`spoolDirFor({dataDir, runId})` 是**逐 Run** 一份，'
    + '而 `root-row.mjs:591`（`installEnforcementRoot` 全仓唯一生产调用方）给 `onDecision` 的时机是**装配期** ⇒ '
    + '在那绑死会让**整个进程只往第一个 Run 的账本里写**（"第二个 Run 的工具账不见了"）。'
    + '★★★ 而且 §14.8 说这一条**不是一个实例、是一族**：它问的**不是**"spool 放哪"，'
    + '而是"**控制面的数据怎么到达执行面**"这一条**通用契约** —— 同族还有**第 18 项**与**第 4 项**（Pack 账）。'
    + '⇒ **所以这一条是"一半施工、一半裁决"，上面那三个选项对应的正是后半** |'
  const n = t.split(FROM).length - 1
  if (n !== 1) bad.push(`  x[简报] 命中 ${n} 次`)
  else { t = t.replace(FROM, TO); writeFileSync(D, t); console.log('  OK[简报] #28 那一格已收窄') }
}

if (bad.length > 0) { for (const b of bad) console.log(b); process.exit(1) }
console.log('  ✔ 四处更正完成')
