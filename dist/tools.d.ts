/**
 * Agent 工具：weixin_send（主动推消息到最近联系人的微信）与 weixin_status。
 * 与引擎共用同一发送面，Web 侧 agent 也可主动联系微信用户。
 */
import type { EngineSurface } from './channel/engine.ts';
export declare function weixinSendTool(engine: EngineSurface): import("@deepseek-ai/dsh-tools").ToolDefinition;
export declare function weixinStatusTool(engine: EngineSurface): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=tools.d.ts.map