// ============================================================================
// PRT-705 的运行记录与孤儿进程清理
//
// spec §6.10 把「优雅关闭与僵尸进程清理」列为 Launcher 必须提供的能力。
// 优雅关闭（SIGTERM → 宽限 → 杀**进程树**）已经在 `supervisor.mjs` 里做了。
// 这里补的是**另一半**，也是更难的一半。
//
// ── 问题 ──
//
// `stop()` 只能清理**它自己还活着时**启动的那些进程。如果 Launcher 自己被
// 强杀（任务管理器结束进程、断电、崩溃），它的子进程会活下来继续占端口。
// 下一次启动时：
//
//   · 端口占用检查报 `PORT_IN_USE`：「请关闭占用它的进程」；
//   · 而用户打开任务管理器，看到的是几个**没有任何标识的 node.exe**。
//
// 真实原因是「上一次 Legion 没退干净」，但现在的提示把它和「一个不相干的
// 程序占了这个端口」说成了同一句话。两条路的处置完全不同：
// 前者应当由产品自己收拾，后者**绝对不能碰**。
//
//   > 一个把"我上次没退干净"与"别人占了这个端口"说成同一句话的提示，
//   > 把一件产品该自己收拾的事，变成了一件要用户去猜的事。
//
// ── 做法 ──
//
// 启动时把「我们起了哪些 pid、每一个的映像名是什么」写进 DataDir，
// 正常停止时删掉。下次启动读它，逐个判。
//
// ── 这里最容易犯的、也是唯一真正危险的那个错 ──
//
// **PID 会被系统回收。**
//
// 记录里写着 `pid=4321`。那个进程退出了，系统把 4321 分配给了用户的编辑器。
// 如果按号码去杀，我们杀掉的是编辑器。这不是"清理得不干净"，
// 这是**毁掉一个不相干的程序**，而且不可撤销。
//
// 所以本模块的绝对纪律是：
//
//   · **★ 绝不按 pid 号码杀。** 必须先用映像名确认"这确实是我们起的那个"；
//   · 映像名对不上 → 判 `recycled`，**无论调用方怎么要求都不杀**；
//   · 映像名读不出来 → 判 `unknown`，默认不杀（要杀得显式 `allowUnverified`）；
//   · "读不出来"与"对不上"与"已经没了"是**三个不同的结论**，分开报。
//
//   > 一个按号码去杀的清理动作，与一个随机杀进程的动作，
//   > 在"会不会误伤"上是同一个东西——只是前者看起来有理有据。
// ============================================================================
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 记录格式版本。**读不认识的版本要拒绝，不要猜。** */
export const RUN_RECORD_VERSION = 'legion/launcher-run@1'

/** 记录文件名。放在 DataDir 根下——它是"这次运行"的状态，不是某个进程的。 */
export const RUN_RECORD_FILENAME = 'launcher-run.json'

export const RUN_RECORD_CODES = Object.freeze({
  /** 记录读不出来（权限、IO）。**不是**「没有记录」。 */
  RECORD_UNREADABLE: 'RUN_RECORD_UNREADABLE',
  /** 记录在，但不是本模块认识的形状/版本。 */
  RECORD_CORRUPT: 'RUN_RECORD_CORRUPT',
  /** 记录写不下去。下一次启动就认不出这次的残留。 */
  RECORD_WRITE_FAILED: 'RUN_RECORD_WRITE_FAILED',
  /** 上一次运行的进程还活着。 */
  ORPHANS_FOUND: 'ORPHANS_FOUND',
  /** 某个 pid 已经被系统回收给了别的程序。**这才是必须显式报出来的那种。** */
  PID_RECYCLED: 'PID_RECYCLED',
  /** 想清理但身份没确认，按纪律拒绝。 */
  SWEEP_REFUSED: 'SWEEP_REFUSED',
  /** 清理时杀失败。 */
  SWEEP_FAILED: 'SWEEP_FAILED',
  /**
   * ★★★ 声明了一个进程字段，却没人登记"怎么取它/怎么校验它"。
   *
   *   **这是一个编程错误，不是一个数据状况**——所以它必须**上抛**，
   *   绝不能"跳过这个字段继续写"。跳过就是静默丢掉那个读数。
   */
  FIELD_NOT_WIRED: 'RUN_RECORD_FIELD_NOT_WIRED',
})

