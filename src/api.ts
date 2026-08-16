/**
 * 宿主 apiProxy 的进程内客户端：工作区/会话/模型/审批的宿主校验入口。
 * 与 Web GUI 走同一条宿主契约（dsh-host-apiproxy 的 ApiProxy 类型），
 * 所以微信侧创建的会话与 Web 完全同构。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  RpcId,
  type ApiProxy,
  type ModelSelection,
  type RpcRequest,
  type RpcResponse,
  type SessionModels,
  type SessionSummary,
  type WorkspaceId,
  type WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionId } from '@deepseek-ai/dsh-session'
// 拉入 dsh-host-apiproxy 对 @deepseek-ai/cordis 的 Context 声明合并（ctx.apiProxy）。
import type {} from '@deepseek-ai/dsh-host-apiproxy'

export class ApiError extends Error {
  readonly code: string
  readonly details: unknown
  constructor(code: string, message: string, details: unknown = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
  }
}

export interface WorkspaceRef {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

export interface SessionRef {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  origin?: string
}

/** 会话创建入参。 */
export interface CreateSessionInput {
  workspaceId?: string
  cwd?: string
  sessionId?: SessionId
}

/**
 * 包一层宿主 apiProxy。所有 RPC 走 `{ rpcId, payload }` 信封，
 * 结果 `{ ok: true, value } | { ok: false, error }`，失败抛 ApiError。
 */
export class HarnessApi {
  private constructor(private readonly proxy: ApiProxy) {}

  static resolve(ctx: Context): HarnessApi | undefined {
    // inject 已声明 apiProxy；此处仍保留防御（测试/诊断上下文可能缺失）。
    const proxy = ctx.apiProxy as ApiProxy | undefined
    return proxy === undefined ? undefined : new HarnessApi(proxy)
  }

  private async call<Req, Res>(fn: (req: RpcRequest<Req>) => Promise<RpcResponse<Res>>, payload: Req): Promise<Res> {
    const resp = await fn({ rpcId: RpcId(randomUUID()), payload })
    if (resp.result.ok) return resp.result.value
    const error = resp.result.error
    throw new ApiError(error.code, error.message, error.details)
  }

  // ------------------------------------------------------------------ 工作区

  async listWorkspaces(): Promise<{ items: WorkspaceView[]; archivedSessionIds: string[] }> {
    const value = await this.call((req) => this.proxy.workspace.list(req), {})
    return { items: value.items, archivedSessionIds: value.archivedSessionIds }
  }

  async createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    return this.call((req) => this.proxy.workspace.create(req), { path })
  }

  // ------------------------------------------------------------------ 会话

  async listSessions(): Promise<SessionSummary[]> {
    const value = await this.call((req) => this.proxy.sessions.list(req), {})
    return value.items
  }

  async createSession(input: CreateSessionInput): Promise<{ sessionId: string; agentPreset?: string }> {
    const value = await this.call(
      (req) => this.proxy.sessions.create(req),
      {
        ...input.workspaceId !== undefined ? { workspaceId: input.workspaceId as WorkspaceId } : {},
        ...input.cwd !== undefined ? { cwd: input.cwd } : {},
        ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
      },
    )
    return { sessionId: String(value.sessionId), ...value.agentPreset !== undefined ? { agentPreset: value.agentPreset } : {} }
  }

  async sessionModels(sessionId: string): Promise<SessionModels> {
    return this.call((req) => this.proxy.sessions.models(req), { sessionId: sessionId as SessionId })
  }

  async selectModel(sessionId: string, selection: { provider: string; model: string; reasoningEffort?: string }): Promise<ModelSelection> {
    const value = await this.call(
      (req) => this.proxy.sessions.selectModel(req),
      {
        sessionId: sessionId as SessionId,
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort !== undefined && selection.reasoningEffort !== ''
          ? { reasoningEffort: selection.reasoningEffort }
          : {},
      },
    )
    return value.selected
  }

  /** 入队一条用户消息并唤醒 agent（宿主负责 resume/create 与 admission）。 */
  async prompt(sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    await this.call(
      (req) => this.proxy.sessions.prompt(req),
      {
        sessionId: sessionId as SessionId,
        mode,
        content: [{ type: 'text' as const, text }],
      },
    )
  }

  async cancel(sessionId: string): Promise<void> {
    await this.call((req) => this.proxy.sessions.cancel(req), { sessionId: sessionId as SessionId })
  }
}
