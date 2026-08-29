#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { main as cliMain } from "./cli.js";
import { startGateway } from "./gateway.js";
import { encryptSecret } from "./keystore.js";
import { DATA_DIR as LKB_DIR } from "./sessions.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function help() {
  console.log(`
lkbclaw - AI 开发助手

用法:
  lkbclaw              显示本帮助
  lkbclaw -cli         启动终端对话（可接提示词: lkbclaw -cli "你的需求"）
  lkbclaw -gateway     启动本地网关服务（默认端口 8787，可用 --port 指定）
  lkbclaw -keygen      生成加密的 API Key 密文（用于密文共享给所有用户）
  lkbclaw -onbread     新建/引导配置一个模型 API（交互向导，含真实连通测试）
  lkbclaw -version     查看当前版本
  lkbclaw -update      更新 lkbclaw 到最新版本（npm 全局）
  lkbclaw -h           显示本帮助

 示例:
   lkbclaw -cli "用 edit_file 把 src/agent.js 里的温度改成 0.2"
   lkbclaw -gateway --port 9000
   lkbclaw -keygen
`);
}

function pkgVersion() {
  try {
    const pj = path.resolve(scriptDir, "..", "package.json");
    return JSON.parse(fs.readFileSync(pj, "utf8")).version;
  } catch {
    return "?";
  }
}

async function update() {
  const cur = pkgVersion();
  console.log("正在查询最新版本…");
  const latest = await new Promise((res) => {
    const p = spawn("npm", ["view", "lkbclaw", "version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (c) => res(c === 0 ? out.trim() : null));
  });
  if (!latest) {
    console.error("无法获取最新版本，请手动执行: npm install -g lkbclaw@latest");
    return;
  }
  if (latest === cur) {
    console.log(`已经是最新版本 (${cur})`);
    return;
  }
  console.log(`当前 ${cur} → 最新 ${latest}，正在更新…`);
  await new Promise((resolve) => {
    const p = spawn("npm", ["install", "-g", "lkbclaw@latest"], { stdio: "inherit" });
    p.on("close", (c) => {
      if (c === 0) console.log(`\n✅ 已更新到 ${latest}，重启终端后生效 (lkbclaw -version)`);
      else console.error("\n更新失败，请手动执行: npm install -g lkbclaw@latest");
      resolve();
    });
  });
}

function readStdinAll() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.resume();
  });
}

async function keygen() {
  let plain;
  let pass;
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (p) => new Promise((r) => rl.question(p, (a) => r((a ?? "").trim())));
    plain = await ask("要加密的明文 API Key: ");
    pass = await ask("口令(留空=默认共享口令，所有用户可直接用): ");
    rl.close();
  } else {
    const data = await readStdinAll();
    const lines = data.split(/\r?\n/).map((l) => l.trim());
    plain = lines[0] || "";
    pass = lines[1] || "";
  }
  if (!plain) {
    console.error("错误: 明文 Key 不能为空");
    process.exit(1);
  }
  const token = encryptSecret(plain, pass ? pass : undefined);
  console.log("\n加密结果(密文):\n" + token);
  console.log("\n用法: 将上面的密文写入 .env 的 AGNES_API_KEY= 或 providers.json 的 apiKey 字段。");
  console.log("若使用了自定义口令，使用者需设置环境变量 LKB_KEY_PASSPHRASE=该口令 才能解密。");
}

let _leftover = "";
function readLineRaw(prompt, mask = false) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let val = "";
    let done = false;
    const wasRaw = process.stdin.isTTY ? process.stdin.isRawMode : false;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const finish = () => {
      done = true;
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      process.stdin.removeListener("data", handler);
      process.stdin.removeListener("end", onEnd);
      process.stdout.write("\n");
      resolve(val);
    };
    const handler = (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (ch === "\u0003") {
          if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
          process.stdout.write("\n");
          process.exit(1);
        }
        if (ch === "\r" || ch === "\n") {
          if (i + 1 < chunk.length) _leftover += chunk.slice(i + 1);
          finish();
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (val.length) {
            val = val.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " " && ch !== "\u0000") {
          val += ch;
          process.stdout.write(mask ? "*" : ch);
        }
      }
    };
    const onEnd = () => {
      if (!done) finish();
    };
    process.stdin.on("data", handler);
    process.stdin.on("end", onEnd);
    if (_leftover) {
      const l = _leftover;
      _leftover = "";
      handler(l);
    }
  });
}

