/**
 * harness 集成测试（e2e）—— 起一个侧路 dsh web（独立端口 + mock iLink + 隔离数据目录），
 * 从微信侧推送指令，断言宿主链路（apiProxy 建会话 / 命令层 / 流式回复）端到端工作。
 *
 * 用法（在装有 dsh 的机器上）：
 *   node tests/e2e-harness.mjs
 *
 * 环境：
 *   DSH_E2E_WEB_PORT   侧路端口（默认 3099）
 *   DSH_E2E_MOCK_PORT  mock 端口（默认 8898）
 *   DSH_E2E_TIMEOUT    总超时秒（默认 180）
 *
 * 注意：侧路实例共享 $DSH_HOME 的 profile 与会话存储；新建会话为空白会话
 * （无 turn），Web 会话列表默认隐藏空白会话，污染可忽略。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_PORT = Number(process.env.DSH_E2E_WEB_PORT ?? 3099)
const MOCK_PORT = Number(process.env.DSH_E2E_MOCK_PORT ?? 8898)
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_E2E_TIMEOUT ?? 180) * 1000
const startedAt = Date.now()

function deadline() {
  return TOTAL_TIMEOUT_MS - (Date.now() - startedAt)
}

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exitCode = 1
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  }
}

async function pushMessage(text, opts = {}) {
  const res = await fetch(`${MOCK_BASE}/__push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...opts }),
  })
  if (!res.ok) throw new Error(`/__push failed: ${res.status}`)
}

async function capturedTexts() {
  const data = await getJson(`${MOCK_BASE}/__captured`)
  if (!data) return []
  return data.captured
    .filter((c) => c.kind === 'sendmessage')
    .flatMap((c) => (c.items ?? []).filter((i) => i.type === 1).map((i) => String(i.text ?? '')))
}

async function waitFor(predicate, what, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await predicate()) return true
    await sleep(1500)
  }
  console.error(`⏱ 等待超时: ${what}`)
  return false
}

// ---------------------------------------------------------------------------

console.log(`[e2e] 起 mock-queue ilink (${MOCK_PORT})…`)
const mock = spawn(process.execPath, [path.join(__dirname, 'mock-queue.mjs'), '--port', String(MOCK_PORT)], {
  stdio: 'ignore',
  shell: false,
})
await sleep(1200)

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wxpro-e2e-'))
console.log(`[e2e] 数据目录: ${dataDir}`)

console.log(`[e2e] 起侧路 dsh web (--port ${WEB_PORT}, baseUrl → mock)…`)
// Windows 上 dsh 是 .cmd shim，Node 直接 spawn 需要走 shell（cmd /c）。
const win = process.platform === 'win32'
const dsh = spawn(win ? 'cmd' : 'dsh', win ? ['/c', 'dsh', 'web', '--port', String(WEB_PORT)] : ['web', '--port', String(WEB_PORT)], {
  cwd: __dirname,
  shell: false,
  env: {
    ...process.env,
    DSH_WXBOT_BASE_URL: MOCK_BASE,
    DSH_WXBOT_DATA_DIR: dataDir,
    DSH_WXBOT_ALLOW_FROM: '',
    DSH_WXBOT_NO_TYPING: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let bootLog = ''
dsh.stdout.on('data', (d) => { bootLog += d.toString('utf8') })
dsh.stderr.on('data', (d) => { bootLog += d.toString('utf8') })
dsh.on('error', (e) => { bootLog += `\n[spawn error] ${e.message}\n` })

async function shutdown(code = 0) {
  if (win) {
    try { spawn('taskkill', ['/pid', String(dsh.pid), '/T', '/F'], { stdio: 'ignore', shell: false }) } catch {}
  } else {
    dsh.kill('SIGTERM')
  }
  mock.kill()
  await sleep(2000)
  try { await rm(dataDir, { recursive: true, force: true }) } catch {}
  process.exit(code)
}

try {
  // 1) 等待插件路由就绪（dsh web 完整启动）
  const ready = await waitFor(
    async () => {
      const st = await getJson(`http://127.0.0.1:${WEB_PORT}/api/dsh-wechat-pro/status`)
      return st?.status?.state !== undefined
    },
    '插件路由 /api/dsh-wechat-pro/status',
    deadline(),
  )
  if (!ready) fail(`dsh web 未在期限内启动。启动日志尾部:\n${bootLog.slice(-2000)}`)

  // 2) 等待微信通道连上 mock（自动扫码确认）
  const connected = await waitFor(
    async () => {
      const st = await getJson(`http://127.0.0.1:${WEB_PORT}/api/dsh-wechat-pro/status`)
      return st?.status?.state === 'connected'
    },
    '微信通道 connected',
    deadline(),
  )
  if (!connected) fail(`微信通道未连接。状态: ${JSON.stringify(await getJson(`http://127.0.0.1:${WEB_PORT}/api/dsh-wechat-pro/status`))}\n日志尾部:\n${bootLog.slice(-2000)}`)

  // 3) 推送指令并断言回复
  const cases = [
    { push: '/help', expect: 'dsh-wechat-pro 指令' },
    { push: '/new demo1', expect: '已新建会话「demo1」' },
    { push: '/sessions', expect: '会话列表' },
    { push: '/workspace', expect: '当前工作区' },
    { push: '/status', expect: '模型' },
  ]
  for (const c of cases) {
    await pushMessage(c.push)
    const ok = await waitFor(
      async () => (await capturedTexts()).some((t) => t.includes(c.expect)),
      `回复包含「${c.expect}」（指令 ${c.push}）`,
      deadline(),
    )
    if (!ok) {
      const texts = (await capturedTexts()).join('\n  | ')
      fail(`未收到预期回复「${c.expect}」。已捕获回复:\n  | ${texts}\n日志尾部:\n${bootLog.slice(-2500)}`)
    }
    console.log(`✅ ${c.push} → ${c.expect}`)
  }

  console.log('\n🎉 harness 集成测试全部通过')
  await shutdown(0)
} catch (error) {
  fail(`e2e 异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n日志尾部:\n${bootLog.slice(-2500)}`)
}
