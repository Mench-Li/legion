export function createSoftwareCollaborationPack({ rolesDefinition, soldierPrompt }) {
  if (!Array.isArray(rolesDefinition?.stages) || typeof soldierPrompt !== 'string') {
    throw new TypeError('Software collaboration pack source is incomplete')
  }
  const roster = [
    ['requirement', '需求分析师', '需求澄清与拆解', '🧭'],
    ['researcher', '方案研究员', '技术选型与搜索', '🔍'],
    ['breaker', '任务拆解师', '任务拆分与依赖规划', '✂️'],
    ['test-designer', '测试设计师', '用例设计与验收标准', '🧪'],
    ['coder', '编码工程师', '实现与自测', '💻'],
    ['reviewer', '代码审查员', '质量审查与反馈', '🔎'],
    ['tester', '测试执行员', '执行用例与回归', '🧹'],
    ['devops', '部署运维员', 'CI/CD 与发布', '🚀'],
  ].map(([role, name, kind, avatar]) => ({ role, name, kind, avatar }))
  const stages = rolesDefinition.stages.map(stage => ({
    role: stage.role,
    label: stage.label,
    prompt: typeof stage.prompt === 'string' ? stage.prompt : '',
    next: stage.next ?? null,
    gate: stage.gate === true,
    artifact: stage.artifact ?? null,
    docs: Array.isArray(stage.docs) ? stage.docs : null,
    enabled: stage.enabled !== false,
  }))
  return {
    format: 'legion/workflow-pack@1',
    id: 'legion.software-collaboration',
    version: '1.0.0',
    name: '软件协作流程',
    description: 'Legion 默认的软件协作工作流：从需求澄清到部署验收的八阶段团队流程。',
    scope: { id: 'software', name: '软件协作' },
    roles: roster,
    stages,
    assets: [{ id: 'soldier-prompt', type: 'template', title: '士兵部署提示词', path: 'workflows/soldier-prompt.md', content: soldierPrompt }],
  }
}