async function choice(prompt, items, defaultIndex = null) {
  console.log(prompt);
  items.forEach((it, i) => console.log("  " + (i + 1) + ") " + it.label));
  while (true) {
    const a = (await readLineRaw("请选择 [1-" + items.length + (defaultIndex != null ? ", 回车=" + (defaultIndex + 1) : "") + "]: ")).trim();
    if (!a && defaultIndex != null) return items[defaultIndex];
    const n = parseInt(a, 10);
    if (n >= 1 && n <= items.length) return items[n - 1];
    console.log("无效输入，请重试");
  }
}

async function testConn(baseUrl, apiKey, model) {
  const url = baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], stream: false, max_tokens: 5 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const txt = await res.text();
    if (res.ok) return { ok: true, status: res.status };
    let cat;
    if (res.status === 401 || res.status === 403) cat = "密钥无效或权限不足（" + res.status + "）";
    else if (res.status === 404) cat = "接口地址错误（404）：BaseURL 可能多/少了 /v1，或路径不对";
    else if (res.status === 429) cat = "频率限制或额度耗尽（429）";
    else cat = "HTTP " + res.status + ": " + txt.slice(0, 200);
    return { ok: false, status: res.status, message: cat };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, message: "连接超时（20s）：请检查网络或 BaseURL" };
    return { ok: false, message: "网络错误: " + (e && e.message ? e.message : e) };
  }
}

