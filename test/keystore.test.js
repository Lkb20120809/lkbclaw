import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  resolveSecret,
  getPassphrase,
} from "../src/keystore.js";

test("encryptSecret 产出 enc: 前缀密文，且可原样解密", () => {
  const token = encryptSecret("sk-1234567890", "mypass");
  assert.ok(isEncrypted(token));
  assert.equal(decryptSecret(token, "mypass"), "sk-1234567890");
});

test("不同口令无法解密", () => {
  const token = encryptSecret("secret-value", "right");
  assert.throws(() => decryptSecret(token, "wrong"), /解密|auth/i);
});

test("相同明文每次加密结果不同(随机 IV)，但都能解密", () => {
  const a = encryptSecret("x", "p");
  const b = encryptSecret("x", "p");
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, "p"), "x");
  assert.equal(decryptSecret(b, "p"), "x");
});

test("resolveSecret 对明文原样返回", () => {
  assert.equal(resolveSecret("plain-text"), "plain-text");
});

test("resolveSecret 对 enc: 用默认口令解密", () => {
  const token = encryptSecret("hello", getPassphrase());
  assert.equal(resolveSecret(token), "hello");
});

test("resolveSecret 解密失败返回空串并告警", () => {
  const token = encryptSecret("data", "correct");
  const out = resolveSecret(token, "wrong");
  assert.equal(out, "");
});
