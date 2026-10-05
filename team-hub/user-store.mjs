// team-hub/user-store.mjs
// ============================================================================
// 用户身份、会话与空间授权（远程 Agent 通道 S-B 之一）
//
// 设计依据：设计文档 §10「区分用户会话、桌面会话、Node 设备令牌和服务间密钥。
// 凭据可单独撤销、轮换」；§8.3「登录采用短期访问令牌和可撤销刷新凭据」。
//
// ## 为什么不能沿用 `TEAM_HUB_TOKEN`
//
// 现有 `team-hub/server.mjs` 的 `authorized(req)` 是**单令牌**：一个字符串对了
// 就放行，覆盖读写全部门。它有三个在单机场景下无所谓、在多用户场景下致命的性质：
//
//   ① 无法识别**是谁**——审计里只能记 `by`，而 `by` 是请求体里自报的；
//   ② 无法**按动作**授权——"能聊天"与"能执行危险工具"是同一个门；
//   ③ 无法**单独撤销**——撤销一个用户的代价是让所有人换令牌。
//
// 所以本模块不是"给 token 加个表"，而是换掉那个门的语义：**会话行是权威**，
// 令牌只是指向它的一段签名引用。撤销一条会话立即生效，因为校验每次都读那一行。
//
// ## 三个刻意的实现选择
//
// 1. **口令用 scrypt 加盐**，参数随哈希一起存（`scrypt$N$r$p$salt$hash`）。
//    存参数是为了以后调高成本时老口令仍能验证并在登录时升级，而不是"改参数
//    等于所有人重置口令"。
// 2. **刷新凭据只存哈希**，且**每次使用都轮换**；一个已轮换过的旧凭据再次出现，
//    按"凭据可能已泄露"处置：撤销整条会话。这是唯一能把"用户重装客户端导致的
//    重复使用"和"有人拿着偷来的凭据在用"区分开的信号——虽然它会把前者误判一次，
//    而误判的代价只是重新登录。
// 3. **用户不存在与口令错误返回同一个码与同一种耗时**：对不存在的用户也跑一次
//    scrypt。否则"响应快"就等于"这个用户名不存在"，而用户名枚举是口令爆破的第一步。
// ============================================================================
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

/** 空间角色。数值越大权限越高；`viewer` 是能看不能改。 */
export const SPACE_ROLES = Object.freeze(['viewer', 'member', 'admin', 'owner'])
export const ROLE_RANK = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 })

/**
 * 系统级角色。**与空间角色是两回事**，这一点必须分开：
 *
 * 引导出来的第一个用户在任何空间都还没有角色行（新空间还没开通），如果他只能靠
 * 空间角色获得权限，就会出现"没人能邀请任何人"的死结——而这不是配置问题，
 * 是模型少了一维。系统级的职责（造邀请、停用账号、列用户）不属于任何单个空间，
 * 所以它需要一个**不依赖空间**的角色位。
 *
 * `admin` 是唯一的系统角色：它**不**自动等于"能看每个空间的任务"。看任务仍然
 * 要求那个空间里的角色行——把两者合并会让"给某人系统管理权"顺带把全部数据
 * 都交出去。
 */
export const SYSTEM_ROLES = Object.freeze(['none', 'admin'])

/** 访问令牌默认寿命：15 分钟（设计文档 §8.3「短期访问令牌」）。 */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
/** 刷新凭据默认寿命：30 天。 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 邀请码默认寿命：24 小时。 */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000

/** 口令哈希参数。`N` 是 CPU/内存成本，随哈希存储。 */
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 })

/** 登录失败锁定：窗口内连续失败达到阈值即锁定。 */
export const LOGIN_MAX_FAILURES = 10
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000

export const IDENTITY_CODES = Object.freeze({
  NOT_BOOTSTRAPPED: 'IDENTITY_NOT_BOOTSTRAPPED',
  ALREADY_BOOTSTRAPPED: 'IDENTITY_ALREADY_BOOTSTRAPPED',
  BOOTSTRAP_DENIED: 'IDENTITY_BOOTSTRAP_DENIED',
  INVALID_INPUT: 'IDENTITY_INVALID_INPUT',
  NAME_TAKEN: 'IDENTITY_NAME_TAKEN',
  INVALID_CREDENTIALS: 'IDENTITY_INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'IDENTITY_ACCOUNT_LOCKED',
  SESSION_NOT_FOUND: 'IDENTITY_SESSION_NOT_FOUND',
  SESSION_REVOKED: 'IDENTITY_SESSION_REVOKED',
  SESSION_EXPIRED: 'IDENTITY_SESSION_EXPIRED',
  TOKEN_MALFORMED: 'IDENTITY_TOKEN_MALFORMED',
  TOKEN_BAD_SIGNATURE: 'IDENTITY_TOKEN_BAD_SIGNATURE',
  TOKEN_EXPIRED: 'IDENTITY_TOKEN_EXPIRED',
  REFRESH_REUSE_DETECTED: 'IDENTITY_REFRESH_REUSE_DETECTED',
  INVITE_NOT_FOUND: 'IDENTITY_INVITE_NOT_FOUND',
  INVITE_CONSUMED: 'IDENTITY_INVITE_CONSUMED',
  INVITE_EXPIRED: 'IDENTITY_INVITE_EXPIRED',
  USER_NOT_FOUND: 'IDENTITY_USER_NOT_FOUND',
  FORBIDDEN: 'IDENTITY_FORBIDDEN',
  KEY_REQUIRED: 'IDENTITY_KEY_REQUIRED',
  REGISTRATION_CLOSED: 'IDENTITY_REGISTRATION_CLOSED',
  INVITE_REQUIRED: 'IDENTITY_INVITE_REQUIRED',
  WRONG_PASSWORD: 'IDENTITY_WRONG_PASSWORD',
  SPACE_NOT_FOUND: 'IDENTITY_SPACE_NOT_FOUND',
  SPACE_REQUIRED: 'IDENTITY_SPACE_REQUIRED',
  REGISTRATION_RATE_LIMITED: 'IDENTITY_REGISTRATION_RATE_LIMITED',
  RESET_NOT_FOUND: 'IDENTITY_RESET_NOT_FOUND',
  RESET_CONSUMED: 'IDENTITY_RESET_CONSUMED',
  RESET_EXPIRED: 'IDENTITY_RESET_EXPIRED',
})

/** 口令重置码的有效期。短是**故意的**：它是一条带外传递的凭据。 */
export const RESET_TTL_MS = 30 * 60 * 1000

/** 自助注册的滑动窗口与上限。见 `registrationAllowed` 里"为什么是全局"那段。 */
export const REGISTRATION_WINDOW_MS = 60 * 60 * 1000
export const REGISTRATION_MAX_PER_WINDOW = 20

/**
 * 注册策略。**默认 `closed`**。
 *
 * 默认值不是随手定的：一个默认开放的注册端点，与一个"忘了设策略"的部署，
 * 在出事那天是同一个东西——只是没人会去查一个一直好好的开关。
 * 要开放注册必须**明确写出来**。
 *
 *   · `closed` —— 只能由管理员造邀请（当前的唯一路径）；
 *   · `invite` —— 自助注册，但必须有邀请码（注册页会多一个输入框）；
 *   · `open`   —— 任何人可注册（自建/内网演示用；公网请三思）。
 */
