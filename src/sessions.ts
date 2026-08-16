/**
 * 会话管理：把"微信联系人 × 命名会话书签"映射到宿主真实 DSH 会话。
 * - 新建：apiProxy.sessions.create({ workspaceId, sessionId })（宿主负责
 *   workspace attach、预设组合、默认模型，与 Web「新建会话」同构）；
 * - 续接：apiProxy.sessions.models({ sessionId }) 让宿主 resume（agentFor），
 *   之后 ctx.agents.get 拿到 live agent；
 * - 附着：把 Web 已存在的会话绑定到微信书签（跨端同轨迹）。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

import { HarnessApi } from './api.ts'
import { DEFAULT_SESSION, type ContactRegistry, type ContactStore, type SessionBookmark } from './registry.ts'
import { log, safeKey } from './util.ts'

export interface ResolvedSession {
  sessionId: string
  workspacePath: string
  name: string
}

export interface WorkspaceInfo {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

export interface WorkspaceSessionRow {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  /** Web 端显示的会话标题（来自 host projections；缺省为书签名/短 id）。 */
  title?: string
  bookmarked: boolean
  bookmarkName?: string
}

/** 从 SessionSummary.projections.values 读标题（title 投影）。 */
function readTitleOf(summary: { projections?: { values?: unknown } }): string | undefined {
  const values = summary.projections?.values
  if (values === null || typeof values !== 'object') return undefined
  const title = (values as { title?: unknown }).title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}

export class SessionManager {
  constructor(
    private readonly ctx: Context,
    readonly api: HarnessApi,
    private readonly store: ContactStore,
    private readonly hostCwdFallback: string,
  ) {}

  // ------------------------------------------------------------------ 工作区

  /** 按路径解析注册工作区（不存在返回 undefined）。 */
  private async findWorkspaceByPath(path: string): Promise<WorkspaceInfo | undefined> {
    const { items } = await this.api.listWorkspaces()
    const hit = items.find((w) => w.path === path || w.path.replace(/[\\/]+$/, '') === path.replace(/[\\/]+$/, ''))
    return hit
      ? {
          workspaceId: String(hit.workspaceId),
          path: hit.path,
          title: hit.title,
          sessionIds: hit.sessionIds.map((s) => String(s)),
        }
      : undefined
  }

  /** 当前工作区：联系人指针 → 未设置/失效时回落默认（第一个工作区或 Host cwd）。 */
  async resolveWorkspace(reg: ContactRegistry): Promise<WorkspaceInfo> {
    if (reg.currentWorkspacePath) {
      const found = await this.findWorkspaceByPath(reg.currentWorkspacePath)
      if (found) return found
      log(`工作区「${reg.currentWorkspacePath}」已不存在，回落默认工作区`)
    }
    return this.defaultWorkspace()
  }

