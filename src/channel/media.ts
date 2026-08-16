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

import crypto from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { IlinkClient } from './ilink.ts'

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024 // 与官方 SDK 一致
const UPLOAD_MAX_RETRIES = 3
const UPLOAD_TIMEOUT_MS = 60_000

/** proto: UploadMediaType */
export const UploadMediaType = Object.freeze({ IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 })
/** proto: MessageItemType */
export const MessageItemType = Object.freeze({ NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 })

export function formatBytes(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

// ---------------------------------------------------------------------------
// 密码学（与官方 SDK aes-ecb.ts 一致）
// ---------------------------------------------------------------------------

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** AES-128-ECB 加密后大小（PKCS7 补齐到 16 字节边界）。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

/**
 * 解析 CDNMedia.aes_key（base64 字符串）为 16 字节原始密钥。兼容两种实际编码：
 * base64(原始 16 字节) 或 base64(utf8(32 位 hex 字符串))。
 */
export function parseAesKey(aesKeyBase64: string, label = 'parseAesKey'): Buffer {
  const decoded = Buffer.from(String(aesKeyBase64 ?? ''), 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(`${label}: aes_key 必须解出 16 字节或 32 位 hex，实际 ${decoded.length} 字节`)
}

// ---------------------------------------------------------------------------
// MIME（与官方 SDK mime.ts 一致的常用表）
// ---------------------------------------------------------------------------

const EXTENSION_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

export function getMimeFromFilename(filename: string): string {
  const ext = path.extname(String(filename)).toLowerCase()
  return EXTENSION_TO_MIME[ext] ?? 'application/octet-stream'
}

/** 按文件头魔数嗅探图片扩展名（收图片时 CDN 不给出文件名）。 */
function guessImageExt(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'GIF87a') return '.gif'
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'GIF89a') return '.gif'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp'
  return '.jpg'
}

function sanitizeFileName(name: string): string {
  return String(name ?? 'file.bin').replace(/[\\/:*?"<>|\r\n\0]/g, '_').slice(0, 128) || 'file.bin'
}

// ---------------------------------------------------------------------------
// CDN 上传
// ---------------------------------------------------------------------------

async function cdnUpload(opts: {
  ciphertext: Buffer
  uploadFullUrl?: string
  uploadParam?: string
  filekey: string
  cdnBaseUrl: string
  label: string
  log: (msg: string) => void
}): Promise<string> {
  const { ciphertext, filekey, cdnBaseUrl, label, log } = opts
  const trimmedFull = opts.uploadFullUrl?.trim()
  let url: string
  if (trimmedFull) {
    url = trimmedFull
  } else if (opts.uploadParam) {
    url = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(opts.uploadParam)}&filekey=${encodeURIComponent(filekey)}`
  } else {
    throw new Error(`${label}: CDN 上传地址缺失（需要 upload_full_url 或 upload_param）`)
  }
  log(`${label}: CDN POST ${url} ciphertext=${ciphertext.length} bytes`)

  let downloadParam: string | undefined
  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(t)
      }
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text().catch(() => '(unreadable)'))
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`)
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`
        throw new Error(`CDN upload server error: ${errMsg}`)
      }
      downloadParam = res.headers.get('x-encrypted-param') ?? undefined
      if (!downloadParam) throw new Error('CDN upload 响应缺少 x-encrypted-param 头')
      break
    } catch (err) {
      lastError = err
      if (err instanceof Error && err.message.includes('client error')) throw err // 4xx 不重试
      if (attempt < UPLOAD_MAX_RETRIES) {
        log(`${label}: 第 ${attempt} 次上传失败，重试… error=${err instanceof Error ? err.message : String(err)}`)
      } else {
        log(`${label}: ${UPLOAD_MAX_RETRIES} 次上传均失败 error=${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error(`CDN upload 失败（${UPLOAD_MAX_RETRIES} 次重试后仍无 x-encrypted-param）`)
  }
  return downloadParam
}

/**
 * 通用上传管线: 读文件 → hash → 生成 aeskey → getUploadUrl → 加密上传 CDN。
 */
export async function uploadMediaToCdn(opts: {
  client: IlinkClient
  filePath: string
  toUserId: string
  mediaType: number
  cdnBaseUrl?: string
  label?: string
  log?: (msg: string) => void
}): Promise<{
  filekey: string
  downloadEncryptedQueryParam: string
  aeskeyHex: string
  aesKeyBase64: string
  fileSize: number
  fileSizeCiphertext: number
}> {
  const { client, filePath, toUserId, mediaType } = opts
  const cdnBaseUrl = opts.cdnBaseUrl ?? CDN_BASE_URL
  const label = opts.label ?? 'uploadMediaToCdn'
  const log = opts.log ?? (() => {})
  const st = await stat(filePath)
  if (!st.isFile()) throw new Error(`${label}: 不是文件: ${filePath}`)
  if (st.size > MEDIA_MAX_BYTES) throw new Error(`${label}: 文件超过 ${formatBytes(MEDIA_MAX_BYTES)} 上限: ${formatBytes(st.size)}`)
  const plaintext = await readFile(filePath)

  const rawsize = plaintext.length
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = crypto.randomBytes(16).toString('hex')
  const aeskey = crypto.randomBytes(16)
  const aeskeyHex = aeskey.toString('hex')

  log(`${label}: file=${filePath} rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5} filekey=${filekey}`)

  const resp = await client.getUploadUrl({
    filekey,
    mediaType,
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskeyHex,
    noNeedThumb: true,
  })
  if (!resp.uploadFullUrl && !resp.uploadParam) {
    throw new Error(`${label}: getUploadUrl 未返回上传地址 (upload_full_url / upload_param 均缺失)`)
  }

  const downloadEncryptedQueryParam = await cdnUpload({
    ciphertext: encryptAesEcb(plaintext, aeskey),
    uploadFullUrl: resp.uploadFullUrl,
    uploadParam: resp.uploadParam,
    filekey,
    cdnBaseUrl,
    label,
    log,
  })

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskeyHex,
    aesKeyBase64: Buffer.from(aeskeyHex, 'utf8').toString('base64'), // 消息体里 aes_key 的编码
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  }
}

