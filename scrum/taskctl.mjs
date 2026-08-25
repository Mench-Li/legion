#!/usr/bin/env node
/**
 * taskctl —— 军团 Scrum 任务看板的权威数据库 CLI（参考 dashi-taskboard 的 taskctl）。
 *
 * 权威数据在 `legion/scrum/tasks.json`；本 CLI 是所有任务变更的唯一入口，保证
 * 状态机合法、认领互斥、乐观锁一致。所有命令成功时向 stdout 输出 JSON，失败时
 * 向 stderr 输出原因并退出码 1 —— 士兵与将军都消费 JSON，不解析叙述文本。
 *
 * 状态机：
 *   backlog ──将军批准──▶ todo ──士兵认领──▶ in_progress ──完成提交──▶ in_review
 *     in_review ──将军验证+用户接受──▶ done     任意 ──▶ blocked / canceled
 *   blocked ──解阻──▶ todo | in_progress        in_progress ──归还──▶ todo
 *
 * 乐观锁：每次写操作 `version` 递增；`--if-version N` 不匹配则拒绝并输出最新任务，
 * 调用方必须重读重试（绝不在过期版本上覆盖）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TASKS_FILE = join(ROOT, 'scrum', 'tasks.json')
/** 补丁目录：patch 命令把统一 diff 落盘于此，看板经 /api/patch 按 id 取阅。 */
const PATCHES_DIR = join(ROOT, 'scrum', 'patches')
/** 默认 worktree 根（与守护 prepareWorktree 的默认值一致）。 */
const WORKTREE_ROOT = join(ROOT, '.legion-worktrees')
/** 多角色流水线定义（将军发布目标时读首阶段，守护按角色派工流转）。 */
const ROLES_FILE = join(ROOT, 'roles.json')

/** 合法状态集合与列顺序（看板列） */
export const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled']
/** 状态机：每个状态允许迁往的目标 */
const TRANSITIONS = {
  backlog: ['todo', 'blocked', 'canceled'],
  todo: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_review', 'todo', 'blocked', 'canceled'],
  in_review: ['done', 'todo', 'in_progress', 'blocked', 'canceled'],
  blocked: ['todo', 'in_progress', 'canceled'],
  done: ['in_progress', 'canceled'],
  canceled: [],
}
const PRIORITIES = ['high', 'medium', 'low']

/** 数据库文档 */
function emptyDb() {
  return { schemaVersion: 1, nextId: 1, tasks: {} }
}

function loadDb() {
  if (!existsSync(TASKS_FILE)) throw new Error(`tasks.json 不存在：先运行 taskctl init（期望路径 ${TASKS_FILE}）`)
  return JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
}

/** 原子写：先写临时文件再 rename，任何时刻文件都是完整的（读不到半个 JSON）。 */
function saveDb(db) {
  mkdirSync(dirname(TASKS_FILE), { recursive: true })
  const tmp = `${TASKS_FILE}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`)
  renameSync(tmp, TASKS_FILE)
}

/**
 * 跨进程互斥文件锁：排他创建 `<file>.lock` 后执行 fn，保证「读-改-写」在多进程间互斥。
 * `'wx'` 排他创建，EEXIST 则等 20ms 重试；锁超过 30s 未释放视为残留强制清除（持锁进程已死）。
 * @param {string} file 被保护的文件（锁 = file + '.lock'）
 * @param {() => any} fn 持锁期间执行的读-改-写
 * @param {number} [timeoutMs] 获取锁超时
 * @returns {any} fn 的返回值
 */
function withFileLock(file, fn, timeoutMs = 10000) {
  const lock = file + '.lock'
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const start = Date.now()
  let fd
  while (true) {
    try {
      fd = openSync(lock, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock) // 残留锁清理
      } catch { /* 锁刚被释放，下一轮重试 */ }
      if (Date.now() - start > timeoutMs) throw new Error(`获取文件锁超时（${lock}），可能被其他进程长期占用`)
      sleep(20)
    }
  }
  try {
    return fn()
  } finally {
    try { closeSync(fd) } catch { /* 关闭失败忽略 */ }
    try { unlinkSync(lock) } catch { /* 锁已清理忽略 */ }
  }
}

