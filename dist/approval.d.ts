/**
 * 审批转发：把 harness 的工具审批（ctx.approval 的 approval/request waterfall）
 * 转给绑定该会话的微信联系人。微信侧回复方式：
 *   - 快捷：`/yes` 允许 / `/no` 拒绝（作用于该联系人最近一个待审批请求）；
 *   - 精确：`允许 <4位码>` / `拒绝 <4位码>`（多个待审批同时存在时按码选择）。
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
    /** 微信回复审批：`/yes`|`/no` 快捷形式，或 `允许/拒绝 <4位码>` 精确形式；返回是否消费了消息。 */
    tryResolve(contactId: string, text: string): Promise<boolean>;
    /** 结算一个审批并回执。 */
    private resolve;
    /** 该联系人是否已有待审批（用于提示精确选择）。 */
    private hasPendingFor;
    /** 该联系人最近一个待审批（Map 插入序，取最后）。 */
    private latestPendingOf;
    dispose(): void;
}
//# sourceMappingURL=approval.d.ts.map