# HTTP API（网关模式）

启动：`lkbclaw -gateway [--port 8787] [--host 127.0.0.1]`

所有响应为 JSON（SSE 除外），错误体形如 `{ "error": "..." }`。

## GET /

返回浏览器聊天界面（HTML）。

## GET /health

健康检查。返回：

```json
{
  "service": "lkbclaw gateway",
  "version": "1.1.0",
  "model": "agnes-2.5-flash",
  "routes": { "POST /chat": "...", "POST /v1/chat/completions": "..." }
}
```

## GET /metrics

Prometheus 文本格式指标：

```
# TYPE lkb_requests_total counter
lkb_requests_total 12
# TYPE lkb_errors_total counter
lkb_errors_total 0
# TYPE lkb_tokens_prompt_total counter
lkb_tokens_prompt_total 1931
# TYPE lkb_tokens_completion_total counter
lkb_tokens_completion_total 54
# TYPE lkb_tool_calls_total counter
lkb_tool_calls_total 1
# TYPE lkb_uptime_seconds counter
lkb_uptime_seconds 7
```

可用于 Grafana / Prometheus 抓取。

## POST /chat

对话。请求体（JSON）：

```json
{ "message": "你好", "model": "agnes-2.5-flash", "temperature": 0.3 }
// 或携带历史：
{ "messages": [ {"role":"user","content":"..."}, {"role":"assistant","content":"..."} ] }
```

响应为 SSE 流，事件类型：

- `data: {"type":"content","content":"..."}` 增量文本
- `data: {"type":"tool","name","args","result"}` 工具调用
- `data: {"type":"reasoning","content":"..."}` 思考过程
- `data: {"type":"usage","usage":{...}}` token 用量
- `data: {"error":"..."}` 出错（已转为人话提示）
- `data: [DONE]` 结束

## POST /v1/chat/completions

把请求原样代理到 `AGNES_API_BASE/v1/chat/completions`（带你的密钥），支持 `stream`。便于把 lkbclaw 当 OpenAI 兼容网关用。

## 会话 API

- `GET /api/sessions` → 列出会话摘要（id / 标题 / 条数 / 更新时间），按最近优先
- `POST /api/sessions` → 新建会话，body `{ "title": "..." }`，返回完整 session
- `GET /api/sessions/:id` → 读取完整会话（含 `messages`）
- `PUT /api/sessions/:id` → 更新，`body { "title"?, "messages"? }`
- `DELETE /api/sessions/:id` → 删除

会话持久化在仓库根目录的 `.lkb-sessions.json`，与终端 `/save` `/load` `/list` 共享同一份数据。
