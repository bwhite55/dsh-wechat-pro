/**
 * 宿主 apiProxy 的进程内客户端：工作区/会话/模型/审批的宿主校验入口。
 * 与 Web GUI 走同一条宿主契约（dsh-host-apiproxy 的 ApiProxy 类型），
 * 所以微信侧创建的会话与 Web 完全同构。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ModelSelection, type SessionModels, type SessionSummary, type WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy';
import type { SessionId } from '@deepseek-ai/dsh-session';
export declare class ApiError extends Error {
    readonly code: string;
    readonly details: unknown;
    constructor(code: string, message: string, details?: unknown);
}
export interface WorkspaceRef {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
}
export interface SessionRef {
    sessionId: string;
    updatedAt: number;
    running: boolean;
    blank: boolean;
    cwd?: string;
    origin?: string;
}
/** 会话创建入参。 */
export interface CreateSessionInput {
    workspaceId?: string;
    cwd?: string;
    sessionId?: SessionId;
}
/**
 * 包一层宿主 apiProxy。所有 RPC 走 `{ rpcId, payload }` 信封，
 * 结果 `{ ok: true, value } | { ok: false, error }`，失败抛 ApiError。
 */
export declare class HarnessApi {
    private readonly proxy;
    private constructor();
    static resolve(ctx: Context): HarnessApi | undefined;
    private call;
    listWorkspaces(): Promise<{
        items: WorkspaceView[];
        archivedSessionIds: string[];
    }>;
    createWorkspace(path: string): Promise<{
        workspace: WorkspaceView;
        created: boolean;
    }>;
    listSessions(): Promise<SessionSummary[]>;
    createSession(input: CreateSessionInput): Promise<{
        sessionId: string;
        agentPreset?: string;
    }>;
    sessionModels(sessionId: string): Promise<SessionModels>;
    selectModel(sessionId: string, selection: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    }): Promise<ModelSelection>;
    /** 入队一条用户消息并唤醒 agent（宿主负责 resume/create 与 admission）。 */
    prompt(sessionId: string, text: string, mode?: 'queue' | 'steer'): Promise<void>;
    cancel(sessionId: string): Promise<void>;
}
//# sourceMappingURL=api.d.ts.map