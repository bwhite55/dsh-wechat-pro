/**
 * 审批转发：把 harness 的工具审批（ctx.approval 的 approval/request waterfall）
 * 转给绑定该会话的微信联系人，等待「允许 <token> / 拒绝 <token>」回复。
 * 无绑定联系人时调用 next() 让位给 Web 审批通道（两者共存）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { EngineSurface } from './channel/engine.ts';
import type { SessionMirror } from './mirror.ts';
export declare class ApprovalForwarder {
    private readonly ctx;
    private readonly engine;
    private readonly mirror;
    private readonly pendings;
    constructor(ctx: Context, engine: EngineSurface, mirror: SessionMirror);
    /** 注册 approval/request 应答器（prepend 先于宿主 apiproxy；绑定会话优先走微信）。 */
    start(): void;
    /** 微信收到「允许/拒绝 <token>」时调用；返回是否消费了消息。 */
    tryResolve(contactId: string, text: string): Promise<boolean>;
    dispose(): void;
}
//# sourceMappingURL=approval.d.ts.map