/**
 * ApprovalForwarder 单元测试：验证微信审批快捷回复（/yes /no）与精确回复（允许/拒绝 <码>）。
 * 使用 dist 构建产物，无需 harness。
 *
 * 用法：pnpm run build && node tests/approval-unit.mjs
 */

import { ApprovalForwarder } from '../dist/approval.js'

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) passed++
  else { failed++; console.error(`❌ ${msg}`) }
}

function makeHarness() {
  const sent = []
  const engine = {
    sendText: async (to, text) => sent.push({ to, text }),
    startTyping: async () => {},
    stopTyping: async () => {},
    streamAllowed: () => true,
    getLastSender: () => null,
    status: () => ({ state: 'connected', loggedIn: true }),
    contextTokenOf: () => undefined,
    reconnect: () => {},
    sendItems: async () => {},
    sendMediaFile: async () => {},
    getTypingTicket: async () => '',
    sendTypingStatus: async () => {},
  }
  let listener = null
  const ctx = { on: (ev, fn) => { if (ev === 'approval/request') listener = fn } }
  const mirror = { contactsOf: () => ['contact-a'], bind: () => {}, unbind: () => {}, isBound: () => true }
  const fw = new ApprovalForwarder(ctx, engine, mirror)
  fw.start()
  /** 触发一次审批，返回 { outcome, request }。 */
  const trigger = (toolName, reason = '跨目录写入') => {
    const controller = new AbortController()
    const request = { agent: { session: { id: 's1' } }, toolName, reason, signal: controller.signal }
    const outcome = listener(request, () => Promise.resolve('unavailable'))
    return { outcome, controller }
  }
  return { sent, fw, trigger }
}

async function main() {
  // ---- 场景1：/yes 快捷允许 ----
  {
    const h = makeHarness()
    const { outcome } = h.trigger('pwsh')
    await new Promise((r) => setTimeout(r, 20))
    const prompt = h.sent.find((x) => x.text.startsWith('🔐'))
    assert(prompt && prompt.text.includes('/yes') && prompt.text.includes('/no'), '提示应包含 /yes 与 /no')
    assert(prompt && !prompt.text.includes('多个待审批'), '单审批不应提示精确选择')
    const consumed = await h.fw.tryResolve('contact-a', '/yes')
    assert(consumed === true, '/yes 应消费消息')
    assert((await outcome) === 'allowed-once', 'outcome 应为 allowed-once')
    assert(h.sent.some((x) => x.text.includes('✅ 已允许「pwsh」')), '应回执已允许')
    console.log('✅ 场景1：/yes 快捷允许')
  }

  // ---- 场景2：/no 快捷拒绝 ----
  {
    const h = makeHarness()
    const { outcome } = h.trigger('read')
    const consumed = await h.fw.tryResolve('contact-a', '/no')
    assert(consumed === true, '/no 应消费消息')
    assert((await outcome) === 'rejected', 'outcome 应为 rejected')
    assert(h.sent.some((x) => x.text.includes('⛔ 已拒绝「read」')), '应回执已拒绝')
    console.log('✅ 场景2：/no 快捷拒绝')
  }

  // ---- 场景3：裸 yes / 大写 No ----
  {
    const h = makeHarness()
    const { outcome } = h.trigger('rm')
    assert(await h.fw.tryResolve('contact-a', 'yes') === true, '裸 yes 应生效')
    assert((await outcome) === 'allowed-once', 'yes → allowed-once')
    const { outcome: o2 } = h.trigger('rm2')
    assert(await h.fw.tryResolve('contact-a', 'No') === true, '大写 No 应生效')
    assert((await o2) === 'rejected', 'No → rejected')
    console.log('✅ 场景3：裸 yes / 大写 No')
  }

  // ---- 场景4：无待审批时 /yes 不消费 ----
  {
    const h = makeHarness()
    assert(await h.fw.tryResolve('contact-a', '/yes') === false, '无待审批时 /yes 返回 false（落命令层）')
    console.log('✅ 场景4：无待审批不消费')
  }

  // ---- 场景5：多待审批 → 提示精确选择 + 精确码生效 ----
  {
    const h = makeHarness()
    const a = h.trigger('pwsh')   // 第一个（随后会收到"多个待审批"提示）
    const b = h.trigger('read')   // 第二个
    await new Promise((r) => setTimeout(r, 20))
    const prompts = h.sent.filter((x) => x.text.startsWith('🔐'))
    assert(prompts.length === 2, '两个审批都应发提示')
    assert(prompts[1].text.includes('多个待审批'), '第二个提示应提示精确选择')
    const tokenMatch = prompts[1].text.match(/允许 ([a-z0-9]{4}) 精确/)
    assert(tokenMatch !== null, '第二个提示应带精确码')
    // /yes 作用于最近一个（read）
    assert(await h.fw.tryResolve('contact-a', '/yes') === true)
    assert((await b.outcome) === 'allowed-once', '最近审批被 /yes 允许')
    // 精确码允许第一个（pwsh）
    const token = prompts[0].text.match(/允许 ([a-z0-9]{4}) 精确/)?.[1]
    if (token) {
      assert(await h.fw.tryResolve('contact-a', `允许 ${token}`) === true, '精确码应消费')
      assert((await a.outcome) === 'allowed-once', '精确码 → allowed-once')
    }
    console.log('✅ 场景5：多待审批 → /yes 最近 + 精确码')
  }

  // ---- 场景6：其它联系人回复不消费 ----
  {
    const h = makeHarness()
    const { outcome } = h.trigger('pwsh')
    assert(await h.fw.tryResolve('contact-b', '/yes') === false, '其他联系人的 /yes 不应消费')
    assert(await h.fw.tryResolve('contact-a', '/no') === true)
    assert((await outcome) === 'rejected')
    console.log('✅ 场景6：跨联系人隔离')
  }

  console.log(`\n${failed === 0 ? '🎉' : '❌'} 审批单元测试：${passed} 通过 / ${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
