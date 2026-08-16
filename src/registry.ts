/**
 * 每联系人的持久化状态（dataDir/contacts/<key>.json）：
 * - 当前工作区路径（微信侧指针，指到宿主的注册工作区目录）；
 * - 命名会话书签 name -> { sessionId, workspacePath }（sessionId 是真实 DSH 会话，
 *   可在 Web 会话列表看到并可跨端续接；书签只是微信侧的名字映射）。
 * 文件损坏时安全回落默认值，绝不中断消息处理。
 */

import path from 'node:path'
import { readJson, safeKey, writeJsonAtomic } from './util.ts'

export const DEFAULT_SESSION = 'main'

const NAME_RE = /^[\p{L}\p{N}_.\-]{1,20}$/u

export function normalizeName(name: string): string {
  return String(name ?? '').trim()
}

export function nameOk(name: string): boolean {
  const n = normalizeName(name)
  return n.length > 0 && NAME_RE.test(n)
}

export interface SessionBookmark {
  sessionId: string
  workspacePath: string
  createdAt: number
}

export interface ContactRegistry {
  currentWorkspacePath: string
  currentSessionName: string
  sessions: Record<string, SessionBookmark>
  /** 联系人级输出等级覆盖（minimal/normal/verbose；缺省回落全局配置）。 */
  streamLevel?: string
}

export function contactKeyFor(from: string): string {
  return safeKey(`wx:${from}`)
}

export function emptyRegistry(): ContactRegistry {
  return { currentWorkspacePath: '', currentSessionName: DEFAULT_SESSION, sessions: {} }
}

export class ContactStore {
  private readonly cache = new Map<string, ContactRegistry>()

  constructor(private readonly dataDir: string) {}

  private fileFor(key: string): string {
    return path.join(this.dataDir, 'contacts', `${key}.json`)
  }

  async get(key: string): Promise<ContactRegistry> {
    const hit = this.cache.get(key)
    if (hit) return hit
    const raw = await readJson<Partial<ContactRegistry>>(this.fileFor(key))
    const reg: ContactRegistry = {
      currentWorkspacePath: typeof raw?.currentWorkspacePath === 'string' ? raw.currentWorkspacePath : '',
      currentSessionName: normalizeName(raw?.currentSessionName ?? '') || DEFAULT_SESSION,
      sessions: raw?.sessions !== null && typeof raw?.sessions === 'object' && !Array.isArray(raw?.sessions)
        ? raw.sessions as Record<string, SessionBookmark>
        : {},
      ...typeof raw?.streamLevel === 'string' && raw.streamLevel !== '' ? { streamLevel: raw.streamLevel } : {},
    }
    if (reg.currentSessionName !== DEFAULT_SESSION && !reg.sessions[reg.currentSessionName]) {
      reg.currentSessionName = DEFAULT_SESSION
    }
    this.cache.set(key, reg)
    return reg
  }

  async save(key: string, reg: ContactRegistry): Promise<void> {
    this.cache.set(key, reg)
    await writeJsonAtomic(this.fileFor(key), reg)
  }

  /** 同步读缓存中的注册表（未加载返回 undefined；供镜像等级等热路径使用）。 */
  peek(key: string): ContactRegistry | undefined {
    return this.cache.get(key)
  }

  /** 找书签（大小写不敏感；main 永远视为存在但可无 sessionId）。 */
  find(reg: ContactRegistry, name: string): { name: string; bookmark?: SessionBookmark } | null {
    const n = normalizeName(name)
    if (n.toLowerCase() === DEFAULT_SESSION) {
      const bookmark = reg.sessions[DEFAULT_SESSION]
      return bookmark ? { name: DEFAULT_SESSION, bookmark } : { name: DEFAULT_SESSION }
    }
    const entry = reg.sessions[n]
    if (entry) return { name: n, bookmark: entry }
    const hit = Object.keys(reg.sessions).find((k) => k.toLowerCase() === n.toLowerCase())
    if (hit) return { name: hit, bookmark: reg.sessions[hit] }
    return null
  }
}
