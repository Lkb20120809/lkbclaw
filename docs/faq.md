# 常见问题（FAQ）

**Q: 运行时报「未配置 API Key」？**
A: 用 `lkbclaw -onbread` 走向导填写，或在 `.env` 设置 `AGNES_API_KEY=...`，或在 `providers.json` 里配置 `apiKey`（支持 `${ENV:AGNES_API_KEY}` 引用环境变量）。

**Q: 连不上模型 / 报网络错误？**
A: 检查网络与 `AGNES_API_BASE` 是否正确；公司代理下可能需配置代理环境变量。网关侧会把这类错误转成「无法连接模型服务，请检查网络以及 apiBase 是否正确」。

**Q: 401 / 无权限？**
A: 密钥无效或该密钥无对应模型权限。核对 `.env` / `providers.json` 中的 key。

**Q: 上下文太长 / 变贵了？**
A: 调小 `LKB_CONTEXT_BUDGET_TOKENS`（默认 60000）；也可用 `/compress [保留轮数]` 主动压缩。超出预算时早期工具调用会被成对压缩为摘要，必要时用 `LKB_MEMORY_MODEL` 生成结构化记忆。

**Q: 当前模型不支持工具调用？**
A: 换用支持 function calling 的模型，例如 `agnes-2.5-flash`；报错会提示「当前模型可能不支持工具调用」。

**Q: 网关日志里有 `[#xxxx]` 是什么？**
A: 每个对话的唯一标签，命令调用（→ 命令 ...）、usage、请求状态都归属到对应对话，便于并发时区分。

**Q: 终端对话和浏览器会话不互通？**
A: 它们共享同一份 `.lkb-sessions.json`。终端用 `/save` 存入、 `/list` 查看、 `/load <id>` 恢复；浏览器新建的会话也会出现在 `/list` 里。

**Q: 会话文件在哪？**
A: 仓库（运行目录）下的 `.lkb-sessions.json`。已加入 `.gitignore`，不会误提交。

**Q: 怎么自己看 token 用量？**
A: 终端输入 `/usage`；网关侧 `/metrics` 汇总所有对话的 token 与工具调用数。

**Q: 网关怎么安全暴露到公网？**
A: 绑定非 loopback 地址时网关会自动生成 `GATEWAY_TOKEN`，请求需带 `Authorization: Bearer <token>` 或 `?token=<token>`；也可手动设置 `GATEWAY_TOKEN`。
