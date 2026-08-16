/**
 * 会话管理：把"微信联系人 × 命名会话书签"映射到宿主真实 DSH 会话。
 * - 新建：apiProxy.sessions.create({ workspaceId, sessionId })（宿主负责
 *   workspace attach、预设组合、默认模型，与 Web「新建会话」同构）；
 * - 续接：apiProxy.sessions.models({ sessionId }) 让宿主 resume（agentFor），
 *   之后 ctx.agents.get 拿到 live agent；
 * - 附着：把 Web 已存在的会话绑定到微信书签（跨端同轨迹）。
 */
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { DEFAULT_SESSION } from "./registry.js";
import { log, safeKey } from "./util.js";
/** 从 SessionSummary.projections.values 读标题（title 投影）。 */
function readTitleOf(summary) {
    const values = summary.projections?.values;
    if (values === null || typeof values !== 'object')
        return undefined;
    const title = values.title;
    return typeof title === 'string' && title.trim() !== '' ? title : undefined;
}
export class SessionManager {
    ctx;
    api;
    store;
    hostCwdFallback;
    constructor(ctx, api, store, hostCwdFallback) {
        this.ctx = ctx;
        this.api = api;
        this.store = store;
        this.hostCwdFallback = hostCwdFallback;
    }
    // ------------------------------------------------------------------ 工作区
    /** 按路径解析注册工作区（不存在返回 undefined）。 */
    async findWorkspaceByPath(path) {
        const { items } = await this.api.listWorkspaces();
        const hit = items.find((w) => w.path === path || w.path.replace(/[\\/]+$/, '') === path.replace(/[\\/]+$/, ''));
        return hit
            ? {
                workspaceId: String(hit.workspaceId),
                path: hit.path,
                title: hit.title,
                sessionIds: hit.sessionIds.map((s) => String(s)),
            }
            : undefined;
    }
    /** 当前工作区：联系人指针 → 未设置/失效时回落默认（第一个工作区或 Host cwd）。 */
    async resolveWorkspace(reg) {
        if (reg.currentWorkspacePath) {
            const found = await this.findWorkspaceByPath(reg.currentWorkspacePath);
            if (found)
                return found;
            log(`工作区「${reg.currentWorkspacePath}」已不存在，回落默认工作区`);
        }
        return this.defaultWorkspace();
    }
    /** 默认工作区：注册列表第一个；空列表则以 Host cwd 兜底注册一个。 */
    async defaultWorkspace() {
        const { items } = await this.api.listWorkspaces();
        if (items.length > 0) {
            const first = items[0];
            return {
                workspaceId: String(first.workspaceId),
                path: first.path,
                title: first.title,
                sessionIds: first.sessionIds.map((s) => String(s)),
            };
        }
        try {
            const { workspace } = await this.api.createWorkspace(this.hostCwdFallback);
            return {
                workspaceId: String(workspace.workspaceId),
                path: workspace.path,
                title: workspace.title,
                sessionIds: workspace.sessionIds.map((s) => String(s)),
            };
        }
        catch (error) {
            throw new Error(`没有可用工作区且无法以 ${this.hostCwdFallback} 创建：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /** /workdir <path>：注册（幂等）并设为当前工作区。 */
    async switchWorkspaceByPath(reg, path) {
        const { workspace } = await this.api.createWorkspace(path);
        return {
            workspaceId: String(workspace.workspaceId),
            path: workspace.path,
            title: workspace.title,
            sessionIds: workspace.sessionIds.map((s) => String(s)),
        };
    }
    /** /workspace <名称|序号>：在注册工作区之间切换。 */
    async listWorkspaces() {
        const { items } = await this.api.listWorkspaces();
        return items.map((w) => ({
            workspaceId: String(w.workspaceId),
            path: w.path,
            title: w.title,
            sessionIds: w.sessionIds.map((s) => String(s)),
        }));
    }
    // ------------------------------------------------------------------ 会话
    /** 只读查看当前书签（不创建）。 */
    async peekCurrent(contactKey) {
        const reg = await this.store.get(contactKey);
        const found = this.store.find(reg, reg.currentSessionName);
        if (!found?.bookmark)
            return undefined;
        return { sessionId: found.bookmark.sessionId, workspacePath: found.bookmark.workspacePath, name: found.name };
    }
    /** 取（或建）联系人当前书签对应的真实会话。 */
    async ensureCurrent(contactKey, contactId) {
        const reg = await this.store.get(contactKey);
        const name = reg.currentSessionName;
        const found = this.store.find(reg, name);
        if (found?.bookmark) {
            return { sessionId: found.bookmark.sessionId, workspacePath: found.bookmark.workspacePath, name: found.name };
        }
        return this.createNamed(contactKey, contactId, name);
    }
    /** 新建命名会话（真实 DSH 会话 + 微信书签），并切换过去。 */
    async createNamed(contactKey, contactId, name) {
        const reg = await this.store.get(contactKey);
        const workspace = await this.resolveWorkspace(reg);
        const sessionId = SessionId(`wechat-${safeKey(contactId)}-${name}-${randomUUID().slice(0, 4)}`);
        try {
            await this.api.createSession({ workspaceId: workspace.workspaceId, sessionId });
        }
        catch (error) {
            throw new Error(`新建会话失败：${error instanceof Error ? error.message : String(error)}`);
        }
        const bookmark = { sessionId: String(sessionId), workspacePath: workspace.path, createdAt: Date.now() };
        reg.sessions[name] = bookmark;
        reg.currentSessionName = name;
        await this.store.save(contactKey, reg);
        return { sessionId: String(sessionId), workspacePath: workspace.path, name };
    }
    /** 切换书签（main 永可选；无书签时 main 走 ensureCurrent 懒创建）。 */
    async switchTo(contactKey, name) {
        const reg = await this.store.get(contactKey);
        const found = this.store.find(reg, name);
        if (!found)
            throw new Error(`会话「${name}」不存在（/new ${name} 新建，或 /sessions 查看列表）`);
        if (!found.bookmark) {
            // main 无书签：懒创建
            return this.createNamed(contactKey, '', DEFAULT_SESSION);
        }
        reg.currentSessionName = found.name;
        await this.store.save(contactKey, reg);
        return { sessionId: found.bookmark.sessionId, workspacePath: found.bookmark.workspacePath, name: found.name };
    }
    /** 把 Web 已存在的会话绑定为当前书签（不新建）。 */
    async attach(contactKey, sessionId, workspacePath, name) {
        const reg = await this.store.get(contactKey);
        const targetName = name && name !== DEFAULT_SESSION ? name : DEFAULT_SESSION;
        reg.sessions[targetName] = { sessionId, workspacePath, createdAt: Date.now() };
        reg.currentSessionName = targetName;
        await this.store.save(contactKey, reg);
        return { sessionId, workspacePath, name: targetName };
    }
    /** 删除书签（真实会话与日志保留，Web 仍可见可续）。 */
    async removeBookmark(contactKey, name) {
        const reg = await this.store.get(contactKey);
        const found = this.store.find(reg, name);
        if (!found)
            return;
        delete reg.sessions[found.name];
        if (reg.currentSessionName === found.name)
            reg.currentSessionName = DEFAULT_SESSION;
        await this.store.save(contactKey, reg);
    }
    /** 列出当前工作区的真实会话（与 Web 端一致：排除归档/空白/子代理；含标题与书签标记）。 */
    async listWorkspaceSessions(contactKey) {
        const reg = await this.store.get(contactKey);
        const workspace = await this.resolveWorkspace(reg);
        const { archivedSessionIds } = await this.api.listWorkspaces();
        const archived = new Set(archivedSessionIds.map((s) => String(s)));
        const summaries = await this.api.listSessions();
        const byId = new Map(summaries.map((s) => [String(s.sessionId), s]));
        const bookmarkBySession = new Map();
        for (const [name, bookmark] of Object.entries(reg.sessions)) {
            bookmarkBySession.set(bookmark.sessionId, name);
        }
        const rows = [];
        for (const sessionId of workspace.sessionIds ?? []) {
            const s = byId.get(String(sessionId));
            if (!s)
                continue;
            // 与 Web 端一致：隐藏空白、子代理、已归档会话
            if (s.blank || s.origin === 'subagent')
                continue;
            if (archived.has(String(sessionId)))
                continue;
            const bookmarkName = bookmarkBySession.get(String(sessionId));
            rows.push({
                sessionId: String(s.sessionId),
                updatedAt: s.updatedAt,
                running: s.running,
                blank: s.blank,
                cwd: s.cwd,
                ...readTitleOf(s) !== undefined ? { title: readTitleOf(s) } : {},
                bookmarked: bookmarkName !== undefined,
                ...bookmarkName !== undefined ? { bookmarkName } : {},
            });
        }
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        return rows;
    }
    // ------------------------------------------------------------------ agent
    /** 让会话的 agent 变为 live（宿主 resume），返回 live agent。 */
    async ensureAgentLive(sessionId) {
        const live = this.ctx.agents.get(SessionId(sessionId));
        if (live)
            return live;
        try {
            await this.api.sessionModels(sessionId); // agentFor：已持久化则 resume
        }
        catch (error) {
            throw new Error(`会话「${sessionId}」不可用：${error instanceof Error ? error.message : String(error)}`);
        }
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (!agent)
            throw new Error(`会话「${sessionId}」未能激活`);
        return agent;
    }
}
//# sourceMappingURL=sessions.js.map