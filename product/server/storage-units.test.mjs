// product/server/storage-units.test.mjs
// ============================================================================
// 存储体检的 systemd 单元：**配置本身**的判据。
//
// ## 为什么需要一族判据来盯两个配置文件
//
// 因为这两个文件里有两处**错的写法看起来完全正常**：
//
//   ① `ExecStart` 里的 `--state` 如果落在 `/var/lib/legion-hub/`（库与备份
//      所在的那块盘），平时一切正常 —— 只有**盘满的时候**才会暴露：
//      那一刻状态文件也写不进去，而整个单元存在的理由就是报告那件事。
//
//   ② `RuntimeDirectoryPreserve=no`（systemd 的默认值）会在**单元停止时删掉**
//      `/run/legion-hub`。本单元是 `Type=oneshot`，`ExecStart` 一结束就停 ——
//      于是刚写好的状态文件当场被删，Hub 永远报"没有在定时体检存储"。
//
//      ★ 我自己第一版就写的是 `no`，而且注释里还信心十足地说"默认就是不删"。
//        那句话是错的。配置里的一个词，与它看起来的意思，可以完全不同。
//
//      > 一个"每次跑完就把自己的结论删掉"的体检，
//      > 与一个"从来没跑过"的体检，在读数上是同一个东西。
//
// 这两处都**不会**被任何跑 Node 的判据抓到 —— 它们不是代码。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const SERVICE = readFileSync(new URL('./legion-hub-storage-check.service', import.meta.url), 'utf8')
const TIMER = readFileSync(new URL('./legion-hub-storage-check.timer', import.meta.url), 'utf8')
const BACKUP_SERVICE = readFileSync(new URL('./legion-hub-backup.service', import.meta.url), 'utf8')
const BACKUP_TIMER = readFileSync(new URL('./legion-hub-backup.timer', import.meta.url), 'utf8')

/** 把 unit 文件读成 `{ 节: { 键: [值…] } }`（同一个键可以出现多次）。 */
export function parseUnit(text) {
  const out = {}
  let section = ''
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) { section = sec[1]; out[section] = out[section] ?? {}; continue }
    const kv = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line)
    if (kv === null || section === '') continue
    const key = kv[1]
    out[section][key] = out[section][key] ?? []
    out[section][key].push(kv[2].trim())
  }
  return out
}

/** 取一个键的**最后一个**值（systemd 里后写的覆盖先写的）。 */
const one = (unit, section, key) => {
  const v = unit[section]?.[key]
  return Array.isArray(v) && v.length > 0 ? v[v.length - 1] : null
}

/** `ExecStart` 拼成一整行（unit 里用 `\` 续行）。
 *
 * ★ 每一段都要**去掉行尾的续行反斜杠** —— 第一版只去了后续行的，
 *   于是第一段的 `\` 留在结果里（`/bin/a \ --x 1`）。
 *   这条是那条"反例守卫"判据抓出来的。
 */
