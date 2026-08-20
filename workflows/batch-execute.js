// 军团批量执行模板 —— 供指挥官使用：
// 1) 从 legion/tasks/backlog.md 挑选本批任务；
// 2) 调用 workflow 工具：script 参数填本文件内容，args 填 { tasks: [...], phaseTitle: "..." }；
// 3) 收集返回的 results，做独立验证，再更新 state.json 与 backlog / done / blocked。
//
// 注意：workflow 脚本不能访问文件系统，任务清单必须通过 args 传入。
// 每个任务项的 prompt 必须自包含：仓库路径、验收标准、输出位置、成功定义。

const { tasks = [], phaseTitle = '执行任务批次' } = args ?? {};
if (!Array.isArray(tasks) || tasks.length === 0) {
  throw new Error('args.tasks 为空：请先从 backlog 挑选本批任务再提交');
}

phase(phaseTitle);
log(`本批共 ${tasks.length} 个任务：${tasks.map((t) => t.id).join(', ')}`);

const results = await parallel(
  tasks.map((task) => () =>
    agent(task.prompt, {
      label: task.id,
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', const: task.id },
          status: { type: 'string', enum: ['done', 'blocked'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          blocker: { type: 'string' },
        },
        required: ['taskId', 'status', 'summary', 'evidence'],
        additionalProperties: false,
      },
    }),
  ),
);

const settled = results.filter(Boolean);
const done = settled.filter((r) => r.status === 'done');
const blocked = settled.filter((r) => r.status === 'blocked');
const failed = tasks.length - settled.length;

log(`批次结束：完成 ${done.length} / 受阻 ${blocked.length} / 失败(null) ${failed}`);
return { phaseTitle, total: tasks.length, done, blocked, failed, results: settled };
