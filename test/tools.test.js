import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/tools.js";

test("未知工具返回 error 而非抛异常", async () => {
  const r = await executeTool("no_such_tool_xyz", {});
  assert.ok(r.error, "应返回包含 error 的对象");
});

test("read_file 能读取临时文件", async () => {
  const f = path.join(os.tmpdir(), "lkb_test_" + Date.now() + ".txt");
  fs.writeFileSync(f, "hello-world");
  try {
    const r = await executeTool("read_file", { path: f });
    assert.equal(r.content, "hello-world");
  } finally {
    fs.unlinkSync(f);
  }
});

test("edit_file 对不存在的旧串返回 error", async () => {
  const f = path.join(os.tmpdir(), "lkb_test_edit_" + Date.now() + ".txt");
  fs.writeFileSync(f, "abc");
  try {
    const r = await executeTool("edit_file", { path: f, old_string: "nope", new_string: "x" });
    assert.ok(r.error);
  } finally {
    fs.unlinkSync(f);
  }
});
