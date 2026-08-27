import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { chat, SYSTEM_PROMPT, summarizeConversation } from "./agent.js";
import { ensureConfig } from "./setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = fs.readFileSync(path.join(__dirname, "ui.html"), "utf8");

let PKG_VERSION = "0.0.0";
try {
  const pj = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  if (pj && pj.version) PKG_VERSION = pj.version;
} catch {}

const SESSIONS_FILE = path.resolve(__dirname, "..", ".lkb-sessions.json");
let sessionsCache = null;
function loadSessions() {
  if (sessionsCache) return sessionsCache;
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
    const data = JSON.parse(raw);
    sessionsCache = Array.isArray(data) ? data : [];
  } catch {
    sessionsCache = [];
  }
  return sessionsCache;
}
function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsCache, null, 2));
  } catch {}
}
function findSession(id) {
  return loadSessions().find((s) => s.id === id);
}
function newSessionId() {
  return crypto.randomBytes(9).toString("base64url");
}
function readBodySafe(req) {
  return readBody(req).catch(() => ({}));
}

function isLoopbackHost(h) {
  return (
    !h ||
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1"
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const incoming = body.messages;
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (Array.isArray(incoming) && incoming.length) {
    for (const m of incoming) messages.push(m);
  } else if (body.message) {
    messages.push({ role: "user", content: body.message });
  } else {
    return sendJSON(res, 400, { error: "missing 'message' or 'messages'" });
  }
  const model = body.model;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const onTool = (name, args, result) => {
    res.write(`data: ${JSON.stringify({ type: "tool", name, args, result })}\n\n`);
  };
  const onUsage = (u) => {
    res.write(`data: ${JSON.stringify({ type: "usage", usage: u })}\n\n`);
  };
  const onReasoning = (text) => {
    res.write(`data: ${JSON.stringify({ type: "reasoning", content: text })}\n\n`);
  };

  try {
    for await (const chunk of chat(messages, { onTool, onUsage, onReasoning, model, temperature: body.temperature ?? config.temperature, summarize: summarizeConversation })) {
      res.write(`data: ${JSON.stringify({ type: "content", content: chunk })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

async function handleProxy(req, res) {
  const body = await readBody(req);
  const upstream = await fetch(`${config.apiBase}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  res.writeHead(upstream.status, {
    "Content-Type": body.stream ? "text/event-stream; charset=utf-8" : "application/json",
  });
  if (body.stream) {
    for await (const chunk of upstream.body) res.write(chunk);
  } else {
    res.end(await upstream.text());
  }
}

const UPLOAD_DIR = ".lkb-uploads";
async function handleUpload(req, res) {
  try {
    const body = await readBody(req);
    const name = String(body.name || "")
      .replace(/[^\w.\-\u4e00-\u9fa5]/g, "_")
      .slice(0, 160);
    if (!name) return sendJSON(res, 400, { error: "invalid filename" });
    const buf = Buffer.from(String(body.content || ""), "base64");
    if (buf.length > 10 * 1024 * 1024) return sendJSON(res, 413, { error: "file too large (max 10MB)" });
    const dir = path.resolve(process.cwd(), UPLOAD_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, name);
    fs.writeFileSync(full, buf);
    return sendJSON(res, 200, { ok: true, path: `${UPLOAD_DIR}/${name}` });
  } catch (e) {
    return sendJSON(res, 500, { error: e.message });
  }
}

export async function startGateway(port = 8787, host = "127.0.0.1") {
  await ensureConfig();
  if (!isLoopbackHost(host) && !config.gatewayToken) {
    config.gatewayToken = crypto.randomBytes(18).toString("base64url");
    console.log(
      `\x1b[33m网关绑定公网地址 ${host}，已自动生成访问令牌（请妥善保管，他人可得知即可能用你的密钥）:\x1b[0m\n  ${config.gatewayToken}`
    );
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);

    const token = config.gatewayToken;
    const authHeader = req.headers["authorization"] || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const authed =
      !token ||
      bearerToken === token ||
      url.searchParams.get("token") === token;

    const reqOrigin = req.headers["origin"];
    let allowOrigin = "null";
    if (isLoopbackHost(host)) {
      if (reqOrigin === `http://localhost:${port}` || reqOrigin === `http://127.0.0.1:${port}`)
        allowOrigin = reqOrigin;
    } else if (authed && reqOrigin) {
      allowOrigin = reqOrigin;
    }
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "POST" && !authed) {
      return sendJSON(res, 401, { error: "unauthorized: missing or invalid token" });
    }

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(UI_HTML);
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJSON(res, 200, {
          service: "lkbclaw gateway",
          version: PKG_VERSION,
          model: config.model,
          routes: {
            "POST /chat": "body {message} or {messages[]} -> SSE stream",
            "POST /v1/chat/completions": "proxy to Agnes API (supports stream)",
          },
        });
      }
      if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
        const base = path.resolve(__dirname, "vendor");
        const full = path.resolve(base, url.pathname.slice("/vendor/".length));
        if (!full.startsWith(base + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return sendJSON(res, 404, { error: "not found" });
        }
        const ext = path.extname(full);
        const types = {
          ".js": "application/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".map": "application/json",
        };
        res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
        return res.end(fs.readFileSync(full));
      }
      if (url.pathname === "/api/sessions" || url.pathname.startsWith("/api/sessions/")) {
        if (req.method === "GET" && url.pathname === "/api/sessions") {
          const list = loadSessions().map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            messageCount: (s.messages || []).length,
          }));
          list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          return sendJSON(res, 200, { sessions: list });
        }
        if (req.method === "POST" && url.pathname === "/api/sessions") {
          const body = await readBodySafe(req);
          const sess = {
            id: newSessionId(),
            title: (body.title || "新对话").toString().slice(0, 120),
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          loadSessions().push(sess);
          saveSessions();
          return sendJSON(res, 200, { session: sess });
        }
        const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
        if (m) {
          const id = m[1];
          if (req.method === "GET") {
            const s = findSession(id);
            if (!s) return sendJSON(res, 404, { error: "not found" });
            return sendJSON(res, 200, { session: s });
          }
          if (req.method === "PUT") {
            const body = await readBodySafe(req);
            const s = findSession(id);
            if (!s) return sendJSON(res, 404, { error: "not found" });
            if (typeof body.title === "string") s.title = body.title.slice(0, 120);
            if (Array.isArray(body.messages)) s.messages = body.messages;
            s.updatedAt = Date.now();
            saveSessions();
            return sendJSON(res, 200, { session: s });
          }
          if (req.method === "DELETE") {
            const arr = loadSessions();
            const i = arr.findIndex((s) => s.id === id);
            if (i < 0) return sendJSON(res, 404, { error: "not found" });
            arr.splice(i, 1);
            saveSessions();
            return sendJSON(res, 200, { ok: true });
          }
        }
        return sendJSON(res, 404, { error: "not found" });
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        return await handleChat(req, res);
      }
      if (req.method === "POST" && url.pathname === "/upload") {
        return await handleUpload(req, res);
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        return await handleProxy(req, res);
      }
      return sendJSON(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) sendJSON(res, 500, { error: e.message });
      else res.end();
    }
  });

  listenWithFallback(server, port, host)
    .then((actual) => {
      console.log(`lkbclaw gateway listening on http://localhost:${actual}`);
      console.log(`  GET  /                       -> 浏览器聊天界面`);
      console.log(`  POST /chat                  -> agent chat (SSE)`);
      console.log(`  POST /v1/chat/completions   -> Agnes proxy`);
    })
    .catch((e) => {
      console.error(`网关启动失败: ${e.message}`);
      process.exit(1);
    });
  return server;
}

function listenWithFallback(server, port, host, maxTries = 10) {
  return new Promise((resolve, reject) => {
    const attempt = (p) => {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && p < port + maxTries) {
          console.log(`端口 ${p} 被占用，尝试 ${p + 1}...`);
          attempt(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, host, () => {
        server.removeAllListeners("error");
        resolve(p);
      });
    };
    attempt(port);
  });
}