export const REGISTRATION_MODES = Object.freeze(['closed', 'invite', 'open'])

/** 自助注册时给新用户的空间角色。与邀请的默认一致。 */
const DEFAULT_REGISTER_ROLE = 'member'

export class IdentityError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
    this.status = status
  }
}

const fail = (code, message, status) => { throw new IdentityError(code, message, status) }

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const id = (prefix) => `${prefix}-${randomBytes(12).toString('hex')}`

/** 口令强度：只做长度下限。**不**做"必须含大小写数字符号"那套——它促进的是
 *  把密码写在便签上，而不是更长更随机的口令。 */
const MIN_PASSWORD_CHARS = 8

function validateName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) fail(IDENTITY_CODES.INVALID_INPUT, '用户名必填')
  const trimmed = name.trim()
  if (trimmed.length > 64) fail(IDENTITY_CODES.INVALID_INPUT, '用户名不超过 64 字符')
  return trimmed
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_CHARS) {
    fail(IDENTITY_CODES.INVALID_INPUT, `口令至少 ${MIN_PASSWORD_CHARS} 个字符`)
  }
  if (password.length > 512) fail(IDENTITY_CODES.INVALID_INPUT, '口令不超过 512 字符')
  return password
}

function validateRole(role) {
  if (!SPACE_ROLES.includes(role)) fail(IDENTITY_CODES.INVALID_INPUT, `角色必须是 ${SPACE_ROLES.join(' / ')} 之一`)
  return role
}

/** 空间 ID 规则与 `server.mjs` 的 `validRuleScope` 对齐（小写字母/数字开头）。 */
function validateSpace(space) {
  if (typeof space !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(space)) {
    fail(IDENTITY_CODES.INVALID_INPUT, 'space 非法：需以小写字母或数字开头，仅含小写字母/数字/下划线/短横')
  }
  return space
}

// ── 口令哈希 ────────────────────────────────────────────────────────────────

/**
 * 造口令哈希。格式 `scrypt$N$r$p$<saltHex>$<hashHex>`。
 *
 * 参数写进字符串而不是从常量读：常量改了以后，老口令仍能按**它自己被创建时**的
 * 参数验证。否则调高成本就等于全员口令失效。
 */
