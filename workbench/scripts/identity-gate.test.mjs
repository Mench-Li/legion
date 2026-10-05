// workbench/scripts/identity-gate.test.mjs —— 指挥台账号会话的**结构性**守卫
//
// 为什么是读源码而不是跑组件：指挥台没有组件级测试环境（没有 jsdom、没有
// 渲染器），而这一组要守的三条**全都不是渲染逻辑**，是"代码长什么样"：
//   · 两种令牌谁优先；
//   · 登录门排在哪个位置；
//   · 刷新是不是单飞。
//
//   > 一个"门放在了错误的位置上"的缺陷，在只看组件是否渲染得出东西的用例下
//   > 是全绿的——它渲染得很好，只是渲染的是**另一件**事。
//
// 第 ② 条尤其值得钉住：它守的是实测抓到的一个**误报**——用户没登录时界面说
// "无法连接数据源，请运行 node scrum/serve.mjs --port 4820"，把人送去修一个
// 没坏的东西。而真正该做的那一件事（登录）在屏幕上根本没出现。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

describe('指挥台账号会话', () => {
  const api = read('workbench/src/api.ts')
  const app = read('workbench/src/App.tsx')
  const identity = read('workbench/src/identity.ts')

  test('① authHeaders 优先用户令牌，机器令牌兜底', () => {
    // 两种令牌是两件事：用户令牌回答"你是谁"，机器令牌回答"你是这台机器上的
    // Legion 组件"。浏览器从外面访问一台公网 Hub 时**机器令牌根本不存在**，
    // 那时唯一能用的就是用户令牌。
    const fn = /function authHeaders\(\)[^]*?\n}/.exec(api)?.[0] ?? ''
    assert.ok(fn.length > 0, '找不到 authHeaders')
    assert.match(fn, /getAccessToken\(\)/, 'authHeaders 必须读用户令牌')
    assert.match(fn, /getToken\(\)/, 'authHeaders 必须保留机器令牌兜底')
    // 顺序：用户令牌的分支必须**先**出现，且先返回。
    assert.ok(
      fn.indexOf('getAccessToken()') < fn.indexOf('getToken()'),
      '用户令牌分支必须排在机器令牌之前，否则兜底会永远赢',
    )
    // 两者用**不同的**存储键——塞进同一个键平时也能跑，而一个 401 摆在面前时
    // "那个键里装的是哪一种"无人能答。
    //
    // 判据要写成"两个键不相等"而不是"文件里不出现那个字符串"：后者会被
    // **注释**里那句解释（"`legion.workbench.token` 是机器令牌"）误伤——
    // 一条把说明文字也算作违规的断言，会逼着后来的人删掉说明。
    assert.match(api, /import \{ getAccessToken, recoverSession \} from '\.\/identity/)
    assert.match(identity, /const SS_ACCESS = 'legion\.identity\.access'/)
    assert.match(identity, /const LS_REFRESH = 'legion\.identity\.refresh'/)
    const legacyKey = /const LEGACY_KEY = '([^']+)'/.exec(api)?.[1] ?? 'legion.workbench.token'
    assert.notEqual('legion.identity.access', legacyKey)
    assert.notEqual('legion.identity.refresh', legacyKey)
  })

  test('② 登录门排在 `conn` 的提前返回**之前**（否则会误报成"连不上数据源"）', () => {
    // ★★★★★ 这是实测踩到的那一条。门放在后面时，Hub 要鉴权而浏览器没会话
    //    ⇒ 每个请求 401 ⇒ `conn === 'error'` ⇒ 界面说"无法连接数据源
    //    http://127.0.0.1:4820"，并让人去起一个本地开发服务端。
    const gate = app.indexOf('if (gateOn || signedOut)')
    assert.ok(gate > 0, '找不到登录门')
    const connecting = app.indexOf("if (conn === 'connecting')")
    const errored = app.indexOf("if (conn === 'error')")
    assert.ok(connecting > 0 && errored > 0, '找不到 conn 的两个提前返回')
    assert.ok(gate < connecting, '登录门必须排在 `conn === \'connecting\'` 之前')
    assert.ok(gate < errored, '登录门必须排在 `conn === \'error\'` 之前——否则"你还没登录"会被说成"连不上数据源"')
  })

  test('③ 只拦"Hub 要求鉴权且手上没有会话"，本机单机部署一个字都不变', () => {
    const gate = /const gateOn = [^]*?\n(?=\s*if \(gateOn \|\| signedOut\))/.exec(app)?.[0] ?? ''
    assert.ok(gate.length > 0, '找不到 gateOn 的判据')
    // 三条**同时**成立才拦：远程鉴权开着、身份体系配好了、且本地没有会话。
    assert.match(gate, /remoteAuthRequired === true/)
    assert.match(gate, /enabled === true/)
    assert.match(gate, /!hasSession\(\)/)
    // 探测还没回来（status === null）时**不**拦：否则每次刷新都闪一下登录页。
    assert.match(gate, /identityStatus !== null/)
  })

  test('④ 会话恢复是单飞：十几路并发 401 只能打一次刷新', () => {
    // 刷新凭据是**轮换**的（服务端作废旧的那个）。首屏十几个请求同时 401 时
    // 各自去刷新，后到的必然失败，把一次本来能救回来的会话砸成"已被撤销"。
    assert.match(identity, /let recovery: Promise<boolean> \| null = null/)
    assert.match(identity, /if \(recovery !== null\) return recovery/)
    // 失败要**清干净**并通知上层：留着半个会话只会让后续每一个请求继续 401。
    const recover = /export async function recoverSession\(\)[^]*?\n}/.exec(identity)?.[0] ?? ''
    assert.match(recover, /clearSession\(\)/)
    assert.match(recover, /expiredHandler\?\.\(\)/)
  })

  test('⑤ 两条中枢出口各重放一次，且重放用新头', () => {
    // 只重放一次：无限重试会在"刷新成功但立刻又过期"时打成死循环，
    // 而那个症状（风扇狂转）与真正的原因（服务端时钟不对）离得很远。
    assert.match(api, /async function fetchWithSessionRetry/)
    // 判据用"整行 + 它在 hubPost 之后"，而不是把 hubPost 的函数体截出来：
    // 截取的终点是第一个 `\n  }`，而 hubPost 里内嵌了一个 `post()` 闭包，
    // 它的收尾**恰好**就是那个形状——于是正则会在真正的重放那行之前断掉，
    // 报出一句"没有重放"，而重放明明在。
    const postAt = api.indexOf('async function hubPost')
    assert.ok(postAt > 0, '找不到 hubPost')
    const replayAt = api.indexOf('res.status === 401 && await recoverSession()')
    assert.ok(replayAt > postAt, 'hubPost 必须在 401 上抢救一次会话并重放')
    // 重放必须重新取头：刷新换了令牌，沿用旧头等于没刷新。
    assert.match(api, /headers: withAuthHeaders\(init\.headers\)/)
    // 没有刷新凭据时**不动手** —— 本机/桌面部署行为与改动前逐字相同。
    assert.match(identity, /if \(getRefreshToken\(\)\.length === 0\) return false/)
  })

  test('⑥ 注册入口按策略出现，closed 时整块不显示', () => {
    const view = read('workbench/src/components/LoginView.tsx')
    assert.match(view, /status\.registration === 'open' \|\| status\.registration === 'invite'/)
    // 一个点下去必然 403 的按钮比没有按钮更坏：用户会以为是自己哪里点错了。
    assert.match(view, /canRegister &&/)
  })
})

