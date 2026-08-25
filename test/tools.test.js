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

test("grep_files 能递归搜索并返回 file:line:content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkb_grep_"));
  const f = path.join(dir, "a.js");
  fs.writeFileSync(f, "foo\nbar baz\nqux foo\n");
  try {
    const r = await executeTool("grep_files", { pattern: "foo", path: dir, include: "*.js" });
    assert.ok(r.matches && r.matches.includes(`${f}:1:foo`), "应匹配第 1 行");
    assert.ok(r.matches.includes(`${f}:3:qux foo`), "应匹配第 3 行");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("grep_files 无匹配时返回 note", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lkb_grep_"));
  const f = path.join(dir, "a.js");
  fs.writeFileSync(f, "hello\nworld\n");
  try {
    const r = await executeTool("grep_files", { pattern: "nomatch_xyz", path: dir });
    assert.equal(r.matches, "");
    assert.equal(r.note, "no matches");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("grep_files 非法正则返回 error 而非抛异常", async () => {
  const r = await executeTool("grep_files", { pattern: "(", path: "." });
  assert.ok(r.error, "非法正则应返回 error 对象");
});
