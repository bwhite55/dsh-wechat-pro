/**
 * 真实模型 e2e（需 DEEPSEEK_API_KEY；消耗少量 API 配额）：
 * 侧路 dsh web + mock iLink，覆盖命令层之外的三条链路：
 *   1) 真实对话 + 流式镜像（过程消息 🧠/🔧/✅ + 最终答复 + 长文分片）；
 *   2) 工具审批转发微信（/permission workspace-write → 越权写盘 → 微信允许/拒绝）；
 *   3) /model 切换（宿主 models/selectModel，下一轮生效）。
 *
 * 用法：node tests/e2e-chat.mjs
 * 环境：DSH_E2E_WEB_PORT / DSH_E2E_MOCK_PORT / DSH_E2E_TIMEOUT
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
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_E2E_TIMEOUT ?? 420) * 1000
const REPLY_MAX = 120 // 强制分片：正常回复都会超过
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

/** 循环应答所有出现过的审批提示（模型可能多步调用触发多次审批）。 */
async function allowAllApprovals(allowedTokens) {
  const texts = await capturedTexts()
  for (const t of texts) {
    const m = t.match(/允许 ([a-z0-9]{4})/)
    if (!m) continue
    const token = m[1]
    if (allowedTokens.has(token)) continue
    allowedTokens.add(token)
    console.log(`  → 自动应答审批 ${token}`)
    await pushMessage(`允许 ${token}`)
  }
}

async function waitFor(predicate, what, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await predicate()) return true
    await sleep(2000)
  }
  console.error(`⏱ 等待超时: ${what}`)
  return false
}

// ---------------------------------------------------------------------------

console.log(`[e2e-chat] 起 mock-queue ilink (${MOCK_PORT})…`)
const mock = spawn(process.execPath, [path.join(__dirname, 'mock-queue.mjs'), '--port', String(MOCK_PORT)], {
  stdio: 'ignore',
  shell: false,
})
await sleep(1200)

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wxpro-e2echat-'))
console.log(`[e2e-chat] 数据目录: ${dataDir}`)

const win = process.platform === 'win32'
console.log(`[e2e-chat] 起侧路 dsh web (--port ${WEB_PORT}, baseUrl → mock, REPLY_MAX=${REPLY_MAX})…`)
const dsh = spawn(win ? 'cmd' : 'dsh', win ? ['/c', 'dsh', 'web', '--port', String(WEB_PORT)] : ['web', '--port', String(WEB_PORT)], {
  cwd: __dirname,
  shell: false,
  env: {
    ...process.env,
    DSH_WXBOT_BASE_URL: MOCK_BASE,
    DSH_WXBOT_DATA_DIR: dataDir,
    DSH_WXBOT_ALLOW_FROM: '',
    DSH_WXBOT_NO_TYPING: '1',
    DSH_WXBOT_REPLY_MAX: String(REPLY_MAX),
    DSH_WXBOT_MAX_CHUNKS: '20',
    DSH_WXBOT_REPLY_TIMEOUT_MS: '180000',
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
  try { await rm('C:\\dsh-approval-test-e2e.txt', { force: true }) } catch {}
  process.exit(code)
}

try {
  const ready = await waitFor(
    async () => (await getJson(`http://127.0.0.1:${WEB_PORT}/api/dsh-wechat-pro/status`))?.status?.state !== undefined,
    '插件路由就绪',
    deadline(),
  )
  if (!ready) fail(`dsh web 未就绪:\n${bootLog.slice(-2000)}`)

  const connected = await waitFor(
    async () => (await getJson(`http://127.0.0.1:${WEB_PORT}/api/dsh-wechat-pro/status`))?.status?.state === 'connected',
    '微信通道 connected',
    deadline(),
  )
  if (!connected) fail('微信通道未连接')

  // ---- 1) 建会话 + 权限预设 ----
  await pushMessage('/new ptest')
  if (!(await waitFor(async () => (await capturedTexts()).some((t) => t.includes('已新建会话「ptest」')), '/new ptest', deadline()))) {
    fail('新建会话失败')
  }
  console.log('✅ /new ptest')

  await pushMessage('/permission workspace-write')
  if (!(await waitFor(async () => (await capturedTexts()).some((t) => t.includes('preset workspace-write')), '/permission workspace-write', deadline()))) {
    fail('权限预设切换失败（原生 /permission 透传）')
  }
  console.log('✅ /permission workspace-write（原生透传）')

  // ---- 2) 审批转发：越权写盘 → 微信允许 ----
  const targetFile = 'C:\\dsh-approval-test-e2e.txt' // 固定路径，结束时清理
  const allowedTokens = new Set()
  await pushMessage(`请用工具执行：把文本 hello-dsh-pro 写入文件 ${targetFile}，然后只回复“写入完成”。不要做其他任何事。`)
  const approvalPrompt = await waitFor(
    async () => { await allowAllApprovals(allowedTokens); return (await capturedTexts()).some((t) => t.includes('🔐 需要审批')) },
    '审批提示到达微信',
    deadline(),
  )
  if (!approvalPrompt) fail(`未见审批提示。已捕获回复:\n${(await capturedTexts()).join('\n| ')}\n日志尾部:\n${bootLog.slice(-2500)}`)
  console.log('✅ 审批提示到达微信')

  // 持续应答审批 + 等待模型最终回复
  const finalOk = await waitFor(
    async () => {
      await allowAllApprovals(allowedTokens)
      return (await capturedTexts()).some((t) => t.includes('写入完成'))
    },
    '模型最终回复',
    deadline(),
  )
  if (!finalOk) {
    const tail = (await capturedTexts()).slice(-15).join('\n| ')
    fail(`未收到模型最终回复。最近回复:\n| ${tail}\n日志尾部:\n${bootLog.slice(-2500)}`)
  }
  console.log('✅ 微信回复「允许」→ 工具放行 → 模型最终回复')

  // ---- 3) 长文分片 ----
  await pushMessage('请用中文列出 1 到 60，每行一个数字，并把这些数字的中文名称也写出来，最后总结。')
  if (!(await waitFor(async () => (await capturedTexts()).some((t) => /（\d+\/\d+）$/.test(t)), '分片标记（N/M）', deadline()))) {
    const tail = (await capturedTexts()).slice(-8).join('\n| ')
    fail(`未见长文分片标记（REPLY_MAX=${REPLY_MAX}）。最近回复:\n| ${tail}`)
  }
  console.log('✅ 长文分片输出')

  // ---- 4) /model 切换 ----
  await pushMessage('/model')
  if (!(await waitFor(async () => (await capturedTexts()).some((t) => t.includes('当前模型')), '/model 列表', deadline()))) {
    fail('/model 未返回模型列表')
  }
  await pushMessage('1')
  if (!(await waitFor(async () => (await capturedTexts()).some((t) => t.includes('已切换模型')), '/model 选择生效', deadline()))) {
    fail('/model 选择未生效')
  }
  console.log('✅ /model 切换（宿主 selectModel）')

  console.log('\n🎉 e2e-chat（真实模型 + 流式 + 审批 + 分片 + 模型切换）全部通过')
  await shutdown(0)
} catch (error) {
  fail(`e2e-chat 异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n日志尾部:\n${bootLog.slice(-2500)}`)
}