/**
 * 记录里每个进程**必须有的**字段。少一个算坏记录；**多一个不算**。
 *
 * ★ 原文写的是「多一个少一个都算坏记录」——**那句话是不对的**。实测
 *   （`run-record.test.mjs` 那两条"多一个/少一个"用例）：
 *
 *     多一个 `peakResource` ⇒ `validateRunRecord` ok=true
 *     少一个 `image`        ⇒ `validateRunRecord` ok=false
 *
 *   下面 `validateRunRecord` 里只有 `for (const f of RUN_RECORD_FIELDS)` 配合
 *   `!(f in p)`，**没有任何地方拒绝多余字段**。
 *
 * ★★ 而"多余字段必须继续被容忍"是**有意的**，不能把这个注释"补成真的"：
 *   记录由**上一个** launcher 进程写下、由**这一个**读出来清理孤儿进程，
 *   所以写入方与读取方**可能不是同一个版本**。一条更富的新记录落到一个更旧的
 *   读取方上时，两种处置的后果相反：
 *
 *     · 容忍多余字段 ⇒ 旧读取方照常按 `{key,pid,image}` 清理；
 *     · 拒绝多余字段 ⇒ 旧读取方报"记录坏了、不知道上次起了什么"
 *                      ⇒ **孤儿进程不被清理**。
 *
 *   > 一个"记录更富了所以我不读"的读取方，
 *   > 与一个"上一轮起的进程泄漏在机器上"的守护进程，是同一个东西——
 *   > 只不过前者的日志里有一行诚实的"记录格式不认识"。
 *
 *   所以本模块的形状是刻意不对称的：**写入方闭合**（`buildRunRecord` 只挑
 *   这三个字段）、**读取方宽容**（多出来的不认、也不拒）。
 */
export const RUN_RECORD_FIELDS = Object.freeze(['key', 'pid', 'image'])

/**
 * 记录里每个进程**可以有、但可以没有**的字段。
 *
 * ★★★ 新读数一律加在**这里**，**不要**加进 `RUN_RECORD_FIELDS`。
 *
 *   上面那张表的语义是「**必须有**」（`validateRunRecord` 里
 *   `!(f in p) ⇒ 坏记录`）。把 `peakResource` 加进去，就要求**上一个** launcher
 *   写下的记录也必须有它——而那条记录写下的时候这个字段**还不存在**
 *   ⇒ 读取方判「记录坏了、不知道上次起了什么」
 *   ⇒ **孤儿进程不被清理**。
 *
 *   也就是说：加进 `RUN_RECORD_FIELDS` 会让这个模块**正好犯下它自己
 *   上面那段注释警告过的事**（旧读取方拒绝更富的记录）。
 *
 *   > 一个"缺了这个字段所以记录不可用"的校验，与一个"这条记录本来就没有这个读数"的记录，
 *   > 在"上一轮起的进程还活着吗"这个问题上是**同一个东西**：
 *   > 都得到"不知道"，而"不知道"的处置是**不动手**。
 *
 *   ★ 同理**不动 `RUN_RECORD_VERSION`**：`validateRunRecord` 里
 *   `value.version !== RUN_RECORD_VERSION ⇒ 坏记录`，所以抬版本号等于把
 *   磁盘上所有更旧的记录一次性判死。两个字段的处置必须一致——
 *   一边说"多余字段容忍"、一边抬版本号，是自相矛盾的。
 *
 *   ⚠️ 后果是**前向兼容靠"容忍"、不靠版本号**：新写入方写的更富记录，
 *   旧读取方照常按 `{key,pid,image}` 清理；旧记录落到新读取方上，
 *   `peakResource` 缺席 ⇒ **不算坏记录**（见 `run-record.test.mjs` ②'）。
 */
export const RUN_RECORD_OPTIONAL_FIELDS = Object.freeze(['peakResource'])

/** `peakResource` 里三个**测量值**。判别"没采到"看的就是它们。 */
const PEAK_RESOURCE_MEASURE_FIELDS = Object.freeze([
  'peakWorkingSetBytes', 'peakRssBytes', 'cpuMs',
])

/**
 * 把一份采样读数规范成记录里的形状。纯函数。
 *
 * ★ 读数的形状来自 `product/launcher/peak-resource.mjs` 的 `window()`：
 *   `{ ok, pid, platform, samples, startedAtMs, endedAtMs, lastOkAtMs, lastCode,
 *      peakWorkingSetBytes, peakRssBytes, cpuMs }`。
 *
 * ★ `null` 是**一等公民**：它表示"从未采样"，与 `ok:false`（采过但采不到）
 *   和 `ok:true`（采到了）是**三种**不同的事。三者都不许塌缩成第四种。
 *
 * ⚠️ 这个函数**不做**"把不合形状的值静默丢掉"以外的事——静默丢掉正是本模块
 *   要避免的那件事（见 `buildRunRecord` 的注释）。所以：
 *   · 传进来 `null`/`undefined` ⇒ 返回 `null`（**从未采样**，如实）；
 *   · 传进来非对象（数字、字符串、数组）⇒ 返回 `null`；
 *   · `validateRunRecord` 会在**读**的那一侧把坏形状报出来，不靠这里拦。
 */
