/**
 * DeepSeek API 连通性监控（诊断用）：每 10s 一次真实请求，记录到文件。
 * 用法：node tests/api-monitor.mjs <输出文件> [分钟数]
 */
import { appendFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'

const out = process.argv[2] ?? 'D:/dsh-wechat-pro/api-monitor.log'
const minutes = Number(process.argv[3] ?? 6)
const cred = readFileSync('C:/Users/Administrator/.dsh/.credentials.yaml', 'utf8')
const m = cred.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)/)
if (!m) { console.error('no key'); process.exit(1) }
const key = m[1]

const log = (line) => { const s = `[${new Date().toISOString()}] ${line}\n`; appendFileSync(out, s); process.stderr.write(s) }

log(`监控启动：每 10s 一次，共 ${minutes} 分钟`)
const deadline = Date.now() + minutes * 60 * 1000
let ok = 0, fail = 0
while (Date.now() < deadline) {
  const body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, reasoning_effort: 'high' }
  const t0 = Date.now()
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const txt = await r.text()
    if (r.ok) { ok++; log(`OK   ${Date.now() - t0}ms (${ok}成功/${fail}失败)`) }
    else { fail++; log(`HTTP ${r.status} ${txt.slice(0, 100)} (${ok}成功/${fail}失败)`) }
  } catch (e) {
    fail++
    log(`FAIL ${e.cause?.code ?? e.message} (${ok}成功/${fail}失败)`)
  }
  await new Promise((r) => setTimeout(r, 10000))
}
log(`监控结束：成功 ${ok}，失败 ${fail}`)
process.exit(0)
