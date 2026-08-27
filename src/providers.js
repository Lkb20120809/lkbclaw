import fs from "node:fs";

// 统一的 Provider 抽象层：每个 provider 实现
//   streamChat({ model, messages, tools, temperature, signal, stream })
//     -> AsyncGenerator，yield 形如 { choices:[{ delta:{ content?, reasoning_content?, tool_calls? } }] } 或 { usage }
// 目前提供 OpenAI 兼容适配器（默认）与 Ollama 适配器（同协议、可无密钥）。

export async function* parseSSE(res) {
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

export function extractContent(json) {
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

function makeCompatProvider(cfg, { needsAuth = true } = {}) {
  return {
    name: cfg.providerName || "openai-compat",
    async *streamChat({ model, messages, tools, temperature, signal, stream = true }) {
      const debug = process.env.LKB_DEBUG;
      if (needsAuth && !cfg.apiKey) {
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
      const headers = { "Content-Type": "application/json" };
      if (needsAuth && cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (debug) {
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

export function createOpenAICompatProvider(cfg) {
  return makeCompatProvider(cfg, { needsAuth: true });
}

// Ollama 兼容 OpenAI 的 /v1/chat/completions，但通常不需要鉴权
export function createOllamaProvider(cfg) {
  return makeCompatProvider(
    { ...cfg, apiBase: cfg.apiBase || "http://localhost:11434" },
    { needsAuth: false }
  );
}

// 按 providerName 选择适配器；以后新增 provider 只在这里加分支
export function createProvider(cfg) {
  const name = (cfg.providerName || "").toLowerCase();
  if (name.includes("ollama")) return createOllamaProvider(cfg);
  return createOpenAICompatProvider(cfg);
}
