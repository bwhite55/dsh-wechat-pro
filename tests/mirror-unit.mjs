/**
 * SessionMirror 单元测试：确定性驱动 session/event 序列，断言按
 * 「输出等级 × 回合发起者」的推送行为。使用 dist 构建产物，无需 harness。
 *
 * 用法：pnpm run build && node tests/mirror-unit.mjs
 */

import { SessionMirror } from '../dist/mirror.js'

let passed = 0
let failed = 0

function assert(cond, msg) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`❌ ${msg}`)
  }
}

function makeHarness({ streamLevel = 'normal', mirrorWebTurns = false, levelOfMap = {}, maxProcessPerTurn = 100, maxReplyChunks = 100, sendLongAsFile = null } = {}) {
  const sent = []
  const files = []
  const engine = {
    sendText: async (to, text) => sent.push({ to, text }),
    startTyping: async (to) => sent.push({ to, text: '__typing1__' }),
    stopTyping: async (to) => sent.push({ to, text: '__typing2__' }),
    streamAllowed: () => true,
  }
  const ctx = { on: () => {} } // SessionMirror 通过 ctx.on 注册 listener；我们直接调 route 不便，改从 start 收集
  let listener = null
  const collectCtx = { on: (ev, fn) => { if (ev === 'session/event') listener = fn } }
  const mirror = new SessionMirror(collectCtx, engine, {
    replyMaxChars: 3800,
    streamLevel,
    mirrorWebTurns,
    maxProcessPerTurn,
    maxReplyChunks,
    levelOf: (contactId) => levelOfMap[contactId] ?? streamLevel,
    ...sendLongAsFile !== null ? { sendLongAsFile: async (text, to) => { files.push({ text, to }) } } : {},
  })
  mirror.start()
  const session = { id: 's-test' }
  mirror.bind('s-test', 'contact-a')
  const emit = async (event) => {
    await listener(session, event)
  }
  return { engine, sent, files, emit }
}

const S = 's-test'

async function scenarioWechatNormal() {
  const h = makeHarness({})
  await h.emit({ type: 'turn/start', data: {} })
  await h.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'hi' }] } })
  await h.emit({ type: 'request/header', data: {} })
  await h.emit({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"ls"}' } })
  await h.emit({ type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } })
  await h.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终答复' }] } } })
  await h.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const texts = h.sent.map((x) => x.text)
  assert(texts.includes('🧠 开始处理…'), 'normal/微信回合：应发 🧠')
  assert(texts.includes('🤔 思考中…'), 'normal/微信回合：应发 🤔')
  assert(texts.some((t) => t.startsWith('🔧 调用工具 pwsh')), 'normal/微信回合：应发 🔧')
  assert(texts.some((t) => t.startsWith('✅ 工具完成 pwsh')), 'normal/微信回合：应发 ✅')
  assert(texts.includes('最终答复'), 'normal/微信回合：应发最终答复')
  console.log('✅ 场景1：微信发起 @ normal → 全量过程消息 + 最终答复')
}

async function scenarioWebQuiet() {
  const h = makeHarness({})
  await h.emit({ type: 'turn/start', data: {} })
  await h.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: 'web hi' }] } })
  await h.emit({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{}' } })
  await h.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'web 答复' }] } } })
  await h.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert(h.sent.length === 0, `Web 发起 @ mirrorWebTurns=false → 应零推送（实际 ${h.sent.length} 条）`)
  console.log('✅ 场景2：Web 发起 @ 默认 → 微信安静')
}

async function scenarioWebMirror() {
  const h = makeHarness({ mirrorWebTurns: true })
  await h.emit({ type: 'turn/start', data: {} })
  await h.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' }, content: [{ type: 'text', text: 'web hi' }] } })
  await h.emit({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{}' } })
  await h.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'web 答复' }] } } })
  await h.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const texts = h.sent.map((x) => x.text)
  assert(texts.includes('🧠 开始处理…') && texts.includes('web 答复'), 'mirrorWebTurns=true 时 Web 回合应推送')
  console.log('✅ 场景3：Web 发起 @ mirrorWebTurns=true → 推送')
}