async function detectOllama() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1200);
    const r = await fetch("http://localhost:11434/api/tags", { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return { running: false, models: [] };
    const j = await r.json();
    const models = Array.isArray(j.models) ? j.models.map((m) => m.name) : [];
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

function haveConfig() {
  if (fs.existsSync(path.join(LKB_DIR, "providers.json"))) return true;
  if (fs.existsSync(path.resolve(process.cwd(), "providers.json"))) return true;
  if (process.env.AGNES_API_KEY) return true;
  return false;
}

async function onbread() {
  console.log("\n========================================================");
  console.log("   lkbclaw 新手引导 · 新建 / 配置一个模型 API (onbread)");
  console.log("========================================================\n");
  console.log("lkbclaw 必须配置一个模型 API 才能调用 AI。下面会引导你填写");
  console.log("配置，并做一次【真实】连通测试（不是只保存）。\n");
  console.log("提示：密钥等同于账号密码，不要分享、不要提交 Git。");
  console.log("随时按 Ctrl+C 可退出；连通失败时也能选择“跳过测试先保存”。\n");

  const ollama = await detectOllama();
  if (ollama.running) {
    console.log(
      "✅ 检测到本地 Ollama 正在运行（localhost:11434），可用模型: " +
        (ollama.models.join(", ") || "(无模型，请先 ollama pull)")
    );
    console.log("");
  }

  const providers = [
    ...(ollama.running
      ? [{ label: `Ollama（本地，已检测到 ${ollama.models.length} 个模型）`, value: { name: "ollama", baseUrl: "http://localhost:11434" } }]
      : []),
    { label: "OpenAI (api.openai.com)", value: { name: "openai", baseUrl: "https://api.openai.com" } },
    { label: "DeepSeek (api.deepseek.com)", value: { name: "deepseek", baseUrl: "https://api.deepseek.com" } },
    { label: "智谱 Zhipu (open.bigmodel.cn)", value: { name: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4" } },
    { label: "通义千问 DashScope", value: { name: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" } },
    { label: "MiniMax", value: { name: "minimax", baseUrl: "https://api.minimax.chat/v1" } },
    { label: "Ollama（本地 localhost:11434）", value: { name: "ollama", baseUrl: "http://localhost:11434" } },
    { label: "自定义 Custom（手动填 BaseURL）", value: { name: "custom", baseUrl: "" } },
  ];
  const p = await choice("① 选择模型提供商:", providers);
  let baseUrl = p.value.baseUrl;
  if (p.value.name === "custom" || !baseUrl) {
    baseUrl = (await readLineRaw("请输入 BaseURL（到 /v1 之前，例如 https://api.xxx.com）: ")).trim();
  }
  baseUrl = baseUrl.replace(/\/$/, "");
  if (!baseUrl) {
    console.error("错误: BaseURL 不能为空");
    process.exit(1);
  }

  const source = await choice("② 凭证来源:", [
    { label: "直接粘贴 API Key（屏幕不回显明文）", value: "paste" },
    { label: "使用环境变量（如 AGNES_API_KEY）", value: "env" },
    { label: "使用 .env 文件里的变量（lkbclaw 会自动加载 .env）", value: "dotenv" },
  ], 0);
  let apiKey, apiKeyStored;
  if (source.value === "paste") {
    apiKey = await readLineRaw("请输入 API Key: ", true);
    apiKeyStored = apiKey;
  } else {
    const envName = (await readLineRaw("环境变量名 (例如 AGNES_API_KEY): ")).trim().toUpperCase();
    if (!envName) { console.error("错误: 变量名不能为空"); process.exit(1); }
    apiKeyStored = "${ENV:" + envName + "}";
    apiKey = process.env[envName] || "";
  }

  const modelDef = p.value.name === "ollama" ? "qwen2.5" : p.value.name === "deepseek" ? "deepseek-chat" : p.value.name === "qwen" ? "qwen-plus" : "gpt-4o-mini";
  let model;
  if (p.value.name === "ollama" && ollama.models.length) {
    const pick = await choice("③ 选择本地 Ollama 模型:", ollama.models.map((m) => ({ label: m, value: m })));
    model = pick.value;
  } else {
    model = (await readLineRaw("③ 默认模型 (留空=" + modelDef + "): ")).trim() || modelDef;
  }

  while (true) {
    if (!apiKey) {
      console.log("\n未拿到可用密钥（凭证来源为 env/.env 且该变量当前为空），跳过连通测试。");
      break;
    }
    console.log("\n正在做真实连通测试 → POST " + baseUrl + "/v1/chat/completions ...");
    const r = await testConn(baseUrl, apiKey, model);
    if (r.ok) {
      console.log("✅ 连通成功！可以正常调用模型。");
      break;
    }
    console.log("❌ 连通失败: " + (r.message || "HTTP " + (r.status || "")));
    const act = await choice("如何处理?", [
      { label: "重新输入密钥并重试", value: "retry" },
      { label: "修改 BaseURL 并重试", value: "url" },
      { label: "跳过测试，直接保存配置", value: "skip" },
      { label: "退出引导（不保存）", value: "exit" },
    ], 2);
    if (act.value === "exit") { console.log("\n已退出，未保存任何配置。"); process.exit(0); }
    if (act.value === "skip") break;
    if (act.value === "retry") { apiKey = await readLineRaw("重新输入 API Key: ", true); apiKeyStored = apiKey; }
    if (act.value === "url") { baseUrl = (await readLineRaw("新的 BaseURL: ")).trim().replace(/\/$/, ""); }
  }

  const providersPath = path.join(LKB_DIR, "providers.json");
  let list = [];
  if (fs.existsSync(providersPath)) {
    try {
      const d = JSON.parse(fs.readFileSync(providersPath, "utf8"));
      list = Array.isArray(d) ? d : d.providers || [];
    } catch {
      console.warn("现有 providers.json 解析失败，将被覆盖。");
    }
  }
  list.forEach((x) => (x.default = false));
  const entry = { name: p.value.name, baseUrl, apiKey: apiKeyStored, model, default: true };
  const idx = list.findIndex((x) => x.name === p.value.name);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  fs.mkdirSync(path.dirname(providersPath), { recursive: true });
  fs.writeFileSync(providersPath, JSON.stringify(list, null, 2), "utf8");

  console.log("\n✅ 已写入配置: " + providersPath);
  console.log("   提供商: " + p.value.name + "  |  模型: " + model);
  console.log("   密钥:   " + (apiKeyStored.startsWith("${ENV") ? apiKeyStored + " (运行时从环境变量读取)" : "(已明文保存，注意保密)"));
  console.log("\n接下来可以运行:");
  console.log("   lkbclaw -cli        启动终端对话");
  console.log("   lkbclaw -gateway    启动本地网关\n");
  process.exit(0);
}

async function run() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    help();
    return;
  }

  if (cmd === "-keygen" || cmd === "-encrypt") {
    await keygen();
    return;
  }

  if (cmd === "-onbread") {
    await onbread();
    return;
  }

  if (cmd === "-version" || cmd === "--version" || cmd === "-v") {
    console.log("lkbclaw " + pkgVersion());
    return;
  }

  if (cmd === "-update" || cmd === "--update") {
    await update();
    return;
  }

  if (cmd === "-cli" || cmd === "-c") {
    if (!haveConfig()) {
      console.log("未检测到配置（providers.json / AGNES_API_KEY），先运行新手引导：\n");
      await onbread();
    }
    await cliMain();
    return;
  }

  if (cmd === "-gateway" || cmd === "-g") {
    if (!haveConfig()) {
      console.log("未检测到配置（providers.json / AGNES_API_KEY），先运行新手引导：\n");
      await onbread();
    }
    let port = 8787;
    let host = "127.0.0.1";
    const i = args.indexOf("--port");
    if (i !== -1 && args[i + 1]) {
      const p = Number(args[i + 1]);
      if (p > 0 && p < 65536) port = p;
    }
    const hi = args.indexOf("--host");
    if (hi !== -1 && args[hi + 1]) host = args[hi + 1];
    await startGateway(port, host);
    return;
  }

  help();
}

run().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
