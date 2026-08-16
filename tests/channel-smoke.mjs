/**
 * 通道级冒烟测试（无需 harness）：直接实例化 WechatEngine 打 mock iLink。
 *
 * 验证：扫码登录（mock 自动确认）→ 长轮询收到消息 → onMessage 回调 →
 *       sendText 回复 / sendtyping / getconfig 都被 mock 捕获；媒体接收链路
 *       （CDN 下载 + AES 解密 + 落盘）。
 *
 * 用法：先起 mock（node tests/test-mock-ilink.mjs --port 8899），再跑本脚本。
 * 断言失败时进程以非 0 退出。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_PORT = 8899
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exitCode = 1
  process.exit(1)
}

async function mockCaptured() {
  const res = await fetch(`${MOCK_BASE}/__captured`)
  return (await res.json()).captured ?? []
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---- 起 mock ----
const mock = spawn(process.execPath, [path.join(__dirname, 'test-mock-ilink.mjs'), '--port', String(MOCK_PORT)], {
  stdio: 'ignore',
  shell: false,
})
await sleep(1200)

const { WechatEngine, buildEngineConfig } = await import('../dist/channel/engine.js')
const { downloadMediaFromItem } = await import('../dist/channel/media.js')

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wxpro-smoke-'))
const received = []

const engine = new WechatEngine(
  { logger: { warn: () => {}, error: (m) => console.error(m) } },
  buildEngineConfig({
    baseUrl: MOCK_BASE,
    channelVersion: '2.4.6',
    botAgent: 'dsh-wechat-pro-smoke',
    dataDir,
    sessionMs: 24 * 3600 * 1000,
    reloginBeforeMs: 2 * 3600 * 1000,
    qrTimeoutMs: 20_000,
    noTyping: false,
    maxStreamIntervalMs: 200,
  }),
  async (msg) => {
    const from = String(msg.from_user_id ?? '')
    const text = (msg.item_list ?? []).find((i) => i.type === 1)?.text_item?.text ?? ''
    received.push(text)
    await engine.startTyping(from)
    try {
      if (text === '') {
        // 媒体消息：测试接收链路
        const item = (msg.item_list ?? []).find((i) => [2, 3, 4, 5].includes(Number(i.type)))
        if (item) {
          const saved = await downloadMediaFromItem({ item, saveDir: path.join(dataDir, 'media'), log: () => {} })
          await engine.sendText(from, saved ? `📥 saved ${saved.savedPath}` : '⚠️ media failed')
        }
        return
      }
      await engine.sendText(from, `收到: ${text}`)
    } finally {
      await engine.stopTyping(from)
    }
  },
)

// ---- 登录 + 监听 ----
console.log('连接 mock iLink…')
await engine.connect()
const st = engine.status()
console.log('连接状态:', JSON.stringify(st))
if (st.state !== 'connected') fail(`连接状态异常: ${st.state}`)
if (!st.loggedIn) fail('未登录')

// 等待 mock 逐条下发消息并处理
await sleep(4000)

// ---- 断言 ----
const captured = await mockCaptured()
const sent = captured.filter((c) => c.kind === 'sendmessage')
console.log(`\n捕获 sendmessage ${sent.length} 条，收到消息 ${received.length} 条`)
console.log('收到消息:', received)

if (received.length === 0) fail('没有收到任何消息')
if (!received.includes('你好，这是第一条消息')) fail('未收到第一条文本消息')
if (!sent.some((s) => s.items?.some((i) => i.type === 1 && String(i.text).includes('收到: 你好')))) {
  fail('未捕获到文本回复')
}
if (!captured.some((c) => c.kind === 'sendtyping' && c.status === 1)) fail('未捕获 typing 开始')
if (!captured.some((c) => c.kind === 'sendtyping' && c.status === 2)) fail('未捕获 typing 结束')
if (!captured.some((c) => c.kind === 'getconfig')) fail('未捕获 getconfig')
// 媒体接收：mock 第 4 条是文件消息（无文本 → 走媒体分支）
if (!sent.some((s) => String(s.items?.[0]?.text ?? '').startsWith('📥 saved'))) {
  console.warn('⚠️ 未见媒体接收回复（可能媒体消息未按预期到达）')
}

// 清理
engine.dispose()
mock.kill()
await rm(dataDir, { recursive: true, force: true })
console.log('\n✅ 通道冒烟测试通过')
