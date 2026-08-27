# 可用工具

模型可通过工具调用操作你的文件系统与网络。当前内置工具：

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件文本。参数 `path`，可选 `maxLines`（默认 2000） |
| `write_file` | 写入文件（自动建父目录）。参数 `path`、`content` |
| `list_files` | 列出目录内容。参数 `path`（默认当前目录） |
| `run_command` | 执行 shell 命令，返回 stdout/stderr。参数 `command`，可选 `timeout`（ms，默认 60000） |
| `grep_files` | 递归正则搜索文件内容。参数 `pattern`、`path`（默认当前）、`include`（glob） |
| `edit_file` | 精确替换文件中的文本。参数 `path`、`old_string`、`new_string`、`replace_all` |
| `git` | 执行 git 子命令。参数 `subcommand`（如 `status`/`diff`/`log`/`commit`）、`args` |
| `websearch` | 联网搜索。参数 `query`、`max`（默认 5） |
| `webfetch` | 抓取网页内容。参数 `url`、`limit`（默认 8000 字符） |
| `run_tests` | 运行测试命令（默认 `npm test`）。参数 `command` |

## 安全提示

- `run_command` 直接在**你的系统**执行命令，请仅在你信任的对话中使用
- 危险命令（如 `rm -rf /`、格式化）建议自行确认，网关日志会记录每次调用（见终端 `[#xxx] → 命令 ...`）
- 如需更强隔离，可自行在沙盒 / 容器 / 专用目录中运行 `lkbclaw -gateway`

> 插件化工具系统（让第三方以独立文件注册工具、并带 `readonly`/`write`/`dangerous` 权限分级）已在规划中，当前工具为内置列表。
