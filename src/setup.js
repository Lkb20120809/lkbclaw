import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";

const CONFIG_DIR = path.join(os.homedir(), ".lkbclaw");
const ENV_PATH = path.join(CONFIG_DIR, ".env");

export async function ensureConfig() {
  if (config.apiKey) return;

  if (!process.stdin.isTTY) {
    console.error(
      "\x1b[31m未配置 API Key，lkbclaw 无法运行。\x1b[0m\n" +
        "请创建配置文件（任选其一）后再运行：\n" +
        `  全局: ${ENV_PATH}\n` +
        "  项目: ./.env\n\n" +
        "内容示例：\n" +
        "  AGNES_API_KEY=你的密钥\n" +
        "  AGNES_API_BASE=https://apihub.agnes-ai.com\n" +
        "  AGNES_MODEL=agnes-2.5-flash\n"
    );
    process.exit(1);
  }

  console.log(
    "\x1b[1m\x1b[38;5;214mlkbclaw\x1b[0m 首次运行：需要配置 API Key（仅此一次，保存到 ~/.lkbclaw/.env）\n"
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (p) => new Promise((r) => rl.question(p, r));

  const baseDef = "https://apihub.agnes-ai.com";
  const modelDef = "agnes-2.5-flash";

  const base = (await ask(`API Base URL [${baseDef}]: `)).trim() || baseDef;
  let key = (await ask("API Key (必填): ")).trim();
  while (!key) {
    console.log("  API Key 不能为空，请重新输入");
    key = (await ask("API Key (必填): ")).trim();
  }
  const model = (await ask(`Model [${modelDef}]: `)).trim() || modelDef;
  rl.close();

  const cleanBase = base.replace(/\/$/, "");
  const content =
    "# lkbclaw 全局配置（首次引导生成，可手动编辑）\n" +
    `AGNES_API_BASE=${cleanBase}\n` +
    `AGNES_API_KEY=${key}\n` +
    `AGNES_MODEL=${model}\n`;

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(ENV_PATH, content, { mode: 0o600 });
  } catch (e) {
    console.error(`\x1b[31m保存配置失败: ${e.message}\x1b[0m`);
  }

  config.apiKey = key;
  config.apiBase = cleanBase;
  config.model = model;
  process.env.AGNES_API_BASE = cleanBase;
  process.env.AGNES_API_KEY = key;
  process.env.AGNES_MODEL = model;

  console.log(`\x1b[32m✓ 配置已保存到 ${ENV_PATH}\x1b[0m 下次运行无需重复输入。\n`);
}
