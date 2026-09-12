// product/lifecycle/uninstall.mjs
// ============================================================================
// PRT-908：卸载时的**数据保留与彻底删除选择**。
//
// spec §10 line 749：「卸载时明确区分删除程序、保留数据和彻底删除数据。」
//
// ## 为什么"删干净了"这句话必须由**枚举**支撑，而不是由返回值支撑
//
// 卸载实现最容易写成这样：按模式列几个路径删掉，然后返回 `{ ok: true }`。
// 它的失败方式很特别——**漏掉一个落点时它照样返回 ok**：
//
//   > 一个「按清单删了几个路径、于是报告成功」的卸载，
//   > 与一个「漏掉了 team-hub 的 team.db 与 whiteboard 的 rooms 目录、
//   > 于是数据还在磁盘上」的卸载，是同一个东西——
//   > 只不过前者在返回值上看起来是彻底干净的。
//
// 所以本模块不接受"要删什么"作为**输入**，而是接受**磁盘上实际存在什么**
// （`stores`），按台账逐条分类，再把结果算出来。三类产出：
//
//   · `remove` —— 这次要删的；
//   · `keep`   —— 这次明确留下的（**必须逐条列出**）；
//   · `refuse` —— 认不出类别、因此**拒绝**动的。
//
// `refuse` 是关键：一个认不出类别的落点，删它是数据丢失，留它是不彻底。
// 本模块选择**保留并报出来**，因为"少删了一个"可以补救，"误删了"不能。
//
// ## ★ "保留数据"与"把凭据留在磁盘上"是两件事
//
// 本仓库的布局让这件事可做：`secretsFile` 在 `productHome/.secrets/` 下，
// **不在** `dataDir` 下（`product/paths.mjs:212`）。所以 `keep-data` 模式
// 能表达"留下 team.db、删掉密钥"。
//
// 而分类器必须先判密钥、再判容器——否则一个把密钥库配在 `dataDir` 下的用户
// 会被归成"业务数据库"，于是 `keep-data` 会**静默地留下凭据**。
// ============================================================================

import {
  DATA_CLASSES,
  DATA_CLASSES_CHECKED,
  UNINSTALL_MODES,
  UNINSTALL_MODE_IDS,
  classifyPath,
} from './data-classes.mjs'

/** 卸载计划版本。 */
export const UNINSTALL_VERSION = 'legion/uninstall@1'

export const UNINSTALL_CODES = Object.freeze({
  /** 认不出类别的落点——不删，报出来。 */
  UNCLASSIFIED_STORE: 'uninstall-unclassified-store',
  /** 未知卸载模式。 */
  MODE_UNKNOWN: 'uninstall-mode-unknown',
  /** 某模式下某落点要删，但它被标为不可删。 */
  PROTECTED: 'uninstall-protected-store',
  /** 磁盘上一个落点都没有——"删完了"与"什么都没找到"不是一件事。 */
  NO_STORES: 'uninstall-no-stores',
})

/**
 * 算一份卸载计划。
 *
 * @param {object} args
 * @param {ReadonlyArray<{path: string, classId?: string, note?: string}>} args.stores
 *   **磁盘上实际存在**的落点。不是"要删什么"——见文件头。
 * @param {string} args.mode `UNINSTALL_MODE_IDS` 之一
 * @param {object} [args.layout] `resolveLayout` 的 layout
 * @returns {{version: string, mode: string, remove: ReadonlyArray<object>,
 *            keep: ReadonlyArray<object>, refuse: ReadonlyArray<object>,
 *            findings: ReadonlyArray<object>, secretsKept: boolean,
 *            byClass: object, ok: boolean}}
 */
