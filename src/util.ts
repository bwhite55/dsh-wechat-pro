/**
 * 公共小工具：路径/键哈希、日志、文本工具、JSON 持久化。
 * 零依赖（Node 22+）。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 稳定短哈希键（历史/注册表/媒体目录名），与旧 bridge 同款算法。 */
export function safeKey(value: string): string {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 16)
}

/** 清理用户可见 ID 中的换行/控制字符。 */
export function cleanChatId(chatId: string): string {
  return String(chatId).replace(/[\r\n\t]/g, ' ').slice(0, 64)
}

/** 截断到最近 n 字符并在前加省略号。 */
export function tail(s: string, n = 400): string {
  return s.length > n ? '…' + s.slice(-n) : s
}

/** 截断到 n 字符并加省略号。 */
export function clamp(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/** 掩码显示 ID。 */
export function mask(s: string | null | undefined, n = 6): string {
  if (typeof s !== 'string' || s.length === 0) return '(空)'
  return s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s
}

/** 带时间戳的 stderr 日志（不污染 dsh web 的 stdout 协议面）。 */
export function log(...a: unknown[]): void {
  process.stderr.write(`[wechat-pro ${new Date().toISOString()}] ${a.map((v) => String(v)).join(' ')}\n`)
}

/** 简单超时包装。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 原子写 JSON（tmp + rename）。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

/** 读 JSON，失败返回 undefined。 */
export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** 从对象挑出非空字符串，否则取默认。 */
export function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}
