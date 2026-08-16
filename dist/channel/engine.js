/**
 * WechatEngine —— 微信 ClawBot 通道状态机（进程内）。
 * 扫码登录（QR 打印到 dsh web 终端）→ 长轮询收消息 → 回调给 Dispatcher；
 * 提供 typing、发送（带每联系人串行队列，供流式过程消息用）、媒体、续连。
 * 移植自 dsh-wechat-bridge 的 weixin-bot.mjs（MIT，已实测跑通）。
 */
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIlinkClient, DEFAULT_BASE_URL, STALE_TOKEN_ERRCODE, LONG_POLL_TIMEOUT_MS, } from "./ilink.js";
import { log, mask, readJson, writeJsonAtomic } from "../util.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readLine(prompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
async function displayQr(qrcodeImgContent) {
    try {
        const qrterm = await import('qrcode-terminal');
        qrterm.default.generate(qrcodeImgContent, { small: true });
    }
    catch {
        // 无 qrcode-terminal 依赖，直接给链接
    }
    console.log(`\n📱 微信扫码链接（在手机微信里打开）:\n${qrcodeImgContent}\n`);
}
export class WechatEngine {
    ctx;
    config;
    onMessage;
    client;
    auth = null;
    state = 'disconnected';
    abort = null;
    polling = false;
    syncBuf = '';
    contextTokens = new Map();
    typingTickets = new Map();
    lastSender = null;
    reloginRequested = false;
    expiryWarned = false;
    lastError;
    pendingQr;
    sendChains = new Map();
    lastStreamAt = new Map();
    authFile;
    syncBufFile;
    constructor(ctx, config, onMessage) {
        this.ctx = ctx;
        this.config = config;
        this.onMessage = onMessage;
        this.authFile = path.join(config.dataDir, 'weixin-auth.json');
        this.syncBufFile = path.join(config.dataDir, 'weixin-syncbuf.txt');
        this.client = createIlinkClient({
            baseUrl: config.baseUrl,
            channelVersion: config.channelVersion,
            botAgent: config.botAgent,
            log: (m) => log(m),
        });
    }
    // ------------------------------------------------------------------ 凭证
    async loadAuth() {
        const raw = await readJson(this.authFile);
        if (raw && typeof raw.token === 'string' && raw.token !== '')
            return raw;
        return null;
    }
    async saveAuth() {
        if (!this.auth)
            return;
        await writeJsonAtomic(this.authFile, this.auth);
    }
    async loadSyncBuf() {
        try {
            this.syncBuf = (await readFile(this.syncBufFile, 'utf8')).trim();
        }
        catch {
            this.syncBuf = '';
        }
    }
    async saveSyncBuf() {
        await mkdir(path.dirname(this.syncBufFile), { recursive: true });
        await writeFile(this.syncBufFile, this.syncBuf, 'utf8');
    }
    // ------------------------------------------------------------------ 状态
    status() {
        const payload = {
            state: this.state,
            loggedIn: this.auth !== null,
        };
        if (this.auth?.botId)
            payload.botId = this.auth.botId;
        if (this.auth) {
            const remaining = this.auth.loggedInAt + this.config.sessionMs - Date.now();
            payload.remainingHours = Math.max(0, Math.round(remaining / 360000) / 10);
        }
        if (this.lastError !== undefined)
            payload.error = this.lastError;
        if (this.pendingQr !== undefined)
            payload.qrLink = this.pendingQr;
        return payload;
    }
    contextTokenOf(to) {
        return this.contextTokens.get(to);
    }
    getLastSender() {
        return this.lastSender;
    }
    // ------------------------------------------------------------------ 登录
    /** 已有凭证且未强制时直接复用；否则走扫码。 */
    async connect(force = false) {
        if (this.state === 'connected' || this.state === 'connecting') {
            if (!force)
                return;
        }
        this.state = 'connecting';
        this.lastError = undefined;
        try {
            if (!force) {
                const auth = await this.loadAuth();
                if (auth && auth.token) {
                    this.auth = auth;
                    this.pendingQr = undefined;
                    this.client.setToken(auth.token);
                    this.client.setBaseUrl(auth.baseUrl || this.config.baseUrl);
                    await this.startPolling();
                    return;
                }
            }
            const auth = await this.doLogin();
            this.auth = auth;
            this.client.setToken(auth.token);
            this.client.setBaseUrl(auth.baseUrl || this.config.baseUrl);
            await this.saveAuth();
            await this.startPolling();
        }
        catch (error) {
            this.state = 'error';
            this.lastError = error instanceof Error ? error.message : String(error);
            log(`连接失败: ${this.lastError}`);
        }
    }
    /** 扫码登录流程（与官方 SDK login-qr.ts 一致：配对码/二维码刷新/节点跳转）。 */
    async doLogin() {
        log('开始微信扫码登录（二维码打印在 dsh web 终端）…');
        let qr = await this.client.getBotQrcode();
        this.pendingQr = qr.qrcodeImgContent;
        await displayQr(qr.qrcodeImgContent);
        let verifyCode;
        let refreshCount = 1;
        const MAX_REFRESH = 3;
        const deadline = Date.now() + this.config.qrTimeoutMs;
        let scannedPrinted = false;
        while (Date.now() < deadline) {
            let st;
            try {
                st = await this.client.pollQrcodeStatus(qr.qrcode, verifyCode);
            }
            catch {
                st = { status: 'wait' };
            }
            switch (st.status) {
                case 'wait':
                    process.stdout.write('.');
                    break;
                case 'scaned':
                    if (verifyCode)
                        verifyCode = undefined;
                    if (!scannedPrinted) {
                        console.log('\n✅ 已扫码，请在手机上确认…');
                        scannedPrinted = true;
                    }
                    break;
                case 'need_verifycode': {
                    const prompt = verifyCode ? '❌ 数字不匹配，请重新输入手机上显示的数字：' : '🔢 输入手机微信显示的数字配对码：';
                    verifyCode = await readLine(prompt);
                    continue;
                }
                case 'verify_code_blocked':
                    console.log('⛔ 配对码多次错误，刷新二维码重试…');
                    verifyCode = undefined;
                    if (++refreshCount > MAX_REFRESH)
                        throw new Error('配对码多次错误且二维码刷新次数超限，请稍后再试');
                    qr = await this.client.getBotQrcode();
                    await displayQr(qr.qrcodeImgContent);
                    scannedPrinted = false;
                    break;
                case 'expired':
                    console.log('⏳ 二维码已过期，正在刷新…');
                    if (++refreshCount > MAX_REFRESH)
                        throw new Error('二维码多次过期，请重新运行 connect');
                    qr = await this.client.getBotQrcode();
                    await displayQr(qr.qrcodeImgContent);
                    scannedPrinted = false;
                    break;
                case 'scaned_but_redirect':
                    if (st.redirectHost) {
                        console.log(`🔀 服务器要求切换节点: ${st.redirectHost}`);
                        this.client.setBaseUrl(`https://${st.redirectHost}`);
                    }
                    break;
                case 'binded_redirect':
                    console.log('✅ 该微信已连接过本机，无需重复连接。');
                    throw new Error('already bound; 清除凭证后重试（/reconnect 或删 weixin-auth.json）');
                case 'confirmed': {
                    if (!st.botId)
                        throw new Error('登录确认但服务器未返回 ilink_bot_id');
                    console.log(`\n🎉 登录成功！botId=${st.botId} userId=${st.userId ? mask(st.userId) : '?'}`);
                    this.pendingQr = undefined;
                    return {
                        token: st.botToken ?? '',
                        baseUrl: st.baseUrl || this.config.baseUrl,
                        botId: st.botId,
                        userId: st.userId ?? undefined,
                        channelVersion: this.config.channelVersion,
                        loggedInAt: Date.now(),
                    };
                }
                default:
                    console.log(`未知扫码状态: ${st.status}，继续轮询`);
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error('等待扫码超时');
    }
    // ------------------------------------------------------------------ 监听
    async startPolling() {
        if (this.polling)
            return;
        this.polling = true;
        this.abort = new AbortController();
        this.state = 'connected';
        await this.loadSyncBuf();
        if (this.syncBuf)
            log(`恢复消息游标（${this.syncBuf.length} 字节）`);
        await this.client.notifyStart().catch(() => { });
        log('开始监听微信消息…');
        void this.runPoll();
    }
    async disconnect() {
        this.polling = false;
        this.abort?.abort();
        await this.client.notifyStop().catch(() => { });
        this.state = 'disconnected';
        log('微信通道已停止');
    }
    /** 清除本地凭证。 */
    async logout() {
        await this.disconnect();
        await rm(this.authFile, { force: true });
        this.auth = null;
        log('已注销（本地凭证已删除）');
    }
    async runPoll() {
        let consecutiveFailures = 0;
        let longPollMs = LONG_POLL_TIMEOUT_MS;
        while (this.polling && !this.abort?.signal.aborted) {
            const age = this.auth ? Date.now() - this.auth.loggedInAt : 0;
            if (this.auth && age > this.config.sessionMs - this.config.reloginBeforeMs && !this.expiryWarned && age < this.config.sessionMs) {
                this.expiryWarned = true;
                log(`⚠️ 连接将在 ${Math.round(this.config.reloginBeforeMs / 60000)} 分钟后到期`);
                if (this.lastSender) {
                    await this.sendText(this.lastSender, '⚠️ 与微信的连接即将到期，请留意电脑终端完成续连（或发送 /reconnect）')
                        .catch(() => { });
                }
            }
            if (this.auth && (age >= this.config.sessionMs || this.reloginRequested)) {
                const ok = await this.doRelogin(this.reloginRequested ? '用户请求' : '会话到期');
                this.reloginRequested = false;
                if (ok)
                    continue;
                log('续连失败，等待 5 分钟后重试…');
                await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
                this.expiryWarned = false;
                continue;
            }
            let resp;
            try {
                resp = await this.client.getUpdates(this.syncBuf, longPollMs, this.abort?.signal);
            }
            catch (e) {
                consecutiveFailures += 1;
                log(`getUpdates 网络错误 (${consecutiveFailures}/3): ${e instanceof Error ? e.message : String(e)}`);
                await new Promise((r) => setTimeout(r, consecutiveFailures >= 3 ? 30_000 : 2_000));
                if (consecutiveFailures >= 3)
                    consecutiveFailures = 0;
                continue;
            }
            if (resp.ret !== 0 || (resp.errcode !== undefined && resp.errcode !== 0)) {
                if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
                    log(`⚠️ token 已失效 (errcode=${resp.errcode ?? resp.ret})，开始续连…`);
                    await this.doRelogin('token 失效');
                    continue;
                }
                consecutiveFailures += 1;
                log(`getUpdates 错误 ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/3)`);
                await new Promise((r) => setTimeout(r, consecutiveFailures >= 3 ? 30_000 : 2_000));
                if (consecutiveFailures >= 3)
                    consecutiveFailures = 0;
                continue;
            }
            consecutiveFailures = 0;
            if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
                longPollMs = resp.longpolling_timeout_ms;
            }
            if (resp.get_updates_buf && resp.get_updates_buf !== this.syncBuf) {
                this.syncBuf = resp.get_updates_buf;
                await this.saveSyncBuf().catch(() => { });
            }
            for (const msg of resp.msgs) {
                if (msg.message_type !== 1)
                    continue; // 只处理用户消息
                if (msg.context_token)
                    this.contextTokens.set(String(msg.from_user_id ?? ''), String(msg.context_token));
                if (msg.from_user_id) {
                    this.lastSender = String(msg.from_user_id);
                }
                await this.onMessage(msg).catch((e) => log(`消息处理异常: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
            }
        }
    }
    // ------------------------------------------------------------------ 续连
    async doRelogin(reason) {
        log(`开始重新连接（原因: ${reason}）…`);
        const fresh = createIlinkClient({
            baseUrl: DEFAULT_BASE_URL,
            channelVersion: this.config.channelVersion,
            botAgent: this.config.botAgent,
            log: (m) => log(m),
        });
        const qr = await fresh.getBotQrcode();
        this.pendingQr = qr.qrcodeImgContent;
        console.log(`\n🔁 连接即将/已经过期，请重新扫码续连。\n📱 二维码链接: ${qr.qrcodeImgContent}\n`);
        await displayQr(qr.qrcodeImgContent);
        if (this.lastSender) {
            await this.sendText(this.lastSender, `🔁 连接即将到期，请在手机微信打开此链接完成续连：\n${qr.qrcodeImgContent}`)
                .catch(() => { });
        }
        let verifyCode;
        const deadline = Date.now() + this.config.qrTimeoutMs;
        while (Date.now() < deadline) {
            const st = await fresh.pollQrcodeStatus(qr.qrcode, verifyCode).catch(() => ({ status: 'wait' }));
            if (st.status === 'need_verifycode') {
                verifyCode = await readLine('🔢 输入手机微信显示的数字配对码：');
                continue;
            }
            if (st.status === 'confirmed' && st.botToken && st.botId) {
                this.auth = {
                    token: st.botToken,
                    baseUrl: st.baseUrl || this.config.baseUrl,
                    botId: st.botId,
                    userId: st.userId ?? this.auth?.userId,
                    channelVersion: this.config.channelVersion,
                    loggedInAt: Date.now(),
                };
                this.pendingQr = undefined;
                await this.saveAuth();
                this.client.setToken(st.botToken);
                this.client.setBaseUrl(this.auth.baseUrl);
                this.expiryWarned = false;
                log(`✅ 续连成功 botId=${st.botId}`);
                await this.client.notifyStart().catch(() => { });
                return true;
            }
            if (st.status === 'expired') {
                console.log('二维码过期，重新申请…');
                const qr2 = await fresh.getBotQrcode();
                this.pendingQr = qr2.qrcodeImgContent;
                await displayQr(qr2.qrcodeImgContent);
                if (this.lastSender) {
                    await this.sendText(this.lastSender, `🔁 新的续连链接：\n${qr2.qrcodeImgContent}`).catch(() => { });
                }
                Object.assign(qr, qr2);
                continue;
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
        log('续连等待超时');
        return false;
    }
    // ------------------------------------------------------------------ 发送
    /** 每联系人串行发送队列（保证流式过程消息与最终答复不乱序）。 */
    enqueueSend(to, send) {
        const prev = this.sendChains.get(to) ?? Promise.resolve();
        const next = prev.then(send, send);
        this.sendChains.set(to, next.catch(() => { }));
        return next;
    }
    /** 节流：同一联系人的流式过程消息至少间隔 maxStreamIntervalMs。返回是否放行。 */
    streamAllowed(to) {
        const now = Date.now();
        const last = this.lastStreamAt.get(to) ?? 0;
        if (now - last < this.config.maxStreamIntervalMs)
            return false;
        this.lastStreamAt.set(to, now);
        return true;
    }
    resetStreamThrottle(to) {
        this.lastStreamAt.set(to, 0);
    }
    /** 发送失败落盘（隐藏窗口/无终端时唯一可查的痕迹）。 */
    logSendFailure(kind, to, snippet, err) {
        const line = `[${new Date().toISOString()}] ${kind} 失败 to=${mask(to)} text=${snippet.slice(0, 80)} err=${err instanceof Error ? err.message : String(err)}\n`;
        const file = path.join(this.config.dataDir, 'logs', 'wechat-pro.log');
        import('node:fs').then((fs) => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, line);
        }).catch(() => { });
        log(line.trim());
    }
    /** 发送文本；retry=true 时失败重试一次（最终答复/审批等重要消息）。失败一律落盘日志。 */
    async sendText(to, text, opts = {}) {
        const token = opts.contextToken ?? this.contextTokens.get(to);
        const attempts = opts.retry === true ? 2 : 1;
        await this.enqueueSend(to, async () => {
            let lastErr;
            for (let i = 0; i < attempts; i++) {
                try {
                    await this.client.sendMessage({ to, text, contextToken: token, clientId: opts.clientId });
                    return;
                }
                catch (e) {
                    lastErr = e;
                    if (i < attempts - 1)
                        await new Promise((r) => setTimeout(r, 1500));
                }
            }
            this.logSendFailure('sendText', to, text, lastErr);
            throw lastErr;
        });
    }
    async sendItems(to, itemList, opts = {}) {
        const token = opts.contextToken ?? this.contextTokens.get(to);
        const attempts = opts.retry === true ? 2 : 1;
        await this.enqueueSend(to, async () => {
            let lastErr;
            for (let i = 0; i < attempts; i++) {
                try {
                    await this.client.sendMessageItems({ to, itemList, contextToken: token, clientId: opts.clientId });
                    return;
                }
                catch (e) {
                    lastErr = e;
                    if (i < attempts - 1)
                        await new Promise((r) => setTimeout(r, 1500));
                }
            }
            this.logSendFailure('sendItems', to, JSON.stringify(itemList).slice(0, 80), lastErr);
            throw lastErr;
        });
    }
    async sendMediaFile(filePath, to, opts = {}) {
        const token = opts.contextToken ?? this.contextTokens.get(to);
        await this.enqueueSend(to, async () => {
            const { sendMediaFile: send } = await import("./media.js");
            await send({ client: this.client, filePath, to, caption: opts.caption, contextToken: token, log: (m) => log(m) });
        });
    }
    async getTypingTicket(to, ctxToken) {
        if (this.config.noTyping)
            return '';
        const cached = this.typingTickets.get(to);
        if (cached && Date.now() - cached.at < 23 * 3600 * 1000)
            return cached.ticket;
        try {
            const { typingTicket } = await this.client.getConfig(to, ctxToken ?? this.contextTokens.get(to));
            if (typingTicket)
                this.typingTickets.set(to, { ticket: typingTicket, at: Date.now() });
            return typingTicket;
        }
        catch (e) {
            log(`getConfig 失败（忽略 typing）: ${e instanceof Error ? e.message : String(e)}`);
            return '';
        }
    }
    async sendTypingStatus(to, ticket, status) {
        if (!ticket)
            return;
        try {
            await this.client.sendTyping(to, ticket, status);
        }
        catch (e) {
            log(`sendTyping(${status}) 失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async startTyping(to, ctxToken) {
        const ticket = await this.getTypingTicket(to, ctxToken);
        if (ticket)
            await this.sendTypingStatus(to, ticket, 1);
    }
    async stopTyping(to, ctxToken) {
        const ticket = await this.getTypingTicket(to, ctxToken);
        if (ticket)
            await this.sendTypingStatus(to, ticket, 2);
    }
    reconnect() {
        this.reloginRequested = true;
        log('收到 /reconnect 请求');
    }
    dispose() {
        this.polling = false;
        this.abort?.abort();
        void this.client.notifyStop().catch(() => { });
    }
}
/** 供 index.ts 构建引擎配置。 */
export function buildEngineConfig(values = {}) {
    return {
        baseUrl: values.baseUrl ?? process.env.DSH_WXBOT_BASE_URL ?? DEFAULT_BASE_URL,
        channelVersion: values.channelVersion ?? process.env.DSH_WXBOT_CHANNEL_VERSION ?? '2.4.6',
        botAgent: values.botAgent ?? process.env.DSH_WXBOT_AGENT ?? 'dsh-wechat-pro',
        dataDir: values.dataDir ?? process.env.DSH_WXBOT_DATA_DIR ?? '',
        sessionMs: values.sessionMs ?? Number(process.env.DSH_WXBOT_SESSION_MS ?? 24 * 3600 * 1000),
        reloginBeforeMs: values.reloginBeforeMs ?? Number(process.env.DSH_WXBOT_RELOGIN_BEFORE_MS ?? 2 * 3600 * 1000),
        qrTimeoutMs: values.qrTimeoutMs ?? Number(process.env.DSH_WXBOT_QR_TIMEOUT_MS ?? 8 * 60 * 1000),
        noTyping: values.noTyping ?? process.env.DSH_WXBOT_NO_TYPING === '1',
        maxStreamIntervalMs: values.maxStreamIntervalMs ?? Number(process.env.DSH_WXBOT_STREAM_INTERVAL_MS ?? 900),
    };
}
//# sourceMappingURL=engine.js.map