export function normalizePeakResource(v) {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object' || Array.isArray(v)) return null
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const txt = (x) => (typeof x === 'string' && x !== '' ? x : null)
  return Object.freeze({
    ok: v.ok === true,
    pid: num(v.pid),
    platform: txt(v.platform),
    samples: num(v.samples) ?? 0,
    startedAtMs: num(v.startedAtMs),
    endedAtMs: num(v.endedAtMs),
    lastOkAtMs: num(v.lastOkAtMs),
    lastCode: txt(v.lastCode),
    peakWorkingSetBytes: num(v.peakWorkingSetBytes),
    peakRssBytes: num(v.peakRssBytes),
    cpuMs: num(v.cpuMs),
  })
}

/**
 * ★★★ 必填字段**怎么从生产者那一行取出来**。
 *
 *   这张登记表必须与 `RUN_RECORD_FIELDS` **逐项对齐**——由 `recordWiring()` 判，
 *   由 `run-record.test.mjs` 钉住。`buildRunRecord` **遍历声明**去取，
 *   **不再手写字段名**（见下面"第三处"那段）。
 *
 *   > 一张"新读数写在这里"的登记表，与一条真的会把新读数带过去的通路，
 *   > 只差这几行——只不过缺少它们时，下一个照做的人会得到一个**静默丢掉**的读数。
 */
const REQUIRED_FIELD_READERS = Object.freeze({
  key: (p) => String(p?.key ?? ''),
  pid: (p) => (typeof p?.pid === 'number' ? p.pid : null),
  image: (p) => (typeof p?.image === 'string' && p.image !== '' ? p.image : null),
})

/** ★★★ 可选字段怎么规范化。同样必须与 `RUN_RECORD_OPTIONAL_FIELDS` 逐项对齐。 */
const OPTIONAL_FIELD_READERS = Object.freeze({
  peakResource: (p) => normalizePeakResource(p?.peakResource),
})

/**
 * ★★★ 可选字段的**形状校验器**。
 *
 *   与 `OPTIONAL_FIELD_READERS` **分开**，因为"写出去的样子"与"读回来什么样算坏"
 *   是两个方向的问题：写的一方要**宽容**（不合形状的落成 null），
 *   读的一方要**报出来**。
 *
 *   > 一个"写入方把坏形状静默落成 null"的模块，配上一个"读取方永远看不到坏形状"的
 *   > 模块，合起来得到的是「这个读数一直是好的」——而它可能**从来没有过值**。
 */
const OPTIONAL_FIELD_VALIDATORS = Object.freeze({
  peakResource: (pr, where, problems) => {
    if (typeof pr !== 'object' || Array.isArray(pr)) {
      problems.push(`${where}.peakResource 既不是 null 也不是对象：${JSON.stringify(pr)}`)
      return
    }
    if (typeof pr.ok !== 'boolean') {
      problems.push(`${where}.peakResource.ok 不是布尔：${JSON.stringify(pr.ok)}`)
    }
    for (const f of PEAK_RESOURCE_MEASURE_FIELDS) {
      const v = pr[f]
      if (v !== null && !(typeof v === 'number' && Number.isFinite(v))) {
        problems.push(`${where}.peakResource.${f} 既不是 null 也不是有限数：${JSON.stringify(v)}`)
      }
    }
    // ★★★ 本模块要守的那条纪律，落成一条**可判**的不变式：
    //   `ok=false`（采过但采不到）时，三个测量值**必须都是 null**。
    //
    //   0 是一个**测量结论**（"一个字节都没用"），不是"不知道"。
    //   一个 `ok:false` 却带着 0 的记录，会让"这台机器很省内存"
    //   与"这台机器根本没采到"在事后读记录时同形。
    if (pr.ok === false) {
      const notNull = PEAK_RESOURCE_MEASURE_FIELDS.filter((f) => pr[f] !== null)
      if (notNull.length > 0) {
        problems.push(`${where}.peakResource 声明 ok=false，却带着测量值 `
          + `${notNull.join('/')}——"没采到"必须写 null，**不许写 0**`)
      }
    }
  },
})

