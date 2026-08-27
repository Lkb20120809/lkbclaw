import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wcwidth,
  displayWidth,
  tagsToAnsi,
  mapEscape,
  feed,
} from "../src/tui.js";
import blessed from "../src/tui.js";

test("wcwidth: 中文宽字符占 2 列", () => {
  assert.equal(wcwidth("a"), 1);
  assert.equal(wcwidth("中"), 2);
  assert.equal(wcwidth("本"), 2);
  assert.equal(displayWidth("中文ab"), 6);
});

test("tagsToAnsi: 颜色标签转为真 ANSI", () => {
  const out = tagsToAnsi("{#ff0000-fg}红{/}");
  assert.ok(out.includes("\x1b[38;2;255;0;0m"), "fg 应为真彩前景");
  assert.ok(out.includes("\x1b[0m"), "{/} 应为重置");
  assert.ok(!out.includes("{#"), "不应残留标签");
});

test("tagsToAnsi: 背景标签", () => {
  const out = tagsToAnsi("{#00ff00-bg}x{/}");
  assert.ok(out.includes("\x1b[48;2;0;255;0m"));
});

test("mapEscape: 方向键与控制序列", () => {
  assert.deepEqual(mapEscape("\x1b[A"), { adv: 3, name: "up" });
  assert.deepEqual(mapEscape("\x1b[B"), { adv: 3, name: "down" });
  assert.deepEqual(mapEscape("\x1b[C"), { adv: 3, name: "right" });
  assert.deepEqual(mapEscape("\x1b[D"), { adv: 3, name: "left" });
  assert.deepEqual(mapEscape("\x1b[H"), { adv: 3, name: "home" });
  assert.deepEqual(mapEscape("\x1b[F"), { adv: 3, name: "end" });
  assert.deepEqual(mapEscape("\x1b[3~"), { adv: 4, name: "delete" });
  assert.deepEqual(mapEscape("\x1b[5~"), { adv: 4, name: "pageup" });
  assert.deepEqual(mapEscape("\x1b[6~"), { adv: 4, name: "pagedown" });
  assert.deepEqual(mapEscape("\x1b[Z"), { adv: 3, name: "tab", shift: true });
});

test("feed: 普通字符与特殊键解析", () => {
  const events = [];
  const screen = { _pending: "", _keypress: (ch, key) => events.push({ ch, key }) };
  feed(screen, "h");
  feed(screen, "\x1b[A");
  feed(screen, "\r");
  feed(screen, "\x7f");
  feed(screen, "\x03");
  feed(screen, "你");
  assert.deepEqual(events[0], { ch: "h", key: undefined });
  assert.deepEqual(events[1], { ch: undefined, key: { name: "up" } });
  assert.deepEqual(events[2], { ch: undefined, key: { name: "enter" } });
  assert.deepEqual(events[3], { ch: undefined, key: { name: "backspace" } });
  assert.deepEqual(events[4], { ch: undefined, key: { name: "c", ctrl: true } });
  assert.deepEqual(events[5], { ch: "你", key: undefined });
});

test("feed: 中文在 raw 模式下正确按码点拆分", () => {
  const events = [];
  const screen = { _pending: "", _keypress: (ch, key) => events.push({ ch, key }) };
  feed(screen, "中文");
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { ch: "中", key: undefined });
  assert.deepEqual(events[1], { ch: "文", key: undefined });
});

test("box 创建后会挂到父 screen 的 _boxes（draw 才会绘制）", () => {
  const scr = blessed.screen();
  const bx = blessed.box({ parent: scr, top: 0, left: 0, width: 10, height: 1 });
  assert.ok(scr._boxes.includes(bx), "box 必须加入 screen._boxes");
  bx.setContent("hi");
  assert.equal(bx.getContent(), "hi");
});

test("pruneMessages: 久远工具调用成对压缩，不产生 orphan tool_calls", async () => {
  const { pruneMessages } = await import("../src/harness.js");
  const longOut = "x".repeat(5000);
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "第1轮" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "run_command" } }] },
    { role: "tool", content: longOut, tool_call_id: "c1" },
    { role: "user", content: "第2轮" },
    { role: "assistant", content: "回答2" },
  ];
  const out = await pruneMessages(messages, { budgetTokens: 100, keepRecent: 1 });
  const hasOrphan = out.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length &&
      !out.some((t) => t.role === "tool" && t.tool_call_id === m.tool_calls[0].id)
  );
  assert.equal(hasOrphan, false, "不应有孤儿 tool_calls（必须成对）");
  assert.ok(!out.some((m) => m.role === "tool"), "旧 tool 消息应被成对移除");
});

test("pruneMessages: 最近轮的工具对保持完整", async () => {
  const { pruneMessages } = await import("../src/harness.js");
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "u" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "run_command" } }] },
    { role: "tool", content: "ok", tool_call_id: "c1" },
  ];
  const out = await pruneMessages(messages, { keepRecent: 4 });
  const pairOk = out.some(
    (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length
  ) && out.some((m) => m.role === "tool");
  assert.equal(pairOk, true, "最近的 tool 调用对应应保留");
});
