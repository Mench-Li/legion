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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TASKS_FILE = join(ROOT, 'scrum', 'tasks.json')

/** 合法状态集合与列顺序（看板列） */
export const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled']
/** 状态机：每个状态允许迁往的目标 */
const TRANSITIONS = {
  backlog: ['todo', 'blocked', 'canceled'],
  todo: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_review', 'todo', 'blocked', 'canceled'],
  in_review: ['done', 'in_progress', 'blocked', 'canceled'],
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

function saveDb(db) {
  mkdirSync(dirname(TASKS_FILE), { recursive: true })
  writeFileSync(TASKS_FILE, `${JSON.stringify(db, null, 2)}\n`)
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
  const db = loadDb()
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
  saveDb(db)
  return t
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

const commands = {
  /** 初始化权威数据库 */
  init() {
    if (existsSync(TASKS_FILE)) throw new Error(`tasks.json 已存在（${TASKS_FILE}），不覆盖`)
    saveDb(emptyDb())
    process.stdout.write(`${JSON.stringify({ ok: true, file: TASKS_FILE }, null, 2)}\n`)
  },

  /** 创建任务（默认 backlog，未批准前不可开工） */
  create(args) {
    requireArgs(args, ['title'])
    const db = loadDb()
    const id = nextId(db)
    const t = {
      id,
      title: args.title.trim(),
      description: args.description ?? '',
      acceptance: (args.acceptance ?? '').split(';').map(s => s.trim()).filter(s => s.length > 0),
      priority: args.priority ?? 'medium',
      status: 'backlog',
      version: 1,
      soldier: null,
      claimedRound: null,
      claimedAt: null,
      ordersVersion: Number(args.ordersVersion ?? 1),
      parent: args.parent ?? null,
      blocks: [],
      blockedBy: [],
      comments: [],
      evidence: [],
      createdAt: now(),
      updatedAt: now(),
    }
    validateTaskShape(t)
    if (!PRIORITIES.includes(t.priority)) throw new Error(`非法优先级 ${t.priority}（high|medium|low）`)
    if (t.parent !== null && db.tasks[t.parent] === undefined) throw new Error(`父任务 ${t.parent} 不存在`)
    db.tasks[id] = t
    saveDb(db)
    printTask(t)
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

  /** 建立任务依赖/父子关系 */
  link(args) {
    const id = requireId(args)
    const db = loadDb()
    const t = task(db, id)
    for (const b of args.blocks?.split(',') ?? []) {
      if (b.length === 0) continue
      task(db, b)
      if (!t.blocks.includes(b)) t.blocks.push(b)
      const target = db.tasks[b]
      if (!target.blockedBy.includes(t.id)) target.blockedBy.push(t.id)
    }
    for (const b of args.blockedBy?.split(',') ?? []) {
      if (b.length === 0) continue
      task(db, b)
      if (!t.blockedBy.includes(b)) t.blockedBy.push(b)
      const target = db.tasks[b]
      if (!target.blocks.includes(t.id)) target.blocks.push(t.id)
    }
    if (args.parent !== undefined) {
      task(db, args.parent)
      t.parent = args.parent
    }
    t.version += 1
    t.updatedAt = now()
    saveDb(db)
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