/**
 * ★★★ 声明与接线**对不对得上**。这是本模块"新增进程读数"唯一一处**机械门禁**。
 *
 *   为什么要有它：这个文件里已经有一张 ★★★ 的登记表（`RUN_RECORD_OPTIONAL_FIELDS`），
 *   注释写着「新读数一律加在**这里**」。而在加这条判据之前，**照做一次**的后果是：
 *
 *     · `buildRunRecord` 只把**它自己手写的那几个**名字抄过去 ⇒ 新字段**静默丢掉**；
 *     · `validateRunRecord` 只校验**它自己手写的那几个**名字 ⇒ 新字段**静默不校验**；
 *     · 于是记录看起来**完全正常**，而那个读数从来没到过磁盘。
 *
 *   实测（`scratch/_probe-record-drop.mjs`）：生产者交上 `diskUsageBytes`，
 *   写出的记录里没有它，`validateRunRecord(...).problems` 为 **`[]`**。
 *
 *   > 一张只写在注释里的扩展点，与一条真的能扩展的通路，
 *   > 在"下一个人照做之后会不会发现问题"这个读数上是**同一个东西**：
 *   > 都不会发现。
 *
 *   可注入是为了让**用例能造一个第二字段**去证明这条通路真的通——
 *   不然这条判据只能证明"当下这一个字段恰好是通的"。
 */
export function recordWiring({
  requiredFields = RUN_RECORD_FIELDS,
  optionalFields = RUN_RECORD_OPTIONAL_FIELDS,
  requiredReaders = REQUIRED_FIELD_READERS,
  optionalReaders = OPTIONAL_FIELD_READERS,
  optionalValidators = OPTIONAL_FIELD_VALIDATORS,
} = {}) {
  const missingReader = requiredFields.filter((f) => typeof requiredReaders[f] !== 'function')
  const missingOptionalReader = optionalFields.filter((f) => typeof optionalReaders[f] !== 'function')
  const missingValidator = optionalFields.filter((f) => typeof optionalValidators[f] !== 'function')
  // 反向：登记了却没人声明 ⇒ 一条**永远不会被执行**的读取/校验（同样的静默，另一个方向）
  const undeclared = [...Object.keys(requiredReaders), ...Object.keys(optionalReaders)]
    .filter((f) => !requiredFields.includes(f) && !optionalFields.includes(f))
  return Object.freeze({
    ok: missingReader.length + missingOptionalReader.length
      + missingValidator.length + undeclared.length === 0,
    missingReader: Object.freeze(missingReader),
    missingOptionalReader: Object.freeze(missingOptionalReader),
    missingValidator: Object.freeze(missingValidator),
    undeclared: Object.freeze(undeclared),
  })
}

/** 记录路径。`dataDir` 为空时返回 null——**不猜位置**。 */
export function runRecordPath(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') return null
  return join(dataDir, RUN_RECORD_FILENAME)
}

/**
 * 造一条记录。纯函数。
 *
 * `image` 是**映像名**（Windows 上 `tasklist` 那一列的 `node.exe` 之类）。
 * 它是本模块里唯一能用来区分"我们的进程"与一个碰巧拿到同一个号码的
 * 别的程序"的东西——没有它，整个模块就退化成"按号码杀"。
 *
 * ★★ 这是一个**闭合映射**：每个进程只挑 `{key, pid, image}` 加
 *   `RUN_RECORD_OPTIONAL_FIELDS` 里认的那几个，**传进来的别的字段会被静默丢掉**
 *   （不是报错，是不出现）。
 *
 *   这一条是有后果的，所以单独写明：想给记录加一个新读数（例如 `peakResource`），
 *   **只改调用方那一处 `map()` 是不够的** —— 值会在这一层被丢掉，
 *   而且没有任何报错，于是记录里那个字段的读数永远是"没有"，
 *   看起来像"采样没采到"。至少还要改这里，以及 `RUN_RECORD_OPTIONAL_FIELDS`。
 *
 *   （PRT-009 的记账曾经写着"接上只是加一行"，那句是错的；订正见 `run-record.test.mjs`
 *   那条 `buildRunRecord 是闭合映射` 的用例。）
 *
 * ★★★ 续（2026-09-18）：`peakResource` 现在**已经**在这一层被带上——
 *   加在 `RUN_RECORD_OPTIONAL_FIELDS`，**不是** `RUN_RECORD_FIELDS`（理由见那里）。
 *   于是上面那句"至少还要改这里，以及 `RUN_RECORD_FIELDS`"里的**后半句是错的**：
 *   加进 `RUN_RECORD_FIELDS` 反而会让旧记录判死、孤儿进程清不掉。
 *   这是这一条记账里**第二处**"看起来像同一件事、其实处置相反"的地方
 *   （第一处是"接上只是加一行"）。
 *
 * ★★★ 续 2（2026-09-18 第 40 轮）：上面那段"闭合映射"的告警当时**仍然成立**，
 *   只不过它把代价说成"至少要改这里"——而"改这里"是个**手写名字**的动作。
 *   也就是说：`RUN_RECORD_OPTIONAL_FIELDS` 那张表**没有任何机械消费者**，
 *   照它的注释加一个字段，得到的是**静默丢掉**（实测见 `recordWiring` 的注释）。
 *
 *   现在这一层**遍历声明**去取：`RUN_RECORD_FIELDS` 走 `REQUIRED_FIELD_READERS`，
 *   `RUN_RECORD_OPTIONAL_FIELDS` 走 `OPTIONAL_FIELD_READERS`。
 *   声明了却没登记 ⇒ **具名上抛**（`FIELD_NOT_WIRED`），不是跳过。
 *
 *   > 这是本条记账里**第三处**"看起来像同一件事、其实处置相反"：
 *   > 前两处是"接上只是加一行"（其实不止）与"加进 `RUN_RECORD_FIELDS`"（其实要加可选表），
 *   > 这一处是"照着注释加一个字段"（其实会被丢掉）。
 */
