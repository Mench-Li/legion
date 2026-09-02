#!/usr/bin/env node
/**
 * 编队种子：为每个工作空间（scope）建立专属智能体队伍——不同空间不同职业。
 *
 * 用法：node team-hub/scripts/seed-roster.mjs
 * 幂等：按 (scope, role) upsert（name/kind/avatar/sort 会被刷新，不重复插入）。
 *
 * 设计意图：
 *   software → 软件流水线 8 角色（与 roles.json 对齐）
 *   marketing → 市场部（内容/投放/增长/品牌）
 *   product   → 产品部（产品/交互/视觉/用户研究/数据）
 *   ops       → 运营部（运营/活动/客服/数据运营）
 *   default   → 我的空间（通用助手）
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../server.mjs'

const ROSTERS = {
  software: [
    ['requirement', '需求分析师', '需求澄清与拆解', '🧭'],
    ['researcher', '方案研究员', '技术选型与搜索', '🔍'],
    ['breaker', '任务拆解师', '任务拆分与依赖规划', '✂️'],
    ['test-designer', '测试设计师', '用例设计与验收标准', '🧪'],
    ['coder', '编码工程师', '实现与自测', '💻'],
    ['reviewer', '代码审查员', '质量审查与反馈', '🔎'],
    ['tester', '测试执行员', '执行用例与回归', '🧹'],
    ['devops', '部署运维员', 'CI/CD 与发布', '🚀'],
  ],
  marketing: [
    ['market-analyst', '市场分析师', '市场洞察与竞品分析', '📊'],
    ['content-planner', '内容策划', '选题与内容产出', '✍️'],
    ['ad-optimizer', '投放优化师', '广告投放与 ROI 优化', '🎯'],
    ['growth-hacker', '用户增长', '增长实验与渠道', '📈'],
    ['brand-copy', '品牌文案', '品牌表达与文案', '💬'],
  ],
  product: [
    ['product-manager', '产品经理', '需求定义与路线图', '🧩'],
    ['ux-designer', '交互设计师', '交互流程与原型', '🖌️'],
    ['ui-designer', '视觉设计师', '界面视觉与设计规范', '🎨'],
    ['user-researcher', '用户研究员', '用户洞察与调研', '🔬'],
    ['data-analyst', '数据分析师', '数据指标与洞察', '📐'],
  ],
  ops: [
    ['ops-specialist', '运营专员', '日常运营执行', '🗂️'],
    ['campaign-planner', '活动策划', '活动方案与执行', '🎪'],
    ['support-lead', '客服主管', '客户反馈与 SLA', '🎧'],
    ['data-ops', '数据运营', '运营数据与报表', '📉'],
  ],
  default: [
    ['assistant', '通用助理', '日常事务与杂务', '🤖'],
    ['research-assistant', '调研助手', '信息检索与整理', '🔦'],
    ['writer', '文字编辑', '文档与文案', '✒️'],
  ],
}

const SPACE_NAMES = {
  software: '软件流水线',
  marketing: '市场部空间',
  product: '产品部空间',
  ops: '运营部空间',
  default: '我的空间',
}

let upserted = 0
const upsert = db.prepare(`
  INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(scope, role) DO UPDATE SET name=excluded.name, kind=excluded.kind, avatar=excluded.avatar, sort=excluded.sort
`)
const upsertSpace = db.prepare(`
  INSERT INTO spaces (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, updatedAt=excluded.updatedAt
`)
const now = new Date().toISOString()
for (const [scope, list] of Object.entries(ROSTERS)) {
  if (SPACE_NAMES[scope]) upsertSpace.run(scope, SPACE_NAMES[scope], now, now)
  list.forEach(([role, name, kind, avatar], i) => {
    upsert.run(scope, role, name, kind, avatar, i)
    upserted += 1
  })
}

const total = db.prepare('SELECT scope, COUNT(*) AS c FROM roster GROUP BY scope ORDER BY scope').all()
console.log(`seed-roster: upserted=${upserted}`)
for (const row of total) console.log(`  ${row.scope}: ${row.c} 名`)
