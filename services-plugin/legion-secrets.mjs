// services-plugin/legion-secrets.mjs
// ============================================================================
// P3 的**值**那一半：从 Legion 自己的受保护密钥库按引用名取出一把钥匙。
//
// ## 为什么在宿主进程内直读，而不是向中枢要
//
// 实测：team-hub **没有任何"取明文值"的路由**
// （`routes/secrets.mjs` 只有 status / 列表（仅元数据）/ 写入 / 轮换 / 删除）。
// 于是有两条路：
//
//   (a) 宿主进程内直读 DPAPI 库（**本模块**）
//   (b) 给中枢加一条 `GET /api/secrets/<ref>/value`
//
// 选 (a)，理由是它**不新增任何明文传输面**：
//
//   > 一个"密钥值经过一次 HTTP 响应、只是那条路由做了鉴权"的设计，
//   > 与一个"密钥值从不离开进程内存"的设计，在**今天**的安全姿态上是同一档 ——
//   > 区别在**明天**：前者会在某一次"顺手加个调试端点""顺手把日志级别调高"里漏出去。
//
// 而且它复用的是**产品自己的**受保护库与产品自己的打开路径：
// `product/secrets.mjs` 的 `openProductSecrets`（`requireProtected: true` 写死）
// + `product/paths.mjs` 的 `resolveLayout`。不是另开一条读法。
//
// ## 拿不到就是拿不到
//
// 打不开、没配、引用的形状不对 —— 一律返回 `null`（"Legion 里没有这个值"）。
// **绝不返回空串**：调用方把空串当成"有一把空钥匙"写进 DSH，会**毁掉**一把正在用的真钥匙。
// 这条由 `materializer.mjs` 的写入循环与它的用例共同守住。
//
// ## 每次取都重新打开
//
// 不做单例缓存：库文件可能被轮换（`secret-admin` 的 rotate 会重写它），
// 而一次启动的生命周期里可能取多把钥匙。打开成本是一个文件读 + 一次 DPAPI 调用，
// 相对"拿到一份过期快照"的风险不值得省。
// ============================================================================

/**
 * 造一个 `(ref) => Promise<string|null>` 的取值器。
 *
 * 依赖全部可注入（`openSecrets` / `resolveLayout`），是为了让上游能用假件测
 * **"取不到值就什么都不写"** 那条规则 —— 那条规则在生产里很难制造，而它一旦失效后果最重。
 */
export function createLegionSecretReader({
  openSecrets = null,
  resolveLayout = null,
  env = process.env,
  log = () => {},
} = {}) {
  // 懒加载：这两个模块属于 Legion 主仓库，插件**可以**import（同一 junction 指向的仓库），
  // 但把它放在函数里可以让"没有它们时插件仍然能启动"成立（与软取同一条纪律）。
  const loadOpen = async () => {
    if (typeof openSecrets === 'function') return openSecrets
    const mod = await import('../product/secrets.mjs')
    return mod.openProductSecrets
  }
  const loadLayout = async () => {
    if (typeof resolveLayout === 'function') return resolveLayout
    const mod = await import('../product/paths.mjs')
    return mod.resolveLayout
  }

  let announced = false
  return async function readLegionSecret(ref) {
    if (typeof ref !== 'string' || ref === '') return null
    try {
      const resolve = await loadLayout()
      const layout = (await resolve({ env }))?.layout ?? null
      const open = await loadOpen()
      const opened = await open({ layout, requireProtected: true })
      if (opened?.ok !== true || !opened.store || typeof opened.store.get !== 'function') {
        // 打不开就明说一次（同一个失败不该每取一把钥匙都刷一行）
        if (!announced) { announced = true; log(`模型配置物化：Legion 的密钥库打不开（${opened?.code ?? '未知'}）→ 所有凭证都保持 DSH 原样`) }
        return null
      }
      const value = await opened.store.get(ref)
      return typeof value === 'string' && value !== '' ? value : null
    } catch (e) {
      if (!announced) {
        announced = true
        log(`模型配置物化：取 Legion 凭证失败（${e instanceof Error ? e.message : String(e)}）→ 本次不写凭证（不影响其它字段）`)
      }
      return null
    }
  }
}
