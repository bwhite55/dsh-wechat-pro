/**
 * 公共小工具：路径/键哈希、日志、文本工具、JSON 持久化。
 * 零依赖（Node 22+）。
 */
/** 稳定短哈希键（历史/注册表/媒体目录名），与旧 bridge 同款算法。 */
export declare function safeKey(value: string): string;
/** 清理用户可见 ID 中的换行/控制字符。 */
export declare function cleanChatId(chatId: string): string;
/** 截断到最近 n 字符并在前加省略号。 */
export declare function tail(s: string, n?: number): string;
/** 截断到 n 字符并加省略号。 */
export declare function clamp(s: string, n: number): string;
/** 掩码显示 ID。 */
export declare function mask(s: string | null | undefined, n?: number): string;
/** 带时间戳的 stderr 日志（不污染 dsh web 的 stdout 协议面）。 */
export declare function log(...a: unknown[]): void;
/** 简单超时包装。 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T>;
/** 原子写 JSON（tmp + rename）。 */
export declare function writeJsonAtomic(file: string, value: unknown): Promise<void>;
/** 读 JSON，失败返回 undefined。 */
export declare function readJson<T>(file: string): Promise<T | undefined>;
/** 从对象挑出非空字符串，否则取默认。 */
export declare function pickString(value: unknown, fallback: string): string;
//# sourceMappingURL=util.d.ts.map