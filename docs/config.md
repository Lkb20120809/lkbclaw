# 配置说明

lkbclaw 的配置来自三层（后者覆盖前者）：

1. 进程环境变量 / 工作目录或用户目录下的 `.env`
2. 工作目录的 `providers.json`（多 provider）
3. 内置默认值

## providers.json

放在**工作目录**（运行 `lkbclaw` 的目录）。可包含一个 provider 数组，或 `{ "providers": [...] }`。

schema（由 `zod` 校验）：

```jsonc
[
  {
    "name": "agnes",                 // 必填，provider 标识
    "baseUrl": "https://apihub.agnes-ai.com",  // API 基地址
    "apiKey": "${ENV:AGNES_API_KEY}", // 可用 ${ENV:XXX} 引用 .env 变量
    "model": "agnes-2.5-flash",
    "temperature": 0.3,               // 0~2
    "default": true                  // 设为默认 provider（无 LKB_PROVIDER 时生效）
  }
]
```

- `apiKey` 支持 `${ENV:VAR}` 占位符，便于把密钥留在 `.env` 而不写进 json
- 用 `LKB_PROVIDER=agnes` 指定使用哪个 provider（否则取 `default`，再否则取第一个）

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `AGNES_API_KEY` | API 密钥（也可写在 providers.json） | 无 |
| `AGNES_API_BASE` | API 基地址 | `https://apihub.agnes-ai.com` |
| `AGNES_MODEL` | 默认模型名 | `agnes-2.5-flash` |
| `AGNES_TEMPERATURE` | 采样温度（0~2） | `0.3` |
| `LKB_PROVIDER` | 指定 provider 名 | 第一个 / `default` |
| `LKB_CONTEXT_BUDGET_TOKENS` | 上下文 token 预算，超出触发压缩 | `60000` |
| `LKB_KEEP_RECENT` | 压缩时保留的最近完整轮数 | `6` |
| `LKB_MEMORY_MODEL` | 生成结构化记忆用的轻量模型（`summarizeConversation`） | 同主模型 |
| `GATEWAY_TOKEN` | 网关绑定公网时校验请求；不设在 loopback 下不需要 | 公网时自动生成 |
| `LKB_KEY_PASSPHRASE` | 若使用本地密钥库加密，提供解密口令 | 无 |

## 校验

启动时 `validateConfig` / `validateProviders` 会对配置做 `zod` 校验。常见错误示例：

- `temperature 必须在 0~2 之间` → 检查 `AGNES_TEMPERATURE` 或 provider 的 `temperature`
- `model 不能为空` → 未设置 `AGNES_MODEL` 且 provider 无 `model`
- `providers.json 第 N 项校验失败: ...` → 对应 provider 字段缺失/类型错误

配置错误会立即抛出并附带字段级中文说明，而不是运行到一半才崩溃。