export async function hashPassword(password, params = SCRYPT_PARAMS) {
  const salt = randomBytes(16)
  const derived = await scrypt(Buffer.from(password, 'utf8'), salt, params.keylen, { N: params.N, r: params.r, p: params.p })
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`
}

/** 校验口令。返回 `{ ok, needsRehash, params }`。任何解析失败都返回 `ok:false`。 */
export async function verifyPassword(password, stored, current = SCRYPT_PARAMS) {
  const parts = String(stored ?? '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, needsRehash: false }
  const [, n, r, p, saltHex, hashHex] = parts
  const N = Number(n); const rr = Number(r); const pp = Number(p)
  if (!Number.isInteger(N) || !Number.isInteger(rr) || !Number.isInteger(pp)) return { ok: false, needsRehash: false }
  let salt; let expected
  try { salt = Buffer.from(saltHex, 'hex'); expected = Buffer.from(hashHex, 'hex') } catch { return { ok: false, needsRehash: false } }
  if (salt.length === 0 || expected.length === 0) return { ok: false, needsRehash: false }
  let derived
  try {
    derived = Buffer.from(await scrypt(Buffer.from(password, 'utf8'), salt, expected.length, { N, r: rr, p: pp }))
  } catch { return { ok: false, needsRehash: false } }
  const ok = derived.length === expected.length && timingSafeEqual(derived, expected)
  return { ok, needsRehash: N !== current.N || rr !== current.r || pp !== current.p }
}

/** 造一个假哈希用于"用户不存在"的等时路径。结果固定丢弃。 */
const DUMMY_HASH = `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${'00'.repeat(16)}$${'00'.repeat(SCRYPT_PARAMS.keylen)}`

// ── 仓储 ────────────────────────────────────────────────────────────────────

/**
 * 用户/会话/邀请/空间授权仓储。
 *
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {(fn: Function) => any} deps.withTx 与任务/审计同一个事务包装（同一连接）
 * @param {() => number} [deps.clock]
 * @param {string} deps.key 访问令牌的 HMAC 密钥。**必填**：缺它就没有签名，
 *   而"没有签名的令牌"与"任何人都能伪造的令牌"是同一个东西。
 * @param {Function} [deps.audit] `(actor, scope, action, taskId, detail)`，可缺省
 */
export function createUserStore({ db, withTx, clock = Date.now, key = '', audit = null, registrationMax = REGISTRATION_MAX_PER_WINDOW } = {}) {
  if (db === undefined || db === null) throw new TypeError('createUserStore 需要 db')
  if (typeof withTx !== 'function') throw new TypeError('createUserStore 需要 withTx')
  if (typeof key !== 'string' || key.length < 16) {
    // 允许空 key 会让 createUserStore 在配置漏项时"看起来能用"。宁可在这里拒绝。
    throw new IdentityError(IDENTITY_CODES.KEY_REQUIRED, 'createUserStore 需要至少 16 字符的 HMAC key（令牌签名密钥）')
  }
  const iso = (ms) => new Date(ms).toISOString()
  const now = () => clock()
  const sign = (value) => createHmac('sha256', key).update(value).digest('base64url')

  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, name_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL, disabled_at_ms INTEGER,
      system_role TEXT NOT NULL DEFAULT 'none');
    CREATE TABLE IF NOT EXISTS hub_user_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      refresh_hash TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL,
      access_expires_at_ms INTEGER NOT NULL, refresh_expires_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER, last_seen_at_ms INTEGER);
    CREATE TABLE IF NOT EXISTS hub_invites (
      id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, space TEXT NOT NULL, role TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER, consumed_by TEXT);
    CREATE TABLE IF NOT EXISTS hub_space_roles (
      user_id TEXT NOT NULL, space TEXT NOT NULL, role TEXT NOT NULL, granted_by TEXT NOT NULL,
      granted_at_ms INTEGER NOT NULL, PRIMARY KEY(user_id, space));
    CREATE TABLE IF NOT EXISTS hub_login_failures (
      name_key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_started_ms INTEGER NOT NULL, locked_until_ms INTEGER);
    CREATE INDEX IF NOT EXISTS idx_hub_sessions_user ON hub_user_sessions(user_id);
    -- 注册事件的**只追加**流水，用来算滑动窗口内的注册量。见 registrationAllowed。
    --
    -- 为什么不复用 hub_login_failures：那一张记的是"某个用户名连续失败了几次"
    -- （按 name_key 归并、失败才写、成功就清）。而注册要限的是**整体速率**——
    -- 攻击面恰恰是"每次换一个新用户名"，按名字归并的计数对它恒为 1。
    --
    --   > 一个"按用户名限速"的注册闸门，
    --   > 与一个"完全不限速"的注册闸门，在批量注册面前是同一个东西——
    --   > 因为批量注册从来不重复用同一个名字。
    CREATE TABLE IF NOT EXISTS hub_registrations (
      id TEXT PRIMARY KEY, user_id TEXT, space TEXT NOT NULL, at_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_hub_registrations_at ON hub_registrations(at_ms);
    -- 一次性口令重置码。**只存哈希**，明文只在签发那一次返回（与邀请码同一口径）。
    CREATE TABLE IF NOT EXISTS hub_password_resets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER);
  `)

  const record = (action, scope, detail, actor) => {
    if (typeof audit !== 'function') return
    try { audit(actor ?? 'system:identity', scope ?? 'global', action, null, detail ?? null) } catch { /* 审计失败不阻断认证 */ }
  }

  // ── 用户 ──────────────────────────────────────────────────────────────────

  const userCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM hub_users').get().n)
  const nameKey = (name) => name.toLowerCase()

  function userRow(userId) {
    const row = db.prepare('SELECT * FROM hub_users WHERE id=?').get(userId)
    if (!row) fail(IDENTITY_CODES.USER_NOT_FOUND, '用户不存在', 404)
    return row
  }

  function publicUser(row) {
    return {
      userId: row.id, name: row.name, createdAt: iso(row.created_at_ms),
      disabled: row.disabled_at_ms !== null, systemRole: row.system_role,
    }
  }

  /** 库里有几个用户。空库 = 还没引导，此时允许用引导凭据建第一个 owner。 */
  function isBootstrapped() { return userCount() > 0 }

  /**
   * 建第一个 owner。
   *
   * 只在**库为空**时成功：这条判断由 `INSERT` 前的 `userCount()` 与唯一约束共同保证。
   * 并发调用时两个请求都会看到 0，但 `name_key` 唯一约束只让一个插入成功；
   * 两个不同名字的并发引导则由外层
   * `withTx`（BEGIN IMMEDIATE）串行化，第二个会看到非 0 而失败。
   */
  async function bootstrapOwner({ name, password, authorized = false }) {
    const clean = validateName(name)
    validatePassword(password)
    if (isBootstrapped()) fail(IDENTITY_CODES.ALREADY_BOOTSTRAPPED, '已经完成初始化，不能再引导', 409)
    if (authorized !== true) fail(IDENTITY_CODES.BOOTSTRAP_DENIED, '引导需要 Hub 管理令牌', 403)
    const hash = await hashPassword(password)
    return withTx(() => {
      if (Number(db.prepare('SELECT COUNT(*) AS n FROM hub_users').get().n) > 0) {
        fail(IDENTITY_CODES.ALREADY_BOOTSTRAPPED, '已经完成初始化，不能再引导', 409)
      }
      const userId = id('user')
      const at = now()
      // 第一个用户是**系统管理员**：没有他就没人能造邀请或开通空间。
      db.prepare('INSERT INTO hub_users VALUES(?,?,?,?,?,NULL,?)').run(userId, clean, nameKey(clean), hash, at, 'admin')
      record('identity:bootstrap-owner', 'global', { userId }, userId)
      return { userId, name: clean, systemRole: 'admin' }
    })
  }

  // ── 邀请 ──────────────────────────────────────────────────────────────────

  /** 造邀请码。**明文只在这里返回一次**，库里存哈希。 */
  function createInvite({ by, space, role = 'member', ttlMs = INVITE_TTL_MS, random = randomBytes }) {
    const cleanSpace = validateSpace(space)
    validateRole(role)
    if (role === 'owner') fail(IDENTITY_CODES.FORBIDDEN, '邀请不能直接授予 owner', 403)
    const inviter = requireInviterFor(by, cleanSpace)
    const code = Buffer.from(random(24)).toString('base64url')
    const at = now()
    return withTx(() => {
      const inviteId = id('invite')
      db.prepare('INSERT INTO hub_invites VALUES(?,?,?,?,?,?,?,NULL,NULL)')
        .run(inviteId, hashSecret(code), cleanSpace, role, inviter.id, at, at + ttlMs)
      record('identity:invite-create', cleanSpace, { inviteId: inviteId, role }, inviter.id)
      return { inviteId, code, space: cleanSpace, role, expiresAtMs: at + ttlMs }
    })
  }

  /**
   * 接受邀请：建用户并授予空间角色。
   *
   * 消费与建用户**同一个事务**：分开写的话，进程在两者之间停下会得到一个
   * "邀请已被消费但用户不存在"的局面——而邀请码是一次性的，用户就再也进不来了。
   */
  async function acceptInvite({ code, name, password }) {
    const clean = validateName(name)
    validatePassword(password)
    if (typeof code !== 'string' || code.length === 0) fail(IDENTITY_CODES.INVALID_INPUT, '邀请码必填')
    const codeHash = hashSecret(code)
    const invite = db.prepare('SELECT * FROM hub_invites WHERE code_hash=?').get(codeHash)
    if (!invite) fail(IDENTITY_CODES.INVITE_NOT_FOUND, '邀请码无效', 404)
    if (invite.consumed_at_ms !== null) fail(IDENTITY_CODES.INVITE_CONSUMED, '邀请码已被使用', 409)
    if (invite.expires_at_ms <= now()) fail(IDENTITY_CODES.INVITE_EXPIRED, '邀请码已过期', 410)
    if (db.prepare('SELECT id FROM hub_users WHERE name_key=?').get(nameKey(clean))) {
      fail(IDENTITY_CODES.NAME_TAKEN, '该用户名已被占用', 409)
    }
    const hash = await hashPassword(password)
    const at = now()
    return withTx(() => {
      // 事务内重新判定：两个并发请求可能都通过了上面那次检查。
      const fresh = db.prepare('SELECT * FROM hub_invites WHERE code_hash=?').get(codeHash)
      if (!fresh || fresh.consumed_at_ms !== null) fail(IDENTITY_CODES.INVITE_CONSUMED, '邀请码已被使用', 409)
      const userId = id('user')
      try {
        db.prepare('INSERT INTO hub_users VALUES(?,?,?,?,?,NULL,?)').run(userId, clean, nameKey(clean), hash, at, 'none')
      } catch (e) {
        if (String(e?.message ?? '').includes('UNIQUE')) fail(IDENTITY_CODES.NAME_TAKEN, '该用户名已被占用', 409)
        throw e
      }
      const consumed = db.prepare('UPDATE hub_invites SET consumed_at_ms=?, consumed_by=? WHERE id=? AND consumed_at_ms IS NULL')
        .run(at, userId, fresh.id)
      // 消费不是"赢者通吃"的竞态：changes=0 说明另一个事务先消费了它。
      if (Number(consumed.changes) !== 1) fail(IDENTITY_CODES.INVITE_CONSUMED, '邀请码已被使用', 409)
      db.prepare('INSERT INTO hub_space_roles VALUES(?,?,?,?,?)').run(userId, fresh.space, fresh.role, fresh.created_by, at)
      record('identity:invite-accept', fresh.space, { userId, role: fresh.role }, userId)
      return { userId, name: clean, space: fresh.space, role: fresh.role }
    })
  }

  // ── 口令重置（忘记口令 / 账号恢复）──────────────────────────────────────
  //
  // ## 为什么必须有它
  //
  // 在此之前，全仓**只有**自助改口令（要记得原口令）与 `rebootstrap.sh`
  // （清整库）。也就是说：忘了口令 = 账号报废 + 整库重来。
  //
  //   > 一个"忘了口令就只能把库推倒重来"的账号体系，
  //   > 与一个"还没有账号体系"的系统，在用户丢掉口令那天是同一个东西——
  //   > 只不过前者会连别人的数据一起推倒。
  //
  // 自托管的 Hub 没有邮件通道，所以恢复走**带外**：管理员生成一次性码，
  // 亲口/当面/别的渠道给用户。这与邀请码是同一套形状（一次性、短时、只存哈希），
  // 不引第二条传递通道。

  /** 生成一枚重置码。**明文只在这里返回一次**。只有系统管理员能签发。 */
  function createPasswordReset({ by, userId, ttlMs = RESET_TTL_MS, random = randomBytes }) {
    const admin = requireSystemAdmin(by)
    // ★ 用 `userRow` 而不是 `requireUser`：**允许给已停用的账号签发**。
    //
    //   `requireUser` 会以「账号已停用」拒掉，于是"停用"变成一条单向路——
    //   管理员想让人回来时，连重置码都开不出来。
    //   签发是管理员的显式动作，而它本身**不改变停用状态**（见下）。
    const target = userRow(userId)
    if (target === null) fail(IDENTITY_CODES.USER_NOT_FOUND, '用户不存在', 404)
    const code = Buffer.from(random(24)).toString('base64url')
    const at = now()
    return withTx(() => {
      const resetId = id('reset')
      db.prepare('INSERT INTO hub_password_resets VALUES(?,?,?,?,?,?,NULL)')
        .run(resetId, target.id, hashSecret(code), admin.id, at, at + ttlMs)
      record('identity:password-reset-issue', 'global', { resetId, userId: target.id }, admin.id)
      return { code, userId: target.id, userName: target.name, expiresAtMs: at + ttlMs }
    })
  }

  /**
   * 用重置码改口令。**消费这条码、改哈希、撤销该用户全部会话**，同一个事务。
   *
   * 为什么撤销**全部**会话（与自助改口令"保留当前"相反）：这条路上的前提是
   * "原凭据可能已经不可信"——用户进不来，我们无从判断此刻哪些会话是他本人的。
   * 宁可让他重新登一次，也不要留下一个可能是别人的会话。
   *
   * 返回会话（而不是"改好了请去登录"）：与注册同一条理由——他刚设完口令，
   * 再让他打一遍是最容易放弃的一步，而在手机上尤其如此。
   */
  async function redeemPasswordReset({ name, code, newPassword, label = '' }) {
    const clean = validateName(name)
    validatePassword(newPassword)
    if (typeof code !== 'string' || code.trim().length === 0) {
      fail(IDENTITY_CODES.INVALID_INPUT, '重置码必填')
    }
    const row = db.prepare('SELECT * FROM hub_password_resets WHERE code_hash=?').get(hashSecret(code.trim()))
    // 「码不对」与「码不是你的」分开报会泄露"这个码存在"。
    if (!row) fail(IDENTITY_CODES.RESET_NOT_FOUND, '重置码无效', 404)
    if (row.consumed_at_ms !== null) fail(IDENTITY_CODES.RESET_CONSUMED, '重置码已被使用', 409)
    if (row.expires_at_ms <= now()) fail(IDENTITY_CODES.RESET_EXPIRED, '重置码已过期，请让管理员重新生成', 410)
    const user = userRow(row.user_id)
    // 用户名对不上就当作"码无效"：**不**说"这个码属于别人"。
    if (user === null || nameKey(clean) !== user.name_key) fail(IDENTITY_CODES.RESET_NOT_FOUND, '重置码无效', 404)

    const hash = await hashPassword(newPassword)
    const at = now()
    const done = withTx(() => {
      // 事务内重新判定：两个并发请求可能都通过了上面那次检查。
      const fresh = db.prepare('SELECT * FROM hub_password_resets WHERE id=?').get(row.id)
      if (!fresh || fresh.consumed_at_ms !== null) fail(IDENTITY_CODES.RESET_CONSUMED, '重置码已被使用', 409)
      // ★ **不**顺手 `disabled_at_ms=NULL`。
      //
      //   顺手解停会让"停用"被一条别的路径悄悄撤销——而管理员停用一个人
      //   （多半是因为某种封禁）之后，一个重置动作就把他放回来了，
      //   这不是他按下"生成重置码"时想做的事。
      //
      //   > 一个"改口令顺带解停用"的动作，与一个"改口令"的动作，
      //   > 在管理员按下按钮那一刻看起来一模一样。
      db.prepare('UPDATE hub_users SET password_hash=? WHERE id=?').run(hash, user.id)
      db.prepare('UPDATE hub_user_sessions SET revoked_at_ms=? WHERE user_id=? AND revoked_at_ms IS NULL').run(at, user.id)
      const used = db.prepare('UPDATE hub_password_resets SET consumed_at_ms=? WHERE id=? AND consumed_at_ms IS NULL').run(at, row.id)
      if (Number(used.changes) !== 1) fail(IDENTITY_CODES.RESET_CONSUMED, '重置码已被使用', 409)
      clearFailures(user.name_key)
      record('identity:password-reset-redeem', 'global', { resetId: row.id }, user.id)
      return { userId: user.id, name: user.name }
    })
    const session = issueSession(done.userId, { label })
    return { ...session, ...done }
  }

  function listPasswordResets({ by, userId = null }) {
    requireSystemAdmin(by)
    const rows = userId === null
      ? db.prepare('SELECT id,user_id,created_by,created_at_ms,expires_at_ms,consumed_at_ms FROM hub_password_resets ORDER BY created_at_ms DESC LIMIT 50').all()
      : db.prepare('SELECT id,user_id,created_by,created_at_ms,expires_at_ms,consumed_at_ms FROM hub_password_resets WHERE user_id=? ORDER BY created_at_ms DESC LIMIT 50').all(userId)
    // **不返回** code_hash：那是一枚凭据的哈希，界面不需要它。
    return rows.map((r) => ({
      resetId: r.id, userId: r.user_id, createdAt: iso(r.created_at_ms),
      expiresAt: iso(r.expires_at_ms), consumed: r.consumed_at_ms !== null,
    }))
  }

  /** 邀请码与刷新凭据都只存哈希：库被读走不等于能直接用。 */
  function hashSecret(secret) {
    return createHash('sha256').update(String(secret)).digest('hex')
  }

  // ── 登录失败锁定 ──────────────────────────────────────────────────────────

  function lockState(nameKeyValue) {
    const row = db.prepare('SELECT * FROM hub_login_failures WHERE name_key=?').get(nameKeyValue)
    if (!row) return { locked: false }
    if (row.locked_until_ms !== null && row.locked_until_ms > now()) return { locked: true, untilMs: row.locked_until_ms }
    return { locked: false }
  }

  function noteFailure(nameKeyValue) {
    const at = now()
    withTx(() => {
      const row = db.prepare('SELECT * FROM hub_login_failures WHERE name_key=?').get(nameKeyValue)
      if (!row || at - row.window_started_ms > LOGIN_LOCKOUT_MS) {
        db.prepare('INSERT INTO hub_login_failures VALUES(?,?,?,NULL) ON CONFLICT(name_key) DO UPDATE SET failures=1, window_started_ms=?, locked_until_ms=NULL')
          .run(nameKeyValue, 1, at, at)
        return
      }
      const failures = row.failures + 1
      const lockedUntil = failures >= LOGIN_MAX_FAILURES ? at + LOGIN_LOCKOUT_MS : null
      db.prepare('UPDATE hub_login_failures SET failures=?, locked_until_ms=? WHERE name_key=?').run(failures, lockedUntil, nameKeyValue)
    })
  }

  function clearFailures(nameKeyValue) {
    db.prepare('DELETE FROM hub_login_failures WHERE name_key=?').run(nameKeyValue)
  }

  // ── 会话与令牌 ────────────────────────────────────────────────────────────

  /**
   * 访问令牌：`v1.<b64url(payload)>.<sig>`。
   *
   * 自带 `exp` 只是**快速失败**用的：真正的权威是会话行。所以校验时既查签名
   * 也查会话行——少了后者，"撤销"要等令牌自然过期才生效，而设计文档要求
   * 「撤销后该设备不能继续调用 Hub」。
   */
  function mintAccessToken(session) {
    const payload = { sub: session.user_id, sid: session.id, exp: session.access_expires_at_ms, iat: now() }
    const body = b64url(JSON.stringify(payload))
    return `v1.${body}.${sign(body)}`
  }

  function issueSession(userId, { label = '', accessTtlMs = ACCESS_TOKEN_TTL_MS, refreshTtlMs = REFRESH_TOKEN_TTL_MS, random = randomBytes } = {}) {
    const at = now()
    const sessionId = id('sess')
    const refreshToken = Buffer.from(random(32)).toString('base64url')
    const row = {
      id: sessionId, user_id: userId, label: String(label).slice(0, 128),
      refresh_hash: hashSecret(refreshToken), created_at_ms: at,
      access_expires_at_ms: at + accessTtlMs, refresh_expires_at_ms: at + refreshTtlMs,
      revoked_at_ms: null, last_seen_at_ms: at,
    }
    db.prepare('INSERT INTO hub_user_sessions VALUES(?,?,?,?,?,?,?,NULL,?)')
      .run(row.id, row.user_id, row.label, row.refresh_hash, row.created_at_ms, row.access_expires_at_ms, row.refresh_expires_at_ms, row.last_seen_at_ms)
    return { sessionId, refreshToken, accessToken: mintAccessToken(row), accessExpiresAtMs: row.access_expires_at_ms, refreshExpiresAtMs: row.refresh_expires_at_ms }
  }

  async function login({ name, password, label = '' } = {}) {
    const clean = validateName(name)
    const nk = nameKey(clean)
    const lock = lockState(nk)
    if (lock.locked) {
      fail(IDENTITY_CODES.ACCOUNT_LOCKED, `失败次数过多，请于 ${iso(lock.untilMs)} 后重试`, 429)
    }
    const row = db.prepare('SELECT * FROM hub_users WHERE name_key=?').get(nk)
    // ★ 用户不存在时也跑一次 scrypt：否则"响应很快"等于"这个用户名不存在"。
    const verified = await verifyPassword(password ?? '', row?.password_hash ?? DUMMY_HASH)
    if (!row || verified.ok !== true || row.disabled_at_ms !== null) {
      noteFailure(nk)
      fail(IDENTITY_CODES.INVALID_CREDENTIALS, '用户名或口令不正确', 401)
    }
    clearFailures(nk)
    return withTx(() => {
      const session = issueSession(row.id, { label })
      record('identity:login', 'global', { userId: row.id, sessionId: session.sessionId }, row.id)
      // `needsPasswordUpgrade` 只是**读数**：这里不趁机改写哈希，因为重新哈希是
      // 异步的，而本事务是同步的。要升级就由调用方显式调 `upgradePassword`。
      return { ...session, userId: row.id, name: row.name, needsPasswordUpgrade: verified.needsRehash }
    })
  }

  /** 显式升级口令哈希（登录发现 needsRehash 后调用）。 */
  async function upgradePassword({ userId, password }) {
    const row = userRow(userId)
    const verified = await verifyPassword(password, row.password_hash)
    if (!verified.ok) fail(IDENTITY_CODES.INVALID_CREDENTIALS, '用户名或口令不正确', 401)
    if (!verified.needsRehash) return { upgraded: false }
    const hash = await hashPassword(password)
    withTx(() => { db.prepare('UPDATE hub_users SET password_hash=? WHERE id=?').run(hash, userId) })
    return { upgraded: true }
  }

  /**
   * 刷新：**轮换**刷新凭据。
   *
   * 拿到一个已轮换过的旧凭据时，按泄露处置（撤销整条会话）。误判一次
   * （用户重装客户端重放了旧凭据）的代价是重新登录；漏判的代价是攻击者
   * 与用户**同时**持有有效凭据而不被察觉。
   */
  function refresh({ refreshToken } = {}) {
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) fail(IDENTITY_CODES.INVALID_INPUT, 'refreshToken 必填')
    const tokenHash = hashSecret(refreshToken)
    return withTx(() => {
      const session = db.prepare('SELECT * FROM hub_user_sessions WHERE refresh_hash=?').get(tokenHash)
      if (!session) {
        // 找不到哈希有两种可能：凭据是编的，或者它是**轮换前**的那一个（已被替换）。
        // 后者要撤销会话，但我们无从知道是哪一条——所以只报失败，不发散地猜。
        fail(IDENTITY_CODES.SESSION_NOT_FOUND, '刷新凭据无效', 401)
      }
      if (session.revoked_at_ms !== null) fail(IDENTITY_CODES.SESSION_REVOKED, '会话已撤销', 401)
      if (session.refresh_expires_at_ms <= now()) fail(IDENTITY_CODES.SESSION_EXPIRED, '刷新凭据已过期', 401)
      const user = db.prepare('SELECT * FROM hub_users WHERE id=?').get(session.user_id)
      if (!user || user.disabled_at_ms !== null) fail(IDENTITY_CODES.SESSION_REVOKED, '账号不可用', 401)
      const at = now()
      const nextRefresh = randomBytes(32).toString('base64url')
      const nextAccessExpires = at + ACCESS_TOKEN_TTL_MS
      db.prepare('UPDATE hub_user_sessions SET refresh_hash=?, access_expires_at_ms=?, last_seen_at_ms=? WHERE id=?')
        .run(hashSecret(nextRefresh), nextAccessExpires, at, session.id)
      const updated = { ...session, access_expires_at_ms: nextAccessExpires }
      return {
        sessionId: session.id, userId: session.user_id, name: user.name,
        accessToken: mintAccessToken(updated), accessExpiresAtMs: nextAccessExpires,
        refreshToken: nextRefresh, refreshExpiresAtMs: session.refresh_expires_at_ms,
      }
    })
  }

  /**
   * 校验访问令牌。
   *
   * 三道：格式 → 签名（常量时间）→ **会话行仍然是活的**。
   * 第三道不能省：省了就等于"撤销要等 15 分钟才生效"。
   */
  function verifyAccessToken(token) {
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, code: IDENTITY_CODES.TOKEN_MALFORMED, message: '缺少访问令牌' }
    }
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') {
      return { ok: false, code: IDENTITY_CODES.TOKEN_MALFORMED, message: '访问令牌格式不正确' }
    }
    const [, body, sig] = parts
    const expected = sign(body)
    const a = Buffer.from(sig); const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, code: IDENTITY_CODES.TOKEN_BAD_SIGNATURE, message: '访问令牌签名不匹配' }
    }
    let payload
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch {
      return { ok: false, code: IDENTITY_CODES.TOKEN_MALFORMED, message: '访问令牌载荷不是合法 JSON' }
    }
    if (typeof payload?.sid !== 'string' || typeof payload?.sub !== 'string') {
      return { ok: false, code: IDENTITY_CODES.TOKEN_MALFORMED, message: '访问令牌缺少会话或用户标识' }
    }
    const session = db.prepare('SELECT * FROM hub_user_sessions WHERE id=?').get(payload.sid)
    if (!session || session.user_id !== payload.sub) {
      return { ok: false, code: IDENTITY_CODES.SESSION_NOT_FOUND, message: '会话不存在' }
    }
    if (session.revoked_at_ms !== null) return { ok: false, code: IDENTITY_CODES.SESSION_REVOKED, message: '会话已撤销' }
    const at = now()
    if (session.refresh_expires_at_ms <= at) return { ok: false, code: IDENTITY_CODES.SESSION_EXPIRED, message: '会话已过期' }
    if (session.access_expires_at_ms <= at) return { ok: false, code: IDENTITY_CODES.TOKEN_EXPIRED, message: '访问令牌已过期，请刷新' }
    const user = db.prepare('SELECT * FROM hub_users WHERE id=?').get(session.user_id)
    if (!user || user.disabled_at_ms !== null) return { ok: false, code: IDENTITY_CODES.SESSION_REVOKED, message: '账号不可用' }
    return { ok: true, userId: session.user_id, sessionId: session.id, name: user.name }
  }

  function touchSession(sessionId) {
    try { db.prepare('UPDATE hub_user_sessions SET last_seen_at_ms=? WHERE id=?').run(now(), sessionId) } catch { /* 心跳式更新失败不影响请求 */ }
  }

  function revokeSession({ sessionId, by = null }) {
    return withTx(() => {
      const row = db.prepare('SELECT * FROM hub_user_sessions WHERE id=?').get(sessionId)
      if (!row) fail(IDENTITY_CODES.SESSION_NOT_FOUND, '会话不存在', 404)
      if (row.revoked_at_ms !== null) return { sessionId, revoked: false, alreadyRevoked: true }
      db.prepare('UPDATE hub_user_sessions SET revoked_at_ms=? WHERE id=?').run(now(), sessionId)
      record('identity:session-revoke', 'global', { sessionId, userId: row.user_id }, by ?? row.user_id)
      return { sessionId, revoked: true, alreadyRevoked: false }
    })
  }

  function revokeAllSessions({ userId, by = null, exceptSessionId = null }) {
    return withTx(() => {
      const rows = db.prepare('SELECT id FROM hub_user_sessions WHERE user_id=? AND revoked_at_ms IS NULL').all(userId)
      let n = 0
      for (const r of rows) {
        if (exceptSessionId !== null && r.id === exceptSessionId) continue
        db.prepare('UPDATE hub_user_sessions SET revoked_at_ms=? WHERE id=?').run(now(), r.id)
        n += 1
      }
      record('identity:session-revoke-all', 'global', { userId, count: n }, by ?? userId)
      return { revoked: n }
    })
  }

  function listSessions(userId) {
    return db.prepare('SELECT * FROM hub_user_sessions WHERE user_id=? ORDER BY created_at_ms DESC').all(userId)
      .map((r) => ({
        sessionId: r.id, label: r.label, createdAt: iso(r.created_at_ms),
        accessExpiresAt: iso(r.access_expires_at_ms), refreshExpiresAt: iso(r.refresh_expires_at_ms),
        revoked: r.revoked_at_ms !== null, lastSeenAt: r.last_seen_at_ms === null ? null : iso(r.last_seen_at_ms),
      }))
  }

  // ── 空间授权 ──────────────────────────────────────────────────────────────

  function grantSpaceRole({ by, userId, space, role }) {
    validateSpace(space)
    validateRole(role)
    const actor = by === null || by === undefined ? null : requireRoleGranter(by, space, role)
    userRow(userId)
    return withTx(() => {
      db.prepare(`INSERT INTO hub_space_roles VALUES(?,?,?,?,?)
        ON CONFLICT(user_id,space) DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by, granted_at_ms=excluded.granted_at_ms`)
        .run(userId, space, role, actor?.id ?? 'system', now())
      record('identity:grant-role', space, { userId, role }, actor?.id ?? 'system')
      return { userId, space, role }
    })
  }

  function revokeSpaceRole({ by, userId, space }) {
    validateSpace(space)
    // 撤销用 admin 门槛（不是 owner）：收回权限应该比授予权限更容易做到，
    // 否则一个被误授 owner 的人只能靠系统管理员才能摘掉。
    const actor = by === null || by === undefined ? null : requireRoleGranter(by, space, 'admin')
    return withTx(() => {
      const res = db.prepare('DELETE FROM hub_space_roles WHERE user_id=? AND space=?').run(userId, space)
      record('identity:revoke-role', space, { userId }, actor?.id ?? 'system')
      return { userId, space, removed: Number(res.changes) > 0 }
    })
  }

  function rolesOf(userId) {
    return db.prepare('SELECT space, role FROM hub_space_roles WHERE user_id=? ORDER BY space').all(userId)
  }

  function roleIn(userId, space) {
    return db.prepare('SELECT role FROM hub_space_roles WHERE user_id=? AND space=?').get(userId, space)?.role ?? null
  }

  /**
   * 这个用户在该空间是否至少拥有 `minRole`。
   *
   * `owner` 空格（还没有任何角色行）时**返回 false**，不返回 true。理由：
   * 一个"默认放行"的空缺会让"忘了授权"表现为"一切正常"，而这类漏配恰恰是
   * 新空间开通时最常见的状态。拒绝得更早、更响，比事后审计发现更便宜。
   */
  function hasRoleAtLeast(userId, space, minRole = 'viewer') {
    const role = roleIn(userId, space)
    if (role === null) return false
    return ROLE_RANK[role] >= ROLE_RANK[minRole]
  }

  function requireUser(userId) {
    if (typeof userId !== 'string' || userId.length === 0) fail(IDENTITY_CODES.INVALID_INPUT, '缺少用户标识')
    const row = userRow(userId)
    if (row.disabled_at_ms !== null) fail(IDENTITY_CODES.FORBIDDEN, '账号已停用', 403)
    return row
  }

  /** 系统管理员：与空间角色无关的一维（见 `SYSTEM_ROLES` 的注释）。 */
  function isSystemAdmin(userId) {
    const row = db.prepare('SELECT system_role FROM hub_users WHERE id=?').get(userId)
    return row?.system_role === 'admin'
  }

  function requireSystemAdmin(userId) {
    const row = requireUser(userId)
    if (row.system_role !== 'admin') fail(IDENTITY_CODES.FORBIDDEN, '需要系统管理员权限', 403)
    return row
  }

  // ── 自助注册 ──────────────────────────────────────────────────────────────

  /**
   * 注册并直接登录（**一个**事务性动作）。
   *
   * ## 为什么注册要顺带发会话，而不是"注册成功，请去登录"
   *
   * 分成两步的版本有一个安静的坏形态：注册成功之后、登录之前，用户处在一个
   * "账号存在但我进不去"的状态。在手机上尤其明显——他要重新输一遍刚打过的口令，
   * 而任何一步出错（口令打错、网络断）都会让他以为**注册失败了**，于是换个名字
   * 再注册一遍。然后两个账号都在。
   *
   * ## 三条闸门，缺一不可
   *
   * ① **策略允许**（`registration`）：默认 `closed`，此时这个函数直接拒绝。
   *    策略由调用方从配置解出来传进来——仓储不认识环境变量。
   * ② **邀请码**（策略为 `invite` 时）：复用 `acceptInvite` 那一条，
   *    消费与建用户同一个事务，邀请码一次性。
   * ③ **用户名没被占**：与登录用同一个 `name_key`（大小写/空白归一），
   *    所以"Admin"与"admin "不会变成两个账号——那正是账号接管最常见的入口。
   *
   * ## 空间角色
   *
   * `open` 策略下没有邀请码可带空间，用调用方给的 `space`（默认 `default`）并
   * 授予 `member`。**不**授予 owner：第一个 owner 只能由 `bootstrapOwner` 产生，
   * 否则任何人都能注册成某个空间的主人。
   */
  async function register({ name, password, space, code, registration = 'closed', label = '' } = {}) {
    if (!REGISTRATION_MODES.includes(registration)) {
      fail(IDENTITY_CODES.INVALID_INPUT, `registration 必须是 ${REGISTRATION_MODES.join(' / ')} 之一`)
    }
    if (registration === 'closed') {
      fail(IDENTITY_CODES.REGISTRATION_CLOSED, '这台 Hub 未开放注册，请向管理员索取邀请码', 403)
    }
    const clean = validateName(name)
    validatePassword(password)

    // `invite` 策略直接复用接受邀请那一条：那里已经处理了"消费与建用户同一事务"
    // 与并发下的二次判定。另写一条会在两处出现两个"邀请码能不能用"的判定，
    // 而它们迟早会漂移。
    //
    // 邀请制**天然**限速：邀请码一次性、短时、由人签发。所以闸门只加在 `open` 上。
    if (registration === 'invite') {
      if (typeof code !== 'string' || code.trim().length === 0) {
        fail(IDENTITY_CODES.INVITE_REQUIRED, '这台 Hub 需要邀请码才能注册', 403)
      }
      const created = await acceptInvite({ code: code.trim(), name: clean, password })
      const session = issueSession(created.userId, { label })
      record('identity:register', created.space, { userId: created.userId, via: 'invite' }, created.userId)
      return { ...session, userId: created.userId, name: created.name, space: created.space, role: created.role, via: 'invite' }
    }

    // ── `open` 策略的两道闸门 ────────────────────────────────────────────────
    //
    // ① 速率。见 `registrationAllowed` 与那张表的注释：按名字归并的计数挡不住
    //    批量注册，而批量注册从来不重复用同一个名字。
    const gate = registrationAllowed()
    if (gate.allowed !== true) {
      fail(IDENTITY_CODES.REGISTRATION_RATE_LIMITED, gate.message, 429)
    }
    // ② 目标空间**必须真的存在**。
    //
    // 只做 `validateSpace`（那是正则）会让"打错一个字母"通过：返回 200、发令牌、
    // 进主界面，然后 `/api/spaces` 里什么都没有。而那个界面与"注册成功、但还没人
    // 拉你进空间"**长得一模一样**——所以用户不会来报 bug，他会以为是自己没被邀请。
    const cleanSpace = resolveRegistrationSpace(space)

    const hash = await hashPassword(password)
    const at = now()
    const userId = withTx(() => {
      // 事务内再查一次：两个并发注册都通过了上面的检查时，唯一约束只会让一个成功，
      // 但那时抛出的是 SQLite 的 UNIQUE 错误，用户看到的是"数据库错误"。
      if (db.prepare('SELECT id FROM hub_users WHERE name_key=?').get(nameKey(clean))) {
        fail(IDENTITY_CODES.NAME_TAKEN, '该用户名已被占用', 409)
      }
      const newId = id('user')
      try {
        db.prepare('INSERT INTO hub_users VALUES(?,?,?,?,?,NULL,?)').run(newId, clean, nameKey(clean), hash, at, 'none')
      } catch (e) {
        if (String(e?.message ?? '').includes('UNIQUE')) fail(IDENTITY_CODES.NAME_TAKEN, '该用户名已被占用', 409)
        throw e
      }
      db.prepare('INSERT INTO hub_space_roles VALUES(?,?,?,?,?)').run(newId, cleanSpace, DEFAULT_REGISTER_ROLE, newId, at)
      // 记账必须在**同一个事务**里：分开写会让"闸门看到 0 条"与"用户已建出来"
      // 之间出现一个窗口，而并发注册恰好都落在那个窗口里。
      db.prepare('INSERT INTO hub_registrations VALUES(?,?,?,?)').run(id('reg'), newId, cleanSpace, at)
      record('identity:register', cleanSpace, { userId: newId, via: 'open' }, newId)
      return newId
    })
    const session = issueSession(userId, { label })
    return { ...session, userId, name: clean, space: cleanSpace, role: DEFAULT_REGISTER_ROLE, via: 'open' }
  }

  /**
   * 目标空间解析：显式给了就必须存在；没给就**只在唯一时**替用户选。
   *
   * 没给且存在多个空间时**拒绝**而不是挑一个：挑第一个会把用户静默丢进一个
   * 他不知道自己为什么在那儿的空间，而他之后做的每件事都落在那儿。
   */
  function resolveRegistrationSpace(space) {
    const given = space === undefined || space === null ? '' : String(space).trim()
    const count = () => {
      try { return Number(db.prepare('SELECT COUNT(*) AS n FROM spaces').get().n) } catch { return 0 }
    }
    const exists = (id) => {
      try { return db.prepare('SELECT id FROM spaces WHERE id=?').get(id) !== undefined } catch { return false }
    }
    if (given !== '') {
      const clean = validateSpace(given)
      if (!exists(clean)) {
        // 不列出可用空间：这个接口**免鉴权**，而列出来就是在向匿名访问者广播
        // 这台 Hub 上有什么。速率闸门挡的是量，不是"该不该说"。
        fail(IDENTITY_CODES.SPACE_NOT_FOUND, `空间「${clean}」不存在。请向管理员确认空间 ID，或让他发一个邀请码给你。`, 404)
      }
      return clean
    }
    const n = count()
    if (n === 1) return db.prepare('SELECT id FROM spaces LIMIT 1').get().id
    if (n === 0) fail(IDENTITY_CODES.SPACE_NOT_FOUND, '这台 Hub 上还没有任何空间，请联系管理员先建一个。', 409)
    fail(IDENTITY_CODES.SPACE_REQUIRED, '这台 Hub 上有多个空间，请在注册时说明要加入哪一个。', 409)
  }

  /**
   * 注册速率闸门：滑动窗口里数 `hub_registrations`。
   *
   * ## 为什么是**全局**而不是按 IP
   *
   * 部署形态是"Hub 绑回环 + 反代"（见 `deploy` 那一节），于是
   * `req.socket.remoteAddress` 恒为反代自己的地址；而要拿真实来源得信
   * `X-Forwarded-For`，那要求"谁是可信代理"是配置出来的——**没配就信它，
   * 等于让任何调用方自带一个 IP**。
   *
   *   > 一个"信一个没人验证过的 X-Forwarded-For"的按 IP 限速，
   *   > 与一个完全不限速的注册端点，在攻击者面前是同一个东西——
   *   > 只不过前者多了一行看起来很安全的代码。
   *
   * 所以这里按**全局**算：自托管的 Hub 上，"一小时内新开了几个账号"本身就是
   * 一个有意义的读数，而合法的注册（自己 + 几个朋友）远远到不了上限。
   */
  function registrationAllowed() {
    const windowMs = REGISTRATION_WINDOW_MS
    const max = registrationMax
    // `<= 0` = **关掉闸门**（明确写出来才算，不给"忘了配"留一条静默放行的路）。
    if (!Number.isFinite(max) || max <= 0) return { allowed: true, message: '', recent: 0, max }
    const at = now()
    let recent = 0
    try {
      recent = Number(db.prepare('SELECT COUNT(*) AS n FROM hub_registrations WHERE at_ms > ?').get(at - windowMs).n)
    } catch { return { allowed: true, message: '', recent: 0, max } }
    if (recent < max) return { allowed: true, message: '', recent, max }
    const hours = Math.round(windowMs / 3_600_000)
    return {
      allowed: false, recent, max,
      message: `这台 Hub 在最近 ${hours} 小时内已经新开了 ${recent} 个账号（上限 ${max}），暂时不再接受自助注册。`
        + '请联系管理员，或稍后再试。管理员可以把上限调高（LEGION_REGISTRATION_MAX）。',
    }
  }

  /**
   * 改口令。**必须给原口令**，且成功后撤销**其它**会话。
   *
   * 撤销其它会话不是可选项：改口令的第一动机通常是"我怀疑别人在用我的账号"，
   * 而只改哈希不踢会话的话，那个人的令牌**照样有效到过期为止**——
   * 用户会以为他做完了，而实际上什么都没挡住。
   *
   * 保留当前会话：把人也一起踢掉，他会以为改口令失败了（要重新登录），
   * 而在手机上重新登录正是最容易放弃的一步。
   */
  async function changePassword({ userId, currentPassword, newPassword, exceptSessionId = null } = {}) {
    const row = requireUser(userId)
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      fail(IDENTITY_CODES.INVALID_INPUT, '请输入当前口令')
    }
    validatePassword(newPassword)
    const verified = await verifyPassword(currentPassword, row.password_hash)
    if (verified.ok !== true) fail(IDENTITY_CODES.WRONG_PASSWORD, '当前口令不正确', 401)
    if (currentPassword === newPassword) {
      fail(IDENTITY_CODES.INVALID_INPUT, '新口令与当前口令相同')
    }
    const hash = await hashPassword(newPassword)
    return withTx(() => {
      db.prepare('UPDATE hub_users SET password_hash=? WHERE id=?').run(hash, userId)
      const at = now()
      const sql = exceptSessionId === null
        ? 'UPDATE hub_user_sessions SET revoked_at_ms=? WHERE user_id=? AND revoked_at_ms IS NULL'
        : 'UPDATE hub_user_sessions SET revoked_at_ms=? WHERE user_id=? AND revoked_at_ms IS NULL AND id<>?'
      const args = exceptSessionId === null ? [at, userId] : [at, userId, exceptSessionId]
      const res = db.prepare(sql).run(...args)
      record('identity:password-change', 'global', { revokedSessions: Number(res.changes) }, userId)
      return { userId, changed: true, revokedOtherSessions: Number(res.changes) }
    })
  }

  /**
   * 造邀请的门槛：**系统管理员**，或**该空间的** admin/owner。
   *
   * 后者是刻意的：邀请某人进入 software 空间，不该要求邀请者同时是系统管理员。
   * 但门槛必须落在**那一个空间**上——否则一个 viewer 也能往别的空间塞人。
   */
  function requireInviterFor(userId, space) {
    const row = requireUser(userId)
    if (row.system_role === 'admin') return row
    if (hasRoleAtLeast(userId, space, 'admin')) return row
    fail(IDENTITY_CODES.FORBIDDEN, `需要系统管理员，或 ${space} 空间的 admin / owner 权限`, 403)
  }

  /** 改空间角色的门槛：系统管理员，或该空间的 admin/owner；授予 owner 另需该空间 owner。 */
  function requireRoleGranter(userId, space, role) {
    const row = requireUser(userId)
    const system = row.system_role === 'admin'
    if (role === 'owner' && !system && !hasRoleAtLeast(userId, space, 'owner')) {
      // 授予 owner 等于把空间交出去。系统管理员可以做，该空间的 owner 可以做。
      fail(IDENTITY_CODES.FORBIDDEN, '只有系统管理员或该空间的 owner 可以授予 owner', 403)
    }
    if (!system && !hasRoleAtLeast(userId, space, 'admin')) {
      fail(IDENTITY_CODES.FORBIDDEN, `需要系统管理员，或 ${space} 空间的 admin / owner 权限`, 403)
    }
    return row
  }

  function listUsers() {
    return db.prepare('SELECT * FROM hub_users ORDER BY created_at_ms').all().map((r) => ({
      ...publicUser(r), roles: rolesOf(r.id),
    }))
  }

  function setUserDisabled({ by, userId, disabled }) {
    requireSystemAdmin(by)
    return withTx(() => {
      db.prepare('UPDATE hub_users SET disabled_at_ms=? WHERE id=?').run(disabled ? now() : null, userId)
      if (disabled) {
        const rows = db.prepare('SELECT id FROM hub_user_sessions WHERE user_id=? AND revoked_at_ms IS NULL').all(userId)
        for (const r of rows) db.prepare('UPDATE hub_user_sessions SET revoked_at_ms=? WHERE id=?').run(now(), r.id)
      }
      record(disabled ? 'identity:user-disable' : 'identity:user-enable', 'global', { userId }, by)
      return { userId, disabled: !!disabled }
    })
  }

  return {
    isBootstrapped, bootstrapOwner,
    createInvite, acceptInvite,
    register, changePassword,
    createPasswordReset, redeemPasswordReset, listPasswordResets,
    // 诊断与用例用：闸门当前读数（不写、不需要就能读）。
    registrationGate: () => registrationAllowed(),
    login, refresh, upgradePassword,
    verifyAccessToken, touchSession,
    revokeSession, revokeAllSessions, listSessions,
    grantSpaceRole, revokeSpaceRole, rolesOf, roleIn, hasRoleAtLeast, listUsers, setUserDisabled,
    isSystemAdmin, requireSystemAdmin, requireInviterFor, requireRoleGranter,
    publicUser, userRow,
    /** 测试与诊断用：库里到底存了什么（不含明文凭据）。 */
    _internals: { hashSecret, nameKey },
  }
}