  /** 默认工作区：注册列表第一个；空列表则以 Host cwd 兜底注册一个。 */
  private async defaultWorkspace(): Promise<WorkspaceInfo> {
    const { items } = await this.api.listWorkspaces()
    if (items.length > 0) {
      const first = items[0]!
      return {
        workspaceId: String(first.workspaceId),
        path: first.path,
        title: first.title,
        sessionIds: first.sessionIds.map((s) => String(s)),
      }
    }
    try {
      const { workspace } = await this.api.createWorkspace(this.hostCwdFallback)
      return {
        workspaceId: String(workspace.workspaceId),
        path: workspace.path,
        title: workspace.title,
        sessionIds: workspace.sessionIds.map((s) => String(s)),
      }
    } catch (error) {
      throw new Error(`没有可用工作区且无法以 ${this.hostCwdFallback} 创建：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** /workdir <path>：注册（幂等）并设为当前工作区。 */
  async switchWorkspaceByPath(reg: ContactRegistry, path: string): Promise<WorkspaceInfo> {
    const { workspace } = await this.api.createWorkspace(path)
    return {
      workspaceId: String(workspace.workspaceId),
      path: workspace.path,
      title: workspace.title,
      sessionIds: workspace.sessionIds.map((s) => String(s)),
    }
  }

  /** /workspace <名称|序号>：在注册工作区之间切换。 */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const { items } = await this.api.listWorkspaces()
    return items.map((w) => ({
      workspaceId: String(w.workspaceId),
      path: w.path,
      title: w.title,
      sessionIds: w.sessionIds.map((s) => String(s)),
    }))
  }

  // ------------------------------------------------------------------ 会话

  /** 只读查看当前书签（不创建）。 */
  async peekCurrent(contactKey: string): Promise<ResolvedSession | undefined> {
    const reg = await this.store.get(contactKey)
    const found = this.store.find(reg, reg.currentSessionName)
    if (!found?.bookmark) return undefined
    return { sessionId: found.bookmark.sessionId, workspacePath: found.bookmark.workspacePath, name: found.name }
  }

  /** 取（或建）联系人当前书签对应的真实会话。 */
  async ensureCurrent(contactKey: string, contactId: string): Promise<ResolvedSession> {
    const reg = await this.store.get(contactKey)
    const name = reg.currentSessionName
    const found = this.store.find(reg, name)
    if (found?.bookmark) {
      return { sessionId: found.bookmark.sessionId, workspacePath: found.bookmark.workspacePath, name: found.name }
    }
    return this.createNamed(contactKey, contactId, name)
  }

  /** 新建命名会话（真实 DSH 会话 + 微信书签），并切换过去。 */
  async createNamed(contactKey: string, contactId: string, name: string): Promise<ResolvedSession> {
    const reg = await this.store.get(contactKey)
    const workspace = await this.resolveWorkspace(reg)
    // 会话 id 只用 ASCII（名字用 hash）：实测 harness 对含非 ASCII 字符的 sessionId，
    // 模型请求会稳定失败（DeepSeek TRANSPORT）。书签的名字仍存注册表，id 不需可读。
    const sessionId = SessionId(`wechat-${safeKey(contactId)}-${safeKey(name)}-${randomUUID().slice(0, 4)}`)
    try {
      await this.api.createSession({ workspaceId: workspace.workspaceId, sessionId })
    } catch (error) {
      throw new Error(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const bookmark: SessionBookmark = { sessionId: String(sessionId), workspacePath: workspace.path, createdAt: Date.now() }
    reg.sessions[name] = bookmark
    reg.currentSessionName = name
    await this.store.save(contactKey, reg)
    return { sessionId: String(sessionId), workspacePath: workspace.path, name }
  }

  /** 切换书签（main 永可选；无书签时 main 走 ensureCurrent 懒创建）。 */
  async switchTo(contactKey: string, name: string): Promise<ResolvedSession> {
    const reg = await this.store.get(contactKey)
    const found = this.store.find(reg, name)
    if (!found) throw new Error(`会话「${name}」不存在（/new ${name} 新建，或 /sessions 查看列表）`)
    if (!found.bookmark) {
      // main 无书签：懒创建
      return this.createNamed(contactKey, '', DEFAULT_SESSION)
    }
    reg.currentSessionName = found.name
    await this.store.save(contactKey, reg)
    return { sessionId: found.bookmark.sessionId, workspacePath: found.bookmark.workspacePath, name: found.name }
  }

  /** 把 Web 已存在的会话绑定为当前书签（不新建）。 */
  async attach(contactKey: string, sessionId: string, workspacePath: string, name?: string): Promise<ResolvedSession> {
    const reg = await this.store.get(contactKey)
    const targetName = name && name !== DEFAULT_SESSION ? name : DEFAULT_SESSION
    reg.sessions[targetName] = { sessionId, workspacePath, createdAt: Date.now() }
    reg.currentSessionName = targetName
    await this.store.save(contactKey, reg)
    return { sessionId, workspacePath, name: targetName }
  }

  /** 删除书签（真实会话与日志保留，Web 仍可见可续）。 */
  async removeBookmark(contactKey: string, name: string): Promise<void> {
    const reg = await this.store.get(contactKey)
    const found = this.store.find(reg, name)
    if (!found) return
    delete reg.sessions[found.name]
    if (reg.currentSessionName === found.name) reg.currentSessionName = DEFAULT_SESSION
    await this.store.save(contactKey, reg)
  }

  /** 列出当前工作区的真实会话（与 Web 端一致：排除归档/空白/子代理；含标题与书签标记）。 */
  async listWorkspaceSessions(contactKey: string): Promise<WorkspaceSessionRow[]> {
    const reg = await this.store.get(contactKey)
    const workspace = await this.resolveWorkspace(reg)
    const { archivedSessionIds } = await this.api.listWorkspaces()
    const archived = new Set(archivedSessionIds.map((s) => String(s)))
    const summaries = await this.api.listSessions()
    const byId = new Map(summaries.map((s) => [String(s.sessionId), s]))
    const bookmarkBySession = new Map<string, string>()
    for (const [name, bookmark] of Object.entries(reg.sessions)) {
      bookmarkBySession.set(bookmark.sessionId, name)
    }
    const rows: WorkspaceSessionRow[] = []
    for (const sessionId of workspace.sessionIds ?? []) {
      const s = byId.get(String(sessionId))
      if (!s) continue
      // 与 Web 端一致：隐藏空白、子代理、已归档会话
      if (s.blank || s.origin === 'subagent') continue
      if (archived.has(String(sessionId))) continue
      const bookmarkName = bookmarkBySession.get(String(sessionId))
      rows.push({
        sessionId: String(s.sessionId),
        updatedAt: s.updatedAt,
        running: s.running,
        blank: s.blank,
        cwd: s.cwd,
        ...readTitleOf(s) !== undefined ? { title: readTitleOf(s) } : {},
        bookmarked: bookmarkName !== undefined,
        ...bookmarkName !== undefined ? { bookmarkName } : {},
      })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
  }

  // ------------------------------------------------------------------ agent

  /** 让会话的 agent 变为 live（宿主 resume），返回 live agent。 */
  async ensureAgentLive(sessionId: string): Promise<Agent> {
    const live = this.ctx.agents.get(SessionId(sessionId))
    if (live) return live
    try {
      await this.api.sessionModels(sessionId) // agentFor：已持久化则 resume
    } catch (error) {
      throw new Error(`会话「${sessionId}」不可用：${error instanceof Error ? error.message : String(error)}`)
    }
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (!agent) throw new Error(`会话「${sessionId}」未能激活`)
    return agent
  }
}
