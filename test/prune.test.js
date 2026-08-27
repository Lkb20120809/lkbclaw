import test from "node:test";
import assert from "node:assert/strict";
import { pruneMessages } from "../src/agent.js";

test("截断超长单条消息（按 token 预算）", async () => {
  const big = Array.from({ length: 6000 }, (_, i) => "token" + i).join(" ");
  const out = await pruneMessages([
    { role: "system", content: "s" },
    { role: "user", content: big },
  ]);
  assert.equal(out[0].role, "system");
  assert.ok(out[1].content.length < big.length, "应被截断变短");
  assert.ok(/省略|truncated/.test(out[1].content), "应包含省略标记");
});

test("超出预算时丢弃最早整轮，但保留 system 与 tool 配对", async () => {
  const msgs = [{ role: "system", content: "s" }];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: "user", content: "u".repeat(20000) });
    msgs.push({
      role: "assistant",
      content: "a",
      tool_calls: [{ id: "c" + i, type: "function", function: { name: "x", arguments: "{}" } }],
    });
    msgs.push({ role: "tool", tool_call_id: "c" + i, content: "t".repeat(20000) });
  }
  const out = await pruneMessages(msgs);
  assert.equal(out[0].role, "system");
  // 首条非 system 必须是 user（保证 tool_call/tool 配对不被拆开）
  assert.equal(out[1].role, "user");
  assert.ok(out.length < msgs.length);
});
