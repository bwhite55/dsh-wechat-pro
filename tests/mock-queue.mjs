/**
 * 队列版 mock iLink 服务器 —— 供 dsh-wechat-pro 的 harness 集成测试。
 * 与 test-mock-ilink.mjs 同款协议端点，但消息由控制端通过 /__push 注入：
 *
 *   POST /__push   { text?, from?, contextToken?, itemList? }  推一条用户消息进队列
 *   GET  /__captured  返回已捕获的 sendmessage/sendtyping/getconfig/getuploadurl 记录
 *   GET  /__state     返回 qrcodePolls / updatesCalls / queue 长度
 *
 * 登录：get_bot_qrcode → mock-qr-0001 → 第 3 次轮询返回 confirmed（免扫码）。
 */

import { createServer } from 'node:http'

const port = Number(process.argv[process.argv.indexOf('--port') + 1] ?? 8898) || 8898

const state = {
  qrcodePolls: 0,
  updatesCalls: 0,
  captured: [],
  queue: [],
}

function json(res, obj, status = 200, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
  })
}

function summarizeItems(itemList = []) {
  return itemList.map((i) => {
    if (i.type === 1) return { type: 1, text: i.text_item?.text ?? '' }
    return { type: i.type }
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = `${req.method} ${url.pathname}`

  if (route === 'POST /__push') {
    const body = await readBody(req)
    const itemList = Array.isArray(body.itemList)
      ? body.itemList
      : [{ type: 1, text_item: { text: body.text ?? '' } }]
    state.queue.push({
      seq: state.updatesCalls + 1000,
      message_id: 2000 + state.queue.length,
      from_user_id: body.from ?? 'tester@im.wechat',
      to_user_id: 'mockbot@im.bot',
      message_type: 1,
      message_state: 2,
      context_token: body.contextToken ?? `ctx-${Date.now()}`,
      item_list: itemList,
    })
    return json(res, { queued: state.queue.length })
  }

  if (route === 'GET /__captured') return json(res, { captured: state.captured })
  if (route === 'GET /__state') return json(res, state)

  if (route === 'POST /ilink/bot/get_bot_qrcode') {
    return json(res, { qrcode: 'mock-qr-0001', qrcode_img_content: `http://127.0.0.1:${port}/mock/qr/mock-qr-0001` })
  }

  if (route === 'GET /ilink/bot/get_qrcode_status') {
    state.qrcodePolls += 1
    if (state.qrcodePolls < 2) return json(res, { status: 'wait' })
    if (state.qrcodePolls === 2) return json(res, { status: 'scaned' })
    return json(res, {
      status: 'confirmed',
      bot_token: 'mock-token-abc123',
      ilink_bot_id: 'mockbot@im.bot',
      baseurl: `http://127.0.0.1:${port}`,
      ilink_user_id: 'tester@im.wechat',
    })
  }

  if (route === 'POST /ilink/bot/getupdates') {
    const body = await readBody(req)
    state.updatesCalls += 1
    state.captured.push({ kind: 'getupdates', get_updates_buf: body.get_updates_buf })
    const batch = state.queue.splice(0, 3)
    return json(res, { ret: 0, msgs: batch, get_updates_buf: `buf-${state.updatesCalls}`, longpolling_timeout_ms: 35000 })
  }

  if (route === 'POST /ilink/bot/getconfig') {
    state.captured.push({ kind: 'getconfig' })
    return json(res, { typing_ticket: 'tt-mock' })
  }

  if (route === 'POST /ilink/bot/sendtyping') {
    const body = await readBody(req)
    state.captured.push({ kind: 'sendtyping', status: body.status })
    return json(res, { ret: 0 })
  }

  if (route === 'POST /ilink/bot/sendmessage') {
    const body = await readBody(req)
    const msg = body.msg ?? {}
    state.captured.push({
      kind: 'sendmessage',
      to: msg.to_user_id,
      message_type: msg.message_type,
      message_state: msg.message_state,
      context_token: msg.context_token,
      items: summarizeItems(msg.item_list),
    })
    return json(res, { ret: 0 })
  }

  if (route === 'POST /ilink/bot/getuploadurl') {
    return json(res, { ret: 0, upload_full_url: `http://127.0.0.1:${port}/mock/cdn/upload`, upload_param: 'mock-upload-param' })
  }

  if (route === 'POST /ilink/bot/msg/notifystart' || route === 'POST /ilink/bot/msg/notifystop') {
    state.captured.push({ kind: route.split('/').pop() })
    return json(res, { ret: 0 })
  }

  return json(res, { ret: -1, errmsg: `mock: unknown route ${route}` }, 404)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-queue-ilink listening on http://127.0.0.1:${port}`)
})
