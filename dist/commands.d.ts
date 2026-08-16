/**
 * 微信斜杠指令层：
 * - 自有指令：/help /status /time /sessions /new /switch /clear /workspace /workdir
 *   /attach /unbind /model /thinking /send /reconnect /cancel；
 * - 原生透传：名称命中 harness 命令注册表（/plan /permission /compact /goal /feedback
 *   /export 等）时，经 ctx.commands.execute 直接执行，不进模型；
 * - 多步选择：/model /thinking /workspace /sessions 后用户回「数字」完成选择
 *   （每联系人单 pending，5 分钟过期）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { HarnessApi } from './api.ts';
import type { EngineSurface } from './channel/engine.ts';
import { type SessionMirror } from './mirror.ts';
import { type ContactStore } from './registry.ts';
import type { SessionManager } from './sessions.ts';
import { log } from './util.ts';
interface CommandsDeps {
    ctx: Context;
    api: HarnessApi;
    sessions: SessionManager;
    store: ContactStore;
    mirror: SessionMirror;
    engine: EngineSurface;
    replyMaxChars: number;
    hostCwd: string;
}
export declare class CommandHandler {
    private readonly deps;
    private readonly pendings;
    constructor(deps: CommandsDeps);
    private reply;
    private setPending;
    /** 裸数字且存在 pending 时解析选择。返回是否消费了消息。 */
    tryResolvePending(contactId: string, text: string): Promise<boolean>;
    private contactKey;
    /** 处理一条指令；返回是否已消费（无论成功失败）。 */
    handle(contactId: string, text: string, ctxToken?: string): Promise<boolean>;
    private cmdStatus;
    private cmdWorkspace;
    private cmdSessions;
    /** /level [minimal|normal|verbose]：查看/切换本联系人的输出等级（持久化）。 */
    private cmdLevel;
    private cmdAttach;
    private cmdModel;
    private cmdThinking;
    private cmdSend;
    private tryNative;
}
/** 解析 "/name arg" 形式（与 harness parseCommand 同构）。 */
export declare function parseCommandLine(line: string): {
    name: string;
    arg: string;
} | undefined;
export { log };
//# sourceMappingURL=commands.d.ts.map