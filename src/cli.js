#!/usr/bin/env node
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { config, setProvider } from "./config.js";
import { chat, SYSTEM_PROMPT } from "./agent.js";
import { tools } from "./tools.js";
import { highlight as hlHighlight } from "cli-highlight";
import { ensureConfig } from "./setup.js";

const messages = [{ role: "system", content: SYSTEM_PROMPT }];
const HISTORY_FILE = path.resolve(process.cwd(), ".lkbclaw-history.json");

function saveHistory(target, msgs) {
  const data = msgs.slice(1);
  fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
}
function loadHistory(target) {
  const raw = fs.readFileSync(target, "utf8");
  return JSON.parse(raw);
}

function printHelp() {
  console.log(`
lkbclaw - 开发助手 CLI
命令:
  /help       显示本帮助
  /tools      列出可用工具
  /clear      清空对话历史
  /save       保存对话到 .lkb-history.json（可选: /save 路径）
  /load       从 .lkb-history.json 载入（可选: /load 路径）
  /history    显示当前对话轮数
  /model      显示当前模型
  /quit       退出
其他输入都会发送给智能体。智能体会用工具读改代码、跑命令、做 git 操作、联网搜索。
`);
}

function printBanner() {
  console.log(`\x1b[1m\x1b[38;5;214mlkbclaw\x1b[0m  ·  \x1b[90m开发助手 CLI (claude-code 风格)\x1b[0m`);
  console.log(`\x1b[90m  model: ${config.model}  ·  /help 查看命令  ·  /quit 退出\x1b[0m\n`);
}

