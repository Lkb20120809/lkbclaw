import fs from "node:fs";
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
  const debug = process.env.LKB_DEBUG;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let dataLines = [];
  let finished = false;
  if (debug) {
    try {
      fs.appendFileSync(".lkb-debug.log", `\n=== SSE START ${new Date().toISOString()} ===\n`);
    } catch {}
  }
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
            if (debug) try { fs.appendFileSync(".lkb-debug.log", "RAW: [DONE]\n=== SSE END ===\n"); } catch {}
            break;
          }
          try {
            yield JSON.parse(data);
          } catch (parseErr) {
            console.error(`[parseSSE] 解析 SSE 数据失败: ${parseErr.message}, data: ${data.slice(0, 100)}`);
          }
        }
      } else if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        if (debug) try { fs.appendFileSync(".lkb-debug.log", `RAW: ${d}\n`); } catch {}
        dataLines.push(d);
      }
    }
  }
  if (dataLines.length) {
    const data = dataLines.join("\n").trim();
    try {
      yield JSON.parse(data);
    } catch {}
  }
}

function extractContent(json) {
  if (!json || typeof json !== "object") return null;
  const c =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.text ??
    json?.choices?.[0]?.message?.text ??
    json?.choices?.[0]?.message?.reasoning_content ??
    json?.output ??
    json?.content ??
    json?.response ??
    null;
  return typeof c === "string" && c.length ? c : null;
}

function createOpenAIProvider(cfg) {
  return {
    name: cfg.providerName || "openai",
    async *streamChat({ model, messages, tools, temperature, signal, stream = true }) {
      const debug = process.env.LKB_DEBUG;
      if (!cfg.apiKey) {
        throw new Error(
          "缺少 API Key：请在 providers.json 设置 apiKey（可用 ${ENV:AGNES_API_KEY} 引用 .env）或配置 .env 的 AGNES_API_KEY"
        );
      }
      const url = `${cfg.apiBase}/v1/chat/completions`;
      const body = {
        model: model || cfg.model,
        messages,
        stream,
        stream_options: { include_usage: true },
        temperature,
      };
      if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = "auto";
      }
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (process.env.LKB_DEBUG) {
        try {
          fs.appendFileSync(
            ".lkb-debug.log",
            `=== REQUEST ${new Date().toISOString()} ===\nURL: ${url}\nMODEL: ${model}\nSTREAM: ${stream}\nSTATUS: ${res.status}\nHEADERS: ${JSON.stringify(Object.fromEntries(res.headers))}\n`
          );
        } catch {}
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      if (!stream) {
        const raw = await res.text();
        if (debug) {
          try {
            fs.appendFileSync(".lkb-debug.log", `RESPONSE_BODY: ${raw.slice(0, 4000)}\n`);
          } catch {}
        }
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          yield { choices: [{ delta: { content: "[接口返回不是合法 JSON] " + raw.slice(0, 300) } }] };
          return;
        }
        const msg = json.choices && json.choices[0] && json.choices[0].message;
        const content = extractContent(json);
        const delta = {};
        if (content) delta.content = content;
        if (msg && msg.reasoning_content && !content) delta.reasoning_content = msg.reasoning_content;
        if (msg && msg.tool_calls) delta.tool_calls = msg.tool_calls;
        if (Object.keys(delta).length) yield { choices: [{ delta }] };
        else yield { choices: [{ delta: { content: "[接口返回未识别的内容格式，原始响应见 .lkb-debug.log]" } }] };
        if (json.usage) yield { usage: json.usage };
        return;
      }
      yield* parseSSE(res);
    },
  };
}

const MEMORY_SYSTEM_PROMPT = `你负责把一段较早的对话提炼成结构化长期记忆，供后续对话恢复上下文。只输出一个 JSON 对象（不要代码块、不要多余解释），字段可包含：
- key_facts: 关键事实或结论（数组）
- decisions: 已作出的决策（数组）
- files_changed: 涉及的文件及改动要点（数组）
- user_preferences: 用户偏好或工程约定（数组）
- open_tasks: 仍未完成的事项（数组）
- unresolved: 未解决或待确认的问题/风险（数组）
若某项无信息，给空数组。`;

const memoryProvider = createOpenAIProvider(config);

export async function summarizeConversation(messages) {
  const model = config.memoryModel || config.model;
  const payload = [
    { role: "system", content: MEMORY_SYSTEM_PROMPT },
    ...messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""),
    })),
  ];
  let acc = "";
  for await (const ev of memoryProvider.streamChat({
    model,
    messages: payload,
    stream: false,
    temperature: 0.1,
  })) {
    const d = ev?.choices?.[0]?.delta;
    const c = d?.content || d?.text;
    if (c) acc += c;
  }
  let json = acc.trim();
  const fence = json.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) json = fence[1].trim();
  return json;
}

export const chat = createHarness({
  provider: createOpenAIProvider(config),
  toolExecutor: executeTool,
  toolSchemas,
  defaultModel: config.model,
  defaultTemperature: config.temperature ?? 0.3,
});
