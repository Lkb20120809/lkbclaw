import crypto from "node:crypto";

const PREFIX = "enc:";
const SALT = "lkbclaw-keystore-salt";
const BUILTIN_PASSPHRASE = "lkbclaw-shared-default-v1";

function deriveKey(passphrase) {
  return crypto.scryptSync(passphrase, SALT, 32);
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function getPassphrase() {
  return process.env.LKB_KEY_PASSPHRASE || BUILTIN_PASSPHRASE;
}

export function encryptSecret(plain, passphrase = BUILTIN_PASSPHRASE) {
  const key = deriveKey(passphrase);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(token, passphrase = BUILTIN_PASSPHRASE) {
  if (!isEncrypted(token)) throw new Error("不是加密令牌(应以 enc: 开头)");
  const buf = Buffer.from(token.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const key = deriveKey(passphrase);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function resolveSecret(value, passphrase) {
  if (!isEncrypted(value)) return value;
  try {
    return decryptSecret(value, passphrase || getPassphrase());
  } catch (e) {
    console.warn(`警告: 解密 enc: 密钥失败 (${e.message})，请检查 LKB_KEY_PASSPHRASE 是否正确`);
    return "";
  }
}
