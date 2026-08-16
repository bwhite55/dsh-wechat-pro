/**
 * iLink 媒体通道（发送 + 接收）。依据腾讯官方 @tencent-weixin/openclaw-weixin@2.4.6
 * 的 CDN 链路实现，移植自 dsh-wechat-bridge（MIT）。零依赖（Node 22+）。
 *
 * 发送链路:
 *   1. 读文件 → md5 → 生成 filekey/aeskey → client.getUploadUrl()
 *   2. AES-128-ECB(PKCS7) 加密 → POST 到 CDN，响应头 x-encrypted-param 即下载参数
 *   3. client.sendMessageItems() 发 sendmessage，item_list 携带 media ref
 *
 * 接收链路:
 *   item.media.encrypt_query_param → CDN download → AES-128-ECB 解密 → 落盘
 */
import type { IlinkClient } from './ilink.ts';
export declare const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export declare const MEDIA_MAX_BYTES: number;
/** proto: UploadMediaType */
export declare const UploadMediaType: Readonly<{
    IMAGE: 1;
    VIDEO: 2;
    FILE: 3;
    VOICE: 4;
}>;
/** proto: MessageItemType */
export declare const MessageItemType: Readonly<{
    NONE: 0;
    TEXT: 1;
    IMAGE: 2;
    VOICE: 3;
    FILE: 4;
    VIDEO: 5;
}>;
export declare function formatBytes(n: number): string;
export declare function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer;
export declare function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer;
/** AES-128-ECB 加密后大小（PKCS7 补齐到 16 字节边界）。 */
export declare function aesEcbPaddedSize(plaintextSize: number): number;
/**
 * 解析 CDNMedia.aes_key（base64 字符串）为 16 字节原始密钥。兼容两种实际编码：
 * base64(原始 16 字节) 或 base64(utf8(32 位 hex 字符串))。
 */
export declare function parseAesKey(aesKeyBase64: string, label?: string): Buffer;
export declare function getMimeFromFilename(filename: string): string;
/**
 * 通用上传管线: 读文件 → hash → 生成 aeskey → getUploadUrl → 加密上传 CDN。
 */
export declare function uploadMediaToCdn(opts: {
    client: IlinkClient;
    filePath: string;
    toUserId: string;
    mediaType: number;
    cdnBaseUrl?: string;
    label?: string;
    log?: (msg: string) => void;
}): Promise<{
    filekey: string;
    downloadEncryptedQueryParam: string;
    aeskeyHex: string;
    aesKeyBase64: string;
    fileSize: number;
    fileSizeCiphertext: number;
}>;
export interface SendMediaResult {
    clientId: string;
    kind: '图片' | '视频' | '文件';
    fileName: string;
    fileSize: number;
}
/**
 * 把本地文件上传并作为微信消息发出（自动按 MIME 选择图片/视频/文件）。
 * caption 会作为一条独立文本消息先发（与官方 SDK 行为一致）。
 */
export declare function sendMediaFile(opts: {
    client: IlinkClient;
    filePath: string;
    to: string;
    caption?: string;
    contextToken?: string;
    cdnBaseUrl?: string;
    log?: (msg: string) => void;
}): Promise<SendMediaResult>;
/** 下载并 AES-128-ECB 解密一个 CDN 媒体，返回明文 Buffer。 */
export declare function downloadAndDecrypt(opts: {
    encryptQueryParam?: string;
    aesKeyBase64?: string;
    fullUrl?: string;
    cdnBaseUrl?: string;
    label?: string;
    log?: (msg: string) => void;
}): Promise<Buffer>;
/** 下载明文（无密钥时）CDN 媒体，返回 Buffer。 */
export declare function downloadPlain(opts: {
    encryptQueryParam?: string;
    fullUrl?: string;
    cdnBaseUrl?: string;
    label?: string;
    log?: (msg: string) => void;
}): Promise<Buffer>;
export interface SavedMedia {
    savedPath: string;
    kind: '图片' | '语音' | '文件' | '视频';
    mediaType: string;
}
/**
 * 下载消息里单个媒体 item 并落盘到 saveDir。
 * 支持 image(2)/voice(3)/file(4)/video(5)。语音按官方逻辑存 .silk（不做转码）。
 */
export declare function downloadMediaFromItem(opts: {
    item: Record<string, unknown>;
    cdnBaseUrl?: string;
    saveDir: string;
    log?: (msg: string) => void;
}): Promise<SavedMedia | null>;
//# sourceMappingURL=media.d.ts.map