// ---------------------------------------------------------------------------
// 发送：把本地文件变成微信消息
// ---------------------------------------------------------------------------

function mediaRef(uploaded: { downloadEncryptedQueryParam: string; aesKeyBase64: string }): Record<string, unknown> {
  return {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: uploaded.aesKeyBase64,
    encrypt_type: 1,
  }
}

export interface SendMediaResult {
  clientId: string
  kind: '图片' | '视频' | '文件'
  fileName: string
  fileSize: number
}

/**
 * 把本地文件上传并作为微信消息发出（自动按 MIME 选择图片/视频/文件）。
 * caption 会作为一条独立文本消息先发（与官方 SDK 行为一致）。
 */
export async function sendMediaFile(opts: {
  client: IlinkClient
  filePath: string
  to: string
  caption?: string
  contextToken?: string
  cdnBaseUrl?: string
  log?: (msg: string) => void
}): Promise<SendMediaResult> {
  const { client, filePath, to, caption, contextToken } = opts
  const cdnBaseUrl = opts.cdnBaseUrl ?? CDN_BASE_URL
  const log = opts.log ?? (() => {})
  const mime = getMimeFromFilename(filePath)
  const fileName = path.basename(filePath)

  let mediaType: number
  let kind: SendMediaResult['kind']
  let item: Record<string, unknown>
  if (mime.startsWith('image/')) {
    mediaType = UploadMediaType.IMAGE
    kind = '图片'
  } else if (mime.startsWith('video/')) {
    mediaType = UploadMediaType.VIDEO
    kind = '视频'
  } else {
    mediaType = UploadMediaType.FILE
    kind = '文件'
  }

  const uploaded = await uploadMediaToCdn({
    client,
    filePath,
    toUserId: to,
    mediaType,
    cdnBaseUrl,
    label: `sendMediaFile(${fileName})`,
    log,
  })

  if (mediaType === UploadMediaType.IMAGE) {
    item = {
      type: MessageItemType.IMAGE,
      image_item: { media: mediaRef(uploaded), mid_size: uploaded.fileSizeCiphertext },
    }
  } else if (mediaType === UploadMediaType.VIDEO) {
    item = {
      type: MessageItemType.VIDEO,
      video_item: { media: mediaRef(uploaded), video_size: uploaded.fileSizeCiphertext },
    }
  } else {
    item = {
      type: MessageItemType.FILE,
      file_item: { media: mediaRef(uploaded), file_name: fileName, len: String(uploaded.fileSize) },
    }
  }

  if (caption) {
    await client.sendMessageItems({
      to,
      contextToken,
      itemList: [{ type: MessageItemType.TEXT, text_item: { text: caption } }],
    })
  }
  const { clientId } = await client.sendMessageItems({ to, contextToken, itemList: [item] })
  log(`sendMediaFile: ${kind} ${fileName} (${formatBytes(uploaded.fileSize)}) 已发送 to=${to} clientId=${clientId}`)
  return { clientId, kind, fileName, fileSize: uploaded.fileSize }
}

