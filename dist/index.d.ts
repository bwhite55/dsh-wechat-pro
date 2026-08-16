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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "wechat-pro";
/** 需要宿主提供的能力（apiProxy 必须 inject 才能读取；其余同 dsh-weixin）。 */
export declare const inject: string[];
/** 插件配置（schema 校验 + 设置面板可编辑；运行时用 resolve() 取默认值）。 */
export interface Config {
    enabled?: boolean;
    autoConnect?: boolean;
    allowFrom?: string[];
    dataDir?: string;
    baseUrl?: string;
    channelVersion?: string;
    sessionMs?: number;
    reloginBeforeMs?: number;
    qrTimeoutMs?: number;
    replyMaxChars?: number;
    maxStreamIntervalMs?: number;
    /** 输出等级（minimal/normal/verbose）；联系人可经 /level 覆盖。 */
    streamLevel?: string;
    /** Web 发起的回合是否也推送到微信（默认 false：只推微信发起的回合）。 */
    mirrorWebTurns?: boolean;
    /** 每回合过程消息上限（防刷屏与微信限流；最终答复与错误不受限）。 */
    maxProcessPerTurn?: number;
    /** 最终答复分片预算（超预算降级为"首片+文件"，默认 2）。 */
    maxReplyChunks?: number;
    noTyping?: boolean;
    announceToAgent?: boolean;
    replyTimeoutMs?: number;
}
export declare const Config: z<Config>;
/** resolve() 输出：全部字段取默认值后的运行时配置。 */
export interface ResolvedConfig {
    enabled: boolean;
    autoConnect: boolean;
    allowFrom: string[];
    dataDir: string;
    baseUrl: string;
    channelVersion: string;
    sessionMs: number;
    reloginBeforeMs: number;
    qrTimeoutMs: number;
    replyMaxChars: number;
    maxStreamIntervalMs: number;
    streamLevel: 'minimal' | 'normal' | 'verbose';
    mirrorWebTurns: boolean;
    maxProcessPerTurn: number;
    maxReplyChunks: number;
    noTyping: boolean;
    announceToAgent: boolean;
    replyTimeoutMs: number;
}
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map