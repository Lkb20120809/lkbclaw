import { config } from "./config.js";
import { countMessageTokens, truncateTokens } from "./tokens.js";

const MAX_MSG_TOKENS = 5000;
const MAX_TOOL_RESULT_TOKENS = 2000;

export async function pruneMessages(messages, opts = {}) {
  const budget = opts.budgetTokens ?? (config.contextBudgetTokens || 60000);
  const keepRecent = opts.keepRecent ?? (config.keepRecentPairs || 6);
  const summarize = opts.summarize || null;
  const system = messages[0] && messages[0].role === "system" ? [messages[0]] : [];
  let rest = system.length ? messages.slice(1) : messages.slice();

  const tok = (m) => countMessageTokens(m);

  const truncate = (m) => ({
    ...m,
    content: typeof m.content === "string" ? truncateTokens(m.content, MAX_MSG_TOKENS) : m.content,
  });
  rest = rest.map(truncate);

  // 按 user 边界切成「轮」(每段 = user + 其后的 assistant/tool)
  const segs = [];
  let cur = null;
  for (const m of rest) {
    if (m.role === "user") {
      cur = [m];
      segs.push(cur);
    } else {
      if (!cur) {
        cur = [];
        segs.push(cur);
      }
      cur.push(m);
    }
  }
  if (segs.length === 0) return [...system];

  const totalTok = segs.reduce((a, seg) => a + seg.reduce((b, m) => b + tok(m), 0), 0);
  if (totalTok <= budget) return [...system, ...rest];

  const recent = segs.slice(-keepRecent);
  const old = segs.slice(0, Math.max(0, segs.length - keepRecent));
  const recentFlat = recent.flat();

  // 久远历史：优先用「小模型结构化记忆」提炼成 JSON，失败则回退到无 LLM 的成对行摘要
  let head = null;
  if (summarize && old.length) {
    try {
      const memory = await summarize(old.flat());
      if (memory && memory.trim()) {
        head = [{ role: "system", content: "【对话记忆 JSON】\n" + memory.trim() }];
      }
    } catch {
      head = null;
    }
  }
  if (!head) {
    const compressSeg = (seg) => {
      const out = [];
      for (const m of seg) {
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const names = m.tool_calls
            .map((t) => t.function?.name)
            .filter(Boolean)
            .join(", ");
          out.push({
            role: "assistant",
            content: `【历史工具调用摘要】调用了 ${m.tool_calls.length} 个工具: ${names || "未知"}（原始返回已压缩，不占上下文）`,
          });
          continue;
        }
        if (m.role === "tool") continue;
        out.push(m);
      }
      return out;
    };
    head = old.flatMap(compressSeg);
  }
  let newRest = [...head, ...recentFlat];

  // 预算守门：若仍超出，从最旧整段丢弃，直到低于预算（至少保留最近一轮）
  let curTotal = newRest.reduce((a, m) => a + tok(m), 0);
  let guard = 0;
  while (newRest.length > recentFlat.length && curTotal > budget && guard++ < 1000) {
    let k = newRest[0]?.role === "user" ? 1 : 0;
    while (k < newRest.length && newRest[k].role !== "user") k++;
    if (k >= newRest.length) k = 1;
    const removed = newRest.slice(0, k);
    curTotal -= removed.reduce((a, m) => a + tok(m), 0);
    newRest = newRest.slice(k);
  }

  return [...system, ...newRest];
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

export async function* runHarness(
  messages,
  {
    provider,
    toolExecutor,
    toolSchemas = [],
    onTool,
    onUsage,
    onReasoning,
    onToken,
    signal,
    model,
    stream,
    temperature = 0.3,
    maxRounds = 24,
    summarize = null,
  } = {}
) {
  if (!provider || typeof provider.streamChat !== "function") {
    throw new Error("harness 需要一个实现了 streamChat 的 provider");
  }
  if (typeof toolExecutor !== "function") {
    throw new Error("harness 需要一个 toolExecutor(name, args) 函数");
  }

  for (let round = 0; round < maxRounds; round++) {
    const events = provider.streamChat({
      model,
      messages: await pruneMessages(messages, { summarize }),
      tools: toolSchemas,
      temperature,
      signal,
      stream,
    });

    let content = "";
    const toolAcc = {};
    for await (const ev of events) {
      if (ev.usage) {
        if (onUsage) onUsage(ev.usage);
        continue;
      }
      const delta = ev.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        if (onToken) onToken(delta.content);
        yield delta.content;
      } else if (delta.text) {
        content += delta.text;
        if (onToken) onToken(delta.text);
        yield delta.text;
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
        let args;
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        let result;
        try {
          result = await toolExecutor(tc.function.name, args);
        } catch (e) {
          result = { error: String(e && e.message ? e.message : e) };
        }
        if (onTool) onTool(tc.function.name, args, result);
        const toolContent = truncateTokens(
          JSON.stringify(result),
          MAX_TOOL_RESULT_TOKENS
        );
        results.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: toolContent,
        });
      }
      messages.push(...results);
      continue;
    }

    return;
  }

  yield "\n[已停止：工具调用轮数过多]";
}

export function createHarness({
  provider,
  toolExecutor,
  toolSchemas = [],
  defaultModel,
  defaultTemperature = 0.3,
}) {
  return function chat(messages, opts = {}) {
    return runHarness(messages, {
      provider,
      toolExecutor,
      toolSchemas,
      model: opts.model || defaultModel,
      temperature: opts.temperature ?? defaultTemperature,
      signal: opts.signal,
      stream: opts.stream,
      onTool: opts.onTool,
      onUsage: opts.onUsage,
      onReasoning: opts.onReasoning,
      onToken: opts.onToken,
      maxRounds: opts.maxRounds,
      toolPermission: opts.toolPermission,
    });
  };
}
