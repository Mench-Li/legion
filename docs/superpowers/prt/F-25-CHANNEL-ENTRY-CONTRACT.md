# F-25 渠道入口契约（立项 · 第一刀）

> 业主 2026-09-24 裁决：**F-23 / F-25 都要做，F-25 先**；渠道 **三件都要：飞书最先**、公开 REST API、邮件
> （邮箱 `1115043055@qq.com`）；身份模型 **单租户多用户**；第一刀 **渠道入口契约**（不是先接某一个渠道）。

## 1. 为什么第一刀不是"接飞书"

接一个渠道能在一天内看到效果，但它会把**那一个渠道的偶然形状**钉进契约 —— §2 对 F-23 的警告
（"契约稳定前不做事"）同样适用于 F-25：**先来的渠道会成为事实标准**。

⇒ 第一刀的产物是**一个渠道无关的入口契约**，之后每接一个渠道都是"实现这个契约"，而不是"改核心"。
判据也随之明确：**接入第二个渠道时，核心不该有任何 diff。**

## 2. 契约形状（草案，实现前不改核心语义）

    // 入站：外部 → Legion。渠道只负责"翻译"，不负责"判定"。
    type InboundChannel = {
      id: 'feishu' | 'rest' | 'email'
      // 渠道把外部消息规范化成这一件事；不能规范化 ⇒ 明确拒绝（不得静默丢弃）
      parse(raw: unknown): ChannelEvent | ChannelReject
    }

    type ChannelEvent = {
      channelId: string          // 哪个渠道来的
      externalUserId: string     // 渠道里的"谁"（只用于**映射**，不作为身份）
      text: string
      receivedAtMs: number
      threadRef?: string         // 回复到同一处所需的句柄
      rawId: string              // 渠道侧唯一 id ⇒ **幂等键**（同一条消息重复投递不得产生第二个 Run）
    }

    // 出站：Legion → 外部。同样只翻译。
    type OutboundChannel = {
      id: string
      send(target: ThreadRef, text: string): Promise<SendResult>
    }

## 3. 三条不许让步的判据（都将有可复跑套件 `channel-contract`，标签点名 F-25）

1. **身份不来自渠道**：`externalUserId` 只能经**映射表**换成 Legion 用户；映射缺失 ⇒ 拒绝并向审计面记账，
   **不得**默认匿名放行（与 F-10 的 fail-closed 同一条纪律）。
2. **幂等**：同一条外部消息重复投递 ⇒ 只产生**一个** Run（用渠道侧 `rawId` 做键）。
3. **接入新渠道不改核心**：第二个渠道接入时，`orchestrator/`、`team-hub/` 的核心文件 **diff 为空** ——
   这条会写成判据（"核心零 diff"），而不只是口头约定。

## 4. 凭据纪律（★ 硬约束）

- 飞书 `app_id`/`app_secret`、邮箱授权码 ⇒ **只**进 DPAPI 秘密库（`team-hub/secret-admin.mjs`，
  PRT-505 的写路径：新增 / 更新 / 轮换 / 删除，每条都有 `secret-admin` 套件）。
- `1115043055@qq.com` 是**地址**不是秘密 ⇒ 按**配置**处理（可入库），但**不硬编码**进源码。
- 我**不会**把任何口令、token、授权码写进仓库、写进提交信息或写进探针 fixture。

## 5. 下一刀（待开场）

1. `channel-contract` 套件 + 契约类型（本文件 §2 落地成代码），先只配一个"回声渠道"作夹具。
2. **飞书**入站 + 出站（需要你给：企业自建应用的 `app_id` / `app_secret`，只进秘密库）。
3. 公开 REST API（不需第三方账号，可作为"接入第二个渠道且核心零 diff"的**判据演示**）。
4. 邮件（IMAP/SMTP）：需要 `1115043055@qq.com` 的**授权码**（不是登录密码）进秘密库。
