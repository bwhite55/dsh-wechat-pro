/**
 * dsh-wechat-pro —— DeepSeek Harness 进程内微信 ClawBot 通道插件。
 *
 * 能力：扫码连接（iLink 官方通道）、/workspace /workdir 切换工作区、
 * 与 Web 共享真实 DSH 会话（新建/切换/附着）、/model /thinking、
 * harness 原生命令透传、工具审批转发微信、过程事件流 + 长文分片输出、
 * 媒体收发、24h 自动续连。
 *
 * 架构：微信通道（engine）与宿主 apiProxy（HarnessApi）都跑在 dsh web 进程内；
 * 会话事件经 session/event 订阅实时镜像到微信（SessionMirror）。
 */
import os from 'node:os';
import path from 'node:path';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { HarnessApi } from "./api.js";
import { ApprovalForwarder } from "./approval.js";
import { buildEngineConfig, WechatEngine } from "./channel/engine.js";
import { downloadMediaFromItem } from "./channel/media.js";
import { extractText } from "./channel/ilink.js";
import { CommandHandler } from "./commands.js";
import { isStreamLevel, SessionMirror } from "./mirror.js";
import { ContactStore, contactKeyFor } from "./registry.js";
import { SessionManager } from "./sessions.js";
import { weixinSendTool, weixinStatusTool } from "./tools.js";
import { log, mask, safeKey } from "./util.js";
export const name = 'wechat-pro';
/** 需要宿主提供的能力（apiProxy 必须 inject 才能读取；其余同 dsh-weixin）。 */
export const inject = ['agents', 'webServer', 'tools', 'systemPrompt', 'apiProxy'];
const SETTINGS_NAMESPACE = settingsNamespace('dsh-wechat-pro');
export const Config = z.object({
    enabled: z.boolean().default(true),
    autoConnect: z.boolean().default(true),
    allowFrom: z.array(z.string()).default([]),
    dataDir: z.string().default(''),
    baseUrl: z.string().default(''),
    channelVersion: z.string().default(''),
    sessionMs: z.number().default(24 * 3600 * 1000),
    reloginBeforeMs: z.number().default(2 * 3600 * 1000),
    qrTimeoutMs: z.number().default(8 * 60 * 1000),
    replyMaxChars: z.number().default(3800),
    maxStreamIntervalMs: z.number().default(900),
    streamLevel: z.string().default('minimal'),
    mirrorWebTurns: z.boolean().default(false),
    maxProcessPerTurn: z.number().default(3),
    maxReplyChunks: z.number().default(8),
    noTyping: z.boolean().default(false),
    announceToAgent: z.boolean().default(true),
    replyTimeoutMs: z.number().default(300_000),
});
const DEFAULT_ANNOUNCE = true;
const WEIXIN_GUIDANCE = '本机已安装 dsh-wechat-pro 插件（微信 ClawBot 通道）：用户可通过微信与 agent 对话，'
    + '与 Web 共享真实会话与记忆；微信侧可用 /workspace /workdir 切换工作区、/new /switch /sessions 管理会话、'
    + '/model /thinking 切换模型与思考强度、/send 发送文件，并可直接执行 harness 原生命令（/plan /permission 等）。'
    + 'agent 可用 weixin_send 工具主动推送消息到用户微信。';