function printStatus(usage, toolCount) {
  const parts = [];
  if (toolCount) parts.push(`⏺ ${toolCount} 工具`);
  if (usage) parts.push(`tokens ${usage.total_tokens} (prompt ${usage.prompt_tokens} + completion ${usage.completion_tokens})`);
  parts.push(config.model);
  console.log(`\x1b[90m  ${parts.join(" · ")}\x1b[0m`);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function highlightCode(code, lang) {
  try {
    return hlHighlight(code, { language: lang || null, ignoreIllegals: true, mode: "ansi" });
  } catch {
    return code;
  }
}

// Streams assistant text: prints plain text live, but buffers fenced code
// blocks and emits them syntax-highlighted (ANSI) once the block closes.
function makeStreamPrinter() {
  let inCode = false;
  let codeLang = "";
  let codeBuf = "";
  let lineBuf = "";
  function handleLine(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        codeBuf = "";
        const m = trimmed.match(/^```(\w+)?/);
        codeLang = m && m[1] ? m[1] : "";
      } else {
        process.stdout.write(highlightCode(codeBuf, codeLang));
        if (!codeBuf.endsWith("\n")) process.stdout.write("\n");
        inCode = false;
        codeLang = "";
        codeBuf = "";
      }
      return;
    }
    if (inCode) codeBuf += line;
    else process.stdout.write(line);
  }
  return {
    onText(text) {
      lineBuf += text;
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        handleLine(lineBuf.slice(0, idx) + "\n");
        lineBuf = lineBuf.slice(idx + 1);
      }
    },
    finish() {
      if (lineBuf.length) {
        handleLine(lineBuf);
        lineBuf = "";
      }
      if (inCode) {
        process.stdout.write(highlightCode(codeBuf, codeLang));
        inCode = false;
      }
    },
  };
}

export async function main() {
  await ensureConfig();
  const rawArgs = process.argv.slice(2);
  let rest = rawArgs;
  if (rest[0] && rest[0].startsWith("-")) rest = rest.slice(1);
  const argPrompt = rest.join(" ").trim();
  if (argPrompt && !argPrompt.startsWith("/")) {
    const printer = makeStreamPrinter();
    let usage = null, toolCount = 0, reasoning = "";
    const onTool = (name, args) => { toolCount++; console.log(`  \x1b[90m⏺ ${name} ${JSON.stringify(args)}\x1b[0m`); };
    const onUsage = (u) => { usage = u; };
    const onReasoning = (t) => { reasoning += t; };
    console.log(`\x1b[90m> ${argPrompt}\x1b[0m`);
    messages.push({ role: "user", content: argPrompt });
    try {
      for await (const chunk of chat(messages, { onTool, onUsage, onReasoning })) {
        printer.onText(chunk);
      }
      printer.finish();
      if (reasoning.trim()) {
        console.log(`\x1b[90m  💭 思考: ${reasoning.trim().slice(0, 400)}${reasoning.length > 400 ? "…" : ""}\x1b[0m`);
      }
      printStatus(usage, toolCount);
      console.log();
    } catch (e) {
      console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
    }
    rl.close();
    return;
  }

  printBanner();
  printHelp();

  while (true) {
    const input = (await ask("\x1b[38;5;214m>\x1b[0m ")).trim();
    if (!input) continue;

    if (input === "/quit" || input === "/exit") break;
    if (input === "/help") {
      printHelp();
      continue;
    }
    if (input === "/clear") {
      messages.length = 1;
      console.log("Conversation cleared.");
      continue;
    }
    if (input === "/model") {
      console.log(`Model: ${config.model}\nBase: ${config.apiBase}`);
      continue;
    }
    if (input.startsWith("/model ")) {
      config.model = input.slice(6).trim();
      console.log(`已切换模型为 ${config.model}`);
      continue;
    }
    if (input === "/provider") {
      console.log(`Provider: ${config.providerName}`);
      continue;
    }
    if (input.startsWith("/provider ")) {
      try {
        setProvider(input.slice(10).trim());
        console.log(`已切换 provider: ${config.providerName}（model: ${config.model}）`);
      } catch (e) {
        console.log(`切换失败: ${e.message}`);
      }
      continue;
    }
    if (input === "/tools") {
      console.log("可用工具:");
      for (const t of tools) {
        console.log(`  - ${t.name}: ${t.description}`);
      }
      continue;
    }
    if (input.startsWith("/save")) {
      const p = input.slice(5).trim() || HISTORY_FILE;
      try {
        saveHistory(p, messages);
        console.log(`已保存 ${messages.length - 1} 条消息到 ${p}`);
      } catch (e) {
        console.log(`保存失败: ${e.message}`);
      }
      continue;
    }
    if (input.startsWith("/load")) {
      const p = input.slice(5).trim() || HISTORY_FILE;
      try {
        const data = loadHistory(p);
        messages.length = 0;
        messages.push({ role: "system", content: SYSTEM_PROMPT });
        for (const m of data) messages.push(m);
        console.log(`已从 ${p} 载入 ${data.length} 条消息`);
      } catch (e) {
        console.log(`载入失败: ${e.message}`);
      }
      continue;
    }
    if (input === "/history") {
      console.log(`当前对话: ${messages.length - 1} 条消息`);
      continue;
    }

    messages.push({ role: "user", content: input });
    console.log(`\x1b[90m> ${input}\x1b[0m`);

    const printer = makeStreamPrinter();
    let usage = null, toolCount = 0, reasoning = "";
    const onTool = (name, args) => { toolCount++; console.log(`  \x1b[90m⏺ ${name} ${JSON.stringify(args)}\x1b[0m`); };
    const onUsage = (u) => { usage = u; };
    const onReasoning = (t) => { reasoning += t; };

    try {
      for await (const chunk of chat(messages, { onTool, onUsage, onReasoning })) {
        printer.onText(chunk);
      }
      printer.finish();
      if (reasoning.trim()) {
        console.log(`\x1b[90m  💭 思考: ${reasoning.trim().slice(0, 400)}${reasoning.length > 400 ? "…" : ""}\x1b[0m`);
      }
      printStatus(usage, toolCount);
      console.log("\n");
    } catch (e) {
      console.error(`\n\x1b[31mError:\x1b[0m ${e.message}\n`);
      messages.pop();
    }
  }

  rl.close();
}

import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