function execLine(text) {
  const parts = []
  let collecting = false
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    const trimmed = line.trim()
    if (!collecting) {
      if (!trimmed.startsWith('ExecStart=')) continue
      collecting = true
    }
    const continued = trimmed.endsWith('\\')
    parts.push((collecting && parts.length === 0
      ? trimmed.slice('ExecStart='.length)
      : trimmed).replace(/\\$/, '').trim())
    if (!continued) break
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

const svc = parseUnit(SERVICE)
const tmr = parseUnit(TIMER)

// ── ① ★★★ 状态落点：必须在 tmpfs 上 ────────────────────────────────────────

test('★★★ `ExecStart` 的 `--state` 必须落在 `/run`（tmpfs），**不是**库那块盘', () => {
  const line = execLine(SERVICE)
  const m = /--state\s+(\S+)/.exec(line)
  assert.ok(m !== null, `ExecStart 里必须有 --state（实际：${line}）`)
  const statePath = m[1]
  assert.match(statePath, /^\/run\//, `--state 必须在 /run 上，实际 ${statePath}`)
  assert.doesNotMatch(statePath, /^\/var\/lib/, '不许落在库/备份所在的那块盘上')
})

test('★★★ `ExecStart` 的 `--db` / `--backups` 指向真实位置（与备份单元一致）', () => {
  const line = execLine(SERVICE)
  // 从**备份单元**里抽出库路径，与本单元比对 —— 两处指向不同的库
  // 是那种"看起来都在跑、其实在测别的东西"的故障。
  const backupExec = execLine(BACKUP_SERVICE)
  const dbInBackup = /--db\s+(\S+)/.exec(backupExec)?.[1] ?? null
  const dbInCheck = /--db\s+(\S+)/.exec(line)?.[1] ?? null
  assert.ok(dbInBackup !== null, '备份单元里应当有 --db')
  assert.equal(dbInCheck, dbInBackup, '体检与备份必须看**同一个库**')
  const backupsInBackup = /--out\s+(\S+)/.exec(backupExec)?.[1] ?? null
  const backupsInCheck = /--backups\s+(\S+)/.exec(line)?.[1] ?? null
  assert.equal(backupsInCheck, backupsInBackup, '体检必须看备份**真正写入的那个目录**')
})

test('★★★ `--state` 指向的目录与 `RuntimeDirectory` 对得上', () => {
  // ★ 两处不一致的后果：脚本会去写一个 systemd **没有**创建（因此属主是 root、
  //   `legion-hub` 写不进去）的目录，于是状态永远写失败。
  //   而"状态写失败"在 Hub 那边的读数与"没人测"长得一样。
  const line = execLine(SERVICE)
  const statePath = /--state\s+(\S+)/.exec(line)[1]
  const runtimeDir = one(svc, 'Service', 'RuntimeDirectory')
  assert.ok(runtimeDir !== null, '必须有 RuntimeDirectory（否则脚本建不了 /run 下的目录）')
  const expectedPrefix = runtimeDir.startsWith('/') ? runtimeDir : `/run/${runtimeDir}`
  assert.ok(statePath.startsWith(`${expectedPrefix}/`),
    `--state(${statePath}) 应当落在 RuntimeDirectory(${expectedPrefix}) 里面`)
})

// ── ② ★★★ RuntimeDirectoryPreserve ────────────────────────────────────────

test('★★★ `RuntimeDirectoryPreserve` 必须是 `yes`（**不能**是 systemd 默认的 `no`）', () => {
  // ★ 这是我这套东西里**唯一一处靠一个词的取值才能work**的地方，而它的默认值
  //   恰好是错的那个：
  //
  //     `no` = 单元**停止时**删掉 RuntimeDirectory。
  //     本单元是 `Type=oneshot` → `ExecStart` 一结束就停 → 状态文件当场被删。
  //
  //   于是 Hub 永远报"没有在定时体检存储" —— 而所有单元看起来都很正常。
  const v = one(svc, 'Service', 'RuntimeDirectoryPreserve')
  assert.ok(v !== null, '必须**显式**写出这个键 —— 默认值是错的')
  assert.equal(v, 'yes', `必须是 yes（no/restart 都会在 oneshot 停止时删掉状态文件），实际 ${v}`)
})

test('★★★ `Type=oneshot`（它是"跑完就结束"，不是常驻）', () => {
  // 这条与上一条是**配套**的：正因为 oneshot 会立刻停止，
  // 才必须 `Preserve=yes`。分开看任何一条都不完整。
  assert.equal(one(svc, 'Service', 'Type'), 'oneshot')
})

// ── ③ ★★★ 退出码语义：非零必须算失败 ────────────────────────────────────

test('★★★ **不许**把非零退出码声明成成功', () => {
  // 脚本用 0/1/2/3 表达四档结论（见 `scripts/ops/storage-check.mjs`）。
  // 一个 `SuccessExitStatus=1 2 3` 会让 warn/critical 落在"成功"里 ——
  // 于是 `systemctl --failed` 里永远看不到它。
  //
  //   > 把"要人看"声明成"成功"，
  //   > 与没有告警，在 `systemctl --failed` 里是同一个东西。
  assert.equal(one(svc, 'Service', 'SuccessExitStatus'), null, '不许声明 SuccessExitStatus')
  assert.equal(one(svc, 'Service', 'IgnoreOnFailure'), null, '不许忽略失败')
  // 而"失败了要留下痕迹"这件事，备份单元的注释里已经写过同一条理由。
  assert.match(BACKUP_SERVICE, /systemctl --failed/, '备份单元里有这条理由的先例')
})

// ── ④ ★★★ 权限面：只读库、只写运行目录 ──────────────────────────────────

test('★★★ 库与备份目录必须是**只读**的（体检不该能改它们）', () => {
  const ro = svc.Service?.ReadOnlyPaths?.[0] ?? null
  assert.ok(ro !== null, '必须有 ReadOnlyPaths（体检只读库）')
  assert.match(ro, /\/var\/lib\/legion-hub/)
  // 而且它**不能**同时出现在 ReadWritePaths 里 —— 两个都写时 systemd 的行为
  // 取决于挂载顺序，那种"不确定"不该出现在权限配置里。
  const rw = (svc.Service?.ReadWritePaths ?? []).join(' ')
  assert.doesNotMatch(rw, /\/var\/lib\/legion-hub/, '库目录不许同时被声明为可写')
  assert.match(rw, /\/run\//, '只该写自己的运行目录')
})

test('★★ 与备份单元用**同一个**身份运行（权限面不该各来一套）', () => {
  // 两个单元读同一个库；身份不同意味着其中一个是多余的授权面。
  assert.equal(one(svc, 'Service', 'User'), one(parseUnit(BACKUP_SERVICE), 'Service', 'User'))
  assert.equal(one(svc, 'Service', 'Group'), one(parseUnit(BACKUP_SERVICE), 'Service', 'Group'))
  assert.equal(one(svc, 'Service', 'WorkingDirectory'), one(parseUnit(BACKUP_SERVICE), 'Service', 'WorkingDirectory'))
})

test('★★ 沙箱键与备份单元保持一致（ProtectSystem / ProtectHome / PrivateTmp / NoNewPrivileges）', () => {
  const b = parseUnit(BACKUP_SERVICE)
  for (const key of ['ProtectSystem', 'ProtectHome', 'PrivateTmp', 'NoNewPrivileges']) {
    assert.equal(one(svc, 'Service', key), one(b, 'Service', key), `${key} 与备份单元不一致`)
  }
})

// ── ⑤ ★★★ 定时器 ────────────────────────────────────────────────────────

test('★★★ 定时器必须 `Persistent=true`（机器关着时开机补跑）', () => {
  // 不补跑的话，"那天机器关着"会静默变成"那天没测" —— 而读数只会显示陈旧。
  assert.equal(one(tmr, 'Timer', 'Persistent'), 'true')
  assert.equal(one(parseUnit(BACKUP_TIMER), 'Timer', 'Persistent'), 'true', '与备份定时器保持一致')
})

test('★★★ 定时器间隔必须**短于**状态判陈旧的门槛', () => {
  // ★ 这是一个**跨文件**的约束：定时器在 `.timer` 里，门槛在
  //   `team-hub/storage-state.mjs` 的 `STALE_AFTER_MS`。
  //   两个文件谁都不知道对方 —— 于是"改成每天一次"会静默把读数变成
  //   一半时间在报 stale，另一半时间在报 ok。
  const stale = 6 * 60 * 60 * 1000
  const cal = one(tmr, 'Timer', 'OnCalendar')
  assert.ok(cal !== null)
  // `*-*-* *:11:00` = 每天每小时的第 11 分 → 每小时一次。
  // 判据看的是"分钟位是不是通配"，而不是去数有几个 token（第一版数错了）。
  const hourly = /^\S+\s+\*:\d{2}:\d{2}$/.test(cal) || /^hourly$/i.test(cal)
  assert.ok(hourly, `OnCalendar 应当是每小时一次（实际 ${cal}）`)
  // 基础间隔 1 小时，远小于 6 小时门槛。
  assert.ok(60 * 60 * 1000 < stale, '每小时一次必须短于陈旧门槛')
  // ★ 而且门槛必须允许**至少**漏几次（否则一次失败就报警，那就成了噪声）。
  const missedAllowed = stale / (60 * 60 * 1000)
  assert.ok(missedAllowed >= 3, `陈旧门槛只允许漏 ${missedAllowed} 次 —— 太少会被单次抖动触发`)
})

test('★★★ 定时器不许排在整点（整点是一天里最挤的一刻）', () => {
  // `legion-hub-backup.timer` 特意选了 03:17 并写清了理由。
  // 体检比备份轻得多，但同样不该去挤整点。
  const cal = one(tmr, 'Timer', 'OnCalendar')
  const minute = /:\s*(\d{2}):\d{2}$/.exec(cal)?.[1] ?? /:(\d{2})\b/.exec(cal)?.[1]
  assert.ok(minute !== undefined, `从 ${cal} 里取不出分钟`)
  assert.notEqual(minute, '00', '不许排在整点第 0 分')
})

test('★★★ 定时器与**服务**成对存在（systemd 靠**同名**配对）', () => {
  // ★ `.timer` 与 `.service` 靠**文件名**配对。名字打错时
  //   `systemctl enable --now <名字>.timer` 会去找一个不存在的 service，
  //   而**定时器本身仍然会启动** —— 于是它每次都拉起失败。
  //   那正是"配了定时器但从来没成功过"的一种形态。
  //
  //   ⚠️ 判据必须查**文件名配对**，不是查描述文字里有没有那个名字 ——
  //      第一版我查的是 `Description` 里含 "storage-check"，
  //      于是它在正确实现上红了（描述写的是中文）。
  const dir = new URL('./', import.meta.url)
  const timerName = 'legion-hub-storage-check.timer'
  const serviceName = `${timerName.replace(/\.timer$/, '')}.service`
  const files = readdirSync(dir)
  assert.ok(files.includes(timerName), `目录里应当有 ${timerName}`)
  assert.ok(files.includes(serviceName), `${timerName} 必须有一个同名的 ${serviceName} 配对`)
  // 而**备份**那一对也应当满足同一条（证明这条判据不是只为我这套东西写的特例）。
  assert.ok(files.includes('legion-hub-backup.timer') && files.includes('legion-hub-backup.service'),
    '既有的备份那一对也应当是配对的')
  // 有 `[Install] WantedBy=timers.target` 才能被 enable。
  assert.equal(one(tmr, 'Install', 'WantedBy'), 'timers.target')
})

// ── ⑥ 判据自身的守卫 ────────────────────────────────────────────────────

test('★★★ 反例守卫：`parseUnit` / `execLine` 真的读得出东西（不是恒真）', () => {
  // 一个解析器写坏了会让**所有**上面的判据变成"没读到 → 断言 null === null 通过"。
  const u = parseUnit('[Service]\nType=oneshot\nType=simple\n# ExecStart=/bin/false\n')
  assert.deepEqual(u.Service.Type, ['oneshot', 'simple'], '同一个键的多次出现都要保留')
  assert.equal(one(u, 'Service', 'Type'), 'simple', '取最后一个（systemd 的覆盖语义）')
  assert.equal(one(u, 'Service', 'Missing'), null)
  assert.equal(execLine('[Service]\nExecStart=/bin/a \\\n  --x 1 \\\n  --y 2\n'), '/bin/a --x 1 --y 2')
  // 注释掉的 ExecStart **不许**被当成真的。
  assert.equal(execLine('# ExecStart=/bin/false\n[Service]\nType=oneshot\n'), '')
  // 真文件上必须读得出关键值（否则上面全是在空对象上断言）。
  assert.equal(one(svc, 'Service', 'User'), 'legion-hub')
  assert.match(execLine(SERVICE), /storage-check\.mjs/)
  assert.ok(one(tmr, 'Timer', 'OnCalendar') !== null)
})
