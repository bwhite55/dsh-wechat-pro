/**
 * Agent 工具：weixin_send（主动推消息到最近联系人的微信）与 weixin_status。
 * 与引擎共用同一发送面，Web 侧 agent 也可主动联系微信用户。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { log, mask } from "./util.js";
function text(value) {
    return [{ type: 'text', text: value }];
}
export function weixinSendTool(engine) {
    return defineTool({
        name: 'weixin_send',
        description: '主动发送一条文本消息到最近与微信通道对话的用户微信（官方 ClawBot 通道）。用于任务完成汇报、异常告警、主动通知。限制：需近期收到过该用户的消息（context_token 约束）。',
        parameters: {
            text: { type: 'string', required: true, description: '要发送的文本内容（微信按纯文本显示，Markdown 符号可能保留）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => text(value.ok ? '已发送到微信' : '发送失败：' + (value.error ?? '未知错误')),
        },
        async execute(args) {
            const target = engine.getLastSender();
            if (!target)
                return { ok: false, error: '微信通道还没有收到过用户消息，无法主动发送' };
            try {
                await engine.sendText(target, args.text);
                log(`weixin_send: user=${mask(target)} len=${args.text.length}`);
                return { ok: true };
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    });
}
export function weixinStatusTool(engine) {
    return defineTool({
        name: 'weixin_status',
        description: '查看微信通道连接状态（disconnected / connecting / connected / error）与剩余在线时长。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    state: { type: 'string', required: true },
                    loggedIn: { type: 'boolean', required: true },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => text('微信状态：' + value.state + (value.error !== undefined ? '，错误：' + value.error : '')),
        },
        async execute() {
            return engine.status();
        },
    });
}
//# sourceMappingURL=tools.js.map