function resolveDataDir(configured) {
    const env = process.env.DSH_WXBOT_DATA_DIR;
    if (env && env.trim() !== '')
        return env.trim();
    if (configured.trim() !== '')
        return configured.trim();
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(home, 'dsh-wechat-pro');
}
function resolveEngineConfig(config, dataDir) {
    const values = buildEngineConfig({
        baseUrl: config.baseUrl || undefined,
        channelVersion: config.channelVersion || undefined,
        sessionMs: config.sessionMs,
        reloginBeforeMs: config.reloginBeforeMs,
        qrTimeoutMs: config.qrTimeoutMs,
        noTyping: config.noTyping,
        maxStreamIntervalMs: config.maxStreamIntervalMs,
        dataDir,
    });
    return values;
}
export function apply(ctx, config) {
    let current = () => config ?? {};
    const resolve = () => {
        const value = current();
        const envAllowFrom = process.env.DSH_WXBOT_ALLOW_FROM;
        return {
            enabled: value.enabled ?? true,
            autoConnect: value.autoConnect ?? true,
            allowFrom: value.allowFrom?.length
                ? value.allowFrom
                : (envAllowFrom?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
            dataDir: value.dataDir ?? '',
            baseUrl: value.baseUrl ?? '',
            channelVersion: value.channelVersion ?? '',
            sessionMs: value.sessionMs ?? 24 * 3600 * 1000,
            reloginBeforeMs: value.reloginBeforeMs ?? 2 * 3600 * 1000,
            qrTimeoutMs: value.qrTimeoutMs ?? 8 * 60 * 1000,
            replyMaxChars: Number(process.env.DSH_WXBOT_REPLY_MAX ?? value.replyMaxChars ?? 3800),
            maxStreamIntervalMs: value.maxStreamIntervalMs ?? 900,
            streamLevel: isStreamLevel(value.streamLevel ?? '') ? value.streamLevel : 'minimal',
            mirrorWebTurns: value.mirrorWebTurns ?? false,
            maxProcessPerTurn: value.maxProcessPerTurn ?? 3,
            maxReplyChunks: Number(process.env.DSH_WXBOT_MAX_CHUNKS ?? value.maxReplyChunks ?? 8),
            noTyping: value.noTyping ?? false,
            announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
            replyTimeoutMs: Number(process.env.DSH_WXBOT_REPLY_TIMEOUT_MS ?? value.replyTimeoutMs ?? 300_000),
        };
    };
    // ---- 核心对象（跨配置编辑存活，只有 enabled=false 或插件卸载才拆除） ----
    const api = HarnessApi.resolve(ctx);
    if (api === undefined) {
        ctx.logger.warn('dsh-wechat-pro: 未找到宿主 apiProxy（web profile 必须提供），插件停用');
        return;
    }
    const harnessApi = api;
    const dataDir = resolveDataDir(resolve().dataDir);
    const store = new ContactStore(dataDir);
    const hostCwd = process.cwd();
    let engineSurfaceRef;
    let disposeRoutes;
    let disposeTools;
    let disposeSection;
    const sync = () => {
        if (disposeRoutes !== undefined) {
            disposeRoutes();
            disposeRoutes = undefined;
        }
        if (disposeTools !== undefined) {
            disposeTools();
            disposeTools = undefined;
        }
        if (disposeSection !== undefined) {
            disposeSection();
            disposeSection = undefined;
        }
        const value = resolve();
        if (!value.enabled)
            return;
        if (value.announceToAgent) {
            disposeSection = ctx.systemPrompt.section({
                name: 'plugin:dsh-wechat-pro',
                order: 160,
                text: WEIXIN_GUIDANCE,
            });
        }
        // 引擎 + 镜像 + 指令 + 审批（配置变化时重建，否则复用）
        const dir = resolveDataDir(value.dataDir);
        const cfg = resolveEngineConfig(value, dir);
        const state = ensureEngineState(ctx, cfg, dir, value, store, hostCwd);
        engineSurfaceRef = state;
        const engineSurface = state.engine;
        const routes = [
            makeRoute('GET', '/api/dsh-wechat-pro/status', async (req, res) => {
                writeJson(res, 200, { status: state.engine.status() });
            }),
            makeRoute('POST', '/api/dsh-wechat-pro/connect', async (_req, res) => {
                void state.engine.connect(true);
                writeJson(res, 202, { status: state.engine.status() });
            }),
            makeRoute('POST', '/api/dsh-wechat-pro/disconnect', async (_req, res) => {
                await state.engine.disconnect();
                writeJson(res, 200, { status: state.engine.status() });
            }),
        ];
        disposeRoutes = ctx.effect(() => {
            const disposers = routes.map((route) => ctx.webServer.register(route));
            return () => { for (const dispose of disposers)
                dispose(); };
        }, 'dsh-wechat-pro: routes');
        const tools = [weixinSendTool(engineSurface), weixinStatusTool(engineSurface)];
        disposeTools = ctx.effect(() => {
            const disposers = tools.map((tool) => ctx.tools.register(tool));
            return () => { for (const dispose of disposers)
                dispose(); };
        }, 'dsh-wechat-pro: tools');
        if (value.autoConnect) {
            void state.engine.connect().catch((e) => log(`autoConnect 失败: ${e instanceof Error ? e.message : String(e)}`));
        }
    };
    /** 组装（或复用）引擎面；configKey 变化时重建。 */
    function ensureEngineState(ctx, cfg, dir, value, store, hostCwd) {
        const key = [cfg.baseUrl, String(value.replyMaxChars), String(value.streamLevel), String(value.mirrorWebTurns), String(value.maxProcessPerTurn), String(value.maxReplyChunks), dir].join('|');
        if (engineSurfaceRef && engineSurfaceRef.configKey === key)
            return engineSurfaceRef;
        if (engineSurfaceRef) {
            engineSurfaceRef.engine.dispose();
            engineSurfaceRef.approval.dispose();
        }
        const manager = new SessionManager(ctx, harnessApi, store, hostCwd);
        const engine = new WechatEngine(ctx, cfg, (msg) => dispatchMessage(ctx, engineSurfaceRef, msg, value, dir, store, manager));
        const engineSurface = engine;
        const mirror = new SessionMirror(ctx, engineSurface, {
            replyMaxChars: value.replyMaxChars,
            streamLevel: value.streamLevel,
            mirrorWebTurns: value.mirrorWebTurns,
            maxProcessPerTurn: value.maxProcessPerTurn,
            maxReplyChunks: value.maxReplyChunks,
            levelOf: (contactId) => {
                const reg = store.peek(contactKeyFor(contactId));
                return reg !== undefined && isStreamLevel(reg.streamLevel ?? '')
                    ? reg.streamLevel
                    : value.streamLevel;
            },
            // 超长回复落盘为文件发给用户（媒体 1 条，不占文本条数额度）
            sendLongAsFile: async (text, to) => {
                const outbox = path.join(dir, 'outbox');
                const { mkdir, writeFile } = await import('node:fs/promises');
                await mkdir(outbox, { recursive: true });
                const file = path.join(outbox, `回复-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`);
                await writeFile(file, text, 'utf8');
                await engineSurface.sendMediaFile(file, to, { caption: `📎 完整回复（${text.length} 字符）` });
            },
        });
        mirror.start();
        const commands = new CommandHandler({
            ctx,
            api: harnessApi,
            sessions: manager,
            store,
            mirror,
            engine: engineSurface,
            replyMaxChars: value.replyMaxChars,
            hostCwd,
        });
        const approval = new ApprovalForwarder(ctx, engineSurface, mirror);
        approval.start();
        const state = { engine, mirror, commands, approval, manager, configKey: key };
        engineSurfaceRef = state;
        return state;
    }
    ctx.effect(() => () => {
        if (disposeRoutes !== undefined) {
            disposeRoutes();
            disposeRoutes = undefined;
        }
        if (disposeTools !== undefined) {
            disposeTools();
            disposeTools = undefined;
        }
        if (disposeSection !== undefined) {
            disposeSection();
            disposeSection = undefined;
        }
        if (engineSurfaceRef) {
            engineSurfaceRef.engine.dispose();
            engineSurfaceRef.approval.dispose();
            engineSurfaceRef = undefined;
        }
    }, 'dsh-wechat-pro: teardown');
    installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, resolve(), {
        setSource: (source) => {
            current = source;
            sync();
        },
        onChange: sync,
    });
    sync();
}
/** 微信消息分发：审批回复 → 数字选择 → 指令 → 媒体 → agent 对话。 */
async function dispatchMessage(ctx, state, msg, config, dataDir, store, manager) {
    const from = typeof msg.from_user_id === 'string' ? msg.from_user_id : '';
    if (!from)
        return;
    const ctxToken = typeof msg.context_token === 'string' ? msg.context_token : undefined;
    const engine = state.engine;
    if (config.allowFrom.length > 0 && !config.allowFrom.includes(from)) {
        log(`忽略未授权用户: ${mask(from)}`);
        return;
    }
    const text = extractText(msg);
    const key = contactKeyFor(from);
    // 媒体下载（图片/语音/文件/视频）
    const mediaItems = (Array.isArray(msg.item_list) ? msg.item_list : [])
        .filter((i) => [2, 3, 4, 5].includes(Number(i.type)));
    const savedMedia = mediaItems.length
        ? (await Promise.all(mediaItems.map((item) => downloadMediaFromItem({
            item: item,
            saveDir: path.join(dataDir, 'media', safeKey(`wx:${from}`)),
            log: (m) => log(m),
        })))).filter((s) => s !== null)
        : [];
    // 1) 审批回复
    if (await state.approval.tryResolve(from, text))
        return;
    // 2) 数字选择（多步指令）
    if (await state.commands.tryResolvePending(from, text))
        return;
    // 3) 指令（自有 + 原生透传）；未识别的一律回提示，绝不漏给模型
    if (text.trim().startsWith('/')) {
        const handled = await state.commands.handle(from, text, ctxToken);
        if (handled)
            return;
        const name = text.trim().split(/\s+/)[0]?.slice(1) ?? '';
        await engine.sendText(from, `未识别的指令 /${name}（/help 查看指令列表）`, { contextToken: ctxToken }).catch(() => { });
        return;
    }
    // 4) 纯媒体消息：只保存并回路径
    if (mediaItems.length > 0 && text === '') {
        if (savedMedia.length > 0) {
            const lines = savedMedia.map((s) => `- ${s.savedPath}（${s.kind}）`).join('\n');
            await engine.sendText(from, `📥 已保存你发来的 ${savedMedia.length} 个文件到电脑：\n${lines}`, { contextToken: ctxToken });
        }
        else {
            await engine.sendText(from, '⚠️ 收到媒体消息但下载失败，请稍后再试。', { contextToken: ctxToken });
        }
        return;
    }
    if (text === '')
        return;
    // 5) agent 对话
    let session;
    try {
        session = await manager.ensureCurrent(key, from);
    }
    catch (error) {
        await engine.sendText(from, `❌ ${error instanceof Error ? error.message : String(error)}`, { contextToken: ctxToken });
        return;
    }
    state.mirror.bind(session.sessionId, from);
    const dshText = savedMedia.length > 0
        ? `（用户刚发来 ${savedMedia.length} 个媒体文件，已保存到电脑：${savedMedia.map((s) => s.savedPath).join('；')}）\n${text}`
        : text;
    try {
        await engine.startTyping(from, ctxToken);
        log(`agent 开始处理: user=${mask(from)} session=${session.sessionId} text=${text.slice(0, 60)}…`);
        await state.manager.api.prompt(session.sessionId, dshText, 'queue');
        const outcome = await state.mirror.awaitTurn(session.sessionId, config.replyTimeoutMs);
        if (outcome.error) {
            log(`回合出错: user=${mask(from)} error=${outcome.error}`);
        }
    }
    catch (error) {
        log(`处理消息出错: ${error instanceof Error ? error.message : String(error)}`);
        const message = error instanceof Error ? error.message : String(error);
        // awaitTurn 超时不是回合失败：最终答复仍会由镜像在 turn/end 推送，措辞改为提示而非报错
        const text = message.includes('处理超时')
            ? `⏳ 任务仍在处理中（超过 ${Math.round(config.replyTimeoutMs / 1000)} 秒），完成后会自动推送结果。`
            : `⚠️ 处理出错：${message}`.slice(0, 500);
        await engine.sendText(from, text, { contextToken: ctxToken, retry: true }).catch(() => { });
    }
    finally {
        await engine.stopTyping(from, ctxToken).catch(() => { });
    }
}
// ---------------------------------------------------------------------------
// Web 路由（仅本机回环，防止 LAN 暴露控制微信连接）
// ---------------------------------------------------------------------------
function isLoopbackRequest(request) {
    const address = request.socket.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1')
        return false;
    const host = request.headers.host;
    if (typeof host !== 'string')
        return false;
    let hostUrl;
    try {
        hostUrl = new URL('http://' + host);
    }
    catch {
        return false;
    }
    if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]')
        return false;
    if (request.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const origin = request.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === hostUrl.host;
    }
    catch {
        return false;
    }
}
function writeJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
    res.end(payload);
}
function makeRoute(method, pathname, handler) {
    return {
        kind: 'exact',
        path: pathname,
        handler: (req, res) => {
            if (!isLoopbackRequest(req)) {
                writeJson(res, 403, { error: 'forbidden: loopback-only' });
                return;
            }
            if (req.method !== method) {
                writeJson(res, 405, { error: 'method not allowed: ' + (req.method ?? '') });
                return;
            }
            void handler(req, res);
        },
    };
}
//# sourceMappingURL=index.js.map