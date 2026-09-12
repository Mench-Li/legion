# 模型配置的客户端层：一条断在中间的链

> `workbench/src/hub-errors.ts`（结构化错误）+ `workbench/src/api.ts` 的模型配置客户端
> （档案 CRUD / 岗位绑定 / 探测 / 迁移 / 导入导出）+ `workbench/scripts/model-api.test.mjs`（**10 例**）。
>
> 这一轮补的是 **PRT-501 / 502 / 504 / 506 / 507 / 508 与界面之间那一整层**。

---

## 1. 缺口的具体形态：**六个功能，零个客户端函数**

后端在最近几轮把模型配置这一族做完了：模型档案 CRUD（PRT-501）、岗位绑定与
fallback（PRT-502）、连通性探测（PRT-504）、非敏感配置迁移（PRT-506）、
配置导入导出（PRT-508）。每一个都有实现、套件、文档、以及一条 `docs/STATUS.md` 记录。

而 `workbench/src/api.ts` 里**一个客户端函数都没有**。

> **功能在、测试在、文档在，而没有任何入口。**

这与上一轮查 PRT-504 时发现的形态**完全同源**（那次是"没有任何非测试调用方"）。
区别只是：上次空的是服务端内部的一截，这次空的是**界面到服务端之间的整层**。
两次的用例都是全绿的。

---

## 2. 第二个、更隐蔽的缺口：`hubPost` 把结构吃掉了

补客户端函数时读到了这一行：

```ts
if (!res.ok) {
  const text = await res.text().catch(() => '')
  throw new Error(`${res.status}${text ? `：${text}` : ''}`)
}
```

它把响应体**压成了一句字符串**。而后端（PRT-252）明明返回：

```json
{ "error": "...", "code": "MODEL_CONFIG_UNKNOWN_PROVIDER",
  "field": "provider", "hint": "已登记的供应商：…", "candidates": ["custom-ds"] }
```

于是 `field`（该落到哪个输入框）、`hint`（下一步做什么）、`candidates`
（实际存在的选项）**在到达界面之前就没了**。

这一处比"没做"更坏一点：那几个字段**在后端有 18 条用例守着**，
所以从任何局部看都像是"已经做了"。唯一缺的那一环，在两者之间。

这正是本仓库反复记过的那条：

> **后端加了码、前端还是笼统提示 —— 那条码就等于没加。**

修法：新增 `HubError`（`status`/`code`/`field`/`hint`/`candidates`/`errors`/`body`），
让 `hubPost` 与新的 `hubRequest` 抛它而不是抛扁平 `Error`。

### 一处必须说清的行为变化

`HubError.message` 保留 `${status}：...` 的形态，但**内容有一处刻意变化**：

| 响应体 | 旧行为 | 新行为 |
| --- | --- | --- |
| 非 JSON（HTML 错误页/纯文本） | `502：<html>Bad Gateway</html>` | **逐字相同** |
| JSON | `400：{"ok":false,"error":"没有已登记的供应商…","code":"…"}` | `400：没有已登记的供应商…` |

我第一版把这条注释写成"与过去逐字相同"——**那是错的**（JSON 分支变了）。
一句关于行为的错误描述比没有描述更坏，所以改成如实写出来，并用一条用例钉住
（断言消息里**不出现** `"code"` 这类 JSON 结构）。

---

## 3. 客户端覆盖了什么

| 域 | 函数 |
| --- | --- |
| 档案（PRT-501） | `fetchModelProfiles` / `createModelProfile` / `updateModelProfile` / `deleteModelProfile` |
| 探测（PRT-504/507） | `probeModelProfile` |
| 绑定（PRT-502） | `fetchModelBindings` / `saveModelBinding` / `resolveModelBinding` / `deleteModelBinding` |
| 迁移（PRT-506） | `fetchMigrationPlan` / `applyMigration` |
| 导入导出（PRT-508） | `fetchConfigBundle` / `planConfigBundle` / `applyConfigBundle` |

几处刻意的选择：

* **`probeModelProfile` 默认 `force: true`**。这是用户主动按下的按钮；只回一个缓存里的
  旧结论会让人以为"刚才那次点击验证了现在"。缓存的价值在于**自动**重复检查。
