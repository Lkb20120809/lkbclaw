import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(scriptDir, ".env"),
  path.resolve(scriptDir, "..", ".env"),
  path.resolve(os.homedir(), ".lkbclaw", ".env"),
];
const envPath = envCandidates.find((p) => fs.existsSync(p));

function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

// 解析 "${ENV:NAME}" 占位符，便于在 providers.json 里引用 .env 中的密钥
export function resolveEnv(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\$\{(?:ENV|env):([A-Za-z0-9_]+)\}/g, (_, n) => {
    const val = process.env[n];
    if (val === undefined) {
      console.warn(`警告: 环境变量 ${n} 未设置，占位符将被替换为空字符串`);
      return "";
    }
    return val;
  });
}

// 加载 providers.json（多 API 提供商配置）
let activeProvider = null;
const providersPath = path.resolve(process.cwd(), "providers.json");
if (fs.existsSync(providersPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(providersPath, "utf8"));
    const list = Array.isArray(data) ? data : data.providers || [];
    const wanted = process.env.LKB_PROVIDER || "";
    activeProvider =
      list.find((p) => p.name === wanted) ||
      list.find((p) => p.default) ||
      list[0] ||
      null;
  } catch (e) {
    console.error("providers.json 解析失败: " + e.message);
  }
}

const apiKey = resolveEnv((activeProvider && activeProvider.apiKey) || process.env.AGNES_API_KEY || "");
const apiBase = (activeProvider && activeProvider.baseUrl) || process.env.AGNES_API_BASE || "https://apihub.agnes-ai.com";
const model = (activeProvider && activeProvider.model) || process.env.AGNES_MODEL || "agnes-2.5-flash";
const temperature = activeProvider?.temperature ?? (process.env.AGNES_TEMPERATURE ? parseFloat(process.env.AGNES_TEMPERATURE) : 0.3);

export const config = {
  apiKey,
  apiBase: apiBase.replace(/\/$/, ""),
  model,
  providerName: (activeProvider && activeProvider.name) || process.env.LKB_PROVIDER || "agnes",
  userHome: process.env.USER_HOME || process.env.HOME || process.env.USERPROFILE || "",
  gatewayToken: process.env.GATEWAY_TOKEN || "",
  temperature,
};

// 运行时切换 provider（重新读取工作目录的 providers.json 并刷新配置）
export function setProvider(name) {
  const p = path.resolve(process.cwd(), "providers.json");
  if (!fs.existsSync(p)) throw new Error("未找到 providers.json");
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  const list = Array.isArray(data) ? data : data.providers || [];
  const found = list.find((x) => x.name === name);
  if (!found) throw new Error("未找到 provider: " + name);
  config.apiKey = resolveEnv(found.apiKey || "");
  config.apiBase = (found.baseUrl || "https://apihub.agnes-ai.com").replace(/\/$/, "");
  config.model = found.model || "agnes-2.5-flash";
  config.temperature = found.temperature ?? 0.3;
  config.providerName = found.name;
}

if (!config.apiKey) {
  console.warn("警告: 未配置 API Key（providers.json 或 .env），对话与网关将无法调用模型。");
}
