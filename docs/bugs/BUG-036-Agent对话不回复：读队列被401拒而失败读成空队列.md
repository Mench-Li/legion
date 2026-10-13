# BUG-036｜Agent 对话永远不回复：读队列的请求被 401 拒掉，而失败被读成"空队列"

> 状态：**已修**（代码 + 判据 + 重建产物）；**需要重启宿主**才能让守护加载新产物
> 影响面：`plugins/src/index.ts` 的 `fetchJson`（一个帮手，三个调用点全是聊天链）
> 症状：**全静默** —— 守护日志一行都没有，用户消息停在 `awaiting`

## 0. 用户原话与现场

> 「Agent 对话，不能够正常回复消息」

现场（`team.db` 的 `messages`）：

```
id=269  conv=3  scope=software  author=general  body="hi"
        meta={"aiStatus":"awaiting","aiStatusAt":"2026-10-13T02:45:54.176Z"}
        ← 静置 34 分钟没有任何人处理；我手动调了一次队列接口才被标成 failed
```

对照：**最后一条成功回复是 2026-10-05**（id=225）。此后 8 天，`replied` 一条都没有。

守护日志（`~/.dsh/super-injector/dsh-scrum-worker-software.log`）：

```
含 'chat-responder' 的行数 = 0      ← 一条都没有
含 '回复' 的行数 = 0
含 '暂停' 的行数 = 0                ← 不是被暂停
```

而同一个守护每 30 秒都在正常干活（`目标上下文同步`、`流水线流转跳过`），进程活着。

## 1. 根因（活体复现）

`plugins/src/index.ts` 的 `fetchJson`：

```ts
async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)      // ← ① 不带任何鉴权头
    if (!res.ok) return null          // ← ② 401 被静默当成"空队列"（catch 都不进）
    return await res.json() as T
  } catch { return null }
}
```

实测：

```
GET /api/chat/replies?scope=software&limit=20           （不带令牌）→ HTTP 401
GET /api/chat/replies?scope=software&limit=20           （带令牌）  → HTTP 200 {"messages":[]}
```

链条：

1. 中枢设了令牌（`teamHubRemoteAuth=1`）⇒ **不带头的读一律 401**；
2. 401 是**鉴权闸门**拒的 ⇒ 请求根本**没进处理器** ⇒ 服务端那句"超龄兜底标 failed"
   （`markStaleAwaiting`）**也没机会跑** ⇒ 消息**永远**停在 `awaiting`；
3. `fetchJson` 把 401 变成 `null` ⇒ 调用方两条路都读成"这轮没东西"：
   · `sweepChatReplies()`：`queue?.messages ?? []` ⇒ **恒空** ⇒ 永远不回复；
   · `answerChatMessage()`：`settings === null` ⇒ 直接 `return`（"等下一轮"）；
4. ⇒ **全静默**：守的是空队列，而空队列本来就是正常状态 ⇒ **没有一行日志**。

  > 一处"我没被授权读"的失败，与一处"确实没有待回复"的空队列，
  > 在调用方眼里是同一个 `null` ——
  > 而只有前者会每 30 秒安静地重复一次，直到有人去看数据库。

## 2. 为什么只有聊天这条链坏（元凶形状）

同一个源文件里，其它 hub 读**全都**带 `hubHeaders()`（`hubList` / `/api/goal` /
`/api/pipeline` / `/api/rules` / `/api/skills`）—— 所以**任务一切正常**。
只有 `fetchJson` 这个帮手漏了，而它的三个调用点**全是聊天链**：

```
:3496  /api/chat/reply-settings   （回复设置）
:3514  /api/models                （岗位模型）
:3664  /api/chat/replies          （回复队列 ← 就是它恒空）
```

而这个文件**自己**在 `hubHeaders()` 上面就写着那条教训：

> 此前全插件的**读**路径…都**不带任何鉴权头**，只有写路径…

⇒ 那条规则当时被修在了"各处显式调用"上，**漏掉了被抽成帮手的这一处**。
同一条规则写成两处、只修了一处 —— 与本仓 BUG-033 是同一个形状。

## 3. 修法

1. `fetchJson` 改用 `hubHeaders()`（与其它读路径同一条路）；
2. 读失败**必须留下痕迹**：`!res.ok` 与网络异常都按 `(状态 + 接口路径)` 节流 60 秒打一行，
   401/403 额外点明"鉴权被拒：hubToken 与中枢的令牌不一致"。
   ⇒ **"读不到"不许再伪装成"没有"**（与 `credential-status.mjs` 纪律 ① 同族）；
3. 返回值仍是 `null`（调用方"这轮跳过"的语义不变）—— 变的只是它**不再安静**。

## 4. 判据（`plugins/tests/hub-read-auth.test.mjs`，4 条）

`fetchJson` 是插件工厂内部的闭包、没有导出面，所以这一组是**读源码的接线判据**
（与 `rework-plan.test.mjs` 里那批同手法）：

- 它必须 `fetch(url, { headers: hubHeaders() })`，且**不许**再出现裸 `fetch(url)`；
- `!res.ok` 之后**必须先 log 再 return null**，日志要带状态码、401/403 要有专门的话；
- 失败日志要节流（扫单间隔就是 30 秒，不节流会刷屏）；
- **同一条规则的其它读路径**也要带鉴权（扫描全文件的 `${hubUrl}` 请求）——
  专门防"只修了一处"再演一次。
  ⚠ 第一版这条判据**误报**了 `hubPost`（`hubHeaders` 在下一行，正则只截到第一个 `)`）⇒
  改成"匹配点之后 400 字符窗口"，并在注释里写明这个坑。

## 5. 还没做完的一步（需要重启宿主）

守护跑在**宿主进程里**，加载的是构建产物 `plugins/lib/`（未入库）。产物已重建，
但运行中的宿主仍持有旧模块 ⇒ **必须重启宿主**这条修复才生效。

验证方式：重启后 `conv=3` 里那条 `【修复验证】`（id=270）应当被答，
或守护日志里出现 `chat-responder` 字样。
