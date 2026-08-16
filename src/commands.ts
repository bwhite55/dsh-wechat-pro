/**
 * 微信斜杠指令层：
 * - 自有指令：/help /status /time /sessions /new /switch /clear /workspace /workdir
 *   /attach /unbind /model /thinking /send /reconnect /cancel；
 * - 原生透传：名称命中 harness 命令注册表（/plan /permission /compact /goal /feedback
 *   /export 等）时，经 ctx.commands.execute 直接执行，不进模型；
 * - 多步选择：/model /thinking /workspace /sessions 后用户回「数字」完成选择
 *   （每联系人单 pending，5 分钟过期）。
 */

import { basename as baseName, isAbsolute as path_absolute, join as joinPath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { HarnessApi } from './api.ts'
import type { EngineSurface } from './channel/engine.ts'
import { formatBytes } from './channel/media.ts'
import { isStreamLevel, STREAM_LEVELS, type SessionMirror } from './mirror.ts'
import { contactKeyFor, DEFAULT_SESSION, nameOk, normalizeName, type ContactStore } from './registry.ts'
import type { SessionManager } from './sessions.ts'
import { clamp, log, mask } from './util.ts'

const PENDING_TTL_MS = 5 * 60 * 1000

type PendingKind = 'model' | 'thinking' | 'workspace' | 'session'

interface PendingOption {
  label: string
  model?: { provider: string; model: string }
  effort?: string
  workspacePath?: string
  sessionId?: string
  bookmarkName?: string
}

interface PendingSelection {
  kind: PendingKind
  sessionId?: string
  current?: { provider: string; model: string; reasoningEffort?: string }
  options: PendingOption[]
  expiresAt: number
}

interface CommandsDeps {
  ctx: Context
  api: HarnessApi
  sessions: SessionManager
  store: ContactStore
  mirror: SessionMirror
  engine: EngineSurface
  replyMaxChars: number
  hostCwd: string
}

const HELP_TEXT = `🤖 dsh-wechat-pro 指令：
/help          本帮助
/status        连接、工作区、会话与模型状态
/time          连接剩余时间
/workspace     切换工作区（回复数字选择）
/workdir <路径>  切换任意工作路径（自动注册为工作区）
/sessions      当前工作区的会话列表（回复数字附着/切换）
/new <名字>     当前工作区内新建会话并切换
/switch <名字>  切换命名会话（main = 默认）
/attach <序号|会话ID> 附着 Web 已有会话
/clear [名字]   删除微信书签（会话与日志保留在 Web）
/unbind        停止接收当前会话的推送
/model         切换模型（回复数字选择，下一轮生效）
/thinking      切换思考强度 off/high/max（回复数字选择）
/level [级别]   输出等级：minimal=只收答复 / normal=思考+工具过程+答复 / verbose=完整参数
/send <路径> [说明] 发电脑文件到微信（相对路径按会话工作目录）
/reconnect     重新扫码续连
/cancel        取消当前回合
其他 /xxx 若为 harness 原生命令（如 /plan /permission /compact）则直接执行。
其余消息交给 DSH agent（Web 同款会话）。`

export class CommandHandler {
  private readonly pendings = new Map<string, PendingSelection>()

  constructor(private readonly deps: CommandsDeps) {}

  private async reply(to: string, text: string): Promise<void> {
    await this.deps.engine.sendText(to, clamp(text, this.deps.replyMaxChars))
  }

  // ------------------------------------------------------------ pending 选择

  private setPending(contactId: string, pending: PendingSelection): void {
    this.pendings.set(contactId, pending)
  }

  /** 裸数字且存在 pending 时解析选择。返回是否消费了消息。 */
  async tryResolvePending(contactId: string, text: string): Promise<boolean> {
    const pending = this.pendings.get(contactId)
    if (!pending || pending.expiresAt < Date.now()) {
      this.pendings.delete(contactId)
      return false
    }
    const n = Number(text.trim())
    if (!/^\d{1,3}$/.test(text.trim()) || !Number.isInteger(n) || n < 1 || n > pending.options.length) {
      return false
    }
    this.pendings.delete(contactId)
    const option = pending.options[n - 1]!
    try {
      switch (pending.kind) {
        case 'model': {
          if (!option.model || !pending.sessionId) break
          const selected = await this.deps.api.selectModel(pending.sessionId, {
            provider: option.model.provider,
            model: option.model.model,
            ...pending.current?.reasoningEffort !== undefined
              ? { reasoningEffort: pending.current.reasoningEffort }
              : {},
          })
          await this.reply(contactId, `✅ 已切换模型：${selected.provider}/${selected.model}${selected.reasoningEffort ? `（${selected.reasoningEffort}）` : ''}（下一轮生效）`)
          return true
        }
        case 'thinking': {
          if (!option.effort || !pending.sessionId || !pending.current) break
          const selected = await this.deps.api.selectModel(pending.sessionId, {
            provider: pending.current.provider,
            model: pending.current.model,
            reasoningEffort: option.effort,
          })
          await this.reply(contactId, `✅ 思考强度已设为 ${selected.reasoningEffort ?? option.effort}（下一轮生效）`)
          return true
        }
        case 'workspace': {
          if (!option.workspacePath) break
          const reg = await this.deps.store.get(this.contactKey(contactId))
          reg.currentWorkspacePath = option.workspacePath
          await this.deps.store.save(this.contactKey(contactId), reg)
          await this.reply(contactId, `✅ 已切换到工作区：${option.workspacePath}\n（当前命名会话书签不变；/new 新建即落在新工作区）`)
          return true
        }
        case 'session': {
          if (option.bookmarkName) {
            const resolved = await this.deps.sessions.switchTo(this.contactKey(contactId), option.bookmarkName)
            await this.reply(contactId, `✅ 已切到会话「${resolved.name}」（${resolved.sessionId.slice(0, 12)}…，工作区 ${resolved.workspacePath}）`)
          } else if (option.sessionId) {
            const sessions = await this.deps.sessions.listWorkspaceSessions(this.contactKey(contactId))
            const row = sessions.find((s) => s.sessionId === option.sessionId)
            const resolved = await this.deps.sessions.attach(this.contactKey(contactId), option.sessionId, row?.cwd ?? this.deps.hostCwd)
            await this.reply(contactId, `✅ 已附着 Web 会话「${resolved.name}」（${resolved.sessionId.slice(0, 12)}…）`)
          }
          return true
        }
      }
    } catch (error) {
      await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
    return false
  }

  private contactKey(contactId: string): string {
    return contactKeyFor(contactId)
  }

  // ------------------------------------------------------------ 指令入口

  /** 处理一条指令；返回是否已消费（无论成功失败）。 */
  async handle(contactId: string, text: string, ctxToken?: string): Promise<boolean> {
    const cmd = parseCommandLine(text)
    if (!cmd) return false
    const key = this.contactKey(contactId)
    const name = cmd.name
    const arg = cmd.arg

    switch (name) {
      case 'help': {
        await this.reply(contactId, HELP_TEXT)
        return true
      }
      case 'status': {
        await this.cmdStatus(contactId, key)
        return true
      }
      case 'time': {
        const st = this.deps.engine.status()
        const hours = typeof st.remainingHours === 'number' ? st.remainingHours : 0
        const mins = Math.round(hours * 60)
        await this.reply(contactId, `⏱ 本次连接剩余约 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`)
        return true
      }
      case 'workspace': {
        await this.cmdWorkspace(contactId, key, arg)
        return true
      }
      case 'workdir': {
        if (!arg) {
          await this.reply(contactId, '📂 用法：/workdir <绝对路径>')
          return true
        }
        try {
          const info = await this.deps.sessions.switchWorkspaceByPath(await this.deps.store.get(key), arg)
          const reg = await this.deps.store.get(key)
          reg.currentWorkspacePath = info.path
          await this.deps.store.save(key, reg)
          await this.reply(contactId, `✅ 已切换工作路径：${info.path}\n（/workdir 会把该目录注册为工作区，Web 端同样可见）`)
        } catch (error) {
          await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
        }
        return true
      }
      case 'sessions': {
        await this.cmdSessions(contactId, key)
        return true
      }
      case 'level': {
        await this.cmdLevel(contactId, key, arg)
        return true
      }
      case 'new': {
        if (!nameOk(arg)) {
          await this.reply(contactId, '📂 用法：/new <名字>（仅限中英文/数字/._-，1-20 字符）')
          return true
        }
        try {
          const resolved = await this.deps.sessions.createNamed(key, contactId, normalizeName(arg))
          this.deps.mirror.bind(resolved.sessionId, contactId)
          await this.reply(contactId, `✅ 已新建会话「${resolved.name}」并切换（工作区：${resolved.workspacePath}）。\n该会话与 Web 共享，可在网页会话列表看到并继续。`)
        } catch (error) {
          await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
        }
        return true
      }
      case 'switch': {
        if (!arg) {
          await this.reply(contactId, '🔄 用法：/switch <名字>（/switch main 回默认；/sessions 查看列表）')
          return true
        }
        try {
          const resolved = await this.deps.sessions.switchTo(key, normalizeName(arg))
          this.deps.mirror.bind(resolved.sessionId, contactId)
          await this.reply(contactId, `✅ 已切到会话「${resolved.name}」（工作区：${resolved.workspacePath}）。直接发消息即可继续。`)
        } catch (error) {
          await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
        }
        return true
      }
      case 'attach': {
        await this.cmdAttach(contactId, key, arg)
        return true
      }
      case 'unbind': {
        const current = await this.deps.sessions.peekCurrent(key)
        if (current) {
          this.deps.mirror.unbind(current.sessionId, contactId)
          await this.reply(contactId, `🔕 已停止接收会话「${current.name}」的推送`)
        } else {
          await this.reply(contactId, '当前没有绑定会话')
        }
        return true
      }
      case 'clear': {
        const target = normalizeName(arg)
        if (target && target !== DEFAULT_SESSION) {
          await this.deps.sessions.removeBookmark(key, target)
          await this.reply(contactId, `🧹 已删除书签「${target}」（真实会话与日志保留在 Web）`)
        } else {
          const current = await this.deps.sessions.peekCurrent(key)
          if (!current) {
            await this.reply(contactId, '当前没有会话书签')
            return true
          }
          await this.deps.sessions.removeBookmark(key, current.name)
          await this.reply(contactId, `🧹 已删除书签「${current.name}」（真实会话与日志保留在 Web）；当前回落 main（下次发消息自动新建）`)
        }
        return true
      }
      case 'model': {
        await this.cmdModel(contactId, key)
        return true
      }
      case 'thinking': {
        await this.cmdThinking(contactId, key)
        return true
      }
      case 'send': {
        await this.cmdSend(contactId, key, arg, ctxToken)
        return true
      }
      case 'reconnect': {
        this.deps.engine.reconnect()
        await this.reply(contactId, '🔁 正在重新连接，请留意电脑终端的新二维码…')
        return true
      }
      case 'cancel': {
        const current = await this.deps.sessions.peekCurrent(key)
        if (!current) {
          await this.reply(contactId, '当前没有活动会话')
          return true
        }
        try {
          await this.deps.api.cancel(current.sessionId)
          await this.reply(contactId, '⏹ 已请求取消当前回合')
        } catch (error) {
          await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
        }
        return true
      }
      default: {
        // 原生透传
        return this.tryNative(contactId, key, text, name, arg)
      }
    }
  }

  // ------------------------------------------------------------ 子命令实现

  private async cmdStatus(contactId: string, key: string): Promise<void> {
    const st = this.deps.engine.status()
    const lines: string[] = []
    lines.push(`🤖 dsh-wechat-pro${st.botId ? `\n- botId: ${mask(st.botId)}` : ''}`)
    lines.push(`- 连接: ${st.state}${typeof st.remainingHours === 'number' ? `（剩余 ${st.remainingHours} 小时）` : ''}`)
    if (st.error) lines.push(`- 错误: ${clamp(st.error, 200)}`)
    const current = await this.deps.sessions.peekCurrent(key)
    const reg = await this.deps.store.get(key)
    if (current) {
      lines.push(`- 工作区: ${current.workspacePath}`)
      lines.push(`- 会话: ${current.name}（${current.sessionId.slice(0, 12)}…）`)
      try {
        const models = await this.deps.api.sessionModels(current.sessionId)
        const cur = models.current
        lines.push(`- 模型: ${cur.provider}/${cur.model}${cur.reasoningEffort ? `（${cur.reasoningEffort}）` : ''}`)
      } catch {
        lines.push('- 模型: （会话未激活，稍后自动加载）')
      }
    } else {
      lines.push(`- 工作区: ${reg.currentWorkspacePath || '（默认，首次会话自动确定）'}`)
      lines.push('- 会话: （尚无，发消息自动创建 main）')
    }
    await this.reply(contactId, lines.join('\n'))
  }

  private async cmdWorkspace(contactId: string, key: string, arg: string): Promise<void> {
    try {
      const workspaces = await this.deps.sessions.listWorkspaces()
      if (workspaces.length === 0) {
        await this.reply(contactId, '还没有注册工作区；用 /workdir <路径> 注册第一个')
        return
      }
      if (arg) {
        // 直接按序号或标题/路径匹配
        const n = Number(arg)
        const target = /^\d+$/.test(arg) && n >= 1 && n <= workspaces.length
          ? workspaces[n - 1]!
          : workspaces.find((w) => w.title === arg || w.path === arg)
        if (!target) {
          await this.reply(contactId, `❌ 找不到工作区「${arg}」`)
          return
        }
        const reg = await this.deps.store.get(key)
        reg.currentWorkspacePath = target.path
        await this.deps.store.save(key, reg)
        await this.reply(contactId, `✅ 已切换到工作区：${target.path}`)
        return
      }
      const reg = await this.deps.store.get(key)
      const lines = workspaces.map((w, i) => `${w.path === reg.currentWorkspacePath ? '👉' : '  '}${i + 1}. ${w.title}  ${w.path}`)
      await this.reply(contactId, `当前工作区：${reg.currentWorkspacePath || '（默认）'}\n回复数字切换：\n${lines.join('\n')}`)
      this.setPending(contactId, {
        kind: 'workspace',
        options: workspaces.map((w) => ({ label: `${w.title} ${w.path}`, workspacePath: w.path })),
        expiresAt: Date.now() + PENDING_TTL_MS,
      })
    } catch (error) {
      await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async cmdSessions(contactId: string, key: string): Promise<void> {
    try {
      const reg = await this.deps.store.get(key)
      const rows = await this.deps.sessions.listWorkspaceSessions(key)
      if (rows.length === 0) {
        await this.reply(contactId, `当前工作区还没有会话。\n/new <名字> 新建，或 /workdir 切换工作路径。\n（工作区：${reg.currentWorkspacePath || '默认'}）`)
        return
      }
      const lines = rows.map((r, i) => {
        const mark = r.bookmarkName
          ? `📌${r.bookmarkName === reg.currentSessionName ? ' 👉' : ''}`
          : '   '
        // 与 Web 端一致：优先显示会话标题；无标题回落书签名/短 id
        const label = r.title ?? r.bookmarkName ?? `${r.sessionId.slice(0, 12)}…`
        const time = new Date(r.updatedAt).toLocaleString('zh-CN', { hour12: false })
        const suffix = r.running ? '（运行中）' : ''
        return `${mark} ${i + 1}. ${label}${suffix}\n      ${time}`
      })
      await this.reply(contactId, `会话列表（工作区：${reg.currentWorkspacePath || '默认'}）:\n${lines.join('\n')}\n\n回复数字切换/附着；📌=微信书签 👉=当前`)
      this.setPending(contactId, {
        kind: 'session',
        options: rows.map((r) => ({
          label: r.bookmarkName ?? r.sessionId,
          bookmarkName: r.bookmarkName,
          sessionId: r.sessionId,
        })),
        expiresAt: Date.now() + PENDING_TTL_MS,
      })
    } catch (error) {
      await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** /level [minimal|normal|verbose]：查看/切换本联系人的输出等级（持久化）。 */
  private async cmdLevel(contactId: string, key: string, arg: string): Promise<void> {
    try {
      const reg = await this.deps.store.get(key)
      const current = isStreamLevel(reg.streamLevel ?? '') ? reg.streamLevel : undefined
      if (!arg) {
        const desc: Record<string, string> = {
          minimal: '只推最终答复与错误',
          normal: '思考 + 工具调用/结果 + 最终答复（默认）',
          verbose: 'normal + 完整工具参数与结果',
        }
        await this.reply(contactId,
          `📊 当前输出等级：${current ?? 'normal（全局默认）'}（${desc[current ?? 'normal']}）\n`
          + `可选：${STREAM_LEVELS.join(' / ')}\n`
          + '例：/level minimal 只收最终答复')
        return
      }
      const target = arg.trim().toLowerCase()
      if (!isStreamLevel(target)) {
        await this.reply(contactId, `❌ 未知等级「${target}」（可选：${STREAM_LEVELS.join(' / ')}）`)
        return
      }
      reg.streamLevel = target
      await this.deps.store.save(key, reg)
      await this.reply(contactId, `✅ 已切换输出等级：${target}\n（minimal=只收最终答复；normal=思考+工具过程+答复；verbose=完整参数）`)
    } catch (error) {
      await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async cmdAttach(contactId: string, key: string, arg: string): Promise<void> {
    if (!arg) {
      await this.reply(contactId, '📎 用法：/attach <会话ID>（/sessions 看列表后回复数字亦可附着）')
      return
    }
    try {
      const rows = await this.deps.sessions.listWorkspaceSessions(key)
      const n = Number(arg)
      const row = /^\d+$/.test(arg) && n >= 1 && n <= rows.length
        ? rows[n - 1]!
        : rows.find((r) => r.sessionId === arg || r.sessionId.startsWith(arg))
      if (!row) {
        await this.reply(contactId, `❌ 当前工作区找不到会话「${arg}」`)
        return
      }
      const resolved = await this.deps.sessions.attach(key, row.sessionId, row.cwd ?? this.deps.hostCwd)
      this.deps.mirror.bind(row.sessionId, contactId)
      await this.reply(contactId, `✅ 已附着会话「${resolved.name}」（${row.sessionId.slice(0, 12)}…）。与 Web 同轨迹，双向可见。`)
    } catch (error) {
      await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async cmdModel(contactId: string, key: string): Promise<void> {
    try {
      const current = await this.deps.sessions.ensureCurrent(key, contactId)
      await this.deps.sessions.ensureAgentLive(current.sessionId)
      const models = await this.deps.api.sessionModels(current.sessionId)
      const cur = models.current
      if (!models.routable) {
        await this.reply(contactId, `⚠️ 当前 provider「${cur.provider}」没有可用适配器，请先 /model 切换`)
      }
      const options: PendingOption[] = []
      const lines: string[] = []
      let i = 1
      for (const group of models.groups) {
        for (const m of group.models) {
          const selected = cur.provider === group.id && cur.model === m.id
          lines.push(`${selected ? '👉' : '  '}${i}. ${group.name}/${m.name}${m.reasoning?.efforts?.length ? `（思考: ${m.reasoning.efforts.map((e) => e.id).join('/')}）` : ''}`)
          options.push({ label: `${group.name}/${m.name}`, model: { provider: group.id, model: m.id } })
          i++
        }
      }
      if (options.length === 0) {
        await this.reply(contactId, `❌ 没有可用的模型目录（groups 为空）。当前: ${cur.provider}/${cur.model}`)
        return
      }
      await this.reply(contactId, `当前模型：${cur.provider}/${cur.model}${cur.reasoningEffort ? `（${cur.reasoningEffort}）` : ''}\n回复数字切换（下一轮生效）：\n${lines.join('\n')}`)
      this.setPending(contactId, {
        kind: 'model',
        sessionId: current.sessionId,
        current: cur,
        options,
        expiresAt: Date.now() + PENDING_TTL_MS,
      })
    } catch (error) {
      await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async cmdThinking(contactId: string, key: string): Promise<void> {
    try {
      const current = await this.deps.sessions.ensureCurrent(key, contactId)
      await this.deps.sessions.ensureAgentLive(current.sessionId)
      const models = await this.deps.api.sessionModels(current.sessionId)
      const cur = models.current
      let efforts: Array<{ id: string; name: string }> = []
      for (const group of models.groups) {
        if (group.id !== cur.provider) continue
        const model = group.models.find((m) => m.id === cur.model)
        efforts = model?.reasoning?.efforts ?? []
        break
      }
      if (efforts.length === 0) {
        await this.reply(contactId, `当前模型 ${cur.provider}/${cur.model} 不暴露思考档位（/model 可换带思考档位的模型）`)
        return
      }
      const lines = efforts.map((e, i) => `${cur.reasoningEffort === e.id ? '👉' : '  '}${i + 1}. ${e.id}${e.name && e.name !== e.id ? `（${e.name}）` : ''}`)
      await this.reply(contactId, `当前思考强度：${cur.reasoningEffort ?? '（默认）'}\n回复数字切换（下一轮生效）：\n${lines.join('\n')}`)
      this.setPending(contactId, {
        kind: 'thinking',
        sessionId: current.sessionId,
        current: cur,
        options: efforts.map((e) => ({ label: e.id, effort: e.id })),
        expiresAt: Date.now() + PENDING_TTL_MS,
      })
    } catch (error) {
      await this.reply(contactId, `❌ ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async cmdSend(contactId: string, key: string, arg: string, ctxToken?: string): Promise<void> {
    if (!arg) {
      await this.reply(contactId, '📎 用法：/send <文件路径> [可选说明]\n例：/send D:\\下载\\报告.pdf')
      return
    }
    const m = arg.match(/^"([^"]+)"\s*(.*)$/s) ?? arg.match(/^(\S+)\s*(.*)$/s)
    const rawPath = m?.[1] ?? arg
    const caption = (m?.[2] ?? '').trim() || undefined
    const current = await this.deps.sessions.peekCurrent(key)
    if (!current) {
      await this.reply(contactId, '❌ 请先创建或附着会话（/new <名字>），才知道相对路径的基准目录')
      return
    }
    const filePath = path_absolute(rawPath) ? rawPath : joinPath(current.workspacePath, rawPath)
    try {
      const { stat } = await import('node:fs/promises')
      const st = await stat(filePath)
      if (!st.isFile()) {
        await this.reply(contactId, `❌ 不是普通文件：${filePath}`)
        return
      }
      await this.deps.engine.startTyping(contactId, ctxToken)
      await this.reply(contactId, `⏳ 正在发送 ${baseName(filePath)}（${formatBytes(st.size)}）…`)
      await this.deps.engine.sendMediaFile(filePath, contactId, { caption, contextToken: ctxToken })
      await this.reply(contactId, `✅ 已发送：${baseName(filePath)}`)
    } catch (error) {
      await this.reply(contactId, `❌ 发送失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 500))
    } finally {
      await this.deps.engine.stopTyping(contactId, ctxToken).catch(() => {})
    }
  }

  // ------------------------------------------------------------ 原生透传

  private async tryNative(contactId: string, key: string, text: string, name: string, _arg: string): Promise<boolean> {
    try {
      const commands = this.deps.ctx.get('commands') as
        | { list(agent: Agent): readonly { name: string; description: string }[]; execute(agent: Agent, line: string, signal: AbortSignal): Promise<{ result?: { kind: string; text?: string } } | undefined> }
        | undefined
      if (!commands) return false
      const current = await this.deps.sessions.peekCurrent(key)
      if (!current) return false
      const agent = await this.deps.sessions.ensureAgentLive(current.sessionId)
      const known = commands.list(agent).some((c) => c.name === name)
      if (!known) return false
      const execution = await commands.execute(agent, text, new AbortController().signal)
      const resultText = execution?.result?.kind === 'success' ? execution.result.text ?? '✅ 已执行' : execution?.result?.text ?? '✅ 已执行'
      await this.reply(contactId, resultText)
      return true
    } catch (error) {
      await this.reply(contactId, `❌ 原生命令失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 500))
      return true
    }
  }
}

/** 解析 "/name arg" 形式（与 harness parseCommand 同构）。 */
export function parseCommandLine(line: string): { name: string; arg: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line.trim())
  if (!match) return undefined
  return { name: match[1]!, arg: line.slice(match[0].length).trim() }
}

export { log }
