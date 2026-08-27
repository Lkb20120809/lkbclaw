import { get_encoding } from "tiktoken";

let _enc = null;
function enc() {
  if (!_enc) _enc = get_encoding("cl100k_base");
  return _enc;
}

export function countTokens(text) {
  if (!text) return 0;
  try {
    return enc().encode(String(text)).length;
  } catch {
    return Math.ceil(String(text).length / 4);
  }
}

export function countMessageTokens(m) {
  let n = 4;
  if (m.role) n += countTokens(m.role);
  if (typeof m.content === "string") n += countTokens(m.content);
  else if (m.content) n += countTokens(JSON.stringify(m.content));
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      n += 4;
      if (tc.function?.name) n += countTokens(tc.function.name);
      if (tc.function?.arguments) n += countTokens(tc.function.arguments);
    }
  }
  return n;
}

export function truncateTokens(text, maxTokens) {
  if (!text) return text;
  const s = String(text);
  const e = enc();
  const ids = e.encode(s);
  if (ids.length <= maxTokens) return s;
  const head = Math.floor(maxTokens * 0.6);
  const tail = maxTokens - head;
  const headIds = ids.slice(0, head);
  const tailIds = ids.slice(ids.length - tail);
  const dec = new TextDecoder();
  return (
    dec.decode(e.decode(headIds)) +
    `\n... [中间已省略，原始 ${ids.length} tokens，保留头 ${head}+尾 ${tail}] ...\n` +
    dec.decode(e.decode(tailIds))
  );
}
