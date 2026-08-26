import test from "node:test";
import assert from "node:assert/strict";
import { runHarness, createHarness, pruneMessages } from "../src/harness.js";

async function* fakeProvider({ messages }) {
  const last = messages[messages.length - 1];
  if (last && last.role === "tool") {
    yield { choices: [{ delta: { content: "最终回复" } }] };
    yield { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
    return;
  }
  yield {
    choices: [
      { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"x":1}' } }] } },
    ],
  };
}

const toolExecutor = async (name, args) => ({ name, args, ok: true });

test("harness 跑通 工具调用→结果→最终回复 的循环", async () => {
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ];
  const chunks = [];
  const called = [];
  let usage = null;
  for await (const c of runHarness(messages, {
    provider: { streamChat: fakeProvider },
    toolExecutor,
    toolSchemas: [],
    onTool: (n) => called.push(n),
    onUsage: (u) => (usage = u),
  })) {
    chunks.push(c);
  }

  assert.deepEqual(called, ["echo"]);
  assert.equal(chunks.join(""), "最终回复");
  assert.equal(usage.total_tokens, 3);
  const assistantWithTool = messages.find((m) => m.role === "assistant" && m.tool_calls);
  assert.ok(assistantWithTool, "应生成带 tool_calls 的 assistant 消息");
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "应把工具结果回灌到 messages");
});

test("createHarness 返回一个 chat(messages, opts) 函数", async () => {
  const chat = createHarness({
    provider: { streamChat: fakeProvider },
    toolExecutor,
    toolSchemas: [],
  });
  assert.equal(typeof chat, "function");
  const messages = [{ role: "user", content: "u" }];
  const out = [];
  for await (const c of chat(messages, {})) out.push(c);
  assert.equal(out.join(""), "最终回复");
});

test("pruneMessages 在超出预算时丢弃最早整轮但保留 system", () => {
  const big = "a".repeat(20000);
  const msgs = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: big });
  }
  const out = pruneMessages(msgs);
  assert.equal(out[0].role, "system");
  assert.ok(out.length < msgs.length, "应丢弃至少一轮");
});
