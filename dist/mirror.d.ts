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
import type { Context } from '@deepseek-ai/cordis';
import type { EngineSurface } from './channel/engine.ts';
import { tail } from './util.ts';
/** 输出等级。 */
export type StreamLevel = 'minimal' | 'normal' | 'verbose';
export declare const STREAM_LEVELS: readonly StreamLevel[];
export declare function isStreamLevel(value: string): value is StreamLevel;
export interface MirrorConfig {
    replyMaxChars: number;
    /** 全局默认输出等级；联系人可经 /level 覆盖（levelOf 优先）。 */
    streamLevel: StreamLevel;
    /** Web 发起的回合是否也推送到微信（默认 false：只推微信发起的回合）。 */
    mirrorWebTurns: boolean;
    /** 按联系人解析有效等级（未覆盖时回落全局默认）。 */
    levelOf: (contactId: string) => StreamLevel;
    /** 每回合过程消息上限（🧠/🤔/🔧/✅ 合计；防刷屏与微信限流；最终答复与错误不受限）。 */
    maxProcessPerTurn: number;
    /** 最终答复分片预算（腾讯对单条入站消息的回复发送有额度限制，超过预算降级为"首片+文件"）。 */
    maxReplyChunks: number;
    /** 超预算时把完整回复落盘为文件发给用户（绕过文本长度与条数额度）。 */
    sendLongAsFile?: (text: string, to: string) => Promise<void>;
}
export declare class SessionMirror {
    private readonly ctx;
    private readonly engine;
    private readonly config;
    private readonly bindings;
    private readonly activeTurns;
    private readonly toolNames;
    constructor(ctx: Context, engine: EngineSurface, config: MirrorConfig);
    /** 订阅 session/event（全局 emit；按绑定过滤）。 */
    start(): void;
    /** 把会话绑定到一个联系人（该会话后续事件都会推给它）。 */
    bind(sessionId: string, contactId: string): void;
    /** 解除一个联系人对当前会话的绑定。 */
    unbind(sessionId: string, contactId: string): void;
    isBound(sessionId: string, contactId: string): boolean;
    /** 绑定到某会话的联系人列表（供审批转发等反向查找）。 */
    contactsOf(sessionId: string): string[];
    /** 等待某会话的当前轮结束（chat 处理器用；超时抛错）。 */
    awaitTurn(sessionId: string, timeoutMs: number): Promise<{
        error?: string;
    }>;
    private route;
    /** 联系人的有效等级（/level 覆盖优先，否则全局默认）。 */
    private levelOf;
    private levelAtLeast;
    /** 占用一个过程消息额度；超上限返回 false（该事件静默）。 */
    private claimProcessSlot;
    /** 长文分片发送（每片失败重试一次；分片超预算降级为"首片 + 文件"，保证完整内容必达）。 */
    private sendChunked;
}
export { tail };
//# sourceMappingURL=mirror.d.ts.map