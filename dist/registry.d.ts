/**
 * 每联系人的持久化状态（dataDir/contacts/<key>.json）：
 * - 当前工作区路径（微信侧指针，指到宿主的注册工作区目录）；
 * - 命名会话书签 name -> { sessionId, workspacePath }（sessionId 是真实 DSH 会话，
 *   可在 Web 会话列表看到并可跨端续接；书签只是微信侧的名字映射）。
 * 文件损坏时安全回落默认值，绝不中断消息处理。
 */
export declare const DEFAULT_SESSION = "main";
export declare function normalizeName(name: string): string;
export declare function nameOk(name: string): boolean;
export interface SessionBookmark {
    sessionId: string;
    workspacePath: string;
    createdAt: number;
}
export interface ContactRegistry {
    currentWorkspacePath: string;
    currentSessionName: string;
    sessions: Record<string, SessionBookmark>;
    /** 联系人级输出等级覆盖（minimal/normal/verbose；缺省回落全局配置）。 */
    streamLevel?: string;
}
export declare function contactKeyFor(from: string): string;
export declare function emptyRegistry(): ContactRegistry;
export declare class ContactStore {
    private readonly dataDir;
    private readonly cache;
    constructor(dataDir: string);
    private fileFor;
    get(key: string): Promise<ContactRegistry>;
    save(key: string, reg: ContactRegistry): Promise<void>;
    /** 同步读缓存中的注册表（未加载返回 undefined；供镜像等级等热路径使用）。 */
    peek(key: string): ContactRegistry | undefined;
    /** 找书签（大小写不敏感；main 永远视为存在但可无 sessionId）。 */
    find(reg: ContactRegistry, name: string): {
        name: string;
        bookmark?: SessionBookmark;
    } | null;
}
//# sourceMappingURL=registry.d.ts.map