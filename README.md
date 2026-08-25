# lkbclaw

一个连接 Agnes API 的 AI 开发助手：终端 CLI（仿 claude-code）+ 浏览器聊天界面（仿 opencode）+ 本地网关。内置 10 个文件/命令/搜索工具，可自主读写代码、跑命令、查网页，并实时显示思考过程与 token 用量。

## 安装

```bash
npm i -g lkbclaw
```

要求 Node.js 18+（用到原生 `fetch` 与 ES Module）。

## 配置 API Key

lkbclaw 不内置任何密钥，需你自己提供一个兼容 OpenAI 的 API（默认 Agnes）。

**不想手写配置？** 首次运行（终端或网关）若检测不到 Key，会进入交互引导：依次输入 API Base / Key / Model，自动保存到全局 `~/.lkbclaw/.env`，之后任意目录直接可用，无需重复配置。

在**工作目录**下放一个 `.env` 文件（优先级高于全局配置）：

```ini
# .env
AGNES_API_KEY=你的密钥
AGNES_API_BASE=https://apihub.agnes-ai.com   # 可选，默认值即此
AGNES_MODEL=agnes-2.5-flash                  # 可选，默认模型
```

也可用多提供商配置 `providers.json`（同样放在工作目录，密钥用 `${ENV:NAME}` 占位，不写进文件）：

```json
{
  "providers": [
    {
      "name": "agnes",
      "baseUrl": "https://apihub.agnes-ai.com",
      "apiKey": "${ENV:AGNES_API_KEY}",
      "model": "agnes-2.5-flash",
      "default": true
    },
    {
      "name": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${ENV:OPENAI_API_KEY}",
      "model": "gpt-4o-mini"
    }
  ]
}
```

用环境变量 `LKB_PROVIDER=openai` 切换提供商；不指定时取 `default: true` 的那项。也可以在运行后随时热切换：CLI 交互模式输入 `/provider openai`，或网关 `POST /chat` 的请求体带 `"model":"..."` 覆盖本次模型。`.env` 与 `providers.json` 都已被 git 忽略，不会随包发布。

## 使用

```bash
lkbclaw                 # 显示帮助
lkbclaw -cli "需求"     # 终端对话（可只写 lkbclaw -cli 进入交互）
lkbclaw -gateway         # 启动浏览器界面，默认 http://localhost:8787
lkbclaw -gateway --port 9000
lkbclaw -h               # 帮助
```

### 终端模式（`-cli`）
- 开场横幅 + 顶部状态行，底部状态栏显示：`⏺ N 工具 · tokens 总用量 (prompt + completion) · model`
- 模型思考过程以 `💭 思考` 实时流式输出
- 工具调用以 `⏺ 工具名 参数` 展示，结果折叠在后面
- 多轮对话，输入 `exit` / `quit` 退出
- 历史记录保存在 `~/.lkbclaw-history.json`

### 网关 + 浏览器模式（`-gateway`）
浏览器打开后：
- 顶栏显示当前会话标题与模型
- 工具调用以可折叠卡片展示（参数 + 返回结果）
- 思考过程可折叠
- 底部状态栏显示忙碌状态与 token 用量
- 单条消息发送后自动滚到底部

如需给网关加访问令牌，设环境变量 `GATEWAY_TOKEN=xxx`，调用 `POST /chat` 时需带 `Authorization: Bearer xxx`。

### 网关安全
- 默认只监听本机 `127.0.0.1`，局域网内他人无法借用你的密钥调模型。
- 要对外暴露时加 `--host 0.0.0.0`；此时若未设 `GATEWAY_TOKEN`，网关会**自动生成随机令牌**并打印，调用方必须带 `?token=xxx` 或 `Authorization: Bearer xxx`。
- CORS 默认仅允许本机来源，公网模式仅对携带有效令牌的来源放行。

### CLI 交互命令
`/help` · `/tools` · `/clear` · `/model [名称]`（查看或切换模型）· `/provider [名称]`（查看或热切换提供商）· `/save [路径]` · `/load [路径]` · `/history` · `/quit`

## 内置工具

| 工具 | 作用 |
| --- | --- |
| `read_file` | 读文件（默认最多 2000 行，超出截断） |
| `write_file` | 写文件（自动建父目录） |
| `edit_file` | 按精确子串替换来改文件（推荐改代码用） |
| `list_files` | 列目录内容 |
| `run_command` | 执行 shell 命令，返回 stdout/stderr |
| `grep_files` | 递归正则搜索文件内容 |
| `git` | 受限 git 操作（status/diff/log/commit…，`reset --hard` 被禁） |
| `websearch` | 联网搜索，返回标题/链接/摘要 |
| `webfetch` | 抓取网页并清洗为纯文本 |
| `run_tests` | 跑测试（默认 `npm test`） |

工具出错不会中断对话，会以错误信息返回给模型自行处理。

## 特性

- **思考过程可见**：实时流式显示模型的 `reasoning_content`
- **token 用量**：每轮结束后显示 prompt / completion / 总 token
- **上下文自动保护**：发送前若超出预算，会截断过长消息并从最早的整轮对话开始丢弃，保证 tool_call/tool 配对完整，避免 `ContextWindowExceededError`
- **多提供商**：通过 `providers.json` + `${ENV:NAME}` 占位切换不同 API

## 常见问题

**报错“未配置 API Key”**：检查工作目录下 `.env` 的 `AGNES_API_KEY`，或 `providers.json` 里对应 `apiKey` 的 `${ENV:xxx}` 环境变量是否已设置。

**模型返回 404**：默认模型 `agnes-2.5-flash`；若用其它提供商，在 `providers.json` 里改 `model`。

## 开发 / 本地运行

```bash
git clone <repo> && cd agnes-chat
npm install
node src/lkbclaw.js -cli "需求"
```

### 测试
```bash
npm test        # 运行 test/ 下的单元测（node:test，零依赖）
```

### 发布新版本
- **推荐（CI）**：打 tag `vX.Y.Z` 推送，GitHub Actions 在 Linux 上自动 `npm test` + `npm publish`（需仓库 Secret `NPM_TOKEN`，Linux 打包无 Windows exec 位问题）。
- **本地（Windows）**：npm 会因无 exec 位删掉 `bin`，用 `packfix.sh` 重打包后再发：
  ```bash
  bash packfix.sh              # 按 package.json 的 version 生成修复 bin 的 tgz
  npm publish lkbclaw-<版本>.tgz
  ```