async function scenarioMinimal() {
  const h = makeHarness({ levelOfMap: { 'contact-a': 'minimal' } })
  await h.emit({ type: 'turn/start', data: {} })
  await h.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'hi' }] } })
  await h.emit({ type: 'request/header', data: {} })
  await h.emit({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{}' } })
  await h.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答复' }] } } })
  await h.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const texts = h.sent.map((x) => x.text)
  assert(!texts.includes('🧠 开始处理…'), 'minimal：不应发 🧠')
  assert(!texts.some((t) => t.startsWith('🔧')), 'minimal：不应发 🔧')
  assert(!texts.some((t) => t.startsWith('✅')), 'minimal：不应发 ✅')
  assert(texts.includes('答复'), 'minimal：应发最终答复')
  console.log('✅ 场景4：微信发起 @ minimal → 只收最终答复')
}

async function scenarioError() {
  const h = makeHarness({ levelOfMap: { 'contact-a': 'minimal' } })
  await h.emit({ type: 'turn/start', data: {} })
  await h.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'hi' }] } })
  await h.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } })
  await h.emit({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: '模型炸了' } } } })
  const texts = h.sent.map((x) => x.text)
  assert(texts.some((t) => t.startsWith('⚠️ 模型炸了')), 'minimal + 出错 → 应发 ⚠️')
  console.log('✅ 场景5：minimal + 回合错误 → ⚠️ 仍推送')
}

async function scenarioVerbose() {
  const longArgs = '{"data":"' + 'x'.repeat(300) + '"}'
  const h = makeHarness({ levelOfMap: { 'contact-a': 'verbose' } })
  await h.emit({ type: 'turn/start', data: {} })
  await h.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'hi' }] } })
  await h.emit({ type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: longArgs } })
  await h.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
  await h.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const toolLine = h.sent.find((x) => x.text.startsWith('🔧'))
  assert(toolLine && toolLine.text.includes('x'.repeat(300)), 'verbose：工具参数应完整不截断')
  console.log('✅ 场景6：verbose → 完整工具参数')
}

async function scenarioProcessLimit() {
  const h = makeHarness({ maxProcessPerTurn: 3 })
  await h.emit({ type: 'turn/start', data: {} })
  await h.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'hi' }] } }) // 🧠 = 1
  await h.emit({ type: 'request/header', data: {} }) // 🤔 = 2
  await h.emit({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{}' } }) // 🔧 = 3
  await h.emit({ type: 'tool/call', data: { callId: 'c2', name: 'read', arguments: '{}' } }) // 超限 → 静默
  await h.emit({ type: 'tool/result', data: { message: { source: { callId: 'c2' }, content: [{ type: 'text', text: 'r' }] } } }) // 超限 → 静默
  await h.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终答复' }] } } })
  await h.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const texts = h.sent.map((x) => x.text)
  const processCount = texts.filter((t) => /^[🧠🤔🔧✅]/.test(t)).length
  assert(processCount === 3, `过程消息应限 3 条（实际 ${processCount}）`)
  assert(texts.includes('最终答复'), '超限后最终答复仍应发送')
  console.log('✅ 场景7：每回合过程消息上限（超限静默，最终答复不受限）')
}

async function scenarioChunkBudget() {
  // 超长回复 + 分片预算 1（minimal 无过程消息）→ 降级：只发首片 + 完整内容走文件（无分片标记）
  const h = makeHarness({ streamLevel: 'minimal', maxReplyChunks: 1, sendLongAsFile: true })
  const longText = '段'.repeat(9000) // 3800 上限下 3 片 > 预算 1
  await h.emit({ type: 'turn/start', data: {} })
  await h.emit({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: 'hi' }] } })
  await h.emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: longText }] } } })
  await h.emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const texts = h.sent.map((x) => x.text)
  const textSends = texts.filter((t) => t !== '__typing1__' && t !== '__typing2__')
  assert(textSends.length === 1, `超预算应只发首片 1 条文本（实际 ${textSends.length} 条）`)
  assert(!textSends.some((t) => /（\d+\/\d+）$/.test(t)), '超预算降级后不应有分片标记')
  assert(h.files.length === 1 && h.files[0].text === longText, '完整内容应落盘为文件')
  console.log('✅ 场景8：分片超预算 → 首片 + 文件（完整内容必达）')
}

async function main() {
  await scenarioWechatNormal()
  await scenarioWebQuiet()
  await scenarioWebMirror()
  await scenarioMinimal()
  await scenarioError()
  await scenarioVerbose()
  await scenarioProcessLimit()
  await scenarioChunkBudget()
  console.log(`\n${failed === 0 ? '🎉' : '❌'} 镜像单元测试：${passed} 通过 / ${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