/** 一个原子事务：持锁读整个库 → fn 就地改 → 原子写回。所有多任务写路径都走它。 */
function transact(fn) {
  return withFileLock(TASKS_FILE, () => {
    const db = loadDb()
    const result = fn(db)
    saveDb(db)
    return result
  })
}

function now() {
  return new Date().toISOString()
}

/** 生成下一个任务 id（T-001、T-002…） */
function nextId(db) {
  const id = `T-${String(db.nextId).padStart(3, '0')}`
  db.nextId += 1
  return id
}

/** 取一个任务或抛错 */
function task(db, id) {
  const t = db.tasks[id]
  if (t === undefined) throw new Error(`未知任务 ${id}`)
  return t
}

/**
 * 解析参数：`--key value` 进 flags；其余进 positional（第一个位置参数通常是任务 id）。
 */
function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[i + 1]
      // boolean flag：`--no-*` 无值即 true（如 --no-discuss）
      if (key.startsWith('no-') && (value === undefined || value.startsWith('--'))) {
        flags[key.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = true
        continue
      }
      if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值`)
      // 连字符键转 camelCase：`--if-version` → `ifVersion`
      flags[key.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value
      i += 1
    } else {
      positional.push(arg)
    }
  }
  return { ...flags, positional }
}

/** 需要的参数缺失即抛错 */
function requireArgs(args, keys) {
  for (const key of keys) {
    if (args[key] === undefined) throw new Error(`缺少参数 --${key}`)
  }
}

/** 第一个位置参数作为任务 id */
function requireId(args) {
  const id = args.positional?.[0]
  if (id === undefined) throw new Error('缺少任务 id（第一个位置参数）')
  return id
}

/**
 * 在乐观锁下执行一次写操作：读 → 检查 if-version → 变更 → 写回。
 * @param {object} opts
 * @param {string} [opts.ifVersion] - 期望的当前版本（不匹配则失败）
 * @param {(t: object, db: object) => void} opts.mutate - 对任务的变更（自动 bump version）
 * @returns {object} 变更后的任务
 */
function withLock(opts) {
  return transact(db => {
    const t = task(db, opts.id)
    if (opts.ifVersion !== undefined) {
      const expected = Number(opts.ifVersion)
      if (!Number.isInteger(expected)) throw new Error(`--if-version 必须是整数，收到 ${opts.ifVersion}`)
      if (t.version !== expected) {
        throw new Error(
          `乐观锁冲突：任务 ${opts.id} 当前 version=${t.version}，你期望 ${expected}。` +
          `请先 taskctl get ${opts.id} 重读最新状态再重试（绝不覆盖他人变更）`,
        )
      }
    }
    opts.mutate(t, db)
    t.version += 1
    t.updatedAt = now()
    return t
  })
}

/** 打印任务 JSON（成功输出） */
function printTask(t) {
  process.stdout.write(`${JSON.stringify(t, null, 2)}\n`)
}

/** 校验任务字段形状 */
function validateTaskShape(t) {
  if (typeof t.title !== 'string' || t.title.trim().length === 0) throw new Error('title 必须是非空字符串')
  if (!STATUSES.includes(t.status)) throw new Error(`非法状态 ${t.status}`)
  if (!PRIORITIES.includes(t.priority)) throw new Error(`非法优先级 ${t.priority}`)
}

/**
 * `from` 是否（直接或传递）依赖 `to`：沿 blockedBy 边深度优先，命中 `to` 即返回 true。
 * link 加边前用它检测是否会成环。
 */
function dependsOn(db, from, to) {
  const seen = new Set()
  const stack = [from]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (seen.has(cur)) continue
    seen.add(cur)
    const node = db.tasks[cur]
    if (node === undefined) continue
    for (const b of node.blockedBy) {
      if (b === to) return true
      stack.push(b)
    }
  }
  return false
}

/** 读取多角色流水线定义（roles.json）。 */
function readRoles() {
  if (!existsSync(ROLES_FILE)) throw new Error(`roles.json 不存在（${ROLES_FILE}）`)
  try {
    return JSON.parse(readFileSync(ROLES_FILE, 'utf8'))
  } catch (e) {
    throw new Error(`roles.json 解析失败：${e.message}`)
  }
}

const commands = {
  /** 初始化权威数据库 */
  init() {
    withFileLock(TASKS_FILE, () => {
      if (existsSync(TASKS_FILE)) throw new Error(`tasks.json 已存在（${TASKS_FILE}），不覆盖`)
      saveDb(emptyDb())
    })
    process.stdout.write(`${JSON.stringify({ ok: true, file: TASKS_FILE }, null, 2)}\n`)
  },

  /** 创建任务（默认 backlog，未批准前不可开工） */
  create(args) {
    requireArgs(args, ['title'])
    const t = transact(db => {
      const id = nextId(db)
      const t = {
        id,
        title: args.title.trim(),
        description: args.description ?? '',
        acceptance: (args.acceptance ?? '').split(';').map(s => s.trim()).filter(s => s.length > 0),
        priority: args.priority ?? 'medium',
        status: args.status ?? 'backlog',
        version: 1,
        soldier: null,
        claimedRound: null,
        claimedAt: null,
        ordersVersion: Number(args.ordersVersion ?? 1),
        parent: args.parent ?? null,
        role: args.role ?? null,
        blocks: [],
        blockedBy: [],
        comments: [],
        evidence: [],
        patches: [],
        createdAt: now(),
        updatedAt: now(),
      }
      validateTaskShape(t)
      if (!PRIORITIES.includes(t.priority)) throw new Error(`非法优先级 ${t.priority}（high|medium|low）`)
      if (t.status !== 'backlog' && t.status !== 'todo') throw new Error(`非法初始状态 ${t.status}（backlog|todo）`)
      if (t.parent !== null && db.tasks[t.parent] === undefined) throw new Error(`父任务 ${t.parent} 不存在`)
      db.tasks[id] = t
      return t
    })
    printTask(t)
  },

  /**
   * 发布目标：读 roles.json。有 discussion 配置时默认先建「讨论任务」（role=discussion），
   * 由将军 + 各角色士兵群聊收敛需求方向，再启动流水线；`--no-discuss` 跳过讨论直接建首阶段任务。
   */
  goal(args) {
    requireArgs(args, ['title'])
    const roles = readRoles()
    const stages = roles.stages ?? []
    if (stages.length === 0) throw new Error('roles.json 无流水线阶段（stages 为空）')
    const pipelineLine = `[流水线] ${roles.name}：${stages.map(s => s.label).join(' → ')}`
    const discuss = roles.discussion !== undefined && !args.noDiscuss
    let role, stageLabel, description
    if (discuss) {
      const members = roles.discussion.roles ?? stages.map(s => s.role)
      const maxRounds = roles.discussion.maxRounds ?? 3
      role = 'discussion'
      stageLabel = `需求讨论（将军 + ${members.length} 名士兵，≤${maxRounds} 轮）`
      description = [
        args.description ?? '',
        pipelineLine,
        `[讨论] 将军与 ${members.join('、')} 等士兵先进行需求讨论（最多 ${maxRounds} 轮），澄清矛盾点并确定最终方向，之后按角色分工开工`,
      ].filter(s => s.length > 0).join('\n\n')
    } else {
      const first = stages[0]
      role = first.role
      stageLabel = first.label
      description = [
        args.description ?? '',
        pipelineLine,
        `[本阶段] ${first.label}（${first.role}）`,
      ].filter(s => s.length > 0).join('\n\n')
    }
    const t = transact(db => {
      const id = nextId(db)
      const t = {
        id,
        title: args.title.trim(),
        description,
        acceptance: (args.acceptance ?? '').split(';').map(s => s.trim()).filter(s => s.length > 0),
        priority: args.priority ?? 'high',
        status: 'todo',
        version: 1,
        soldier: null,
        claimedRound: null,
        claimedAt: null,
        ordersVersion: Number(args.ordersVersion ?? 1),
        parent: null,
        role,
        blocks: [],
        blockedBy: [],
        comments: [],
        evidence: [],
        patches: [],
        createdAt: now(),
        updatedAt: now(),
      }
      validateTaskShape(t)
      db.tasks[id] = t
      return t
    })
    process.stdout.write(`${JSON.stringify({ ok: true, goal: args.title.trim(), pipeline: roles.name, stage: stageLabel, role, discuss, task: t }, null, 2)}\n`)
  },

  /** 读取一个任务 */
  get(args) {
    printTask(task(loadDb(), requireId(args)))
  },

  /** 列出任务（可按状态/士兵过滤） */
  list(args) {
    const db = loadDb()
    const all = Object.values(db.tasks)
    const rows = all
      .filter(t => args.status === undefined || t.status === args.status)
      .filter(t => args.soldier === undefined || t.soldier === args.soldier)
      .filter(t => args.role === undefined || t.role === args.role)
      .sort((a, b) => a.id.localeCompare(b.id))
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
  },

  /** 将军批准：backlog → todo（之后士兵才可认领） */
  approve(args) {
    const id = requireId(args)
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        if (t.status !== 'backlog') throw new Error(`只有 backlog 需要批准，当前 ${t.status}`)
        t.status = 'todo'
      },
    })
    printTask(t)
  },

  /**
   * 士兵认领：todo → in_progress，绑定士兵身份与轮次。
   * 认领是互斥的：已被其他士兵认领的任务拒绝；已 in_progress 且绑定他人则拒绝。
   */
  claim(args) {
    requireArgs(args, ['soldier'])
    const id = requireId(args)
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        if (t.status !== 'todo' && t.status !== 'blocked') {
          throw new Error(`无法认领：任务 ${t.id} 当前 ${t.status}（仅 todo/blocked 可认领）`)
        }
        if (t.soldier !== null && t.soldier !== args.soldier) {
          throw new Error(`任务 ${t.id} 已被 ${t.soldier} 认领，不得抢占`)
        }
        const open = t.blockedBy.filter(b => {
          const dep = loadDb().tasks[b]
          return dep === undefined || (dep.status !== 'done' && dep.status !== 'canceled')
        })
        if (open.length > 0 && args.force === undefined) {
          throw new Error(`任务被未完成依赖阻塞：${open.join(', ')}（确认后加 --force）`)
        }
        t.status = 'in_progress'
        t.soldier = args.soldier
        t.claimedRound = args.round !== undefined ? Number(args.round) : null
        t.claimedAt = now()
      },
    })
    printTask(t)
  },

  /** 状态迁移（带合法性与依赖检查） */
  transition(args) {
    requireArgs(args, ['to'])
    const id = requireId(args)
    if (!STATUSES.includes(args.to)) throw new Error(`非法目标状态 ${args.to}`)
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        const allowed = TRANSITIONS[t.status] ?? []
        if (!allowed.includes(args.to)) {
          throw new Error(`非法迁移 ${t.status} → ${args.to}（允许：${allowed.join(', ')}）`)
        }
        if (args.to === 'in_progress') {
          if (t.soldier !== null && t.soldier !== args.by) {
            throw new Error(`任务 ${t.id} 已绑定 ${t.soldier}，不能由 ${args.by} 开工`)
          }
          const open = t.blockedBy.filter(b => loadDb().tasks[b]?.status !== 'done' && loadDb().tasks[b]?.status !== 'canceled')
          if (open.length > 0 && args.force === undefined) {
            throw new Error(`任务被未完成依赖阻塞：${open.join(', ')}（确认后加 --force）`)
          }
          t.soldier = args.by ?? t.soldier
          if (t.claimedAt === null) t.claimedAt = now()
        }
        if (args.to === 'todo') {
          t.soldier = null
          t.claimedAt = null
          t.claimedRound = null
        }
        if (args.to === 'done') {
          if (t.status !== 'in_review') {
            throw new Error(`只有 in_review 可完成（当前 ${t.status}）；先 transition --to in_review`)
          }
          if (args.by !== 'general') {
            throw new Error('只有将军（--by general）能在用户接受后把任务移到 done')
          }
        }
        if (args.to === 'in_review' && args.by !== undefined && t.soldier !== null && t.soldier !== args.by) {
          throw new Error(`任务 ${t.id} 由 ${t.soldier} 负责，不能由 ${args.by} 提交验收`)
        }
        t.status = args.to
      },
    })
    printTask(t)
  },

  /** 追加评论（承载需求变化、返回工作、阻塞说明） */
  comment(args) {
    requireArgs(args, ['by', 'text'])
    const id = requireId(args)
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        t.comments.push({ by: args.by, at: now(), text: args.text })
      },
    })
    printTask(t)
  },

  /** 追加验证证据（将军验证通过后写入） */
  evidence(args) {
    requireArgs(args, ['by', 'text'])
    const id = requireId(args)
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        t.evidence.push({ by: args.by, at: now(), text: args.text })
      },
    })
    printTask(t)
  },

  /** 建立任务依赖/父子关系（blockedBy/blocks 成环即拒绝，整条 link 原子） */
  link(args) {
    const id = requireId(args)
    const t = transact(db => {
      const t = task(db, id)
      // t blocks b → b 依赖 t（边 b→t）：若 t 已（传递）依赖 b，则成环
      for (const b of args.blocks?.split(',') ?? []) {
        if (b.length === 0) continue
        if (b === id) throw new Error(`任务不能阻塞自身（${id}）`)
        task(db, b)
        if (dependsOn(db, t.id, b)) throw new Error(`依赖成环：${id} 已依赖 ${b}，不能再声明 ${id} 阻塞 ${b}`)
        if (!t.blocks.includes(b)) t.blocks.push(b)
        const target = db.tasks[b]
        if (!target.blockedBy.includes(t.id)) target.blockedBy.push(t.id)
      }
      // t blockedBy b → t 依赖 b（边 t→b）：若 b 已（传递）依赖 t，则成环
      for (const b of args.blockedBy?.split(',') ?? []) {
        if (b.length === 0) continue
        if (b === id) throw new Error(`任务不能依赖自身（${id}）`)
        task(db, b)
        if (dependsOn(db, b, t.id)) throw new Error(`依赖成环：${b} 已依赖 ${id}，不能再声明 ${id} 依赖 ${b}`)
        if (!t.blockedBy.includes(b)) t.blockedBy.push(b)
        const target = db.tasks[b]
        if (!target.blocks.includes(t.id)) target.blocks.push(t.id)
      }
      if (args.parent !== undefined) {
        task(db, args.parent)
        if (args.parent === id) throw new Error(`任务不能以自身为父（${id}）`)
        t.parent = args.parent
      }
      t.version += 1
      t.updatedAt = now()
      return t
    })
    printTask(t)
  },

  /** 归还：in_progress → todo，释放认领（士兵主动放弃或守护超时回收） */
  release(args) {
    requireArgs(args, ['by'])
    const id = requireId(args)
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        if (t.status !== 'in_progress') throw new Error(`只能归还 in_progress 的任务，当前 ${t.status}`)
        t.status = 'todo'
        t.soldier = null
        t.claimedAt = null
        t.claimedRound = null
        t.comments.push({ by: args.by, at: now(), text: args.reason ?? `归还（由 ${args.by} 释放）` })
      },
    })
    printTask(t)
  },

  /** 守护批量回收：认领超过 --older-than 分钟无进展的 in_progress 任务释放回 todo */
  'release-stale'(args) {
    const minutes = Number(args.olderThan ?? 60)
    const by = args.by ?? 'daemon'
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--older-than 必须是正整数分钟数')
    const released = transact(db => {
      const cutoff = Date.now() - minutes * 60_000
      const released = []
      for (const t of Object.values(db.tasks)) {
        if (t.status !== 'in_progress' || t.claimedAt === null) continue
        if (new Date(t.claimedAt).getTime() > cutoff) continue
        t.status = 'todo'
        t.soldier = null
        t.claimedAt = null
        t.claimedRound = null
        t.comments.push({ by, at: now(), text: `守护检测到认领超过 ${minutes} 分钟无进展，自动释放回 todo` })
        t.version += 1
        t.updatedAt = now()
        released.push(t.id)
      }
      return released
    })
    process.stdout.write(`${JSON.stringify({ ok: true, released }, null, 2)}\n`)
  },

  /** 记录一次改动为统一 diff：patch 内容落盘 scrum/patches/<id>，任务只存元数据（供将军审阅）。 */
  patch(args) {
    requireArgs(args, ['by', 'summary', 'diff'])
    const id = requireId(args)
    if (!existsSync(args.diff)) throw new Error(`--diff 不是存在的文件：${args.diff}`)
    const diffContent = readFileSync(args.diff, 'utf8')
    if (diffContent.trim().length === 0) throw new Error('--diff 文件为空，拒绝记录空补丁')
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        const list = t.patches ?? []
        const patchId = `${t.id}-${list.length + 1}`
        const diffFile = `${patchId}.patch`
        mkdirSync(PATCHES_DIR, { recursive: true })
        writeFileSync(join(PATCHES_DIR, diffFile), diffContent, 'utf8')
        const files = (args.files ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0)
        list.push({ id: patchId, at: now(), by: args.by, summary: args.summary, files, diffFile })
        t.patches = list
      },
    })
    printTask(t)
  },

  /**
   * 打回：将军退回 in_review/done 的任务——回滚 worktree（删分支 w/<id>）并归还 todo。
   * 只有将军可执行（--by general）。
   */
  reject(args) {
    requireArgs(args, ['by', 'reason'])
    if (args.by !== 'general') throw new Error('只有将军（--by general）能打回任务')
    const id = requireId(args)
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        if (t.status !== 'in_review' && t.status !== 'done') {
          throw new Error(`只有 in_review/done 可打回，当前 ${t.status}`)
        }
        const git = a => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' })
        let reverted = false
        try {
          git(['worktree', 'remove', '--force', join(WORKTREE_ROOT, id)])
          reverted = git(['branch', '-D', `w/${id}`]).status === 0
        } catch { /* 无 worktree 也继续（非隔离模式或已清理） */ }
        t.status = 'todo'
        t.soldier = null
        t.claimedAt = null
        t.claimedRound = null
        t.comments.push({
          by: args.by,
          at: now(),
          text: `打回：${args.reason}${reverted ? `（已回滚 worktree 改动并删除分支 w/${id}）` : '（worktree 回滚失败或不存在，需手动清理）'}`,
        })
      },
    })
    printTask(t)
  },

  /**
   * 流水线自动推进：in_progress/in_review → done（守护调用，将军已授权整条流水线）。
   * 推进者须匹配任务角色（流水线任务）或认领者（通用任务）。
   */
  advance(args) {
    requireArgs(args, ['by'])
    const id = requireId(args)
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        if (t.status !== 'in_progress' && t.status !== 'in_review') {
          throw new Error(`无法推进：任务 ${t.id} 当前 ${t.status}`)
        }
        const expected = t.role ?? t.soldier
        if (expected !== null && expected !== args.by) {
          throw new Error(`只有 ${expected} 可推进任务 ${t.id}（当前 --by ${args.by}）`)
        }
        t.status = 'done'
      },
    })
    printTask(t)
  },

  /**
   * promote：将军验收通过后把 worktree 分支 w/<id> 合并回主分支并清理。
   * 只有将军可执行（--by general），任务须已 done。
   */
  promote(args) {
    requireArgs(args, ['by'])
    if (args.by !== 'general') throw new Error('只有将军（--by general）能 promote 合并')
    const id = requireId(args)
    const t = withLock({
      id,
      ifVersion: args.ifVersion,
      mutate(t) {
        if (t.status !== 'done') throw new Error(`只有 done 的任务可 promote，当前 ${t.status}`)
        const git = a => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' })
        const branch = `w/${id}`
        if (git(['rev-parse', '--verify', branch]).status !== 0) {
          throw new Error(`分支 ${branch} 不存在（可能已 promote 或非隔离模式）`)
        }
        const merge = git(['merge', '--no-ff', branch, '-m', `promote ${id}`])
        if (merge.status !== 0) throw new Error(`merge 失败：${(merge.stderr || merge.stdout).trim()}`)
        git(['worktree', 'remove', '--force', join(WORKTREE_ROOT, id)])
        git(['branch', '-D', branch])
        t.comments.push({ by: args.by, at: now(), text: `promote：分支 ${branch} 已合并回主分支并清理 worktree` })
      },
    })
    printTask(t)
  },
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === undefined || commands[cmd] === undefined) {
    throw new Error(
      `用法：taskctl <${Object.keys(commands).join('|')}> [--key value …]`,
    )
  }
  commands[cmd](parseArgs(rest))
}

main().catch(error => {
  process.stderr.write(`taskctl: ${error.message}\n`)
  process.exitCode = 1
})
