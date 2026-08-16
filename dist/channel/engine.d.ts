/**
 * WechatEngine —— 微信 ClawBot 通道状态机（进程内）。
 * 扫码登录（QR 打印到 dsh web 终端）→ 长轮询收消息 → 回调给 Dispatcher；
 * 提供 typing、发送（带每联系人串行队列，供流式过程消息用）、媒体、续连。
 * 移植自 dsh-wechat-bridge 的 weixin-bot.mjs（MIT，已实测跑通）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type InboundMessage } from './ilink.ts';
export interface EngineConfig {
    baseUrl: string;
    channelVersion: string;
    botAgent: string;
    dataDir: string;
    sessionMs: number;
    reloginBeforeMs: number;
    qrTimeoutMs: number;
    noTyping: boolean;
    maxStreamIntervalMs: number;
}
export interface AuthRecord {
    token: string;
    baseUrl: string;
    botId?: string;
    userId?: string;
    channelVersion: string;
    loggedInAt: number;
}
export type EngineState = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface StatusPayload {
    state: EngineState;
    loggedIn: boolean;
    botId?: string;
    remainingHours?: number;
    error?: string;
    /** 最近一次登录/续连二维码链接（手机微信打开即可扫码；登录成功后清空）。 */
    qrLink?: string;
}
export interface OutboundMessage {
    to: string;
    text: string;
    contextToken?: string;
    clientId?: string;
}
/** 引擎对外暴露给 Dispatcher 的发送面。 */
export interface EngineSurface {
    sendText(to: string, text: string, opts?: {
        contextToken?: string;
        clientId?: string;
        retry?: boolean;
    }): Promise<void>;
    sendItems(to: string, itemList: Array<Record<string, unknown>>, opts?: {
        contextToken?: string;
        clientId?: string;
        retry?: boolean;
    }): Promise<void>;
    sendMediaFile(filePath: string, to: string, opts?: {
        caption?: string;
        contextToken?: string;
    }): Promise<void>;
    getTypingTicket(to: string, ctxToken?: string): Promise<string>;
    sendTypingStatus(to: string, ticket: string, status: number): Promise<void>;
    startTyping(to: string, ctxToken?: string): Promise<void>;
    stopTyping(to: string, ctxToken?: string): Promise<void>;
    reconnect(): void;
    status(): StatusPayload;
    contextTokenOf(to: string): string | undefined;
    getLastSender(): string | null;
    streamAllowed(to: string): boolean;
}
export declare class WechatEngine {
    private readonly ctx;
    private readonly config;
    private readonly onMessage;
    private client;
    private auth;
    private state;
    private abort;
    private polling;
    private syncBuf;
    private contextTokens;
    private typingTickets;
    private lastSender;
    private reloginRequested;
    private expiryWarned;
    private lastError;
    private pendingQr;
    private sendChains;
    private lastStreamAt;
    readonly authFile: string;
    readonly syncBufFile: string;
    constructor(ctx: Context, config: EngineConfig, onMessage: (msg: InboundMessage) => Promise<void>);
    private loadAuth;
    private saveAuth;
    private loadSyncBuf;
    private saveSyncBuf;
    status(): StatusPayload;
    contextTokenOf(to: string): string | undefined;
    getLastSender(): string | null;
    /** 已有凭证且未强制时直接复用；否则走扫码。 */
    connect(force?: boolean): Promise<void>;
    /** 扫码登录流程（与官方 SDK login-qr.ts 一致：配对码/二维码刷新/节点跳转）。 */
    private doLogin;
    startPolling(): Promise<void>;
    disconnect(): Promise<void>;
    /** 清除本地凭证。 */
    logout(): Promise<void>;
    private runPoll;
    private doRelogin;
    /** 每联系人串行发送队列（保证流式过程消息与最终答复不乱序）。 */
    private enqueueSend;
    /** 节流：同一联系人的流式过程消息至少间隔 maxStreamIntervalMs。返回是否放行。 */
    streamAllowed(to: string): boolean;
    resetStreamThrottle(to: string): void;
    /** 发送失败落盘（隐藏窗口/无终端时唯一可查的痕迹）。 */
    private logSendFailure;
    /** 发送文本；retry=true 时失败重试一次（最终答复/审批等重要消息）。失败一律落盘日志。 */
    sendText(to: string, text: string, opts?: {
        contextToken?: string;
        clientId?: string;
        retry?: boolean;
    }): Promise<void>;
    sendItems(to: string, itemList: Array<Record<string, unknown>>, opts?: {
        contextToken?: string;
        clientId?: string;
        retry?: boolean;
    }): Promise<void>;
    sendMediaFile(filePath: string, to: string, opts?: {
        caption?: string;
        contextToken?: string;
    }): Promise<void>;
    getTypingTicket(to: string, ctxToken?: string): Promise<string>;
    sendTypingStatus(to: string, ticket: string, status: number): Promise<void>;
    startTyping(to: string, ctxToken?: string): Promise<void>;
    stopTyping(to: string, ctxToken?: string): Promise<void>;
    reconnect(): void;
    dispose(): void;
}
/** 供 index.ts 构建引擎配置。 */
export declare function buildEngineConfig(values?: Partial<EngineConfig>): EngineConfig;
//# sourceMappingURL=engine.d.ts.map