// ---------------------------------------------------------------------------
// 接收：下载 + 解密 + 落盘
// ---------------------------------------------------------------------------

async function fetchCdnBytes(url: string, label: string, log: (msg: string) => void): Promise<Buffer> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    throw new Error(`${label}: CDN 下载网络错误 url=${url} err=${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)')
    throw new Error(`${label}: CDN 下载 ${res.status} ${res.statusText} body=${body.slice(0, 200)}`)
  }
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MEDIA_MAX_BYTES) throw new Error(`${label}: 媒体超过 ${formatBytes(MEDIA_MAX_BYTES)} 上限（content-length=${len}）`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MEDIA_MAX_BYTES) throw new Error(`${label}: 媒体超过 ${formatBytes(MEDIA_MAX_BYTES)} 上限（实际 ${buf.length}）`)
  return buf
}

/** 下载并 AES-128-ECB 解密一个 CDN 媒体，返回明文 Buffer。 */
export async function downloadAndDecrypt(opts: {
  encryptQueryParam?: string
  aesKeyBase64?: string
  fullUrl?: string
  cdnBaseUrl?: string
  label?: string
  log?: (msg: string) => void
}): Promise<Buffer> {
  const { encryptQueryParam, aesKeyBase64, fullUrl } = opts
  const cdnBaseUrl = opts.cdnBaseUrl ?? CDN_BASE_URL
  const label = opts.label ?? 'downloadAndDecrypt'
  const log = opts.log ?? (() => {})
  if (!aesKeyBase64) throw new Error(`${label}: 缺少 aes_key`)
  const key = parseAesKey(aesKeyBase64, label)
  const url = fullUrl
    ? fullUrl
    : `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam ?? '')}`
  log(`${label}: GET ${url}`)
  const encrypted = await fetchCdnBytes(url, label, log)
  return decryptAesEcb(encrypted, key)
}

/** 下载明文（无密钥时）CDN 媒体，返回 Buffer。 */
export async function downloadPlain(opts: {
  encryptQueryParam?: string
  fullUrl?: string
  cdnBaseUrl?: string
  label?: string
  log?: (msg: string) => void
}): Promise<Buffer> {
  const { encryptQueryParam, fullUrl } = opts
  const cdnBaseUrl = opts.cdnBaseUrl ?? CDN_BASE_URL
  const label = opts.label ?? 'downloadPlain'
  const log = opts.log ?? (() => {})
  const url = fullUrl
    ? fullUrl
    : `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam ?? '')}`
  log(`${label}: GET ${url}`)
  return fetchCdnBytes(url, label, log)
}

export interface SavedMedia {
  savedPath: string
  kind: '图片' | '语音' | '文件' | '视频'
  mediaType: string
}

/**
 * 下载消息里单个媒体 item 并落盘到 saveDir。
 * 支持 image(2)/voice(3)/file(4)/video(5)。语音按官方逻辑存 .silk（不做转码）。
 */
export async function downloadMediaFromItem(opts: {
  item: Record<string, unknown>
  cdnBaseUrl?: string
  saveDir: string
  log?: (msg: string) => void
}): Promise<SavedMedia | null> {
  const { item, saveDir } = opts
  const cdnBaseUrl = opts.cdnBaseUrl ?? CDN_BASE_URL
  const log = opts.log ?? (() => {})
  await mkdir(saveDir, { recursive: true })
  const ts = Date.now()
  const label = `downloadMedia(type=${String(item?.type)})`

  const hasRef = (m: Record<string, unknown> | undefined): boolean =>
    Boolean(m && (typeof m.encrypt_query_param === 'string' || typeof m.full_url === 'string'))

  try {
    if (item?.type === MessageItemType.IMAGE) {
      const img = (item.image_item ?? {}) as Record<string, unknown>
      const media = (img.media ?? {}) as Record<string, unknown>
      if (!hasRef(media)) return null
      // 收图时 aes_key 可能在 image_item.aeskey(hex) 或 media.aes_key(base64)
      const aesKeyBase64 = typeof img.aeskey === 'string'
        ? Buffer.from(img.aeskey, 'hex').toString('base64')
        : typeof media.aes_key === 'string' ? media.aes_key : undefined
      const buf = aesKeyBase64
        ? await downloadAndDecrypt({ aesKeyBase64, fullUrl: optStr(media.full_url), encryptQueryParam: optStr(media.encrypt_query_param), cdnBaseUrl, label: `${label} image`, log })
        : await downloadPlain({ fullUrl: optStr(media.full_url), encryptQueryParam: optStr(media.encrypt_query_param), cdnBaseUrl, label: `${label} image-plain`, log })
      const savedPath = path.join(saveDir, `wx-image-${ts}${guessImageExt(buf)}`)
      await writeFile(savedPath, buf)
      log(`${label}: image saved ${savedPath} (${formatBytes(buf.length)})`)
      return { savedPath, kind: '图片', mediaType: 'image' }
    }

    if (item?.type === MessageItemType.VOICE) {
      const voice = (item.voice_item ?? {}) as Record<string, unknown>
      const media = (voice.media ?? {}) as Record<string, unknown>
      if (!hasRef(media) || typeof media.aes_key !== 'string') return null
      const buf = await downloadAndDecrypt({ aesKeyBase64: media.aes_key, fullUrl: optStr(media.full_url), encryptQueryParam: optStr(media.encrypt_query_param), cdnBaseUrl, label: `${label} voice`, log })
      const savedPath = path.join(saveDir, `wx-voice-${ts}.silk`)
      await writeFile(savedPath, buf)
      log(`${label}: voice saved ${savedPath} (${formatBytes(buf.length)})`)
      return { savedPath, kind: '语音', mediaType: 'audio/silk' }
    }

    if (item?.type === MessageItemType.FILE) {
      const f = (item.file_item ?? {}) as Record<string, unknown>
      const media = (f.media ?? {}) as Record<string, unknown>
      if (!hasRef(media) || typeof media.aes_key !== 'string') return null
      const buf = await downloadAndDecrypt({ aesKeyBase64: media.aes_key, fullUrl: optStr(media.full_url), encryptQueryParam: optStr(media.encrypt_query_param), cdnBaseUrl, label: `${label} file`, log })
      const savedPath = path.join(saveDir, sanitizeFileName(typeof f.file_name === 'string' ? f.file_name : `wx-file-${ts}.bin`))
      await writeFile(savedPath, buf)
      log(`${label}: file saved ${savedPath} (${formatBytes(buf.length)})`)
      return { savedPath, kind: '文件', mediaType: getMimeFromFilename(savedPath) }
    }

    if (item?.type === MessageItemType.VIDEO) {
      const v = (item.video_item ?? {}) as Record<string, unknown>
      const media = (v.media ?? {}) as Record<string, unknown>
      if (!hasRef(media) || typeof media.aes_key !== 'string') return null
      const buf = await downloadAndDecrypt({ aesKeyBase64: media.aes_key, fullUrl: optStr(media.full_url), encryptQueryParam: optStr(media.encrypt_query_param), cdnBaseUrl, label: `${label} video`, log })
      const savedPath = path.join(saveDir, `wx-video-${ts}.mp4`)
      await writeFile(savedPath, buf)
      log(`${label}: video saved ${savedPath} (${formatBytes(buf.length)})`)
      return { savedPath, kind: '视频', mediaType: 'video/mp4' }
    }
  } catch (err) {
    log(`${label}: 下载/解密失败 err=${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  return null
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}
