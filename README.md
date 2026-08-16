# dsh-wechat-pro

DeepSeek Harness 进程内微信 ClawBot 通道插件：把 DSH 变成微信里的一只「龙虾」🦞。

- **扫码即用**：腾讯官方 iLink 通道（个人微信免白名单），二维码打印在 `dsh web` 终端，凭证 24h 自动续连 + 到期提醒；
- **与 Web 共享真实会话**：微信里新建/切换的会话就是真实 DSH 会话，出现在 Web 会话列表、可跨端续接（Codex 式附着）；
- **工作区**：`/workspace` 在注册工作区间切换，`/workdir <路径>` 切换任意工作路径（自动注册为工作区，Web 同源可见）；
- **模型与思考强度**：`/model`、`/thinking` 按会话切换，下一轮生效（走 Web 同款宿主 apiProxy）；
- **原生命令**：`/plan`、`/permission`、`/compact`、`/goal`、`/feedback`、`/export` 等 harness 原生命令直接在微信执行；
- **审批转发微信**：高风险工具调用在微信里推送「允许/拒绝」，回复即审批；
- **流式输出**：思考/工具调用过程事件实时推送，最终答复长文自动分片；
- **媒体收发**：`/send` 发电脑文件到微信；微信图片/文件/视频/语音自动下载解密落盘；
- **主动能力**：agent 可用 `weixin_send` 工具随时推送消息到微信。

架构：微信通道与宿主 apiProxy 都跑在 `dsh web` 进程内；会话事件经 `session/event` 订阅实时镜像到微信。不需要 OpenClaw、不需要公网服务器、不需要独立进程。

## 安装

**方式一：从 GitHub 安装（推荐，发布后）**

```powershell
dsh plugin --profile web add github:bwhite55/dsh-wechat-pro
dsh web
```

**方式二：本地源码（开发/修改）**

```powershell
# 1. 构建
cd D:\dsh-wechat-pro
pnpm install
pnpm run build

# 2. 装进 web profile（link 方式，改源码后重新 build 即生效）
dsh plugin --profile web add link:D:\dsh-wechat-pro

# 3. 重启 dsh web
dsh web
```

重启后 `dsh web` 终端会打印登录二维码（或已有凭证自动连接）。手机微信「我 → 设置 → 插件」添加 ClawBot/龙虾，扫二维码配对后即可对话。

> **隐藏窗口运行 dsh web 时**（如 `start-dsh-web-hidden.vbs`）终端看不到二维码：
> 浏览器打开 `http://127.0.0.1:3080/api/dsh-wechat-pro/status`，响应里的 `qrLink`
> 就是当前登录二维码链接（手机微信打开即可扫码）；`POST /api/dsh-wechat-pro/connect`
> 可强制重新扫码。

## 指令

| 指令 | 作用 |
|---|---|
| `/help` | 指令列表 |
| `/status` | 连接、工作区、会话、模型状态 |
| `/time` | 连接剩余时间 |
| `/workspace` | 切换工作区（回复数字选择） |
| `/workdir <路径>` | 切换任意工作路径（自动注册为工作区） |
| `/sessions` | 当前工作区会话列表（回复数字切换/附着；📌=微信书签） |
| `/new <名字>` | 当前工作区内新建会话并切换（Web 会话列表可见） |
| `/switch <名字>` | 切换命名会话（`main` = 默认） |
| `/attach <序号\|会话ID>` | 附着 Web 已有会话（同轨迹双向可见） |
| `/clear [名字]` | 删除微信书签（真实会话与日志保留在 Web） |
| `/unbind` | 停止接收当前会话的推送 |
| `/model` | 切换模型（回复数字选择，下一轮生效） |
| `/thinking` | 切换思考强度 off/high/max（回复数字选择） |
| `/level [级别]` | 输出等级：`minimal`=只收最终答复与错误 / `normal`=思考+工具调用/结果+答复 / `verbose`=完整工具参数（按联系人持久化） |
| `/send <路径> [说明]` | 发电脑文件到微信（相对路径按会话工作区目录） |
| `/reconnect` | 重新扫码续连 |
| `/cancel` | 取消当前回合 |
| 其他 `/xxx` | 若为 harness 原生命令（`/plan` `/permission` `/compact` 等）直接执行 |

## 配置

插件配置在「设置 → 插件配置 → dsh-wechat-pro」或 `cordis.patch.yml` 的 `config` 段，
也支持环境变量（`DSH_WXBOT_*`，测试时可指向本地 mock）：