export function buildRunRecord({
  runId, launcherPid = null, startedAt, processes,
  requiredFields = RUN_RECORD_FIELDS,
  optionalFields = RUN_RECORD_OPTIONAL_FIELDS,
  requiredReaders = REQUIRED_FIELD_READERS,
  optionalReaders = OPTIONAL_FIELD_READERS,
  now = () => new Date().toISOString(),
} = {}) {
  const unwired = requiredFields.filter((f) => typeof requiredReaders[f] !== 'function')
    .concat(optionalFields.filter((f) => typeof optionalReaders[f] !== 'function'))
  if (unwired.length > 0) {
    const err = new Error(`RunRecord 声明了字段却没有登记取法：${unwired.join('、')}`
      + '——这一层**不**跳过未登记的字段（跳过就是把它静默丢掉）')
    err.code = RUN_RECORD_CODES.FIELD_NOT_WIRED
    err.fields = Object.freeze([...unwired])
    throw err
  }
  return Object.freeze({
    version: RUN_RECORD_VERSION,
    runId: String(runId ?? ''),
    launcherPid: typeof launcherPid === 'number' ? launcherPid : null,
    startedAt: startedAt ?? now(),
    processes: Object.freeze((Array.isArray(processes) ? processes : []).map((p) => {
      // ★ 遍历**声明**，不手写名字：声明里加一项就自动被带过去（或具名上抛）。
      //   键的顺序 = 先必填、后可选，与历史记录逐字相同。
      const row = {}
      for (const f of requiredFields) row[f] = requiredReaders[f](p)
      for (const f of optionalFields) {
        // ★ 缺席与 `null` 是**同一个意思**（"这个写入方没有这个读数"），
        //   所以统一落成 `null`，不用"字段在不在这"再表达一次。
        //   于是读取方只有一件事要判：它是 null 还是有形状。
        row[f] = optionalReaders[f](p)
      }
      return Object.freeze(row)
    })),
  })
}

/**
 * 校验一条记录的形状。
 *
 * 认不出的记录**不能用**：一条写了一半的记录（比如断电时正在写）会让我们
 * 以为"只有两个进程要清"，而实际上有五个。宁可报"记录坏了、不知道上次
 * 起了什么"，也不要按一条残缺记录去清理。
 */
export function validateRunRecord(value, {
  requiredFields = RUN_RECORD_FIELDS,
  optionalFields = RUN_RECORD_OPTIONAL_FIELDS,
  optionalValidators = OPTIONAL_FIELD_VALIDATORS,
} = {}) {
  const problems = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['记录不是一个对象'] }
  }
  if (value.version !== RUN_RECORD_VERSION) {
    problems.push(`记录版本不认识：${JSON.stringify(value.version)}（本模块只认 ${RUN_RECORD_VERSION}）`)
  }
  if (!Array.isArray(value.processes)) {
    problems.push('记录缺少 processes 数组')
  } else {
    for (const [i, p] of value.processes.entries()) {
      if (p === null || typeof p !== 'object') { problems.push(`processes[${i}] 不是对象`); continue }
      for (const f of requiredFields) {
        if (!(f in p)) problems.push(`processes[${i}] 缺少字段「${f}」`)
      }
      if ('pid' in p && p.pid !== null && !Number.isInteger(p.pid)) {
        problems.push(`processes[${i}].pid 不是整数：${JSON.stringify(p.pid)}`)
      }
      // ★★ 可选字段：**缺席不算坏**（那是上一个版本的写入方，见
      //   `RUN_RECORD_OPTIONAL_FIELDS`）；但**在了就要有形状**。
      //
      //   > 一个"缺席"与一个"有但是坏的"，在只判"字段在不在"的校验里
      //   > 是同一个东西——而前者必须放行（否则旧记录判死、孤儿进程清不掉），
      //   > 后者必须报出来（否则一个新写入方的 bug 会伪装成"这个读数没有"）。
      //
      // ★★★ 第 40 轮：这里过去**手写**了 `'peakResource'`，于是
      //   `RUN_RECORD_OPTIONAL_FIELDS` 里新加一项**不会**被校验到——
      //   一个新写入方的坏形状会**静默通过**。现在遍历声明。
      for (const f of optionalFields) {
        if (!(f in p) || p[f] === null || p[f] === undefined) continue
        optionalValidators[f](p[f], `processes[${i}]`, problems)
      }
    }
  }
  return { ok: problems.length === 0, problems }
}

