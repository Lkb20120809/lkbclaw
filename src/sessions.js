import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SESSIONS_FILE = path.resolve(__dirname, "..", ".lkb-sessions.json");

let cache = null;

export function loadSessions() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
    const data = JSON.parse(raw);
    cache = Array.isArray(data) ? data : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

export function findSession(id) {
  return loadSessions().find((s) => s.id === id);
}

export function newSessionId() {
  return crypto.randomBytes(9).toString("base64url");
}

export function upsertSession(sess) {
  const arr = loadSessions();
  const i = arr.findIndex((s) => s.id === sess.id);
  if (i < 0) arr.push(sess);
  else arr[i] = sess;
  saveSessions();
  return sess;
}
