/**
 * S6（R-2/R-3/R-4，决策 C1/E1 接线）：守护答问前的「外部上下文」收集——绑定仓库摘要 + 本次随消息上传附件内容。
 *
 * 纪律（对齐 docs/G-mtr3su6f-1/TEST_CASES.md TC-S6-* 与 AC-R2-4/R4-3/R4-5/R4-6）：
 *   - 摘要来源：空间绑定的本地仓库目录（buildSpaceDigest 只读，S4）；未绑定 → null（答问提示词降级占位）；
 *     目录存在但不可读 → { text:'', unavailable: 原因 }（同降级占位、原因可见，不冒充有内容）；
 *   - 附件内容：仅取「本次消息」meta.attachments 引用对应的 UTF-8 文本（GET /api/chat/attachments/content，S3），
 *     历史消息的附件不注入（防跨消息重复/泄漏，AC-R4-6）；取回失败 → { content:null, readError } 占位（不抛、不冒充）；
 *   - 本模块绝不把摘要/附件内容写入任何消息 body/meta（纯返回给调用方作当次提示词，AC-R4-3）；
 *   - 任何一步失败仅降级，不 throw 到调用方（守护侧源消息不因上下文失败标 failed，仅日志，TC-S6-03/04）。
 * 依赖：node:fs 读 + fetch（经 hubUrl）；纯模块可单测（plugins/tests/chat-context.test.mjs）。
 */

import { buildSpaceDigest } from './spaceDigest.js'
import type { ChatCtxAttachment, ChatCtxDigest } from './chatResponder.js'

export interface AttachmentRef {
  id: number
  fileName: string
  size: number
}

export interface GatherChatContextOptions {
  /** team-hub 基址（如 http://127.0.0.1:3080/team-hub）。 */
  hubUrl: string
  scope: string
  /** 附件所属会话（归属校验用）。 */
  convId: number
  /** 读取审计身份（回复方身份，如 software-assistant）。 */
  by: string
  /** 本次消息 meta.attachments 引用（无则 []）。 */
  attachmentRefs?: AttachmentRef[]
  /** 空间绑定本地仓库目录；null = 未绑定（→ spaceDigest=null 降级占位）。 */
  bindingDir?: string | null
  /** 空间元数据（远程仓库等；可选）。 */
  bindingMeta?: { remoteUrl?: string; name?: string; id?: string } | null
  /** 摘要子预算（默认 4000，决策 G1 子预算；总预算在提示词层二次拟合）。 */
  digestBudget?: number
}

export interface ChatContextBundle {
  /** undefined = 未启用不产块；null/空 = 降级占位（S5 语义）。 */
  spaceDigest: ChatCtxDigest | null | undefined
  attachments: ChatCtxAttachment[]
}

interface ContentResp { content?: string; error?: string }

/** S6：守护答问上下文收集。不 throw：上下文任一步失败仅降级（null/占位），调用方继续回答。 */
export async function gatherChatContext(opts: GatherChatContextOptions): Promise<ChatContextBundle> {
  let hubUrl = String(opts?.hubUrl ?? '').trim()
  while (hubUrl.endsWith('/')) hubUrl = hubUrl.slice(0, -1)
  const scope = (opts?.scope || '').trim()
  const convId = Number(opts?.convId)
  const by = (opts?.by || '').trim()

  // 1) 空间摘要（只读 fs；失败/不可读 → 空 text + unavailable / null，绝不 throw）
  let spaceDigest: ChatCtxDigest | null | undefined = undefined
  if (opts?.bindingDir !== undefined) {
    const dir = opts.bindingDir === null ? null : String(opts.bindingDir).trim()
    if (dir === null || dir.length === 0) {
      spaceDigest = null // 未绑定 → 提示词层固定降级占位
    } else {
      try {
        const meta: { id?: string; name?: string; remoteUrl?: string } = {}
        if (opts.bindingMeta?.id) meta.id = String(opts.bindingMeta.id)
        meta.name = opts.bindingMeta?.name ? String(opts.bindingMeta.name) : scope
        if (opts.bindingMeta?.remoteUrl) meta.remoteUrl = String(opts.bindingMeta.remoteUrl)
        const d = buildSpaceDigest({ dir, budget: opts.digestBudget ?? 4000, meta })
        if (d.text.length > 0) {
          spaceDigest = { text: d.text, sourceNote: '取自绑定仓库（只读快照）', generatedAt: new Date().toISOString() }
        } else if (d.reason) {
          spaceDigest = { text: '', unavailable: d.reason } // 目录不可读等 → 降级占位 + 原因
        } else {
          spaceDigest = { text: '', unavailable: '（绑定目录无可用内容）' }
        }
      } catch (e) {
        spaceDigest = { text: '', unavailable: '空间摘要读取失败：' + String(e) }
      }
    }
  }

  // 2) 本次消息附件内容（顺序取回；归属/存在性由 hub 校验；失败 → 占位不 throw）
  const attachments: ChatCtxAttachment[] = []
  const refs = Array.isArray(opts?.attachmentRefs) ? opts.attachmentRefs.filter((r) => r && Number.isInteger(r.id) && r.id > 0) : []
  if (hubUrl.length > 0 && refs.length > 0) {
    for (const ref of refs) {
      try {
        const qs = new URLSearchParams({ id: String(ref.id), conv: String(convId), scope, by })
        const res = await fetch(hubUrl + '/api/chat/attachments/content?' + qs.toString())
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '')
          attachments.push({ id: ref.id, fileName: ref.fileName, size: ref.size, content: null, readError: '读取失败：HTTP ' + res.status + (bodyText ? ' ' + bodyText.slice(0, 80) : '') })
        } else {
          const data = await res.json().catch(() => null) as ContentResp | null
          const content = data?.content
          if (typeof content === 'string' && content.length > 0) {
            attachments.push({ id: ref.id, fileName: ref.fileName, size: ref.size, content })
          } else {
            attachments.push({ id: ref.id, fileName: ref.fileName, size: ref.size, content: null, readError: '读取失败：内容为空' })
          }
        }
      } catch (e) {
        attachments.push({ id: ref.id, fileName: ref.fileName, size: ref.size, content: null, readError: '读取失败：' + String(e) })
      }
    }
  }
  return { spaceDigest, attachments }
}