describe('账号面板（「连接与令牌」里那一节）', () => {
  const panel = read('workbench/src/components/AccountPanel.tsx')

  test('⑦ 只在真的在用账号体系时渲染：本机单机部署整块不出现', () => {
    // 判据是"手上有没有用户会话"。本机用的是机器令牌，这里恒为空 ⇒ 整块不渲染。
    // 本机用户不该看到一个"退出登录"按钮——按下去只会让他以为自己把
    // 本机 Legion 登出了。
    assert.match(panel, /const active = hasSession\(\)/)
    assert.match(panel, /if \(!active && loaded\) return null/)
  })

  test('⑧ 四件事都在：退出 / 改口令 / 会话列表 / 邀请码', () => {
    for (const fn of ['signOut', 'submitPassword', 'revoke', 'makeInvite']) {
      // 用 indexOf 而不是正则：函数名拼进正则要转义括号，而模板里 `\(`
      // 会被解析成一个普通的 `(`，得到一个「未闭合的组」——报出来是
      // SyntaxError，读起来却像"这条断言没通过"。
      assert.ok(panel.includes(`function ${fn}(`), `账号面板缺 ${fn}`)
    }
    // 邀请入口只给系统管理员：对普通成员显示一个必然 403 的按钮更坏。
    assert.match(panel, /me\?\.systemRole === 'admin' &&/)
  })

  test('⑨ 当前会话不给"撤销"按钮，只标注"这台（现在）"', () => {
    // 一个点了就把自己踢掉的按钮，用户按下去只会以为出错了。
    // 要离开请用「退出登录」——那是另一件事。
    assert.match(panel, /s\.sessionId === sessions\.currentId/)
    assert.match(panel, /这台（现在）/)
  })
})

describe('设备一节（「连接与令牌」里）', () => {
  const panel = read('workbench/src/components/DevicePanel.tsx')
  const identity = read('workbench/src/identity.ts')

  test('⑩ 只在真的用账号体系时渲染（本机单机部署不出现）', () => {
    assert.match(panel, /const active = hasSession\(\)/)
    assert.match(panel, /if \(!active && loaded\) return null/)
  })

  test('⑪ 三件事都在：生成配对码 / 换令牌 / 撤销', () => {
    for (const fn of ['makeCode', 'rotate', 'revoke']) {
      assert.ok(panel.includes(`function ${fn}(`), `设备面板缺 ${fn}`)
    }
  })

  test('⑫ ★ 换令牌读的是 deviceToken，不是 token', () => {
    // `device-store.mjs` 的 rotateToken 返回 `{ nodeId, deviceToken }`。
    // 读错名字的后果**不是报错**，而是一个空字符串——界面上得到一个空输入框，
    // 而"令牌是空的"与"令牌没显示出来"看起来一模一样。
    assert.match(identity, /deviceToken \?\? ''/)
    const fn = /export async function rotateDeviceToken[\s\S]*?\n}/.exec(identity)?.[0] ?? ''
    assert.ok(fn.length > 0, '找不到 rotateDeviceToken')
    assert.match(fn, /deviceToken/)
    assert.doesNotMatch(fn, /r\.token\b/, '不许读 r.token —— 那个字段不存在')
  })

  test('⑬ 配对码要有名字，且明说只能用一次', () => {
    // 默认成随机 id 会让"我在撤销哪一台"变成一个要猜的问题。
    assert.match(panel, /给这台电脑起个名字/)
    assert.match(panel, /只能用一次/)
  })

  test('⑭ 设备状态是**三**种：在线 / 离线 / 还没连过', () => {
    // 刚配好对、还没启动那台电脑上的 Legion 时显示"离线"，会让人以为配对失败了，
    // 然后去重配一次——而那一遍会造出第二台设备。
    assert.match(panel, /'还没连过'/)
    assert.match(panel, /'在线' : '离线'/)
  })
})
