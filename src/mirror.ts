/**
 * 流式镜像：进程内订阅 `session/event`，把绑定到微信联系人的会话事件
 * 实时推送到微信。输出按「日志调试等级」控制，并按「回合发起者」决定是否推送。
 *
 * 事件映射（等级 minimal/normal/verbose，按联系人独立）：
 *   turn/start      → 暂不发送（等 user/message 判定发起者）
 *   user/message    → 判定微信发起（source.kind=user 且无 clientTimeZone）；
 *                     发起者决定本回合是否推送（mirrorWebTurns 覆盖）
 *   request/header  → 🤔 思考中…（normal+，每轮一次）
 *   tool/call       → 🔧 <name>(<args>)（normal+；verbose 显示完整参数）
 *   tool/result     → ✅ <name> → <snippet>（normal+；verbose 显示完整结果）
 *   assistant/message → 暂存该轮最新可见文本
 *   turn/end        → 发送最终答复（分片）+ typing(2) + settle（错误则 ⚠️）
 *
 * 等级语义：
 *   minimal — 只推最终答复与错误（无思考/工具过程）；
 *   normal  — 思考 + 工具调用 + 工具结果 + 最终 + 错误（默认）；
 *   verbose — normal + 完整工具参数/结果。
 *
 * 来源语义：微信发起的回合 → 推送（按各联系人等级过滤）；
 * Web 发起的回合 → 默认不推（mirrorWebTurns=true 时同样推送）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import type { EngineSurface } from './channel/engine.ts'
import { clamp, log, tail } from './util.ts'

/** 输出等级。 */
export type StreamLevel = 'minimal' | 'normal' | 'verbose'

export const STREAM_LEVELS: readonly StreamLevel[] = ['minimal', 'normal', 'verbose']

export function isStreamLevel(value: string): value is StreamLevel {
  return (STREAM_LEVELS as readonly string[]).includes(value)
}

export interface MirrorConfig {
  replyMaxChars: number
  /** 全局默认输出等级；联系人可经 /level 覆盖（levelOf 优先）。 */
  streamLevel: StreamLevel
  /** Web 发起的回合是否也推送到微信（默认 false：只推微信发起的回合）。 */
  mirrorWebTurns: boolean
  /** 按联系人解析有效等级（未覆盖时回落全局默认）。 */
  levelOf: (contactId: string) => StreamLevel
  /** 每回合过程消息上限（🧠/🤔/🔧/✅ 合计；防刷屏与微信限流；最终答复与错误不受限）。 */
  maxProcessPerTurn: number
  /** 最终答复分片预算（腾讯对单条入站消息的回复发送有额度限制，超过预算降级为"首片+文件"）。 */
  maxReplyChunks: number
  /** 超预算时把完整回复落盘为文件发给用户（绕过文本长度与条数额度）。 */
  sendLongAsFile?: (text: string, to: string) => Promise<void>
}

interface ActiveTurn {
  sessionId: string
  contacts: Set<string>
  /** 本回合是否由微信发起（首个 user/message 判定）。 */
  wechatInitiated: boolean
  /** 本回合是否推送（wechatInitiated || mirrorWebTurns）。 */
  pushable: boolean
  thinkingSent: boolean
  lastAssistantText: string
  /** 已推送的过程消息条数（全回合、全联系人合计）。 */
  processCount: number
  settle: () => void
  settleError?: string
  startedAt: number
}

/** 从 ContentBlock 列表提取可见文本。 */
function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
    .trim()
}

/** 工具调用参数的一行摘要（verbose 不截断）。 */
function summarizeArgs(args: unknown, full: boolean): string {
  if (args === undefined || args === null) return ''
  const raw = JSON.stringify(args)
  if (raw.length === 0) return ''
  return full ? raw : clamp(raw, 120)
}

export class SessionMirror {
  private readonly bindings = new Map<string, Set<string>>() // sessionId -> contactIds
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly toolNames = new Map<string, string>() // callId -> toolName

  constructor(
    private readonly ctx: Context,
    private readonly engine: EngineSurface,
    private readonly config: MirrorConfig,
  ) {}

  /** 订阅 session/event（全局 emit；按绑定过滤）。 */
  start(): void {
    this.ctx.on('session/event', (session, event) => {
      const contacts = this.bindings.get(String(session.id))
      if (contacts === undefined || contacts.size === 0) return
      void this.route(session, event).catch((e) => log(`镜像事件处理失败: ${e instanceof Error ? e.message : String(e)}`))
    })
  }

