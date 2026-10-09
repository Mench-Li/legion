// services-plugin/materialize-ops.mjs
// ============================================================================
// P3（docs/DECISION-legion-owns-model-config.md）：把 P2 的计划翻译成**能写下去的 ops**，
// 以及"写坏了怎么改回去"的逆 ops。**纯函数** —— 没有 ctx、没有网络、没有时钟。
//
// ## 为什么写**叶子**而不是整个 provider 对象
//
// 一个 provider 节点在 DSH 的档案里可能还带着我们不认识的东西（header、超时、代理…）。
// 一上来就 `set ['providers', id] = {我们认识的那几个字段}` 会把那些**无声地抹掉** ——
// 而我们的读者（`dsh-snapshot.mjs`）本来就是按白名单读的，所以**看不见被抹掉的是什么**。
//
//   > 一个"把整块覆盖成我认为的样子"的写入，
//   > 与一个"只改我要改的那几个叶子"的写入，
//   > 在两端都只有白名单字段时是同一个东西 ——
//   > 而差别只在**别人往那块里放了东西**的时候显现，那时前者的失败是静默的。
//
// 所以：`create` / `update` 一律走**逐叶子** set/unset；只有 `delete` 才 unset 整个节点。
//
// ## 逆 ops 只能还原"看得见的部分"
//
// 这是本模块最诚实的一处限制：删除整个 provider 时，逆操作只能把**读者看得见的那些叶子**
// 写回去（`dsh-snapshot.mjs` 是白名单读者）。别人放进那块里的未知字段**还原不了**。
// 因此 `delete` 在本实现里默认**不执行**（见 `materializer.mjs` 的 `allowDeletes`），
// 并且这一点在文档里明说 —— 一个"回滚看起来成功了、其实少还原了几个字段"的读数，
// 与一个"回滚真的完整"的读数，在日志里长得一模一样。
// ============================================================================

/** 受管叶子：与 `dsh-snapshot.mjs` 的读者、`provider-store.mjs` 的白名单同一组。 */
export const MANAGED_LEAVES = Object.freeze(['displayName', 'api', 'baseURL', 'apiKeyEnv', 'models'])

/** Legion 侧的一条 → DSH 侧的 provider 值形状。**只含受管叶子**。 */
export function providerValue(entry) {
  return {
    displayName: typeof entry?.displayName === 'string' && entry.displayName !== '' ? entry.displayName : (entry?.id ?? ''),
    api: entry?.api ?? null,
    baseURL: entry?.baseURL ?? null,
    apiKeyEnv: entry?.apiKeyEnv ?? entry?.secretRef ?? null,
    models: Array.isArray(entry?.models) ? entry.models.map((m) => ({ ...m })) : [],
  }
}

function leafOps(id, value) {
  const ops = []
  for (const leaf of MANAGED_LEAVES) {
    const v = value[leaf]
    // null/undefined ⇒ **unset 这个叶子**（撤掉"我们这一层"的覆盖），而不是写一个 null 进去。
    // 写 null 会让"没有这个字段"与"这个字段是空的"变成两种状态，而它们在该 schema 下不是。
    if (v === null || v === undefined) ops.push({ op: 'unset', path: ['providers', id, leaf] })
    else ops.push({ op: 'set', path: ['providers', id, leaf], value: v })
  }
  return ops
}

/**
 * 计划 → ops。
 *
 * @param plan      `planMaterialization(...)` 的返回值
 * @param desired   Legion 侧目录（用来取每条要写什么值）
 * @param actual    DSH 侧快照（用来算逆 ops 的"改回去"）
 * @param allowDeletes `false` 时**跳过全部删除**，并把它们记进 `skippedDeletes`
 * @returns `{ ops, reversed, appliedIds, skippedDeletes, credentialsToSet, credentialsSkipped }`
 */
