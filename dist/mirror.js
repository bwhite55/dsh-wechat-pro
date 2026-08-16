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
import { clamp, log, tail } from "./util.js";
export const STREAM_LEVELS = ['minimal', 'normal', 'verbose'];
export function isStreamLevel(value) {
    return STREAM_LEVELS.includes(value);
}
/** 从 ContentBlock 列表提取可见文本。 */
function textOf(content) {
    return content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();
}
/** 工具调用参数的一行摘要（verbose 不截断）。 */
function summarizeArgs(args, full) {
    if (args === undefined || args === null)
        return '';
    const raw = JSON.stringify(args);
    if (raw.length === 0)
        return '';
    return full ? raw : clamp(raw, 120);
}
export class SessionMirror {
    ctx;
    engine;
    config;
    bindings = new Map(); // sessionId -> contactIds
    activeTurns = new Map();
    toolNames = new Map(); // callId -> toolName
    constructor(ctx, engine, config) {
        this.ctx = ctx;
        this.engine = engine;
        this.config = config;
    }
    /** 订阅 session/event（全局 emit；按绑定过滤）。 */
    start() {
        this.ctx.on('session/event', (session, event) => {
            const contacts = this.bindings.get(String(session.id));
            if (contacts === undefined || contacts.size === 0)
                return;
            void this.route(session, event).catch((e) => log(`镜像事件处理失败: ${e instanceof Error ? e.message : String(e)}`));
        });
    }
    /** 把会话绑定到一个联系人（该会话后续事件都会推给它）。 */
    bind(sessionId, contactId) {
        let set = this.bindings.get(sessionId);
        if (set === undefined) {
            set = new Set();
            this.bindings.set(sessionId, set);
        }
        set.add(contactId);
    }
    /** 解除一个联系人对当前会话的绑定。 */
    unbind(sessionId, contactId) {
        const set = this.bindings.get(sessionId);
        set?.delete(contactId);
        if (set?.size === 0)
            this.bindings.delete(sessionId);
    }
    isBound(sessionId, contactId) {
        return this.bindings.get(sessionId)?.has(contactId) ?? false;
    }
    /** 绑定到某会话的联系人列表（供审批转发等反向查找）。 */
    contactsOf(sessionId) {
        return [...(this.bindings.get(sessionId) ?? [])];
    }
    /** 等待某会话的当前轮结束（chat 处理器用；超时抛错）。 */
    awaitTurn(sessionId, timeoutMs) {
        const existing = this.activeTurns.get(sessionId);
        if (!existing)
            return Promise.resolve({});
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`处理超时（${timeoutMs} ms）`));
            }, timeoutMs);
            const done = (turn) => {
                clearTimeout(timer);
                if (turn.settleError)
                    resolve({ error: turn.settleError });
                else
                    resolve({});
            };
            // 替换 settle：原 settle 用于内部收尾，这里只接结果
            const original = existing.settle;
            existing.settle = () => {
                original();
                done(existing);
            };
        });
    }
    async route(session, event) {
        const sessionId = String(session.id);
        const contacts = [...(this.bindings.get(sessionId) ?? [])];
        switch (event.type) {
            case 'turn/start': {
                const turn = {
                    sessionId,
                    contacts: new Set(contacts),
                    wechatInitiated: false,
                    pushable: false,
                    thinkingSent: false,
                    lastAssistantText: '',
                    processCount: 0,
                    settle: () => { },
                    startedAt: Date.now(),
                };
                const prev = this.activeTurns.get(sessionId);
                if (prev)
                    prev.settle();
                this.activeTurns.set(sessionId, turn);
                break;
            }
            case 'user/message': {
                const turn = this.activeTurns.get(sessionId);
                if (!turn)
                    break;
                const source = event.data.source;
                // 微信来源：kind=user 且无 clientTimeZone（Web 浏览器必带时区；notice/插件注入是 kind=plugin）
                if (source?.kind === 'user' && source.clientTimeZone === undefined) {
                    turn.wechatInitiated = true;
                }
                if (!turn.pushable && (turn.wechatInitiated || this.config.mirrorWebTurns)) {
                    turn.pushable = true;
                    for (const to of turn.contacts) {
                        await this.engine.startTyping(to);
                        // minimal 等级只收最终答复/错误，连「开始处理」也不发
                        if (this.levelAtLeast(to, 'normal') && this.claimProcessSlot(turn)) {
                            await this.engine.sendText(to, '🧠 开始处理…');
                        }
                    }
                }
                break;
            }
            case 'request/header': {
                const turn = this.activeTurns.get(sessionId);
                if (!turn || !turn.pushable || turn.thinkingSent)
                    break;
                turn.thinkingSent = true;
                for (const to of turn.contacts) {
                    if (this.levelAtLeast(to, 'normal') && this.engine.streamAllowed(to) && this.claimProcessSlot(turn)) {
                        await this.engine.sendText(to, '🤔 思考中…');
                    }
                }
                break;
            }
            case 'tool/call': {
                const turn = this.activeTurns.get(sessionId);
                if (!turn || !turn.pushable)
                    break;
                const name = String(event.data.name ?? '?');
                this.toolNames.set(String(event.data.callId), name);
                for (const to of turn.contacts) {
                    if (!this.levelAtLeast(to, 'normal'))
                        continue;
                    const full = this.levelOf(to) === 'verbose';
                    const args = summarizeArgs(event.data.arguments, full);
                    if (this.engine.streamAllowed(to) && this.claimProcessSlot(turn)) {
                        await this.engine.sendText(to, `🔧 调用工具 ${name}${args ? `(${args})` : ''}…`);
                    }
                }
                break;
            }
            case 'tool/result': {
                const turn = this.activeTurns.get(sessionId);
                if (!turn || !turn.pushable)
                    break;
                for (const to of turn.contacts) {
                    if (!this.levelAtLeast(to, 'normal'))
                        continue;
                    const full = this.levelOf(to) === 'verbose';
                    const source = (event.data.message.source ?? {});
                    const name = source.callId !== undefined
                        ? (this.toolNames.get(String(source.callId)) ?? '?')
                        : '?';
                    const summary = clamp(textOf(event.data.message.content ?? []), full ? 2000 : 200) || '(空结果)';
                    if (this.engine.streamAllowed(to) && this.claimProcessSlot(turn)) {
                        await this.engine.sendText(to, `✅ 工具完成 ${name} → ${summary}`);
                    }
                }
                break;
            }
            case 'assistant/message': {
                const turn = this.activeTurns.get(sessionId);
                if (!turn)
                    break;
                const text = textOf(event.data.message.content ?? []);
                if (text !== '')
                    turn.lastAssistantText = text;
                break;
            }
            case 'turn/end': {
                const turn = this.activeTurns.get(sessionId);
                if (!turn)
                    break;
                this.activeTurns.delete(sessionId);
                const reason = event.data.reason;
                if (reason.kind === 'error') {
                    const message = reason.error && typeof reason.error.message === 'string'
                        ? reason.error.message
                        : String(reason.error ?? '未知错误');
                    turn.settleError = clamp(message, 500);
                }
                else if (reason.kind === 'aborted') {
                    turn.settleError = '已取消';
                }
                if (turn.pushable) {
                    for (const to of turn.contacts) {
                        await this.engine.stopTyping(to);
                        if (turn.settleError) {
                            await this.engine.sendText(to, `⚠️ ${turn.settleError}`, { retry: true });
                        }
                        else if (turn.lastAssistantText) {
                            await this.sendChunked(to, turn.lastAssistantText);
                        }
                        else {
                            await this.engine.sendText(to, '（无文本回复）', { retry: true });
                        }
                    }
                }
                turn.settle();
                break;
            }
            default:
                break;
        }
    }
    /** 联系人的有效等级（/level 覆盖优先，否则全局默认）。 */
    levelOf(contactId) {
        try {
            return this.config.levelOf(contactId);
        }
        catch {
            return this.config.streamLevel;
        }
    }
    levelAtLeast(contactId, level) {
        const order = { minimal: 0, normal: 1, verbose: 2 };
        return order[this.levelOf(contactId)] >= order[level];
    }
    /** 占用一个过程消息额度；超上限返回 false（该事件静默）。 */
    claimProcessSlot(turn) {
        if (turn.processCount >= this.config.maxProcessPerTurn)
            return false;
        turn.processCount += 1;
        return true;
    }
    /** 长文分片发送（每片失败重试一次；分片超预算降级为"首片 + 文件"，保证完整内容必达）。 */
    async sendChunked(to, text) {
        const max = Math.max(200, this.config.replyMaxChars);
        if (text.length <= max) {
            await this.engine.sendText(to, text, { retry: true });
            return;
        }
        const chunks = [];
        for (let i = 0; i < text.length; i += max) {
            chunks.push(text.slice(i, i + max));
        }
        const total = chunks.length;
        const budget = Math.max(1, this.config.maxReplyChunks);
        // 超预算：发首片 + 完整内容落盘为文件（1 条媒体，不占文本条数额度）
        if (total > budget) {
            log(`回复超长: to=${to} 总长=${text.length} 片数=${total} 预算=${budget} → 降级首片+文件`);
            await this.engine.sendText(to, chunks[0], { retry: true });
            if (this.config.sendLongAsFile) {
                try {
                    await this.config.sendLongAsFile(text, to);
                }
                catch (error) {
                    log(`超长回复落盘发送失败: ${error instanceof Error ? error.message : String(error)}`);
                    await this.engine.sendText(to, `⚠️ 回复过长（${text.length} 字符）且文件发送失败，请在 Web 端查看。`, { retry: true }).catch(() => { });
                }
            }
            else {
                await this.engine.sendText(to, `⚠️ 回复过长（${text.length} 字符），请在 Web 端查看完整内容。`, { retry: true }).catch(() => { });
            }
            return;
        }
        for (let i = 0; i < total; i++) {
            const suffix = `（${i + 1}/${total}）`;
            const chunk = chunks[i];
            await this.engine.sendText(to, i === total - 1 ? `${chunk}${suffix}` : chunk, { retry: true });
            // 分片之间留间隔，降低撞上腾讯发送额度窗口的概率
            if (i < total - 1)
                await new Promise((r) => setTimeout(r, 1000));
        }
        log(`长文分片发送: to=${to} 总长=${text.length} 片数=${total}`);
    }
}
export { tail };
//# sourceMappingURL=mirror.js.map