# lkbclaw

一个接入 **Agnes API** 的 AI 开发助手：终端对话 + 本地网关 + 联网搜索。支持真实 token 预算压缩、结构化记忆、工具调用（读写文件 / 跑命令 / 搜索网页等），以及浏览器聊天界面与会话持久化。

## 功能特性

- **终端 TUI 对话**：鼠标滚轮滚动、侧边栏（`Ctrl+B`）、布局切换（`Ctrl+L`）、语法高亮、流式输出
- **本地网关**：把终端体验搬到浏览器（`-gateway`），自带会话库与文件上传
- **真实 token 预算**：用 `tiktoken` 统计 token，超预算时把早期工具调用成对压缩为摘要，必要时用轻量模型生成结构化记忆
- **工具调用**：读/写/列文件、编辑、搜索、执行命令、git、网页搜索/抓取、跑测试
- **会话持久化**：终端（`/save` `/load` `/list`）与浏览器共享同一份 `.lkb-sessions.json`
- **可观测**：网关 `/health`、`/metrics`（Prometheus 格式）、按对话归因的实时日志
- **优雅关闭**：`Ctrl+C` 等待在途请求完成再退出；常见错误转成人话提示
- **配置校验**：`zod` 校验 `providers.json` 与运行配置，写错立即报清晰错误

## 安装

```bash
npm install -g lkbclaw
```

要求 Node >= 18。

## 快速开始

### 终端对话

```bash
lkbclaw -cli
```

首次运行会引导配置（选择 provider、填写 API Key、默认模型）。也可用 `-onbread` 重新走向导。

### 启动本地网关（浏览器 UI）

```bash
lkbclaw -gateway            # 默认 http://localhost:8787
lkbclaw -gateway --port 9000
```

打开浏览器访问对应地址即可聊天；端点见下文「HTTP API」。

## 配置

配置来源优先级：环境变量 `.env` → 工作目录 `providers.json` → 内置默认。

详细字段与 `providers.json` schema 见 [docs/config.md](docs/config.md)。

关键环境变量：

| 变量 | 说明 | 默认 |
|------|------|------|
| `AGNES_API_KEY` / `providers.json` | API 密钥 | 无 |
| `AGNES_API_BASE` | API 基地址 | `https://apihub.agnes-ai.com` |
| `AGNES_MODEL` | 默认模型 | `agnes-2.5-flash` |
| `AGNES_TEMPERATURE` | 温度 0~2 | `0.3` |
| `LKB_PROVIDER` | 指定 provider 名 | 第一个 / default |
| `LKB_CONTEXT_BUDGET_TOKENS` | 上下文 token 预算 | `60000` |
| `LKB_KEEP_RECENT` | 压缩时保留的最近轮数 | `6` |
| `LKB_MEMORY_MODEL` | 结构化记忆用的轻量模型 | 同主模型 |
| `GATEWAY_TOKEN` | 公网暴露网关时的访问令牌 | 自动生成 |
| `LKB_KEY_PASSPHRASE` | 密钥库加密口令 | 无 |

## 终端命令

输入 `/` 唤起命令补全。常用：

- `/help` 帮助
- `/tools` 列出可用工具
- `/clear` 清空当前对话
- `/compress [保留轮数]` 主动压缩上下文
- `/save [标题]` 存入会话库；`/save <路径>` 导出为文件
- `/load <id>` 从会话库恢复；`/load <路径>` 从文件导入
- `/list` 列出已保存会话
- `/model [name]` `/provider [name]` 切换模型 / provider
- `/mode plan|build` 计划 / 执行模式
- `/usage` 查看本次会话 token 用量
- `/history` 当前对话轮数
- `/quit` 退出

## HTTP API（网关模式）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 浏览器聊天界面 |
| GET | `/health` | 健康检查（含版本与模型） |
| GET | `/metrics` | Prometheus 格式指标（请求数 / 错误数 / token / 工具调用 / uptime） |
| POST | `/chat` | 对话，body `{message}` 或 `{messages[]}`，SSE 流返回 |
| POST | `/v1/chat/completions` | 代理到 Agnes API（支持流式） |
| GET/POST | `/api/sessions` | 列出 / 新建会话 |
| GET/PUT/DELETE | `/api/sessions/:id` | 读取 / 更新 / 删除会话 |

详细见 [docs/api.md](docs/api.md)。

## 开发

```bash
npm install
npm test            # node --test
npx eslint src/     # 代码检查
```

CI：push/PR 自动跑 `npm test` + `eslint`；打 `v*` tag 自动 `npm publish`（需在仓库 Secrets 配置 `NPM_TOKEN`）。

## 许可证

MIT
