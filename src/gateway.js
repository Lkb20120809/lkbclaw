import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { chat, SYSTEM_PROMPT } from "./agent.js";
import { ensureConfig } from "./setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = fs.readFileSync(path.join(__dirname, "ui.html"), "utf8");

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
    for await (const chunk of chat(messages, { onTool, onUsage, onReasoning, model })) {
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

  res.writeHead(upstream.status, { "Content-Type": "application/json" });
  if (body.stream) {
    for await (const chunk of upstream.body) res.write(chunk);
  } else {
    res.end(await upstream.text());
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
      if (req.method === "POST" && url.pathname === "/chat") {
        return await handleChat(req, res);
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