export function planToOps({ plan, desired = [], actual = [], allowDeletes = true } = {}) {
  const wantById = new Map()
  for (const raw of desired) {
    const id = raw?.id
    if (typeof id === 'string' && id !== '') wantById.set(id, providerValue(raw))
  }
  const haveById = new Map()
  for (const raw of actual) {
    const id = raw?.id
    if (typeof id === 'string' && id !== '') haveById.set(id, raw)
  }

  const ops = []
  const reversed = []
  const appliedIds = []
  const touched = [...plan.create, ...plan.update.map((u) => u.id)]

  for (const id of touched) {
    const want = wantById.get(id)
    if (want === undefined) continue
    // 逆 ops 先算：它描述的是"这些叶子改之前是什么样"。
    //   改之前**没有这条**（create）⇒ 逆操作是 unset 整个节点；
    //   改之前**有这条**（update）⇒ 逆操作是把它当时的叶子写回去。
    const before = haveById.get(id)
    if (before === undefined) reversed.push({ op: 'unset', path: ['providers', id] })
    else reversed.push(...leafOps(id, providerValue(before)))
    ops.push(...leafOps(id, want))
    appliedIds.push(id)
  }

  const skippedDeletes = []
  for (const id of plan.delete) {
    if (!allowDeletes) { skippedDeletes.push(id); continue }
    const before = haveById.get(id)
    // 删除的逆操作只能还原"看得见的叶子"（见文件头那条限制）。
    if (before !== undefined) reversed.push(...leafOps(id, providerValue(before)))
    ops.push({ op: 'unset', path: ['providers', id] })
    appliedIds.push(id)
  }

  // 凭证：**只新增、从不删除**。
  //   "Legion 里没有这个值"不等于"DSH 该把它删掉" —— 后者的后果是别人正在用的模型直接失效。
  const credentialsToSet = []
  const credentialsSkipped = []
  for (const id of wantById.keys()) {
    const want = wantById.get(id)
    if (want.apiKeyEnv === null) continue
    if (plan.credentialsNeeded.includes(want.apiKeyEnv)) credentialsToSet.push(want.apiKeyEnv)
    else credentialsSkipped.push(want.apiKeyEnv)
  }

  return Object.freeze({
    ops: Object.freeze(ops),
    reversed: Object.freeze(reversed),
    appliedIds: Object.freeze(appliedIds),
    skippedDeletes: Object.freeze(skippedDeletes.slice().sort()),
    credentialsToSet: Object.freeze([...new Set(credentialsToSet)].sort()),
    credentialsSkipped: Object.freeze([...new Set(credentialsSkipped)].sort()),
  })
}

/**
 * 写完之后，**还允许剩下哪些差异**。
 *
 * 这是判据的关键：验收不是"绝对干净"，而是"剩下的差异恰好是我们**有意**跳过的那几条"。
 * 用"绝对干净"当判据会在跳过删除时**永远判失败** —— 于是每次写都回滚，
 * 而日志上看起来像"DSH 不听话"。
 *
 * @param skippedDeletes    有意跳过的删除（数组，用条数）
 * @param credentialRefsLeft 有意不动的凭证**个数**（不是数组，见下面的教训）
 */
export function expectedResidual({ skippedDeletes = [], credentialRefsLeft = 0 } = {}) {
  return Object.freeze({
    create: 0,
    update: 0,
    delete: Array.isArray(skippedDeletes) ? skippedDeletes.length : 0,
    // ★ 这里收的是**个数**。写成 `credentialRefsLeft.length` 会在调用方传数字时得到
    //   `undefined` —— 而 `undefined !== 0` 于是判据永远失败、每次都回滚。
    //   （实测踩到：第一次跑 P3 用例 ⑧⑨ 全红，日志写着"仍缺凭证 1 个（期望 undefined）"。）
    credentialsNeeded: Number.isInteger(credentialRefsLeft) ? credentialRefsLeft : 0,
  })
}

/** 把"写后回读"的实际计划与期望的残余差异比一比，说清差在哪。 */
export function verifyResidual(actualPlan, expected) {
  const problems = []
  if (actualPlan.counts.create !== expected.create) {
    problems.push(`仍有 ${actualPlan.counts.create} 条要新增（期望 ${expected.create}）：${actualPlan.create.join(', ')}`)
  }
  if (actualPlan.counts.update !== expected.update) {
    problems.push(`仍有 ${actualPlan.counts.update} 条要修改（期望 ${expected.update}）：${actualPlan.update.map((u) => `${u.id}(${u.fields.join('/')})`).join(', ')}`)
  }
  if (actualPlan.counts.delete !== expected.delete) {
    problems.push(`要删除的条数变成 ${actualPlan.counts.delete}（期望 ${expected.delete}）：${actualPlan.delete.join(', ')}`)
  }
  if (actualPlan.credentialsNeeded.length !== expected.credentialsNeeded) {
    problems.push(`仍缺凭证 ${actualPlan.credentialsNeeded.length} 个（期望 ${expected.credentialsNeeded}）：${actualPlan.credentialsNeeded.join(', ')}`)
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}
