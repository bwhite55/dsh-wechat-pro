/**
 * iLink（微信 ClawBot）协议客户端 —— 依据腾讯官方 @tencent-weixin/openclaw-weixin@2.4.6
 * 实现，移植自 dsh-wechat-bridge（MIT，已在本机实测跑通）。纯 HTTP/JSON，零依赖。
 *
 * 端点约定（与官方 SDK 一致）：
 *   - 请求头: Content-Type / AuthorizationType: ilink_bot_token / X-WECHAT-UIN(随机)
 *             / iLink-App-Id / iLink-App-ClientVersion / Authorization: Bearer <token>
 *   - base_info: { channel_version, bot_agent }
 *   - getupdates 长轮询 35s，客户端超时视为空响应
 *   - errcode/ret === -14 表示 token 过期（stale）
 */
export declare const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const DEFAULT_BOT_TYPE = "3";
export declare const DEFAULT_APP_ID = "bot";
export declare const STALE_TOKEN_ERRCODE = -14;
export declare const LONG_POLL_TIMEOUT_MS = 35000;
export declare const API_TIMEOUT_MS = 15000;
export declare const LIGHT_TIMEOUT_MS = 10000;
/** "2.4.6" -> 132102（major<<16 | minor<<8 | patch）。 */
export declare function buildClientVersion(version: string): number;
export declare class IlinkError extends Error {
    readonly kind: 'api' | 'http' | 'transport';
    readonly ret?: number;
    readonly errcode?: number;
    readonly status?: number;
    constructor(message: string, opts?: {
        kind?: 'api' | 'http' | 'transport';
        ret?: number;
        errcode?: number;
        status?: number;
    });
}
export interface IlinkClientOptions {
    baseUrl?: string;
    token?: string | null;
    channelVersion?: string;
    botAgent?: string;
    appId?: string;
    log?: (msg: string) => void;
}
export interface QrcodeResult {
    qrcode: string;
    qrcodeImgContent: string;
}
export interface QrcodeStatus {
    status: string;
    botToken?: string;
    botId?: string;
    baseUrl?: string;
    userId?: string;
    redirectHost?: string;
}
export interface UpdatesResult {
    ret: number;
    errcode?: number;
    errmsg?: string;
    msgs: Array<Record<string, unknown>>;
    get_updates_buf: string;
    longpolling_timeout_ms?: number;
}
export interface InboundMessage {
    from_user_id?: string;
    to_user_id?: string;
    message_type?: number;
    context_token?: string;
    item_list?: Array<Record<string, unknown>>;
    [key: string]: unknown;
}
export interface SendItemsOptions {
    to: string;
    itemList: Array<Record<string, unknown>>;
    contextToken?: string;
    clientId?: string;
}
export interface SendTextOptions {
    to: string;
    text: string;
    contextToken?: string;
    clientId?: string;
}
export interface UploadUrlParams {
    filekey: string;
    mediaType: number;
    toUserId: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskeyHex: string;
    noNeedThumb?: boolean;
}
export interface IlinkClient {
    readonly config: {
        baseUrl: string;
        token: string | null;
        channelVersion: string;
        botAgent: string;
    };
    setToken(token: string | null): void;
    setBaseUrl(url: string): void;
    getBotQrcode(botType?: string): Promise<QrcodeResult>;
    pollQrcodeStatus(qrcode: string, verifyCode?: string): Promise<QrcodeStatus>;
    getUpdates(buf?: string, timeoutMs?: number, signal?: AbortSignal): Promise<UpdatesResult>;
    getConfig(ilinkUserId: string, contextToken?: string): Promise<{
        typingTicket: string;
    }>;
    sendTyping(ilinkUserId: string, typingTicket: string, status: number): Promise<void>;
    sendMessageItems(options: SendItemsOptions): Promise<{
        clientId: string;
    }>;
    sendMessage(options: SendTextOptions): Promise<{
        clientId: string;
    }>;
    getUploadUrl(params: UploadUrlParams): Promise<{
        uploadFullUrl: string;
        uploadParam: string;
    }>;
    notifyStart(): Promise<void>;
    notifyStop(): Promise<void>;
}
export declare function createIlinkClient(opts?: IlinkClientOptions): IlinkClient;
/**
 * 从消息的 item_list 提取文本（与官方 SDK inbound 逻辑一致）：
 * 优先第一个 TEXT item（含引用拼接）；其次 VOICE item 的转写文本。
 */
export declare function extractText(msg: InboundMessage | Record<string, unknown> | undefined): string;
/** 消息里是否含媒体（图片/视频/文件/语音）。 */
export declare function hasMedia(msg: InboundMessage | Record<string, unknown> | undefined): boolean;
//# sourceMappingURL=ilink.d.ts.map