/** 读记录。返回 `{record, diagnostics}`；**任何失败都返回 `record: null`**。 */
export function readRunRecord(file, { fs = { readFileSync, existsSync } } = {}) {
  const diagnostics = []
  if (typeof file !== 'string' || file === '') {
    return { record: null, diagnostics }
  }
  let text = null
  try {
    if (fs.existsSync(file) !== true) return { record: null, diagnostics }
    text = String(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    // **「读不出来」不是「没有记录」。** 当成没有的话，我们会在一个
    // 「不知道上次起了什么」的状态下，按"很干净"去处理。
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.RECORD_UNREADABLE,
      message: `上一次运行的记录读不出来（${e?.code ?? e?.name ?? 'Error'}）：` +
        '**这不等于"上次没有残留进程"**，只是我们无从判断。请人工确认端口是否被占。',
    }))
    return { record: null, diagnostics }
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.RECORD_CORRUPT,
      message: '上一次运行的记录不是合法 JSON（很可能是上次退出时正在写）。' +
        '**不能按一条残缺记录去清理**：它可能少列了进程，按它清理会留下真正的残留。',
    }))
    return { record: null, diagnostics }
  }
  const check = validateRunRecord(parsed)
  if (!check.ok) {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.RECORD_CORRUPT,
      message: `上一次运行的记录形状不对：${check.problems.join('；')}。` +
        '**不能按它去清理**（它可能少列了进程）。请人工确认端口是否被占。',
    }))
    return { record: null, diagnostics }
  }
  return { record: parsed, diagnostics }
}

/** 写记录。失败**不抛**——写不下去不该拦住启动，但必须报出来。 */
export function writeRunRecord(file, record, { fs = { writeFileSync } } = {}) {
  if (typeof file !== 'string' || file === '') {
    return { ok: false, diagnostic: null }
  }
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
    return { ok: true, diagnostic: null }
  } catch (e) {
    return {
      ok: false,
      diagnostic: Object.freeze({
        severity: 'warn', code: RUN_RECORD_CODES.RECORD_WRITE_FAILED,
        message: `这次运行的进程记录写不下去（${e?.code ?? e?.name ?? 'Error'}）。` +
          '**后果是：如果 Legion 这次被强杀，下一次启动就认不出这些残留进程**——' +
          '它们会继续占着端口，而提示只会说"端口被其他进程占用"。',
      }),
    }
  }
}

/** 删记录。失败不抛（删不掉只意味着下次多判一轮，那些 pid 早就没了）。 */
export function clearRunRecord(file, { fs = { rmSync } } = {}) {
  if (typeof file !== 'string' || file === '') return false
  try { fs.rmSync(file, { force: true }); return true } catch { return false }
}

/**
 * 逐个判断记录里的 pid 现在是什么。
 *
 * `isAlive(pid)` 与 `imageOf(pid)` 都是注入的：真实实现见 `createProcessProbe`。
 * 这样这个函数（本模块唯一的判断核心）不需要真的去杀任何东西就能测。
 *
 * 四种结论，**互不替代**：
 *
 *   · `gone`     — 已经不在了。正常情况，什么都不用做。
 *   · `verified` — 活着，且映像名与我们记录的一致。**很可能是我们的。**
 *   · `recycled` — 活着，但映像名对不上：**这个号码已经被系统给了别的程序。**
 *   · `unknown`  — 活着，但映像名读不出来。**不知道它是谁。**
 *
 * `recycled` 与 `unknown` 都不许杀；`unknown` 只有在调用方显式
 * `allowUnverified` 时才杀。`recycled` **无论如何都不杀**。
 */
