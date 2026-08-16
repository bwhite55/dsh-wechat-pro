/**
 * 审批转发：把 harness 的工具审批（ctx.approval 的 approval/request waterfall）
 * 转给绑定该会话的微信联系人，等待「允许 <token> / 拒绝 <token>」回复。
 * 无绑定联系人时调用 next() 让位给 Web 审批通道（两者共存）。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

import type { EngineSurface } from './channel/engine.ts'
import type { SessionMirror } from './mirror.ts'
import { clamp, log, mask } from './util.ts'

const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000

interface PendingApproval {
  token: string
  contactId: string
  toolName: string
  reason?: string
  settle: (outcome: ApprovalOutcome) => void
  timer: NodeJS.Timeout
}

export class ApprovalForwarder {
  private readonly pendings = new Map<string, PendingApproval>()

  constructor(
    private readonly ctx: Context,
    private readonly engine: EngineSurface,
    private readonly mirror: SessionMirror,
  ) {}

  /** 注册 approval/request 应答器（prepend 先于宿主 apiproxy；绑定会话优先走微信）。 */
  start(): void {
    this.ctx.on('approval/request', (request, next) => {
      const sessionId = String(request.agent.session.id)
      const contacts = this.mirror.contactsOf(sessionId)
      if (contacts.length === 0 || request.signal?.aborted) {
        // 无绑定联系人：让位给 Web 审批通道（宿主 apiproxy）
        return next()
      }
      const contactId = contacts[0]!
      const token = randomUUID().slice(0, 4)
      const prompt = `🔐 需要审批：工具「${request.toolName}」${
        request.reason ? `\n原因：${clamp(request.reason, 300)}` : ''
      }\n回复「允许 ${token}」或「拒绝 ${token}」`
      void this.engine.sendText(contactId, prompt, { retry: true }).catch((e) => log(`审批提示发送失败: ${e instanceof Error ? e.message : String(e)}`))
      log(`审批转发: user=${mask(contactId)} tool=${request.toolName} token=${token}`)

      return new Promise<ApprovalOutcome>((resolve) => {
        const settle = (outcome: ApprovalOutcome): void => {
          if (!this.pendings.delete(token)) return
          request.signal?.removeEventListener('abort', onAbort)
          clearTimeout(pending.timer)
          resolve(outcome)
        }
        const onAbort = (): void => settle('cancelled')
        const pending: PendingApproval = {
          token,
          contactId,
          toolName: request.toolName,
          ...request.reason !== undefined ? { reason: request.reason } : {},
          settle,
          timer: setTimeout(() => {
            void this.engine.sendText(contactId, `⏱ 审批「${request.toolName}」超时未回复，已按失败处理（可用 /cancel 取消当前回合）`).catch(() => {})
            settle('unavailable')
          }, APPROVAL_TIMEOUT_MS),
        }
        this.pendings.set(token, pending)
        request.signal?.addEventListener('abort', onAbort, { once: true })
      })
    }, { prepend: true })
  }

  /** 微信收到「允许/拒绝 <token>」时调用；返回是否消费了消息。 */
  async tryResolve(contactId: string, text: string): Promise<boolean> {
    const m = /^(允许|拒绝|allow|reject|同意|不同意)\s*([a-z0-9]{4})$/i.exec(text.trim())
    if (!m) return false
    const token = m[2]!.toLowerCase()
    const pending = this.pendings.get(token)
    if (!pending) return false
    if (pending.contactId !== contactId) return false
    const allowed = /^(允许|allow|同意)$/i.test(m[1]!)
    pending.settle(allowed ? 'allowed-once' : 'rejected')
    await this.engine.sendText(contactId, allowed ? `✅ 已允许「${pending.toolName}」` : `⛔ 已拒绝「${pending.toolName}」`, { retry: true })
    return true
  }

  dispose(): void {
    for (const pending of this.pendings.values()) {
      clearTimeout(pending.timer)
      pending.settle('cancelled')
    }
    this.pendings.clear()
  }
}
