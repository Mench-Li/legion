#!/usr/bin/env node
/**
 * 编队种子：为每个工作空间（scope）建立专属智能体队伍——不同空间不同职业。
 *
 * 用法：node team-hub/scripts/seed-roster.mjs
 * 幂等：按 (scope, role) upsert；**只替换旧默认值**（旧职称名 / 旧 emoji / 空），
 *       用户显式自定义过的 name/avatar 原样保留（AC-R10-1）。
 *
 * 设计意图：
 *   software → 软件流水线 8 角色（与 roles.json 对齐）
 *   marketing → 市场部（内容/投放/增长/品牌）
 *   product   → 产品部（产品/交互/视觉/用户研究/数据）
 *   ops       → 运营部（运营/活动/客服/数据运营）
 *   default   → 我的空间（通用助手）
 *
 * 展示名是「两段式」的第一段：拟人称呼（2~6 汉字）；第二段仍是既有 kind 职能副标题。
 * 头像令牌由 role 单射决定（human:<role>），跨空间同 role 恒同（AC-R5-1）。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db as defaultDb } from '../server.mjs'
import { builtinAvatarFor, isAvatarToken } from '../agent-avatars.mjs'

/** scope → [[role, 展示名, 职能副标题], …]（两段式：名字给个体感，kind 保留职能）。 */
export const ROSTER_NAMES = {
  software: [
    ['requirement', '析言', '需求澄清与拆解'],
    ['researcher', '探微', '技术选型与搜索'],
    ['breaker', '分略', '任务拆分与依赖规划'],
    ['test-designer', '构验', '用例设计与验收标准'],
    ['coder', '衡码', '实现与自测'],
    ['reviewer', '鉴微', '质量审查与反馈'],
    ['tester', '寻瑕', '执行用例与回归'],
    ['devops', '启舟', 'CI/CD 与发布'],
  ],
  marketing: [
    ['market-analyst', '观市', '市场洞察与竞品分析'],
    ['content-planner', '谋篇', '选题与内容产出'],
    ['ad-optimizer', '定投', '广告投放与 ROI 优化'],
    ['growth-hacker', '拓流', '增长实验与渠道'],
    ['brand-copy', '润声', '品牌表达与文案'],
  ],
  product: [
    ['product-manager', '谋远', '需求定义与路线图'],
    ['ux-designer', '疏径', '交互流程与原型'],
    ['ui-designer', '绘色', '界面视觉与设计规范'],
    ['user-researcher', '问真', '用户洞察与调研'],
    ['data-analyst', '明数', '数据指标与洞察'],
  ],
  ops: [
    ['ops-specialist', '理常', '日常运营执行'],
    ['campaign-planner', '造势', '活动方案与执行'],
    ['support-lead', '解忧', '客户反馈与 SLA'],
    ['data-ops', '呈数', '运营数据与报表'],
  ],
  default: [
    ['assistant', '小通', '日常事务与杂务'],
    ['research-assistant', '小辑', '信息检索与整理'],
    ['writer', '执笔', '文档与文案'],
  ],
}

const SPACE_NAMES = {
  software: '软件流水线',
  marketing: '市场部空间',
  product: '产品部空间',
  ops: '运营部空间',
  default: '我的空间',
}

/** 旧职称名（迁移白名单）：命中即替换为新展示名，其余视为用户自定义、原样保留。 */
const LEGACY_NAMES = new Set([
  '需求分析师', '方案研究员', '任务拆解师', '测试设计师', '编码工程师', '代码审查员', '测试执行员', '部署运维员',
  '市场分析师', '内容策划', '投放优化师', '用户增长', '品牌文案',
  '产品经理', '交互设计师', '视觉设计师', '用户研究员', '数据分析师',
  '运营专员', '活动策划', '客服主管', '数据运营',
  '通用助理', '调研助手', '文字编辑',
])

/** 纯函数：5 空间 25 岗位的完整种子数据（不落库，供测试直调）。 */
export function buildRosterSeed() {
  const rows = []
  for (const [scope, list] of Object.entries(ROSTER_NAMES)) {
    list.forEach(([role, name, kind], i) => {
      rows.push({ scope, role, name, kind, avatar: builtinAvatarFor(role) ?? 'human:' + role, sort: i })
    })
  }
  return rows
}

/**
 * 落库（幂等 + 迁移保护）。返回 { upserted, scopes }。
 * @param db better-sqlite3 风格的库（必须有 prepare）
 * @param opts { quiet?: boolean }
 */
export function applyRosterSeed(db, opts = {}) {
  const rows = buildRosterSeed()
  const selectExisting = db.prepare('SELECT name, avatar FROM roster WHERE scope = ? AND role = ?')
  const upsert = db.prepare(`
    INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, role) DO UPDATE SET name=excluded.name, kind=excluded.kind, avatar=excluded.avatar, sort=excluded.sort
  `)
  const upsertSpace = db.prepare(`
    INSERT INTO spaces (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, updatedAt=excluded.updatedAt
  `)
  const now = new Date().toISOString()
  let upserted = 0
  for (const row of rows) {
    if (SPACE_NAMES[row.scope]) upsertSpace.run(row.scope, SPACE_NAMES[row.scope], now, now)
    const existing = selectExisting.get(row.scope, row.role)
    // 只替换旧默认值：用户显式改过的名字 / 已是合法令牌的头像都保留。
    const name = existing && existing.name && !LEGACY_NAMES.has(existing.name) ? existing.name : row.name
    const avatar = existing && isAvatarToken(existing.avatar) ? existing.avatar.trim() : row.avatar
    upsert.run(row.scope, row.role, name, row.kind, avatar, row.sort)
    upserted += 1
  }
  const scopes = db.prepare('SELECT scope, COUNT(*) AS c FROM roster GROUP BY scope ORDER BY scope').all()
  if (!opts.quiet) {
    console.log(`seed-roster: upserted=${upserted}`)
    for (const row of scopes) console.log(`  ${row.scope}: ${row.c} 名`)
  }
  return { upserted, scopes }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false
if (isMain) applyRosterSeed(defaultDb)
