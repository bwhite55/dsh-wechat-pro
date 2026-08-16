/**
 * 审批转发：把 harness 的工具审批（ctx.approval 的 approval/request waterfall）
 * 转给绑定该会话的微信联系人。微信侧回复方式：
 *   - 快捷：`/yes` 允许 / `/no` 拒绝（作用于该联系人最近一个待审批请求）；
 *   - 精确：`允许 <4位码>` / `拒绝 <4位码>`（多个待审批同时存在时按码选择）。
 * 无绑定联系人时调用 next() 让位给 Web 审批通道（两者共存）。
 */
import { randomUUID } from 'node:crypto';
import { clamp, log, mask } from "./util.js";
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
export class ApprovalForwarder {
    ctx;
    engine;
    mirror;
    pendings = new Map();
    constructor(ctx, engine, mirror) {
        this.ctx = ctx;
        this.engine = engine;
        this.mirror = mirror;
    }
    /** 注册 approval/request 应答器（prepend 先于宿主 apiproxy；绑定会话优先走微信）。 */
    start() {
        this.ctx.on('approval/request', (request, next) => {
            const sessionId = String(request.agent.session.id);
            const contacts = this.mirror.contactsOf(sessionId);
            if (contacts.length === 0 || request.signal?.aborted) {
                // 无绑定联系人：让位给 Web 审批通道（宿主 apiproxy）
                return next();
            }
            const contactId = contacts[0];
            const token = randomUUID().slice(0, 4);
            const multiple = this.hasPendingFor(contactId);
            const prompt = `🔐 需要审批：工具「${request.toolName}」${request.reason ? `\n原因：${clamp(request.reason, 300)}` : ''}\n回复「/yes」允许 或「/no」拒绝${multiple ? `\n（多个待审批时：允许 ${token} 精确选择）` : ''}`;
            void this.engine.sendText(contactId, prompt, { retry: true }).catch((e) => log(`审批提示发送失败: ${e instanceof Error ? e.message : String(e)}`));
            log(`审批转发: user=${mask(contactId)} tool=${request.toolName} token=${token}`);
            return new Promise((resolve) => {
                const settle = (outcome) => {
                    if (!this.pendings.delete(token))
                        return;
                    request.signal?.removeEventListener('abort', onAbort);
                    clearTimeout(pending.timer);
                    resolve(outcome);
                };
                const onAbort = () => settle('cancelled');
                const pending = {
                    token,
                    contactId,
                    toolName: request.toolName,
                    ...request.reason !== undefined ? { reason: request.reason } : {},
                    settle,
                    timer: setTimeout(() => {
                        void this.engine.sendText(contactId, `⏱ 审批「${request.toolName}」超时未回复，已按失败处理（可用 /cancel 取消当前回合）`).catch(() => { });
                        settle('unavailable');
                    }, APPROVAL_TIMEOUT_MS),
                };
                this.pendings.set(token, pending);
                request.signal?.addEventListener('abort', onAbort, { once: true });
            });
        }, { prepend: true });
    }
    /** 微信回复审批：`/yes`|`/no` 快捷形式，或 `允许/拒绝 <4位码>` 精确形式；返回是否消费了消息。 */
    async tryResolve(contactId, text) {
        const trimmed = text.trim();
        // 精确形式：允许/拒绝 <token>
        const exact = /^(允许|拒绝|allow|reject|同意|不同意)\s*([a-z0-9]{4})$/i.exec(trimmed);
        if (exact) {
            const token = exact[2].toLowerCase();
            const pending = this.pendings.get(token);
            if (pending && pending.contactId === contactId) {
                const allowed = /^(允许|allow|同意)$/i.test(exact[1]);
                this.resolve(pending, contactId, allowed);
                return true;
            }
            return false;
        }
        // 快捷形式：/yes /no yes no（作用于该联系人最近一个待审批）
        const quick = /^\/?(yes|no|y|n)$/i.exec(trimmed);
        if (quick) {
            const pending = this.latestPendingOf(contactId);
            if (!pending)
                return false;
            const allowed = /^(yes|y)$/i.test(quick[1]);
            this.resolve(pending, contactId, allowed);
            return true;
        }
        return false;
    }
    /** 结算一个审批并回执。 */
    resolve(pending, contactId, allowed) {
        pending.settle(allowed ? 'allowed-once' : 'rejected');
        void this.engine.sendText(contactId, allowed ? `✅ 已允许「${pending.toolName}」` : `⛔ 已拒绝「${pending.toolName}」`, { retry: true }).catch(() => { });
        log(`审批应答: user=${mask(contactId)} tool=${pending.toolName} ${allowed ? '允许' : '拒绝'}`);
    }
    /** 该联系人是否已有待审批（用于提示精确选择）。 */
    hasPendingFor(contactId) {
        for (const p of this.pendings.values()) {
            if (p.contactId === contactId)
                return true;
        }
        return false;
    }
    /** 该联系人最近一个待审批（Map 插入序，取最后）。 */
    latestPendingOf(contactId) {
        let latest;
        for (const p of this.pendings.values()) {
            if (p.contactId === contactId)
                latest = p;
        }
        return latest;
    }
    dispose() {
        for (const pending of this.pendings.values()) {
            clearTimeout(pending.timer);
            pending.settle('cancelled');
        }
        this.pendings.clear();
    }
}
//# sourceMappingURL=approval.js.map