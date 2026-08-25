import test from "node:test";
import assert from "node:assert/strict";
import { pruneMessages } from "../src/agent.js";

test("截断超长单条消息", () => {
  const big = "x".repeat(50000);
  const out = pruneMessages([
    { role: "system", content: "s" },
    { role: "user", content: big },
  ]);
  assert.equal(out[0].role, "system");
  assert.ok(out[1].content.length < 50000);
  assert.match(out[1].content, /truncated/);
});

test("超出预算时丢弃最早整轮，但保留 system 与 tool 配对", () => {
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
  const out = pruneMessages(msgs);
  assert.equal(out[0].role, "system");
  // 首条非 system 必须是 user（保证 tool_call/tool 配对不被拆开）
  assert.equal(out[1].role, "user");
  assert.ok(out.length < msgs.length);
});
