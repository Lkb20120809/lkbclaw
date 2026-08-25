import { config } from "./config.js";
import { toolSchemas, executeTool } from "./tools.js";

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

function buildToolCalls(acc) {
  const calls = Object.values(acc);
  if (calls.length === 0) return null;
  return calls.map((t) => ({
    id: t.id || `call_${t.index}`,
    type: "function",
    function: { name: t.name || "", arguments: t.args || "{}" },
  }));
}

function mergeToolDelta(acc, delta) {
  if (!delta.tool_calls) return;
  for (const tc of delta.tool_calls) {
    const i = tc.index ?? 0;
    if (!acc[i]) acc[i] = { index: i, id: undefined, name: undefined, args: "" };
    if (tc.id) acc[i].id = tc.id;
    if (tc.function?.name) acc[i].name = tc.function.name;
    if (tc.function.arguments) acc[i].args += tc.function.arguments;
  }
}

// Safety: keep the full conversation in memory (for display/tools) but send a
// trimmed copy to the API so we never blow the context window. We cap the size
// of any single message (tool results can be huge) and drop oldest turns
// (always at user-message boundaries, so tool_call/tool pairs stay intact).
const MAX_MSG_CHARS = 20000;
const MAX_PROMPT_CHARS = 600000;

function truncateStr(s, max) {
  if (typeof s !== "string" || s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated, original ${s.length} chars]`;
}

export function pruneMessages(messages) {
  const system = messages[0] && messages[0].role === "system" ? [messages[0]] : [];
  let rest = system.length ? messages.slice(1) : messages.slice();

  const truncate = (m) => ({
    ...m,
    content: typeof m.content === "string" ? truncateStr(m.content, MAX_MSG_CHARS) : m.content,
  });
  rest = rest.map(truncate);

  const totalChars = () => rest.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : 0), 0);
  let curTotal = totalChars();
  const dropOldestTurn = (arr) => {
    // 从首个 user 边界整体丢弃一轮（user 及其后的 assistant/tool），保证 tool_call/tool 配对与结构完整
    // 如果第一条已经是 user，则从第二条开始找下一个 user（即丢弃第一轮）
    let k = arr[0]?.role === "user" ? 1 : 0;
    while (k < arr.length && arr[k].role !== "user") k++;
    if (k >= arr.length) return arr; // 没有 user 消息，不再丢弃
    const removed = arr.slice(0, k);
    // 重新计算总字符数（避免每轮 O(n²)）
    const subtract = (msgArr) => msgArr.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : 0), 0);
    curTotal -= subtract(removed);
    return arr.slice(k);
  };

  let guard = 0;
  while (rest.length > 2 && curTotal > MAX_PROMPT_CHARS && guard++ < 1000) {
    rest = dropOldestTurn(rest);
  }

  return [...system, ...rest];
}

export async function* chat(messages, { onTool, onUsage, onReasoning, signal, model, temperature = config.temperature ?? 0.3 } = {}) {
  if (!config.apiKey) {
    throw new Error("缺少 API Key：请在 providers.json 设置 apiKey（可用 ${ENV:AGNES_API_KEY} 引用 .env）或配置 .env 的 AGNES_API_KEY");
  }
  const url = `${config.apiBase}/v1/chat/completions`;

  for (let round = 0; round < 24; round++) {
    const body = {
      model: model || config.model,
      messages: pruneMessages(messages),
      tools: toolSchemas,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
      temperature,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    let content = "";
    const toolAcc = {};
    for await (const ev of parseSSE(res)) {
      if (ev.usage) {
        if (onUsage) onUsage(ev.usage);
        continue;
      }
      const delta = ev.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        yield delta.content;
      }
      if (delta.reasoning_content) {
        if (onReasoning) onReasoning(delta.reasoning_content);
      }
      mergeToolDelta(toolAcc, delta);
    }

    const toolCalls = buildToolCalls(toolAcc);
    const msg = {
      role: "assistant",
      content: content || null,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
    messages.push(msg);

    if (toolCalls && toolCalls.length > 0) {
      const results = [];
      for (const tc of toolCalls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        let result;
        try {
          result = await executeTool(tc.function.name, args);
        } catch (e) {
          result = { error: String(e && e.message ? e.message : e) };
        }
        if (onTool) onTool(tc.function.name, args, result);
        results.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(result),
        });
      }
      messages.push(...results);
      continue;
    }

    return;
  }

  yield "\n[已停止：工具调用轮数过多]";
}