export function planUninstall({ stores = [], mode, layout = {} } = {}) {
  const findings = []
  const spec = UNINSTALL_MODES[mode]

  if (spec === undefined) {
    return Object.freeze({
      version: UNINSTALL_VERSION,
      mode: mode ?? null,
      remove: Object.freeze([]),
      keep: Object.freeze([]),
      // 未知模式**不猜**。猜"purge"会删掉用户的数据，猜"program-only"会什么都不删。
      refuse: Object.freeze([...stores]),
      findings: Object.freeze([Object.freeze({
        code: UNINSTALL_CODES.MODE_UNKNOWN,
        detail: `未知卸载模式 ${JSON.stringify(mode)}（合法值：${UNINSTALL_MODE_IDS.join(' / ')}）——不猜，什么都不删`,
      })]),
      secretsKept: true,
      byClass: Object.freeze({}),
      ok: false,
    })
  }

  const remove = []
  const keep = []
  const refuse = []
  const byClass = {}

  for (const store of stores) {
    const { classId, reason } = classifyPath(store, layout)
    if (classId === null) {
      // ★ 认不出就不动。"少删了一个"可以补救，"误删了"不能。
      refuse.push(Object.freeze({ path: store.path, classId: null, note: store.note ?? null, reason }))
      findings.push(Object.freeze({
        code: UNINSTALL_CODES.UNCLASSIFIED_STORE,
        path: store.path,
        detail: `认不出类别的落点：${reason}——保留并报出来，不猜着删`,
      }))
      continue
    }
    byClass[classId] = (byClass[classId] ?? 0) + 1
    const action = DATA_CLASSES[classId].onUninstall
    const chosen = spec.removes.includes(classId)

    if (action === 'never') {
      // 台账说"永不删"，但模式表偏偏要删它 → 拒绝执行，而不是照做。
      // 两个表打架时以更保守的那个为准。
      keep.push(Object.freeze({ path: store.path, classId, note: store.note ?? null, reason: `台账规定 ${classId} 永不删除` }))
      findings.push(Object.freeze({
        code: UNINSTALL_CODES.PROTECTED,
        path: store.path,
        classId,
        detail: `模式 ${mode} 要求删除 ${classId}，但台账规定它永不删除——已拒绝，保留`,
      }))
      continue
    }

    // ★ `ask` 类（密钥）：模式**必须**对它有明确表态。
    //   三种模式都显式列了 secret 或不列，因此这里的表态是清楚的；
    //   若某个模式两边都没写，那才是问题——台账自检已经拦住那种情况。
    if (chosen) {
      remove.push(Object.freeze({
        path: store.path, classId, note: store.note ?? null,
        reason: `模式 ${mode}（${spec.label}）要求删除 ${classId}`,
      }))
    } else {
      keep.push(Object.freeze({
        path: store.path, classId, note: store.note ?? null,
        reason: `模式 ${mode} 保留 ${classId}`,
      }))
    }
  }

  if (stores.length === 0) {
    findings.push(Object.freeze({
      code: UNINSTALL_CODES.NO_STORES,
      detail: '磁盘上一个落点都没找到——"删完了"与"什么都没扫到"不是同一件事',
    }))
  }

  return Object.freeze({
    version: UNINSTALL_VERSION,
    mode,
    remove: Object.freeze(remove),
    keep: Object.freeze(keep),
    refuse: Object.freeze(refuse),
    findings: Object.freeze(findings),
    // ★ 必须能一眼看出凭据留没留下，而不是让人去 keep 列表里找。
    secretsKept: keep.some((k) => k.classId === 'secret'),
    byClass: Object.freeze(byClass),
    // 有 refuse 或 findigns 里的存疑项时不算 ok——"报告成功"必须是有条件的。
    ok: refuse.length === 0 && !findings.some((f) => f.code === UNINSTALL_CODES.MODE_UNKNOWN),
  })
}

/**
 * 把计划渲染成**用户看得懂的去留清单**。
 *
 * 这是 spec line 749"明确区分"的落点：用户在看到这张表之后才应该确认。
 * 只打印"将删除数据"，与不区分是一回事。
 */
export function renderUninstallPlan(plan) {
  const lines = []
  const spec = UNINSTALL_MODES[plan.mode]
  lines.push(`卸载模式：${plan.mode ?? '(未知)'}${spec ? `　${spec.label}` : ''}`)
  if (spec) lines.push(`说明：${spec.why}`)
  lines.push('')

  const group = (title, list, mark) => {
    lines.push(`${title}（${list.length}）`)
    if (list.length === 0) lines.push('  （无）')
    for (const it of list) {
      lines.push(`  ${mark} [${it.classId ?? '未知'}] ${it.path}${it.note ? ` — ${it.note}` : ''}`)
    }
    lines.push('')
  }
  group('将删除', plan.remove, '✖')
  group('将保留', plan.keep, '✔')
  group('拒绝处理（认不出类别，保留）', plan.refuse, '?')

  // ★ 凭据的去留单独一行说清。它是"保留数据"里最容易被误读的那一项。
  lines.push(`凭据（密钥库）：${plan.secretsKept ? '**保留**' : '删除'}`)
  if (plan.secretsKept && plan.mode === 'program-only') {
    lines.push('  ⚠️ 本次选择了保留凭据。若这台机器会交给别人，请改用 keep-data 或 purge。')
  }

  for (const f of plan.findings) lines.push(`  [${f.code}] ${f.detail}`)
  return lines.join('\n')
}