export async function classifyRecordedPids(record, { isAlive, imageOf } = {}) {
  const entries = []
  for (const p of Array.isArray(record?.processes) ? record.processes : []) {
    if (p?.pid === null || p?.pid === undefined) {
      entries.push(Object.freeze({ key: p?.key ?? '', pid: null, recordedImage: p?.image ?? null, actualImage: null, status: 'gone' }))
      continue
    }
    let alive = false
    try { alive = (await isAlive?.(p.pid)) === true } catch { alive = false }
    if (!alive) {
      entries.push(Object.freeze({ key: p.key ?? '', pid: p.pid, recordedImage: p.image ?? null, actualImage: null, status: 'gone' }))
      continue
    }
    let actualImage = null
    try { actualImage = await imageOf?.(p.pid) } catch { actualImage = null }
    if (typeof actualImage !== 'string' || actualImage === '') {
      entries.push(Object.freeze({ key: p.key ?? '', pid: p.pid, recordedImage: p.image ?? null, actualImage: null, status: 'unknown' }))
      continue
    }
    // 记录里没有映像名时，我们**没有任何依据**说这个 pid 还是我们的。
    // 这不是"乐观地当它是我们的"，而是"承认我们不知道"。
    if (typeof p.image !== 'string' || p.image === '') {
      entries.push(Object.freeze({ key: p.key ?? '', pid: p.pid, recordedImage: null, actualImage, status: 'unknown' }))
      continue
    }
    const status = actualImage.toLowerCase() === p.image.toLowerCase() ? 'verified' : 'recycled'
    entries.push(Object.freeze({ key: p.key ?? '', pid: p.pid, recordedImage: p.image, actualImage, status }))
  }
  return Object.freeze(entries)
}

/**
 * 把分类结果变成**用户能据此做决定**的诊断。
 *
 * 分三条报，因为三条的处置完全不同：
 *   · 有 `verified` → 「这些是我们上次留下的」+ 可以清（`--sweep-orphans`）；
 *   · 有 `recycled` → 「这个号码现在是别的程序在用，**我们没有动它**」；
 *   · 有 `unknown`  → 「读不出它是谁，**我们也没有动它**」。
 *
 * `recycled` 那一条必须是 `warn` 而不是静默：用户可能正因为端口被占而
 * 在排查，而这条恰好解释了"为什么端口占用提示帮不上忙"。
 */
export function orphanDiagnostics(entries) {
  const diagnostics = []
  const verified = entries.filter((e) => e.status === 'verified')
  const recycled = entries.filter((e) => e.status === 'recycled')
  const unknown = entries.filter((e) => e.status === 'unknown')

  if (verified.length > 0) {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.ORPHANS_FOUND,
      pids: Object.freeze(verified.map((e) => e.pid)),
      message: `上一次 Legion 运行留下的 ${verified.length} 个进程还活着：` +
        verified.map((e) => `${e.key}(pid=${e.pid})`).join('、') +
        '。它们很可能还占着端口，这就是"端口被占用"的真实原因。' +
        '用 `--sweep-orphans` 清理（我们会先核对映像名再动手）。',
    }))
  }
  if (recycled.length > 0) {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.PID_RECYCLED,
      pids: Object.freeze(recycled.map((e) => e.pid)),
      message: `记录里的 ${recycled.length} 个 pid 现在**是别的程序**在用，我们没有动它们：` +
        recycled.map((e) => `pid=${e.pid} 记的是 ${e.recordedImage}，现在是 ${e.actualImage}`).join('；') +
        '。系统回收并重新分配了这些号码——这正说明**"按号码杀进程"是会误伤别人的**。' +
        '这些进程本身不需要处理。',
    }))
  }
  if (unknown.length > 0) {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.SWEEP_REFUSED,
      pids: Object.freeze(unknown.map((e) => e.pid)),
      message: `记录里的 ${unknown.length} 个 pid 还活着，但**读不出它们是什么程序**，我们没有动它们：` +
        unknown.map((e) => `pid=${e.pid}`).join('、') +
        '。没有映像名就无法确认这号码还是不是我们的——请人工确认。',
    }))
  }
  return Object.freeze(diagnostics)
}

/**
 * 清理。**只杀 `verified`。**
 *
 * `unknown` 要杀必须显式 `allowUnverified: true`；`recycled` 无论传什么
 * **都不会杀**——那是"号码已经被别人拿走了"，杀它等于毁掉一个不相干的程序。
 *
 * 返回值把"杀了谁、没杀谁、为什么"分开列，因为**"没杀"与"杀失败"
 * 对用户是两件事**：前者是我们的纪律，后者是需要他去处理的故障。
 */
