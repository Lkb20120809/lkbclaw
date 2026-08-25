import test from "node:test";
import assert from "node:assert/strict";
import { resolveEnv } from "../src/config.js";

test("resolveEnv 替换 ${ENV:NAME}", () => {
  process.env.LKB_TEST_X = "abc";
  assert.equal(resolveEnv("${ENV:LKB_TEST_X}"), "abc");
  assert.equal(resolveEnv("prefix-${ENV:LKB_TEST_X}-suffix"), "prefix-abc-suffix");
  assert.equal(resolveEnv("${ENV:LKB_TEST_MISSING}"), "");
  delete process.env.LKB_TEST_X;
});

test("resolveEnv 原样返回非占位符", () => {
  assert.equal(resolveEnv("plain text"), "plain text");
});
