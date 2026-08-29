import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveSecret } from "./keystore.js";
import { DATA_DIR } from "./sessions.js";

const LKB_DIR = DATA_DIR;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  path.join(LKB_DIR, ".env"),
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

const ProviderSchema = z
  .object({
    name: z.string().min(1, "provider 名称不能为空"),
    baseUrl: z.string().min(1, "baseUrl 不能为空").optional(),
    apiKey: z.string().optional(),
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2, "temperature 必须在 0~2 之间").optional(),
    default: z.boolean().optional(),
  })
  .passthrough();

const ConfigSchema = z.object({
  apiKey: z.string(),
  apiBase: z.string().min(1, "apiBase 不能为空"),
  model: z.string().min(1, "model 不能为空"),
  providerName: z.string().min(1),
  userHome: z.string(),
  gatewayToken: z.string(),
  temperature: z.number().min(0).max(2, "temperature 必须在 0~2 之间"),
  contextBudgetChars: z.number().int().nonnegative(),
  contextBudgetTokens: z.number().int().nonnegative(),
  keepRecentPairs: z.number().int().nonnegative(),
  memoryModel: z.string(),
});

function formatIssues(issues) {
  return issues
    .map((i) => `  - ${i.path.join(".") || "(根)"}: ${i.message}`)
    .join("\n");
}

export function validateProviders(list) {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i++) {
    const r = ProviderSchema.safeParse(list[i]);
    if (!r.success) {
      throw new Error(
        `providers.json 第 ${i + 1} 项校验失败:\n${formatIssues(r.error.issues)}`
      );
    }
  }
}

export function validateConfig(cfg) {
  const r = ConfigSchema.safeParse(cfg);
  if (!r.success) {
    throw new Error(`配置校验失败:\n${formatIssues(r.error.issues)}`);
  }
  return true;
}


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
function getProvidersPath() {
  const cands = [
    path.join(LKB_DIR, "providers.json"),
    path.resolve(process.cwd(), "providers.json"),
    path.resolve(scriptDir, "providers.json"),
    path.resolve(scriptDir, "..", "providers.json"),
    path.resolve(os.homedir(), ".lkbclaw", "providers.json"),
  ];
  return cands.find((p) => fs.existsSync(p)) || cands[0];
}
const providersPath = getProvidersPath();
if (fs.existsSync(providersPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(providersPath, "utf8"));
    const list = Array.isArray(data) ? data : data.providers || [];
    validateProviders(list);
    const wanted = process.env.LKB_PROVIDER || "";
    activeProvider =
      list.find((p) => p.name === wanted) ||
      list.find((p) => p.default) ||
      list[0] ||
      null;
  } catch (e) {
    console.error("providers.json 校验/解析失败: " + e.message);
  }
}

const apiKey = resolveSecret(resolveEnv((activeProvider && activeProvider.apiKey) || process.env.AGNES_API_KEY || ""));
const apiBase = (activeProvider && activeProvider.baseUrl) || process.env.AGNES_API_BASE || "https://apihub.agnes-ai.com";
const model = (activeProvider && activeProvider.model) || process.env.AGNES_MODEL || "agnes-2.5-flash";
const temperature = activeProvider?.temperature ?? (process.env.AGNES_TEMPERATURE ? parseFloat(process.env.AGNES_TEMPERATURE) : 0.3);
const contextBudgetChars = process.env.LKB_CONTEXT_BUDGET
  ? parseInt(process.env.LKB_CONTEXT_BUDGET, 10)
  : 240000;
const contextBudgetTokens = process.env.LKB_CONTEXT_BUDGET_TOKENS
  ? parseInt(process.env.LKB_CONTEXT_BUDGET_TOKENS, 10)
  : 60000;
const keepRecentPairs = process.env.LKB_KEEP_RECENT
  ? parseInt(process.env.LKB_KEEP_RECENT, 10)
  : 6;
const memoryModel = process.env.LKB_MEMORY_MODEL || "";

export const config = {
  apiKey,
  apiBase: apiBase.replace(/\/$/, ""),
  model,
  providerName: (activeProvider && activeProvider.name) || process.env.LKB_PROVIDER || "agnes",
  userHome: process.env.USER_HOME || process.env.HOME || process.env.USERPROFILE || "",
  gatewayToken: process.env.GATEWAY_TOKEN || "",
  temperature,
  contextBudgetChars,
  contextBudgetTokens,
  keepRecentPairs,
  memoryModel,
};

// 运行时切换 provider（重新读取工作目录的 providers.json 并刷新配置）
export function setProvider(name) {
  const p = getProvidersPath();
  if (!fs.existsSync(p)) throw new Error("未找到 providers.json");
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  const list = Array.isArray(data) ? data : data.providers || [];
  const found = list.find((x) => x.name === name);
  if (!found) throw new Error("未找到 provider: " + name);
  config.apiKey = resolveSecret(resolveEnv(found.apiKey || ""));
  config.apiBase = (found.baseUrl || "https://apihub.agnes-ai.com").replace(/\/$/, "");
  config.model = found.model || "agnes-2.5-flash";
  config.temperature = found.temperature ?? 0.3;
  config.providerName = found.name;
}

if (!config.apiKey) {
  console.warn("警告: 未配置 API Key（providers.json 或 .env），对话与网关将无法调用模型。");
}

validateConfig(config);