export async function sweepOrphans(entries, { killTree, allowUnverified = false } = {}) {
  const killed = []
  const refused = []
  const failed = []
  const diagnostics = []

  for (const e of entries) {
    if (e.status === 'gone') continue
    if (e.status === 'recycled') {
      refused.push(Object.freeze({ key: e.key, pid: e.pid, reason: 'pid-recycled' }))
      continue
    }
    if (e.status === 'unknown' && allowUnverified !== true) {
      refused.push(Object.freeze({ key: e.key, pid: e.pid, reason: 'identity-unknown' }))
      continue
    }
    let ok = false
    try { ok = (await killTree?.(e.pid)) === true } catch { ok = false }
    if (ok) killed.push(Object.freeze({ key: e.key, pid: e.pid, image: e.actualImage ?? e.recordedImage ?? null }))
    else {
      failed.push(Object.freeze({ key: e.key, pid: e.pid }))
      diagnostics.push(Object.freeze({
        severity: 'warn', code: RUN_RECORD_CODES.SWEEP_FAILED,
        message: `清理进程 ${e.key}(pid=${e.pid}) 失败。它可能仍占着端口——` +
          '**这条失败不代表它还在，也不代表它已经没了**，请用端口占用检查确认。',
      }))
    }
  }

  if (refused.length > 0) {
    const recycledCount = refused.filter((r) => r.reason === 'pid-recycled').length
    const unknownCount = refused.filter((r) => r.reason === 'identity-unknown').length
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.SWEEP_REFUSED,
      message: `有 ${refused.length} 个进程**没有被清理**：` +
        (recycledCount > 0 ? `${recycledCount} 个的 pid 已被系统回收给别的程序` : '') +
        (recycledCount > 0 && unknownCount > 0 ? '，' : '') +
        (unknownCount > 0 ? `${unknownCount} 个读不出是什么程序` : '') +
        '。这不是失败，是我们的纪律：**没有确认身份就不动手**。' +
        (recycledCount > 0 ? '按号码去杀会杀掉一个不相干的程序，而且不可撤销。' : ''),
    }))
  }

  return Object.freeze({
    killed: Object.freeze(killed),
    refused: Object.freeze(refused),
    failed: Object.freeze(failed),
    diagnostics: Object.freeze(diagnostics),
  })
}

/**
 * 真实的进程探针（可注入 spawn，便于用例不真的起进程）。
 *
 * `isAlive` 用 `process.kill(pid, 0)`：它不发信号，只做存在性检查。
 * `ESRCH` = 不在了；`EPERM` = 在，但不是我们能动的（也算"在"）。
 *
 * `imageOf` 走系统自带的 `tasklist` / `ps`——**这是本模块里唯一能拿到
 * 映像名的途径**，而映像名是"能不能安全清理"的全部依据。
 */
export function createProcessProbe({
  spawnImpl,
  platform = process.platform,
  killImpl = (pid, sig) => process.kill(pid, sig),
} = {}) {
  return Object.freeze({
    isAlive(pid) {
      if (!Number.isInteger(pid)) return false
      try { killImpl(pid, 0); return true } catch (e) { return e?.code !== 'ESRCH' }
    },

    async imageOf(pid) {
      if (!Number.isInteger(pid) || typeof spawnImpl !== 'function') return null
      const [cmd, args] = platform === 'win32'
        ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']]
        : ['ps', ['-p', String(pid), '-o', 'comm=']]
      return await new Promise((resolve) => {
        let out = ''
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        try {
          const child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
          child.stdout?.on?.('data', (d) => { out += String(d) })
          child.once('error', () => finish(null))
          child.once('exit', () => finish(parseImage(out, platform)))
        } catch { finish(null) }
      })
    },
  })
}

/**
 * 从 `tasklist` / `ps` 的输出里取映像名。
 *
 * 取不到就返回 `null`——**不要退回 pid 或空串**：一个看起来像映像名的
 * 东西如果其实是别的东西，会让分类判成 `recycled` 或 `verified`，
 * 而这两个结论都会导致"动手"。`null` 只会导致"不动手"。
 */
export function parseImage(text, platform = process.platform) {
  const s = String(text ?? '').trim()
  if (s === '') return null
  if (platform === 'win32') {
    // CSV：`"node.exe","1234","Console","1","100,000 K"`
    const m = s.match(/^"([^"]+)"/)
    if (m) return m[1]
    // 认不出的形状：**不要**把整行当映像名
    return null
  }
  const first = s.split('\n')[0].trim()
  return first === '' ? null : first
}
