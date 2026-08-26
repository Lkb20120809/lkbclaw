import { config } from "./config.js";
import { toolSchemas, executeTool } from "./tools.js";
import { createHarness, pruneMessages } from "./harness.js";

export { pruneMessages };

export const SYSTEM_PROMPT = `你是一个在命令行中运行的开发助手，名字叫 lkbclaw。你可以通过工具来读写代码、运行命令、搜索代码、执行 git 操作，从而真正完成编程任务，而不只是给建议。

准则：
- 修改代码时优先使用 edit_file 做精确替换；只有新建文件或大幅重写时才用 write_file。
- 改动前先用 read_file / list_files / grep_files 了解上下文和仓库约定，模仿现有代码风格。
- 涉及 git 时，先 git status / git diff 了解情况；提交用清晰的commit message；不要做 reset --hard 或强制推送。
- 运行命令前说明你要做什么；命令失败就读取错误并尝试修复。
- 需要最新资料、文档或事实时，用 websearch 联网搜索、用 webfetch 抓取网页内容。
- 改完代码后，主动用 run_tests 跑测试（或 run_command 跑 lint/构建）来验证，失败就读取错误并修复。
- 回复里的代码必须放在 \`\`\`语言 标记的代码块中（如 \`\`\`python），不要裸写代码，以便终端与网页正确高亮显示。
- 回答简洁直接，用中文。不要编造文件内容或事实，用工具核实。`;

async function* parseSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let dataLines = [];
  let finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line === "") {
        if (dataLines.length) {
          const data = dataLines.join("\n").trim();
          dataLines = [];
          if (data === "[DONE]") {
            finished = true;
            break;
          }
          try {
            yield JSON.parse(data);
          } catch (parseErr) {
            console.error(`[parseSSE] 解析 SSE 数据失败: ${parseErr.message}, data: ${data.slice(0, 100)}`);
          }
        }
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
  }
}

function createOpenAIProvider(cfg) {
  return {
    name: cfg.providerName || "openai",
    async *streamChat({ model, messages, tools, temperature, signal }) {
      if (!cfg.apiKey) {
        throw new Error(
          "缺少 API Key：请在 providers.json 设置 apiKey（可用 ${ENV:AGNES_API_KEY} 引用 .env）或配置 .env 的 AGNES_API_KEY"
        );
      }
      const url = `${cfg.apiBase}/v1/chat/completions`;
      const body = {
        model: model || cfg.model,
        messages,
        tools,
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
        temperature,
      };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      yield* parseSSE(res);
    },
  };
}

export const chat = createHarness({
  provider: createOpenAIProvider(config),
  toolExecutor: executeTool,
  toolSchemas,
  defaultModel: config.model,
  defaultTemperature: config.temperature ?? 0.3,
});
