/**
 * 宿主 apiProxy 的进程内客户端：工作区/会话/模型/审批的宿主校验入口。
 * 与 Web GUI 走同一条宿主契约（dsh-host-apiproxy 的 ApiProxy 类型），
 * 所以微信侧创建的会话与 Web 完全同构。
 */
import { randomUUID } from 'node:crypto';
import { RpcId, } from '@deepseek-ai/dsh-host-apiproxy';
export class ApiError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.details = details;
    }
}
/**
 * 包一层宿主 apiProxy。所有 RPC 走 `{ rpcId, payload }` 信封，
 * 结果 `{ ok: true, value } | { ok: false, error }`，失败抛 ApiError。
 */
export class HarnessApi {
    proxy;
    constructor(proxy) {
        this.proxy = proxy;
    }
    static resolve(ctx) {
        // inject 已声明 apiProxy；此处仍保留防御（测试/诊断上下文可能缺失）。
        const proxy = ctx.apiProxy;
        return proxy === undefined ? undefined : new HarnessApi(proxy);
    }
    async call(fn, payload) {
        const resp = await fn({ rpcId: RpcId(randomUUID()), payload });
        if (resp.result.ok)
            return resp.result.value;
        const error = resp.result.error;
        throw new ApiError(error.code, error.message, error.details);
    }
    // ------------------------------------------------------------------ 工作区
    async listWorkspaces() {
        const value = await this.call((req) => this.proxy.workspace.list(req), {});
        return { items: value.items, archivedSessionIds: value.archivedSessionIds };
    }
    async createWorkspace(path) {
        return this.call((req) => this.proxy.workspace.create(req), { path });
    }
    // ------------------------------------------------------------------ 会话
    async listSessions() {
        const value = await this.call((req) => this.proxy.sessions.list(req), {});
        return value.items;
    }
    async createSession(input) {
        const value = await this.call((req) => this.proxy.sessions.create(req), {
            ...input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {},
            ...input.cwd !== undefined ? { cwd: input.cwd } : {},
            ...input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
        });
        return { sessionId: String(value.sessionId), ...value.agentPreset !== undefined ? { agentPreset: value.agentPreset } : {} };
    }
    async sessionModels(sessionId) {
        return this.call((req) => this.proxy.sessions.models(req), { sessionId: sessionId });
    }
    async selectModel(sessionId, selection) {
        const value = await this.call((req) => this.proxy.sessions.selectModel(req), {
            sessionId: sessionId,
            provider: selection.provider,
            model: selection.model,
            ...selection.reasoningEffort !== undefined && selection.reasoningEffort !== ''
                ? { reasoningEffort: selection.reasoningEffort }
                : {},
        });
        return value.selected;
    }
    /** 入队一条用户消息并唤醒 agent（宿主负责 resume/create 与 admission）。 */
    async prompt(sessionId, text, mode = 'queue') {
        await this.call((req) => this.proxy.sessions.prompt(req), {
            sessionId: sessionId,
            mode,
            content: [{ type: 'text', text }],
        });
    }
    async cancel(sessionId) {
        await this.call((req) => this.proxy.sessions.cancel(req), { sessionId: sessionId });
    }
}
//# sourceMappingURL=api.js.map