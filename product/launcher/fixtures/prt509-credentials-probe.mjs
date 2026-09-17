/**
 * PRT-509 缺口 ③ 的 fixture：挂在**真 DSH 进程**里的探针插件。
 *
 * 为什么需要它：这条线此前唯一的判据是在**进程内**手工 `new Context()` 之后去问
 * DSH 的 `LocalCredentialProvider`——那证明的是"提供方读得到"，而不是
 * "一个真 DSH 进程在启动时解析了它"。后者要求判据落在一个**真的被启动起来的树**上，
 * 本文件就是那个读数点。
 *
 * 它写下的**不是值**：只有 `source`、值的长度与 sha256。
 *
 *   > 一条把密钥写进日志的探针，会在下一次有人贴日志时变成一次泄漏；
 *   > 而这条探针要回答的问题（"值是不是材料化时那一把"）用 sha256 就答完了。
 *
 * 参数走**组合行的 `config`**（`apply(ctx, config)`，与 `@dsh-external/dsh-scrum-worker`
 * 同一形态），不读进程环境：
 *
 *   > 把测试的引线（写在哪个文件、问哪个引用名）登记进**产品的** env schema，
 *   > 会让那份 schema 从此多出三个只有用例才会设的名字——而 schema 的用途
 *   > 是"这个产品认哪些环境变量"，不是"今天哪个夹具需要几个旋钮"。
 *
 * 由 fixture profile 里的一行以 `file://` 入口挂进那棵树
 * （与 `tests/p13-fixture/control-plugin.mjs` 同一形态）。
 *
 * 读数的三个字段各自堵一条假绿：
 *   · `configured`   —— "启动了"不等于"读到了"；
 *   · `source`       —— 值可能是**环境变量**里来的（那说明文件根本没被读）；
 *   · `valueSha256`  —— "读到了某个字符串"不等于"读到了材料化时那一把"。
 * `otherResolved` 是反向对照：Legion 的内部引用名**不是** DSH 的寻址名。
 * @module prt509-credentials-probe
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

export const name = 'prt509-credentials-probe'

export const inject = ['credentials', 'appExit']

export async function apply(ctx, config = {}) {
  const ref = typeof config.ref === 'string' ? config.ref : ''
  const otherRef = typeof config.otherRef === 'string' ? config.otherRef : ''
  const outFile = typeof config.outFile === 'string' ? config.outFile : ''
  const reading = { ref, otherRef, pid: process.pid, probe: 'prt509-credentials-probe' }
  try {
    const got = ref === '' ? undefined : await ctx.credentials.resolve(ref)
    reading.configured = got !== undefined
    reading.source = got === undefined ? null : got.source
    reading.valueSha256 = got === undefined
      ? null
      : createHash('sha256').update(got.value, 'utf8').digest('hex')
    reading.valueLength = got === undefined ? null : got.value.length
    reading.otherResolved = otherRef === '' ? null : (await ctx.credentials.resolve(otherRef)) !== undefined
  } catch (error) {
    // 提供方抛错也要留下读数：一次"探针自己炸了"不能看起来像"没有配置"。
    reading.error = {
      name: error?.name ?? null,
      code: error?.code ?? null,
      // 消息里可能含引用名，不含值；仍然只取首行并按长度截断。
      message: String(error?.message ?? error).split('\n')[0].slice(0, 200),
    }
  }
  if (outFile !== '') writeFileSync(outFile, `${JSON.stringify(reading, null, 2)}\n`, 'utf8')
  // 用 DSH 自己的退出通道收尾（与 p13 control-plugin 同一形态）：让这次启动
  // **确定性地**结束，而不是靠用例超时去杀进程——超时杀掉的进程给不出读数。
  setTimeout(() => {
    try {
      ctx.appExit(0)
    } catch {
      process.exitCode = 1
    }
  }, 50)
}
