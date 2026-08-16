/**
 * 会话管理：把"微信联系人 × 命名会话书签"映射到宿主真实 DSH 会话。
 * - 新建：apiProxy.sessions.create({ workspaceId, sessionId })（宿主负责
 *   workspace attach、预设组合、默认模型，与 Web「新建会话」同构）；
 * - 续接：apiProxy.sessions.models({ sessionId }) 让宿主 resume（agentFor），
 *   之后 ctx.agents.get 拿到 live agent；
 * - 附着：把 Web 已存在的会话绑定到微信书签（跨端同轨迹）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessApi } from './api.ts';
import { type ContactRegistry, type ContactStore } from './registry.ts';
export interface ResolvedSession {
    sessionId: string;
    workspacePath: string;
    name: string;
}
export interface WorkspaceInfo {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
}
export interface WorkspaceSessionRow {
    sessionId: string;
    updatedAt: number;
    running: boolean;
    blank: boolean;
    cwd?: string;
    /** Web 端显示的会话标题（来自 host projections；缺省为书签名/短 id）。 */
    title?: string;
    bookmarked: boolean;
    bookmarkName?: string;
}
export declare class SessionManager {
    private readonly ctx;
    readonly api: HarnessApi;
    private readonly store;
    private readonly hostCwdFallback;
    constructor(ctx: Context, api: HarnessApi, store: ContactStore, hostCwdFallback: string);
    /** 按路径解析注册工作区（不存在返回 undefined）。 */
    private findWorkspaceByPath;
    /** 当前工作区：联系人指针 → 未设置/失效时回落默认（第一个工作区或 Host cwd）。 */
    resolveWorkspace(reg: ContactRegistry): Promise<WorkspaceInfo>;
    /** 默认工作区：注册列表第一个；空列表则以 Host cwd 兜底注册一个。 */
    private defaultWorkspace;
    /** /workdir <path>：注册（幂等）并设为当前工作区。 */
    switchWorkspaceByPath(reg: ContactRegistry, path: string): Promise<WorkspaceInfo>;
    /** /workspace <名称|序号>：在注册工作区之间切换。 */
    listWorkspaces(): Promise<WorkspaceInfo[]>;
    /** 只读查看当前书签（不创建）。 */
    peekCurrent(contactKey: string): Promise<ResolvedSession | undefined>;
    /** 取（或建）联系人当前书签对应的真实会话。 */
    ensureCurrent(contactKey: string, contactId: string): Promise<ResolvedSession>;
    /** 新建命名会话（真实 DSH 会话 + 微信书签），并切换过去。 */
    createNamed(contactKey: string, contactId: string, name: string): Promise<ResolvedSession>;
    /** 切换书签（main 永可选；无书签时 main 走 ensureCurrent 懒创建）。 */
    switchTo(contactKey: string, name: string): Promise<ResolvedSession>;
    /** 把 Web 已存在的会话绑定为当前书签（不新建）。 */
    attach(contactKey: string, sessionId: string, workspacePath: string, name?: string): Promise<ResolvedSession>;
    /** 删除书签（真实会话与日志保留，Web 仍可见可续）。 */
    removeBookmark(contactKey: string, name: string): Promise<void>;
    /** 列出当前工作区的真实会话（与 Web 端一致：排除归档/空白/子代理；含标题与书签标记）。 */
    listWorkspaceSessions(contactKey: string): Promise<WorkspaceSessionRow[]>;
    /** 让会话的 agent 变为 live（宿主 resume），返回 live agent。 */
    ensureAgentLive(sessionId: string): Promise<Agent>;
}
//# sourceMappingURL=sessions.d.ts.map