  /** 把会话绑定到一个联系人（该会话后续事件都会推给它）。 */
  bind(sessionId: string, contactId: string): void {
    let set = this.bindings.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.bindings.set(sessionId, set)
    }
    set.add(contactId)
  }

  /** 解除一个联系人对当前会话的绑定。 */
  unbind(sessionId: string, contactId: string): void {
    const set = this.bindings.get(sessionId)
    set?.delete(contactId)
    if (set?.size === 0) this.bindings.delete(sessionId)
  }

  isBound(sessionId: string, contactId: string): boolean {
    return this.bindings.get(sessionId)?.has(contactId) ?? false
  }

  /** 绑定到某会话的联系人列表（供审批转发等反向查找）。 */
  contactsOf(sessionId: string): string[] {
    return [...(this.bindings.get(sessionId) ?? [])]
  }

  /** 等待某会话的当前轮结束（chat 处理器用；超时抛错）。 */
  awaitTurn(sessionId: string, timeoutMs: number): Promise<{ error?: string }> {
    const existing = this.activeTurns.get(sessionId)
    if (!existing) return Promise.resolve({})
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`处理超时（${timeoutMs} ms）`))
      }, timeoutMs)
      const done = (turn: ActiveTurn) => {
        clearTimeout(timer)
        if (turn.settleError) resolve({ error: turn.settleError })
        else resolve({})
      }
      // 替换 settle：原 settle 用于内部收尾，这里只接结果
      const original = existing.settle
      existing.settle = () => {
        original()
        done(existing)
      }
    })
  }

  private async route(session: Session, event: SessionEvent): Promise<void> {
    const sessionId = String(session.id)
    const contacts = [...(this.bindings.get(sessionId) ?? [])]

    switch (event.type) {
      case 'turn/start': {
        const turn: ActiveTurn = {
          sessionId,
          contacts: new Set(contacts),
          wechatInitiated: false,
          pushable: false,
          thinkingSent: false,
          lastAssistantText: '',
          processCount: 0,
          settle: () => {},
          startedAt: Date.now(),
        }
        const prev = this.activeTurns.get(sessionId)
        if (prev) prev.settle()
        this.activeTurns.set(sessionId, turn)
        break
      }
      case 'user/message': {
        const turn = this.activeTurns.get(sessionId)
        if (!turn) break
        const source = (event.data as { source?: { kind?: string; clientTimeZone?: string } }).source
        // 微信来源：kind=user 且无 clientTimeZone（Web 浏览器必带时区；notice/插件注入是 kind=plugin）
        if (source?.kind === 'user' && source.clientTimeZone === undefined) {
          turn.wechatInitiated = true
        }
        if (!turn.pushable && (turn.wechatInitiated || this.config.mirrorWebTurns)) {
          turn.pushable = true
          for (const to of turn.contacts) {
            await this.engine.startTyping(to)
            // minimal 等级只收最终答复/错误，连「开始处理」也不发
            if (this.levelAtLeast(to, 'normal') && this.claimProcessSlot(turn)) {
              await this.engine.sendText(to, '🧠 开始处理…')
            }
          }
        }
        break
      }
      case 'request/header': {
        const turn = this.activeTurns.get(sessionId)
        if (!turn || !turn.pushable || turn.thinkingSent) break
        turn.thinkingSent = true
        for (const to of turn.contacts) {
          if (this.levelAtLeast(to, 'normal') && this.engine.streamAllowed(to) && this.claimProcessSlot(turn)) {
            await this.engine.sendText(to, '🤔 思考中…')
          }
        }
        break
      }
      case 'tool/call': {
        const turn = this.activeTurns.get(sessionId)
        if (!turn || !turn.pushable) break
        const name = String(event.data.name ?? '?')
        this.toolNames.set(String(event.data.callId), name)
        for (const to of turn.contacts) {
          if (!this.levelAtLeast(to, 'normal')) continue
          const full = this.levelOf(to) === 'verbose'
          const args = summarizeArgs(event.data.arguments, full)
          if (this.engine.streamAllowed(to) && this.claimProcessSlot(turn)) {
            await this.engine.sendText(to, `🔧 调用工具 ${name}${args ? `(${args})` : ''}…`)
          }
        }
        break
      }
      case 'tool/result': {
        const turn = this.activeTurns.get(sessionId)
        if (!turn || !turn.pushable) break
        for (const to of turn.contacts) {
          if (!this.levelAtLeast(to, 'normal')) continue
          const full = this.levelOf(to) === 'verbose'
          const source = (event.data.message.source ?? {}) as { callId?: string }
          const name = source.callId !== undefined
            ? (this.toolNames.get(String(source.callId)) ?? '?')
            : '?'
          const summary = clamp(textOf(event.data.message.content ?? []), full ? 2000 : 200) || '(空结果)'
          if (this.engine.streamAllowed(to) && this.claimProcessSlot(turn)) {
            await this.engine.sendText(to, `✅ 工具完成 ${name} → ${summary}`)
          }
        }
        break
      }
      case 'assistant/message': {
        const turn = this.activeTurns.get(sessionId)
        if (!turn) break
        const text = textOf(event.data.message.content ?? [])
        if (text !== '') turn.lastAssistantText = text
        break
      }
      case 'turn/end': {
        const turn = this.activeTurns.get(sessionId)
        if (!turn) break
        this.activeTurns.delete(sessionId)
        const reason = event.data.reason
        if (reason.kind === 'error') {
          const message = reason.error && typeof (reason.error as { message?: string }).message === 'string'
            ? (reason.error as { message: string }).message
            : String(reason.error ?? '未知错误')
          turn.settleError = clamp(message, 500)
        } else if (reason.kind === 'aborted') {
          turn.settleError = '已取消'
        }
        if (turn.pushable) {
          for (const to of turn.contacts) {
            await this.engine.stopTyping(to)
            if (turn.settleError) {
              await this.engine.sendText(to, `⚠️ ${turn.settleError}`, { retry: true })
            } else if (turn.lastAssistantText) {
              await this.sendChunked(to, turn.lastAssistantText)
            } else {
              await this.engine.sendText(to, '（无文本回复）', { retry: true })
            }
          }
        }
        turn.settle()
        break
      }
      default:
        break
    }
  }

  /** 联系人的有效等级（/level 覆盖优先，否则全局默认）。 */
  private levelOf(contactId: string): StreamLevel {
    try {
      return this.config.levelOf(contactId)
    } catch {
      return this.config.streamLevel
    }
  }

  private levelAtLeast(contactId: string, level: StreamLevel): boolean {
    const order: Record<StreamLevel, number> = { minimal: 0, normal: 1, verbose: 2 }
    return order[this.levelOf(contactId)] >= order[level]
  }

  /** 占用一个过程消息额度；超上限返回 false（该事件静默）。 */
  private claimProcessSlot(turn: ActiveTurn): boolean {
    if (turn.processCount >= this.config.maxProcessPerTurn) return false
    turn.processCount += 1
    return true
  }

  /** 长文分片发送（每片失败重试一次；分片超预算降级为"首片 + 文件"，保证完整内容必达）。 */
  private async sendChunked(to: string, text: string): Promise<void> {
    const max = Math.max(200, this.config.replyMaxChars)
    if (text.length <= max) {
      await this.engine.sendText(to, text, { retry: true })
      return
    }
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += max) {
      chunks.push(text.slice(i, i + max))
    }
    const total = chunks.length
    const budget = Math.max(1, this.config.maxReplyChunks)

    // 超预算：发首片 + 完整内容落盘为文件（1 条媒体，不占文本条数额度）
    if (total > budget) {
      log(`回复超长: to=${to} 总长=${text.length} 片数=${total} 预算=${budget} → 降级首片+文件`)
      await this.engine.sendText(to, chunks[0]!, { retry: true })
      if (this.config.sendLongAsFile) {
        try {
          await this.config.sendLongAsFile(text, to)
        } catch (error) {
          log(`超长回复落盘发送失败: ${error instanceof Error ? error.message : String(error)}`)
          await this.engine.sendText(to, `⚠️ 回复过长（${text.length} 字符）且文件发送失败，请在 Web 端查看。`, { retry: true }).catch(() => {})
        }
      } else {
        await this.engine.sendText(to, `⚠️ 回复过长（${text.length} 字符），请在 Web 端查看完整内容。`, { retry: true }).catch(() => {})
      }
      return
    }

    for (let i = 0; i < total; i++) {
      const suffix = `（${i + 1}/${total}）`
      const chunk = chunks[i]!
      await this.engine.sendText(to, i === total - 1 ? `${chunk}${suffix}` : chunk, { retry: true })
      // 分片之间留间隔，降低撞上腾讯发送额度窗口的概率
      if (i < total - 1) await new Promise((r) => setTimeout(r, 1000))
    }
    log(`长文分片发送: to=${to} 总长=${text.length} 片数=${total}`)
  }
}

export { tail }