| 键 / 环境变量 | 默认 | 说明 |
|---|---|---|
| `autoConnect` | `true` | 启动时已有凭证自动连接 |
| `allowFrom` / `DSH_WXBOT_ALLOW_FROM` | 空 | 微信用户白名单（逗号分隔的 `from_user_id`；空 = 全部，建议设置） |
| `dataDir` / `DSH_WXBOT_DATA_DIR` | `$DSH_HOME/dsh-wechat-pro` | 凭证/联系人注册表/媒体目录 |
| `baseUrl` / `DSH_WXBOT_BASE_URL` | `https://ilinkai.weixin.qq.com` | iLink 端点（测试可指向 mock） |
| `replyMaxChars` / `DSH_WXBOT_REPLY_MAX` | `3800` | 单条微信消息上限，超出分片（env 优先） |
| `streamLevel` | `normal` | 默认输出等级（minimal/normal/verbose；微信内可 `/level` 覆盖） |
| `mirrorWebTurns` | `false` | Web 发起的回合是否也推送到微信（默认只推微信发起的回合） |
| `replyTimeoutMs` / `DSH_WXBOT_REPLY_TIMEOUT_MS` | `300000` | 单轮回复超时（env 优先） |
| `announceToAgent` | `true` | 是否在系统提示词声明插件能力 |

### 输出等级与推送范围

- **`/level`（微信内即时切换，按联系人持久化）**：
  - `minimal`（默认，推荐）— 只推最终答复与错误（不含任何过程消息）；
  - `normal` — 思考（🤔）+ 工具调用（🔧）/结果（✅）+ 最终答复；
  - `verbose` — normal + 完整工具参数与结果（不截断）。
- **回合来源**：只有**微信发起的回合**会推送到微信；Web 端在同一会话发起的对话默认**不推送**（`mirrorWebTurns: true` 可改为也推送）。判断依据：该回合的触发消息是否带浏览器时区（微信侧不带）。
- **⚠️ 腾讯发送额度限制（重要）**：实测腾讯 iLink 对**单条入站消息的回复发送有额度限制**——过程消息刷屏（`normal`/`verbose` 下每个工具调用都推一条）会触发 `sendMessage ret=-2 prepare failed`，**后续所有发送（含最终答复）都会被拒**。因此**默认 `minimal`**（每回合只发最终答复+错误，最可靠）。若确实想看过程，可 `/level normal`，同时过程消息上限 `maxProcessPerTurn`（默认 3）会尽量为最终答复留额度，但不能保证。
- **长度限制与超长回复降级**：微信单条消息约 2048 字符限制，`replyMaxChars` 默认 3800（超出自动分片，每片间隔 1s）。最终答复分片预算 `maxReplyChunks`（默认 8 片）：分片数在预算内正常发送；**超预算时降级为「首片 + 完整内容落盘为文件发给你」**（一条媒体消息，不占文本条数额度，完整内容必达）。文件存于 `dataDir/outbox/`。
- **发送可靠性**：最终答复/审批提示等关键消息发送失败会自动重试一次；所有发送失败都会追加到 `dataDir/logs/wechat-pro.log`（隐藏窗口启动时这是唯一可查的发送痕迹，`ret=-2 prepare failed` 即额度/上下文被拒）。

## 数据与安全

- 凭证 `weixin-auth.json` 含 bot token（= 以你微信身份收发消息的凭据），勿外传；
- 每联系人注册表存于 `dataDir/contacts/<key>.json`（当前工作区 + 命名会话书签）；
- 微信来的媒体解密后存 `dataDir/media/<key>/`；发送失败日志存 `dataDir/logs/wechat-pro.log`；
- 控制路由（`/api/dsh-wechat-pro/*`）仅监听回环地址，LAN 暴露会被拒绝；
- 建议保持 DSH 自身权限为 `workspace-write`，并用 `allowFrom` 只放行自己的微信号。

## 开发与测试

```sh
pnpm run typecheck   # 类型检查
pnpm run build       # tsc 构建到 dist/
node tests/test-mock-ilink.mjs --port 8899   # 起 mock iLink（登录/收发闭环）
```

自动化测试（无需真实微信）：

```sh
node tests/channel-smoke.mjs   # 通道冒烟：引擎直连 mock（登录/轮询/typing/回复/媒体接收）
node tests/e2e-harness.mjs     # harness 集成：侧路 dsh web + mock 队列，命令层端到端
node tests/e2e-chat.mjs        # 真实模型 e2e：对话/流式/审批转发/长文分片//model（需 DEEPSEEK_API_KEY，消耗少量配额）
```

侧路 dsh web 约定：`DSH_E2E_WEB_PORT=3099`（默认）、`DSH_E2E_MOCK_PORT=8898`（默认）、`DSH_E2E_TIMEOUT`（秒）。

本地闭环（手动，无需真实微信）：

```powershell
# 终端 A：mock iLink
node tests\test-mock-ilink.mjs --port 8899

# 终端 B：带插件的 dsh web（另一端口 + mock 端点 + 隔离数据目录）
$env:DSH_WEB_PORT = "3099"
$env:DSH_WXBOT_BASE_URL = "http://127.0.0.1:8899"
$env:DSH_WXBOT_DATA_DIR = "D:\dsh-wechat-pro\.test-data"
dsh web
```

## 许可

MIT
