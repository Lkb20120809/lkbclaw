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
