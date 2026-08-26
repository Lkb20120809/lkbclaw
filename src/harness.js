const MAX_MSG_CHARS = 20000;
const MAX_PROMPT_CHARS = 600000;
const MAX_TOOL_RESULT_CHARS = 8000;

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

  const totalChars = () =>
    rest.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : 0), 0);
  let curTotal = totalChars();
  const dropOldestTurn = (arr) => {
    let k = arr[0]?.role === "user" ? 1 : 0;
    while (k < arr.length && arr[k].role !== "user") k++;
    if (k >= arr.length) return arr;
    const removed = arr.slice(0, k);
    const subtract = (msgArr) =>
      msgArr.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : 0), 0);
    curTotal -= subtract(removed);
    return arr.slice(k);
  };

  let guard = 0;
  while (rest.length > 2 && curTotal > MAX_PROMPT_CHARS && guard++ < 1000) {
    rest = dropOldestTurn(rest);
  }

  return [...system, ...rest];
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
    signal,
    model,
    temperature = 0.3,
    maxRounds = 24,
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
      messages: pruneMessages(messages),
      tools: toolSchemas,
      temperature,
      signal,
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
          result = await toolExecutor(tc.function.name, args);
        } catch (e) {
          result = { error: String(e && e.message ? e.message : e) };
        }
        if (onTool) onTool(tc.function.name, args, result);
        const toolContent = truncateStr(
          JSON.stringify(result),
          MAX_TOOL_RESULT_CHARS
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
      onTool: opts.onTool,
      onUsage: opts.onUsage,
      onReasoning: opts.onReasoning,
      maxRounds: opts.maxRounds,
    });
  };
}
