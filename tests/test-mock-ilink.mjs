#!/usr/bin/env node
/**
 * mock iLink 服务器 —— 模拟 ilinkai.weixin.qq.com 的 Bot 端点（含媒体链路），
 * 供 weixin-bot.mjs 做本地闭环测试（无需真实微信扫码）。
 *
 * 用法: node test-mock-ilink.mjs [--port 8899]
 * 检查: GET /__captured  返回已捕获的 sendmessage/sendtyping/getconfig/getuploadurl 记录
 *       GET /__headers   返回最近一次请求头（断言协议头是否齐全）
 *
 * 媒体链路:
 *   - POST /ilink/bot/getuploadurl → upload_full_url 指向本 mock 的 CDN 上传端点
 *   - POST /mock/cdn/upload        → 200 + x-encrypted-param 头（等价真实微信 CDN）
 *   - GET  /mock/cdn/download      → 返回预设 AES-ECB 密文（供接收侧解密测试）
 */

import { createServer } from "node:http";
import crypto from "node:crypto";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] ?? 8899) || 8899;

const state = {
  qrcodePolls: 0,
  updatesCalls: 0,
  captured: [], // {kind, ...body}
  lastHeaders: null,
};

// ---- 接收测试用：预设密钥 + 密文（AES-128-ECB，明文 "mock-file-content"）----
const MOCK_AESKEY_HEX = "00112233445566778899aabbccddeeff";
const MOCK_AESKEY = Buffer.from(MOCK_AESKEY_HEX, "hex");
const MOCK_PLAINTEXT = Buffer.from("mock-file-content", "utf8");
const _mockCipher = crypto.createCipheriv("aes-128-ecb", MOCK_AESKEY, null); // 同一实例：update + final
const MOCK_CIPHERTEXT = Buffer.concat([_mockCipher.update(MOCK_PLAINTEXT), _mockCipher.final()]);
const MOCK_AES_KEY_B64 = Buffer.from(MOCK_AESKEY_HEX, "utf8").toString("base64"); // 官方约定: base64(hex 字符串)

const MESSAGES = [
  {
    seq: 1,
    message_id: 1001,
    from_user_id: "tester@im.wechat",
    to_user_id: "mockbot@im.bot",
    message_type: 1,
    message_state: 2,
    context_token: "ctx-token-1",
    item_list: [{ type: 1, text_item: { text: process.env.MOCK_MSG1_TEXT ?? "你好，这是第一条消息" } }],
  },
  {
    seq: 2,
    message_id: 1002,
    from_user_id: "tester@im.wechat",
    to_user_id: "mockbot@im.bot",
    message_type: 1,
    message_state: 2,
    context_token: "ctx-token-2",
    item_list: [{ type: 1, text_item: { text: "我们刚才聊了什么？" } }],
  },
  {
    // 触发 /send 内置指令（发送侧测试，文件需预先放在该联系人的工作目录里）
    seq: 3,
    message_id: 1003,
    from_user_id: "tester@im.wechat",
    to_user_id: "mockbot@im.bot",
    message_type: 1,
    message_state: 2,
    context_token: "ctx-token-3",
    item_list: [{ type: 1, text_item: { text: "/send test.txt 这是一份测试文件" } }],
  },
  {
    // 用户发来一个文件（接收侧测试：下载 → AES 解密 → 落盘）
    seq: 4,
    message_id: 1004,
    from_user_id: "tester@im.wechat",
    to_user_id: "mockbot@im.bot",
    message_type: 1,
    message_state: 2,
    context_token: "ctx-token-4",
    item_list: [
      {
        type: 4,
        file_item: {
          media: {
            encrypt_query_param: "mock-download-param-1",
            full_url: `http://127.0.0.1:${port}/mock/cdn/download`,
            aes_key: MOCK_AES_KEY_B64,
            encrypt_type: 1,
          },
          file_name: "mock-report.txt",
          len: String(MOCK_PLAINTEXT.length),
        },
      },
    ],
  },
];