/**
 * 台账自检的再导出：卸载计划建立在台账自洽的前提上。
 *
 * 留下算出来的值（每模式删哪些类、密钥去留），不是一个布尔。
 */
export function uninstallSelfCheck() {
  const problems = []
  // 三种模式的**观察结果**必须两两不同——否则"明确区分"只是三个名字。
  const observed = UNINSTALL_MODE_IDS.map((id) => {
    const stores = [
      { path: '/p/program/app.exe', classId: 'program' },
      { path: '/h/data/team.db', classId: 'database' },
      { path: '/h/log/app.log', classId: 'log' },
      { path: '/h/secrets/secrets.json', classId: 'secret' },
      { path: '/h/cache/x', classId: 'cache' },
      { path: '/w/repo/file.js', classId: 'workspace' },
    ]
    const plan = planUninstall({ stores, mode: id })
    return {
      mode: id,
      removes: plan.remove.map((r) => r.classId).sort(),
      keeps: plan.keep.map((r) => r.classId).sort(),
      secretsKept: plan.secretsKept,
      workspaceKept: plan.keep.some((k) => k.classId === 'workspace'),
    }
  })
  const shapes = new Map()
  for (const o of observed) {
    const key = o.removes.join(',')
    if (shapes.has(key)) problems.push(`模式 ${o.mode} 与 ${shapes.get(key)} 的实际删除集合相同`)
    shapes.set(key, o.mode)
    // 工作区在任何模式下都必须保留。
    if (!o.workspaceKept) problems.push(`模式 ${o.mode} 删掉了工作区`)
  }
  // keep-data 必须真的留下业务数据库、且真的删掉密钥——
  // 这一条是 spec line 749 的字面要求，单独钉住。
  const kd = observed.find((o) => o.mode === 'keep-data')
  if (kd === undefined) problems.push('没有 keep-data 模式')
  else {
    if (!kd.keeps.includes('database')) problems.push('keep-data 没有保留业务数据库——那 "保留数据" 是空话')
    if (kd.secretsKept) problems.push('keep-data 留下了密钥——"保留数据"不该被读成"把凭据也留着"')
  }
  // program-only 必须留下数据库但**可以**留密钥；purge 必须不留密钥。
  const pg = observed.find((o) => o.mode === 'purge')
  if (pg !== undefined && pg.secretsKept) problems.push('purge 留下了密钥——"彻底删除"没做到')
  const po = observed.find((o) => o.mode === 'program-only')
  if (po !== undefined && !po.keeps.includes('database')) problems.push('program-only 删掉了业务数据库')

  // 认不出类别的落点必须进 refuse，不能进 remove。
  const unclassified = planUninstall({
    stores: [{ path: '/somewhere/unknown-thing' }], mode: 'purge', layout: {},
  })
  if (unclassified.remove.length !== 0) problems.push('认不出类别的落点在 purge 下被删了')
  if (unclassified.refuse.length !== 1) problems.push('认不出类别的落点没有进 refuse')
  // 未知模式必须什么都不删。
  const bogus = planUninstall({ stores: [{ path: '/h/data/team.db', classId: 'database' }], mode: 'nuke' })
  if (bogus.remove.length !== 0) problems.push('未知卸载模式仍然删了东西')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    version: UNINSTALL_VERSION,
    modeObservations: Object.freeze(observed.map((o) => Object.freeze({
      mode: o.mode, removes: Object.freeze(o.removes), keeps: Object.freeze(o.keeps),
      secretsKept: o.secretsKept, workspaceKept: o.workspaceKept,
    }))),
    classesChecked: DATA_CLASSES_CHECKED.ok,
  })
}

export const UNINSTALL_CHECKED = uninstallSelfCheck()
