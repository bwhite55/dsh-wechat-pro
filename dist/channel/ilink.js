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
import crypto from 'node:crypto';
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_BOT_TYPE = '3';
export const DEFAULT_APP_ID = 'bot';
export const STALE_TOKEN_ERRCODE = -14;
export const LONG_POLL_TIMEOUT_MS = 35_000;
export const API_TIMEOUT_MS = 15_000;
export const LIGHT_TIMEOUT_MS = 10_000;
/** "2.4.6" -> 132102（major<<16 | minor<<8 | patch）。 */
export function buildClientVersion(version) {
    const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((p) => parseInt(p, 10) || 0);
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
function randomWechatUin() {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), 'utf-8').toString('base64');
}
function ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : `${url}/`;
}
export class IlinkError extends Error {
    kind;
    ret;
    errcode;
    status;
    constructor(message, opts = {}) {
        super(message);
        this.name = 'IlinkError';
        this.kind = opts.kind ?? 'api';
        this.ret = opts.ret;
        this.errcode = opts.errcode;
        this.status = opts.status;
    }
}
export function createIlinkClient(opts = {}) {
    const cfg = {
        baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
        token: opts.token ?? null,
        channelVersion: opts.channelVersion ?? '2.4.6',
        botAgent: opts.botAgent ?? 'dsh-wechat-pro',
        appId: opts.appId ?? DEFAULT_APP_ID,
        log: opts.log ?? (() => { }),
    };
    function baseInfo() {
        return { channel_version: cfg.channelVersion, bot_agent: cfg.botAgent };
    }
    function headers(withToken = true) {
        const h = {
            'Content-Type': 'application/json',
            AuthorizationType: 'ilink_bot_token',
            'X-WECHAT-UIN': randomWechatUin(),
            'iLink-App-Id': cfg.appId,
            'iLink-App-ClientVersion': String(buildClientVersion(cfg.channelVersion)),
        };
        if (withToken && cfg.token?.trim())
            h.Authorization = `Bearer ${cfg.token.trim()}`;
        return h;
    }
    async function fetchWithTimeout(url, init, timeoutMs, label, signal) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const onExternalAbort = () => controller.abort();
        signal?.addEventListener('abort', onExternalAbort, { once: true });
        try {
            const res = await fetch(url, { ...init, signal: controller.signal });
            const rawText = await res.text();
            cfg.log(`[ilink] ${label} HTTP ${res.status} ${rawText.length} bytes`);
            if (!res.ok) {
                throw new IlinkError(`${label} HTTP ${res.status}: ${rawText.slice(0, 200)}`, {
                    kind: 'http',
                    status: res.status,
                });
            }
            try {
                return JSON.parse(rawText);
            }
            catch {
                return { ret: 0, raw: rawText };
            }
        }
        finally {
            clearTimeout(t);
            signal?.removeEventListener('abort', onExternalAbort);
        }
    }
    function apiGet(endpoint, opts = {}) {
        const url = new URL(endpoint, ensureTrailingSlash(cfg.baseUrl)).toString();
        return fetchWithTimeout(url, { method: 'GET', headers: headers(opts.withToken ?? false) }, opts.timeoutMs ?? LIGHT_TIMEOUT_MS, opts.label ?? 'GET');
    }
    function apiPost(endpoint, body, opts = {}, signal) {
        const url = new URL(endpoint, ensureTrailingSlash(cfg.baseUrl)).toString();
        return fetchWithTimeout(url, { method: 'POST', headers: headers(opts.withToken ?? true), body: JSON.stringify(body ?? {}) }, opts.timeoutMs ?? API_TIMEOUT_MS, opts.label ?? 'POST', signal);
    }
    return {
        get config() {
            return { ...cfg };
        },
        setToken(token) {
            cfg.token = token ?? null;
        },
        setBaseUrl(url) {
            cfg.baseUrl = url;
        },
        /** 获取登录二维码（2.x 风格：POST + local_token_list）。 */
        async getBotQrcode(botType = DEFAULT_BOT_TYPE) {
            const resp = await apiPost(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, { local_token_list: [] }, { label: 'getBotQrcode' });
            const qrcode = String(pick(resp, 'qrcode') ?? '');
            const qrcodeImgContent = String(pick(resp, 'qrcode_img_content') ?? '');
            if (!qrcode)
                throw new Error('获取二维码失败：响应中缺少 qrcode');
            return { qrcode, qrcodeImgContent };
        },
        /** 轮询扫码状态（长轮询）。网络错误/客户端超时视为 wait。 */
        async pollQrcodeStatus(qrcode, verifyCode) {
            let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
            if (verifyCode)
                endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
            try {
                const resp = await apiGet(endpoint, { timeoutMs: LONG_POLL_TIMEOUT_MS, label: 'pollQrcodeStatus' });
                return {
                    status: String(pick(resp, 'status') ?? 'wait'),
                    botToken: opt(resp, 'bot_token'),
                    botId: opt(resp, 'ilink_bot_id'),
                    baseUrl: opt(resp, 'baseurl'),
                    userId: opt(resp, 'ilink_user_id'),
                    redirectHost: opt(resp, 'redirect_host'),
                };
            }
            catch (err) {
                if (isAbort(err) || err instanceof IlinkError)
                    return { status: 'wait' };
                cfg.log(`[ilink] pollQrcodeStatus error: ${String(err)}，按 wait 继续`);
                return { status: 'wait' };
            }
        },
        /** 长轮询收消息；客户端超时返回空。signal 用于外部取消。 */
        async getUpdates(buf = '', timeoutMs = LONG_POLL_TIMEOUT_MS, signal) {
            try {
                const resp = await apiPost('ilink/bot/getupdates', { get_updates_buf: buf, base_info: baseInfo() }, { timeoutMs, label: 'getUpdates' }, signal);
                return {
                    ret: num(resp.ret ?? resp.errcode ?? 0),
                    errcode: numOpt(resp.errcode),
                    errmsg: opt(resp, 'errmsg'),
                    msgs: Array.isArray(resp.msgs) ? resp.msgs : [],
                    get_updates_buf: typeof resp.get_updates_buf === 'string' ? resp.get_updates_buf : buf,
                    longpolling_timeout_ms: numOpt(resp.longpolling_timeout_ms),
                };
            }
            catch (err) {
                if (isAbort(err))
                    return { ret: 0, msgs: [], get_updates_buf: buf };
                throw err;
            }
        },
        /** 获取某用户的 typing_ticket。 */
        async getConfig(ilinkUserId, contextToken) {
            const resp = await apiPost('ilink/bot/getconfig', { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: baseInfo() }, { timeoutMs: LIGHT_TIMEOUT_MS, label: 'getConfig' });
            return { typingTicket: String(pick(resp, 'typing_ticket') ?? '') };
        },
        /** 发送"正在输入"状态：status 1=开始 2=结束。 */
        async sendTyping(ilinkUserId, typingTicket, status) {
            await apiPost('ilink/bot/sendtyping', { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: baseInfo() }, { timeoutMs: LIGHT_TIMEOUT_MS, label: `sendTyping(${status})` });
        },
        /** 发送任意 item_list（文本/图片/文件/视频消息通用入口）。 */
        async sendMessageItems({ to, itemList, contextToken, clientId }) {
            const id = clientId ?? `dsh-wechat-pro-${crypto.randomBytes(6).toString('hex')}`;
            const resp = await apiPost('ilink/bot/sendmessage', {
                msg: {
                    from_user_id: '',
                    to_user_id: to,
                    client_id: id,
                    message_type: 2, // BOT
                    message_state: 2, // FINISH
                    context_token: contextToken ?? undefined,
                    item_list: itemList ?? [],
                },
                base_info: baseInfo(),
            }, { timeoutMs: API_TIMEOUT_MS, label: 'sendMessageItems' });
            const ret = num(resp.ret ?? 0);
            if (ret !== 0) {
                throw new IlinkError(`sendMessage ret=${ret} errmsg=${String(pick(resp, 'errmsg') ?? '')}`, {
                    kind: 'api',
                    ret,
                    errcode: numOpt(resp.errcode),
                });
            }
            return { clientId: id };
        },
        /** 发送文本消息（sendMessageItems 的便捷封装）。 */
        async sendMessage({ to, text, contextToken, clientId }) {
            return this.sendMessageItems({
                to,
                contextToken,
                clientId,
                itemList: [{ type: 1, text_item: { text } }],
            });
        },
        /** 获取 CDN 预签名上传地址（媒体发送第一步）。 */
        async getUploadUrl({ filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskeyHex, noNeedThumb = true }) {
            const resp = await apiPost('ilink/bot/getuploadurl', {
                filekey,
                media_type: mediaType,
                to_user_id: toUserId,
                rawsize,
                rawfilemd5,
                filesize,
                no_need_thumb: noNeedThumb,
                aeskey: aeskeyHex,
                base_info: baseInfo(),
            }, { timeoutMs: API_TIMEOUT_MS, label: 'getUploadUrl' });
            const ret = num(resp.ret ?? 0);
            if (ret !== 0) {
                throw new IlinkError(`getUploadUrl ret=${ret} errmsg=${String(pick(resp, 'errmsg') ?? '')}`, {
                    kind: 'api',
                    ret,
                    errcode: numOpt(resp.errcode),
                });
            }
            return { uploadFullUrl: String(pick(resp, 'upload_full_url') ?? ''), uploadParam: String(pick(resp, 'upload_param') ?? '') };
        },
        /** 通知服务器客户端启动/停止（尽力而为）。 */
        async notifyStart() {
            try {
                await apiPost('ilink/bot/msg/notifystart', { base_info: baseInfo() }, { timeoutMs: LIGHT_TIMEOUT_MS, label: 'notifyStart' });
            }
            catch (e) {
                cfg.log(`[ilink] notifyStart 失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
            }
        },
        async notifyStop() {
            try {
                await apiPost('ilink/bot/msg/notifystop', { base_info: baseInfo() }, { timeoutMs: LIGHT_TIMEOUT_MS, label: 'notifyStop' });
            }
            catch (e) {
                cfg.log(`[ilink] notifyStop 失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
            }
        },
    };
}
function pick(resp, key) {
    return resp[key];
}
function opt(resp, key) {
    const v = resp[key];
    return typeof v === 'string' && v !== '' ? v : undefined;
}
function num(v) {
    return typeof v === 'number' ? v : Number(v) || 0;
}
function numOpt(v) {
    return typeof v === 'number' ? v : undefined;
}
function isAbort(err) {
    return err instanceof Error && err.name === 'AbortError';
}
/**
 * 从消息的 item_list 提取文本（与官方 SDK inbound 逻辑一致）：
 * 优先第一个 TEXT item（含引用拼接）；其次 VOICE item 的转写文本。
 */
export function extractText(msg) {
    const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
    for (const item of items) {
        if (item.type === 1) {
            const textItem = item.text_item;
            const text = textItem?.text;
            if (typeof text === 'string' && text !== '')
                return text;
            if (text != null)
                return String(text);
        }
        if (item.type === 3) {
            const voiceItem = item.voice_item;
            if (typeof voiceItem?.text === 'string' && voiceItem.text !== '')
                return voiceItem.text;
        }
    }
    return '';
}
/** 消息里是否含媒体（图片/视频/文件/语音）。 */
export function hasMedia(msg) {
    const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
    return items.some((i) => [2, 3, 4, 5].includes(Number(i.type)));
}
//# sourceMappingURL=ilink.js.map