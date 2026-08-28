import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { chat, SYSTEM_PROMPT, summarizeConversation } from "./agent.js";
import { ensureConfig } from "./setup.js";
import { loadSessions, saveSessions, findSession, newSessionId, upsertSession } from "./sessions.js";
import { info as logInfo, error as logError } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = fs.readFileSync(path.join(__dirname, "ui.html"), "utf8");

let PKG_VERSION = "1.3.1";
try {
  const pj = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  if (pj && pj.version) PKG_VERSION = pj.version;
} catch {}

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

function metricsText(m) {
  const up = Math.floor((Date.now() - m.startTime) / 1000);
  const lines = [];
  const counter = (name, desc, value) => {
    lines.push(`# HELP lkb_${name} ${desc}`);
    lines.push(`# TYPE lkb_${name} counter`);
    lines.push(`lkb_${name} ${value}`);
  };
  counter("requests_total", "Total HTTP requests handled by the gateway", m.requests);
  counter("errors_total", "Total HTTP responses with status >= 400", m.errors);
  counter("tokens_prompt_total", "Total prompt tokens consumed across chats", m.promptTokens);
  counter("tokens_completion_total", "Total completion tokens generated across chats", m.completionTokens);
  counter("tool_calls_total", "Total tool/command invocations across chats", m.toolCalls);
  counter("uptime_seconds", "Gateway process uptime in seconds", up);
  return lines.join("\n") + "\n";
}

function sendMetrics(res, m) {
  res.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
  res.end(metricsText(m));
}

const metrics = {
  startTime: Date.now(),
  requests: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  toolCalls: 0,
};

// 把常见底层错误转成用户能看懂的提示（原始信息仍会打到网关日志，便于排查）
function friendlyError(e) {
  const msg = (e && e.message ? e.message : String(e)) || "";
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network|getaddrinfo/i.test(msg))
    return "无法连接模型服务，请检查网络以及 apiBase 是否正确";
  if (/401|unauthorized|invalid api key|invalid_api_key|auth/i.test(msg))
    return "API Key 无效或无权限，请检查 providers.json / .env 中的密钥";
  if (/403/i.test(msg)) return "当前密钥无权限访问该模型";
  if (/timeout|timed out|aborted/i.test(msg))
    return "请求超时，请稍后重试或调小上下文预算";
  if (/not support|unsupported|tool_calls|does not support/i.test(msg))
    return "当前模型可能不支持工具调用，请换用支持工具的模型";
  if (/400|bad request/i.test(msg)) return "请求被拒（400）：" + msg;
  if (/429|rate limit/i.test(msg)) return "触发限流（429），请稍后重试";
  return msg || "未知错误";
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
  const rid = crypto.randomBytes(3).toString("hex");
  const tag = `\x1b[35m[#${rid}]\x1b[0m`;
  res.__logTag = tag;
  console.log(
    `${tag} \x1b[35m[chat]\x1b[0m model=${model || config.model} msgs=${messages.length}`
  );
  logInfo("chat_start", { tag, model: model || config.model, msgs: messages.length });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const clip = (s, n = 160) => {
    s = typeof s === "string" ? s : JSON.stringify(s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const onTool = (name, args, result) => {
    res.write(`data: ${JSON.stringify({ type: "tool", name, args, result })}\n\n`);
    metrics.toolCalls++;
    console.log(
      `${tag}   \x1b[33m→ 命令\x1b[0m ${name} ${clip(args)} => ${clip(result)}`
    );
    logInfo("tool", { tag, name, args: clip(args, 400), blocked: !!(result && result.blocked) });
  };
  const onUsage = (u) => {
    res.write(`data: ${JSON.stringify({ type: "usage", usage: u })}\n\n`);
    metrics.promptTokens += u.prompt_tokens || 0;
    metrics.completionTokens += u.completion_tokens || 0;
    console.log(`${tag}   \x1b[2musage\x1b[0m ${clip(u)}`);
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
  console.error(`\x1b[31m[chat] 出错: ${e.stack || e.message}\x1b[0m`);
  logError("chat_error", { tag, error: e.message });
  res.write(`data: ${JSON.stringify({ error: friendlyError(e) })}\n\n`);
  res.write("data: [DONE]\n\n");
  }
  res.end();
}

async function handleProxy(req, res) {
  const body = await readBody(req);
  console.log(
    `\x1b[34m[proxy]\x1b[0m ${config.apiBase}/v1/chat/completions stream=${!!body.stream}`
  );
  logInfo("proxy", { target: config.apiBase + "/v1/chat/completions", stream: !!body.stream });
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
  let serverClosing = false;
  let activeRequests = 0;
  if (!isLoopbackHost(host) && !config.gatewayToken) {
    config.gatewayToken = crypto.randomBytes(18).toString("base64url");
    console.log(
      `\x1b[33m网关绑定公网地址 ${host}，已自动生成访问令牌（请妥善保管，他人可得知即可能用你的密钥）:\x1b[0m\n  ${config.gatewayToken}`
    );
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);
    if (serverClosing) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "server is shutting down" }));
    }
    activeRequests++;
    const reqStart = Date.now();
    res.on("finish", () => {
      activeRequests = Math.max(0, activeRequests - 1);
      const ms = Date.now() - reqStart;
      const status = res.statusCode;
      metrics.requests++;
      if (status >= 400) metrics.errors++;
      const color = status >= 500 ? "\x1b[31m" : status >= 400 ? "\x1b[33m" : "\x1b[36m";
      const tag = res.__logTag ? res.__logTag + " " : "";
      console.log(
        `\x1b[2m${new Date().toISOString()}\x1b[0m ${tag}${color}${req.method} ${url.pathname}\x1b[0m -> ${status} (${ms}ms)`
      );
      logInfo("request", { method: req.method, path: url.pathname, status, ms, tag: res.__logTag || "" });
    });

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
      if (req.method === "GET" && url.pathname === "/metrics") {
        return sendMetrics(res, metrics);
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
      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const base = path.resolve(__dirname, "assets");
        const full = path.resolve(base, url.pathname.slice("/assets/".length));
        if (!full.startsWith(base + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return sendJSON(res, 404, { error: "not found" });
        }
        const ext = path.extname(full);
        const types = {
          ".ico": "image/x-icon",
          ".png": "image/png",
          ".svg": "image/svg+xml",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".js": "application/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".json": "application/json; charset=utf-8",
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
          upsertSession(sess);
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
            upsertSession(s);
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
    console.error(
      `\x1b[31m请求处理出错 ${req.method} ${url.pathname}: ${e.stack || e.message}\x1b[0m`
    );
    logError("request_error", { method: req.method, path: url.pathname, error: e.message });
    if (!res.headersSent) sendJSON(res, 500, { error: friendlyError(e) });
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

  const shutdown = (sig) => {
    if (serverClosing) return;
    serverClosing = true;
    console.log(
      `\n\x1b[33m收到 ${sig}，正在关闭网关（等待 ${activeRequests} 个在途请求完成）...\x1b[0m`
    );
    server.close(() => {
      console.log("\x1b[32m网关已优雅关闭。\x1b[0m");
      process.exit(0);
    });
    setTimeout(() => {
      console.log("\x1b[31m等待超时，强制退出。\x1b[0m");
      process.exit(1);
    }, 10000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

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