function json(res, obj, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/octet-stream", ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
  });
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** 把 item_list 归纳成可断言的摘要。 */
function summarizeItems(itemList = []) {
  return itemList.map((i) => {
    switch (i.type) {
      case 1:
        return { type: 1, text: i.text_item?.text ?? "" };
      case 2:
        return { type: 2, mid_size: i.image_item?.mid_size, hasMedia: Boolean(i.image_item?.media?.encrypt_query_param) };
      case 4:
        return { type: 4, file_name: i.file_item?.file_name, len: i.file_item?.len, hasMedia: Boolean(i.file_item?.media?.encrypt_query_param) };
      case 5:
        return { type: 5, video_size: i.video_item?.video_size, hasMedia: Boolean(i.video_item?.media?.encrypt_query_param) };
      default:
        return { type: i.type };
    }
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/__")) state.lastHeaders = { ...req.headers };
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /__captured") return json(res, { captured: state.captured });
  if (route === "GET /__headers") {
    const h = state.lastHeaders ?? {};
    return json(res, {
      hasAuthType: h.authorizationtype === "ilink_bot_token",
      hasWechatUin: typeof h["x-wechat-uin"] === "string" && h["x-wechat-uin"].length > 0,
      hasAppId: h["ilink-app-id"],
      hasClientVersion: h["ilink-app-clientversion"],
      hasBearer: String(h.authorization ?? "").startsWith("Bearer "),
      all: h,
    });
  }

  if (route === "POST /ilink/bot/get_bot_qrcode") {
    const body = await readBody(req);
    const tokens = Array.isArray(body.local_token_list) ? body.local_token_list : [];
    state.captured.push({ kind: "getBotQrcode", local_token_list: tokens });
    // 模拟真实服务器语义：重连请求携带现有 token → 返回"已绑定"二维码（binded_redirect）
    const qrcode =
      tokens.length > 0 && process.env.MOCK_QR_MODE !== "force-confirm" ? "mock-qr-binded" : "mock-qr-0001";
    return json(res, {
      qrcode,
      qrcode_img_content: `http://127.0.0.1:${port}/mock/qr/${qrcode}`,
    });
  }

  if (route === "GET /ilink/bot/get_qrcode_status") {
    if (url.searchParams.get("qrcode") === "mock-qr-binded") {
      return json(res, { status: "binded_redirect" });
    }
    state.qrcodePolls += 1;
    if (state.qrcodePolls < 2) return json(res, { status: "wait" });
    if (state.qrcodePolls === 2) return json(res, { status: "scaned" });
    return json(res, {
      status: "confirmed",
      bot_token: "mock-token-abc123",
      ilink_bot_id: "mockbot@im.bot",
      baseurl: "http://127.0.0.1:8899",
      ilink_user_id: "tester@im.wechat",
    });
  }

  if (route === "POST /ilink/bot/getupdates") {
    const body = await readBody(req);
    state.captured.push({ kind: "getupdates", get_updates_buf: body.get_updates_buf });
    state.updatesCalls += 1;
    const msg = MESSAGES[state.updatesCalls - 1];
    if (msg) return json(res, { ret: 0, msgs: [msg], get_updates_buf: `buf-${state.updatesCalls}`, longpolling_timeout_ms: 35000 });
    return json(res, { ret: 0, msgs: [], get_updates_buf: "buf-end", longpolling_timeout_ms: 35000 });
  }

  if (route === "POST /ilink/bot/getconfig") {
    const body = await readBody(req);
    state.captured.push({ kind: "getconfig", ...body });
    return json(res, { typing_ticket: "tt-mock" });
  }

  if (route === "POST /ilink/bot/sendtyping") {
    const body = await readBody(req);
    state.captured.push({ kind: "sendtyping", ...body });
    return json(res, { ret: 0 });
  }

  if (route === "POST /ilink/bot/getuploadurl") {
    const body = await readBody(req);
    state.captured.push({ kind: "getuploadurl", ...body });
    return json(res, {
      ret: 0,
      upload_full_url: `http://127.0.0.1:${port}/mock/cdn/upload`,
      upload_param: "mock-upload-param",
    });
  }

  if (route === "POST /ilink/bot/sendmessage") {
    const body = await readBody(req);
    const msg = body.msg ?? {};
    state.captured.push({
      kind: "sendmessage",
      to: msg.to_user_id,
      from: msg.from_user_id,
      client_id: msg.client_id,
      message_type: msg.message_type,
      message_state: msg.message_state,
      context_token: msg.context_token,
      items: summarizeItems(msg.item_list),
    });
    return json(res, { ret: 0 });
  }

  // ---- 模拟微信 CDN ----
  if (route === "POST /mock/cdn/upload") {
    const ciphertext = await readRawBody(req);
    state.captured.push({ kind: "cdn-upload", bytes: ciphertext.length });
    return json(res, { ret: 0 }, 200, { "x-encrypted-param": "mock-download-param-1" });
  }

  if (route === "GET /mock/cdn/download") {
    state.captured.push({ kind: "cdn-download", bytes: MOCK_CIPHERTEXT.length });
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(MOCK_CIPHERTEXT.length),
      "x-encrypted-param": "mock-download-param-1",
    });
    return res.end(MOCK_CIPHERTEXT);
  }

  if (route === "POST /ilink/bot/msg/notifystart" || route === "POST /ilink/bot/msg/notifystop") {
    return json(res, { ret: 0 });
  }

  return json(res, { ret: -1, errmsg: `mock: unknown route ${route}` }, 404);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-ilink listening on http://127.0.0.1:${port}`);
});
