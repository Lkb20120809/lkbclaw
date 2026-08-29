import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// 所有 lkbclaw 用户数据都放在「用户文档/lkbclaw」下：
//   DATA_DIR      = 文档/lkbclaw            （全局配置：providers.json / .env）
//   SESSIONS_DIR  = 文档/lkbclaw/sessions   （每个会话一个 <id>.json）
function getLkbDocsDir() {
  const home = os.homedir();
  for (const name of ["文档", "Documents", "My Documents"]) {
    const cand = path.join(home, name);
    if (fs.existsSync(cand)) return path.join(cand, "lkbclaw");
  }
  return path.join(home, "Documents", "lkbclaw");
}

export const DATA_DIR = getLkbDocsDir();
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

// 这些文件名是配置，不是会话，绝不能当孤儿清理或当会话迁移
const CONFIG_NAMES = new Set(["providers.json"]);

function ensureDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}
function fileFor(id) {
  return path.join(SESSIONS_DIR, id + ".json");
}

let cache = null;

// 兼容旧版本：会话曾平铺在 DATA_DIR 下，迁移到 sessions/ 子目录
function migrateOldSessions() {
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith(".json")) continue;
      if (CONFIG_NAMES.has(f)) continue;
      const full = path.join(DATA_DIR, f);
      let s;
      try { s = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
      if (s && s.id && Array.isArray(s.messages)) {
        try {
          fs.mkdirSync(SESSIONS_DIR, { recursive: true });
          fs.renameSync(full, fileFor(s.id));
        } catch {}
      }
    }
  } catch {}
}

export function loadSessions() {
  if (cache) return cache;
  cache = [];
  try {
    migrateOldSessions();
    ensureDir();
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
        if (s && s.id) cache.push(s);
      } catch {}
    }
  } catch {}
  return cache;
}

function writeOne(s) {
  try {
    ensureDir();
    fs.writeFileSync(fileFor(s.id), JSON.stringify(s, null, 2));
  } catch {}
}

export function saveSessions() {
  if (cache === null) loadSessions();
  const list = cache;
  const keep = new Set(list.map((s) => s.id));
  for (const s of list) writeOne(s);
  // 只清理会话子目录里的孤儿，绝不碰 DATA_DIR 下的配置文件
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (!keep.has(id)) {
        try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch {}
      }
    }
  } catch {}
}

export function findSession(id) {
  const mem = loadSessions().find((s) => s.id === id);
  if (mem) return mem;
  try {
    const s = JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
    return s && s.id ? s : undefined;
  } catch {
    return undefined;
  }
}

export function newSessionId() {
  return crypto.randomBytes(9).toString("base64url");
}

export function upsertSession(sess) {
  loadSessions();
  const i = cache.findIndex((s) => s.id === sess.id);
  if (i < 0) cache.push(sess);
  else cache[i] = sess;
  writeOne(sess);
  return sess;
}

export function deleteSession(id) {
  try { fs.unlinkSync(fileFor(id)); } catch {}
  if (cache) cache = cache.filter((s) => s.id !== id);
}