* **`applyMigration` 必须回传 `expectedDigest`**。服务端会重算计划并要求两者一致；
  不回传就等于跳过那道对齐，执行一份用户可能没看过的计划。
* **`fetchMigrationPlan` 不把"缺 runtimeType"当异常**：服务端此时返回 **200 + 一份
  `ok:false` 的计划**（说"必须选一种协议"），那正是界面要渲染的第一件事。
  把它当异常会让界面先撞一个错误、再猜该传什么。
* **`updateModelProfile` 强制要 `version`**：服务端用它做 CAS，不给会 400 而不是
  "改最后一版"。

---

## 4. 一条不靠人记得同步的闸门

`model-api.test.mjs` 的第三条是一处**交叉校验**：把 `api.ts` 里的路径抽出来，
与 `team-hub/server.mjs` **源码抽出**的路由表比对，任何一条对不上就红。

它抓的是"前端写了个不存在的端点"——这种错**不会报错，只会 404**，
所以只靠类型和评审很难拦住。

抽取规则**只认 `hubGet` / `hubPost` / `hubRequest` 三个必带字面量的入口**，
不认裸 `fetch(...)`。第一版我加了一条宽松的 `fetch(` 正则，它因为多抽了一个
capture group 而把路径当成了方法，报出一串 `/api/config undefined`——
**一条会给出错误结论的校验，比不校验更坏**，所以把范围收窄到能可靠判定的集合，
并加了两道前提自检（抽到的条数下限，以及本轮新增的四条路径必须在集合里）。

---

## 5. 变红验证（9 条全红）

```
基线 fail = 0
✔ 变红  fail=3  把结构化错误重新压成一句字符串（field/hint/candidates 又没了）
✔ 变红  fail=2  客户端路径拼错（交叉校验必须抓住）
✔ 变红  fail=1  丢掉 field（用户又只能看到一整句 toast）
✔ 变红  fail=1  candidates 混入非字符串（界面渲染 undefined）
✔ 变红  fail=1  非 JSON 响应体也编造结构（猜一个"某字段有问题"）
✔ 变红  fail=1  探测不再默认强制（点击只回缓存）
✔ 变红  fail=1  改档案不带 version（丢掉 CAS 基线）
✔ 变红  fail=1  id 不编码（含斜杠的 id 会变成多段路径）
✔ 变红  fail=1  迁移不回传指纹（服务端无法对齐用户确认过的那一份）
```

### 第一次跑时第 ⑧ 条是**绿的**，而它暴露的是测试的漏洞

`encodeURIComponent` 出现在三处（改 / 删 / 探测），而我只对**改**那条用了带斜杠的 id。
于是"去掉探测那处的编码"没有任何用例变红——**用例覆盖的是三处里的一处，
而它们看起来一样**。补上探测与删除的带斜杠断言之后才真的红。

这与本仓库已记过的两条是同一个家族：
*「一个没生效的变红验证，和一个通过的验证，在输出上完全一样」*、
*「一个测不到东西的断言，和一个正确的实现，在输出上完全一样」*。

---

## 6. 未交付

- **React 组件仍未接**。本轮补的是 **api 层**，`ModelConfigModal.tsx` 依然从硬编码的
  `MODEL_OPTIONS` 渲染，也还没有调用 `probeModelProfile` / 迁移 / 导入。
  现在它**可以**接了（入口齐了），但那是独立的一步。
- **`MODEL_OPTIONS` 硬编码仍在**，与产品档案是两份来源。应改为 `fetchModelProfiles`。
- **档位（light/balanced/heavy/vision）不在产品档案里**，"按档位挑模型"接不上。
- **`hubGet` 的失败路径没有同样处理**：它经 `readJson` 抛 `${status} ${statusText}`，
  仍然丢掉响应体。本轮只改了写路径（后端返回结构的主要是写接口）。读接口若有结构化
  错误（如 `resolveModelBinding` 的 404 带 `code`），调用方仍拿不到。**已知缺口**。
- **`owner` 仍无来源**（承 PRT-257/509）；hub 路由测试仍未纳入套件。

---

## 7. 复跑方式

```bash
node --test workbench/scripts/model-api.test.mjs   # 10 例
node --test workbench/scripts/model-settings.test.mjs
node scripts/config/scan.mjs --check                # 341 个疑似字面量
```
