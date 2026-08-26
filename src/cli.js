#!/usr/bin/env node
import blessed from "blessed";
import fs from "node:fs";
import path from "node:path";
import { config, setProvider } from "./config.js";
import { chat, SYSTEM_PROMPT } from "./agent.js";
import { tools, executeTool } from "./tools.js";
import { ensureConfig } from "./setup.js";

const PLAN_NOTE =
  "\n\n[PLAN MODE] 你处于计划模式。请只进行调查、阅读、搜索与规划，给出清晰的计划与理由，不要修改任何文件，也不要执行会改变状态的命令（如写文件、git commit、运行构建/测试等）。如需写文件请先征求用户同意。";

const LOGO = [
  " ██╗     ██╗  ██╗██████╗  █████╗  ██████╗██╗    ██╗",
  " ██║     ██║ ██╔╝██╔══██╗██╔══██╗██╔════╝██║    ██║",
  " ██║     ██║████║ ██████╔╝███████║██║     ██║ █╗ ██║",
  " ██║     ██║╚██╝ ██╔══██╗██╔══██║██║     ██║███╗██║",
  " ███████╗██║ ╚═╝ ██║  ██║██║  ██║╚██████╗╚███╔███╔╝",
  " ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══╝╚══╝",
];

const messages = [{ role: "system", content: SYSTEM_PROMPT }];
let mode = "build";
const cards = [];
let sessionTokens = 0;
let lastUsage = null;
const todos = [];
let inputBuffer = "";
let cursor = 0;
let viewTop = 0;
let busy = false;

let suggestions = [];
let suggestSel = 0;
let suggestActive = false;
let suggestAt = -1;

let screen, convBox, inputBox, rightBox, suggestBox;
let convLines = [];
let convWidth = 80;
let convHeight = 20;
let rightWidth = 30;

function escapeBlessed(s) {
  return String(s).replace(/[{}]/g, (c) => (c === "{" ? "{{" : "}}"));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function wrap(text, width, indent = "") {
  const res = [];
  const lines = String(text).split("\n");
  for (const raw of lines) {
    if (raw.length === 0) {
      res.push(indent);
      continue;
    }
    let line = raw;
    while (line.length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      res.push(indent + line.slice(0, cut));
      line = line.slice(cut).replace(/^\s+/, "");
    }
    res.push(indent + line);
  }
  return res;
}

function updateSystem() {
  messages[0].content = SYSTEM_PROMPT + (mode === "plan" ? PLAN_NOTE : "");
}

function setMode(m) {
  mode = m;
  updateSystem();
  renderInput();
  renderRight();
  screen.render();
}

function addChatCard(userText) {
  const card = {
    type: "chat",
    n: cards.filter((c) => c.type === "chat").length + 1,
    user: userText,
    assistant: "",
    reasoning: "",
    tools: [],
  };
  cards.push(card);
  return card;
}

function refreshLayout() {
  convWidth = Math.max(20, Math.floor(screen.width * 0.72) - 2);
  convHeight = Math.max(5, screen.height - 3);
  rightWidth = Math.max(10, screen.width - Math.floor(screen.width * 0.72));
}

function buildCardLines(card) {
  const w = convWidth - 2;
  const out = [];
  if (card.type === "shell") {
    out.push("{green-fg}! " + escapeBlessed(card.shell) + "{/}");
    for (const l of wrap(card.output || "", w, "  ")) out.push(l);
    return out;
  }
  if (card.type === "error") {
    out.push("{red-fg}⚠ " + escapeBlessed(card.text) + "{/}");
    return out;
  }
  out.push("{cyan-fg}── 第 " + card.n + " 轮 ──{/}");
  for (const l of wrap(card.user, w, "{yellow-fg}> {/}")) out.push(l);
  if (card.reasoning && card.reasoning.trim()) {
    out.push("{gray-fg}💭 " + escapeBlessed(card.reasoning.trim().slice(0, 600)) + "{/}");
  }
  if (card.assistant && card.assistant.trim()) {
    for (const l of wrap(card.assistant, w)) out.push(escapeBlessed(l));
  }
  for (const t of card.tools) {
    out.push("{gray-fg}⏺ " + escapeBlessed(t.name) + " " + escapeBlessed(JSON.stringify(t.args)) + "{/}");
    if (t.result && t.result.error) {
      out.push("{gray-fg}  ✗ " + escapeBlessed(String(t.result.error)).slice(0, 200) + "{/}");
    }
  }
  return out;
}

function renderConv() {
  if (cards.length === 0) {
    const off = Math.max(0, Math.floor(convHeight * 0.28));
    const logo = LOGO.map((l) => {
      const pad = Math.max(0, Math.floor((convWidth - l.length) / 2));
      return " ".repeat(pad) + l;
    });
    convLines = [
      ...Array(off).fill(""),
      ...logo,
      "",
      " ".repeat(Math.max(0, Math.floor((convWidth - 24) / 2))) +
        "{gray-fg}输入需求开始对话 — Shift+Tab 切换 PLAN/BUILD{/}",
      "",
      " ".repeat(Math.max(0, Math.floor((convWidth - 40) / 2))) +
        "{gray-fg}@ 引用文件   ! 执行命令   /help 帮助{/}",
    ];
  } else {
    const blocks = cards.map(buildCardLines);
    const all = [];
    for (let i = blocks.length - 1; i >= 0; i--) {
      all.push(...blocks[i]);
      all.push("");
    }
    convLines = all;
  }
  const maxTop = Math.max(0, convLines.length - 1);
  viewTop = clamp(viewTop, 0, maxTop);
  const win = convLines.slice(viewTop, viewTop + convHeight);
  convBox.setContent(win.join("\n"));
}

let renderScheduled = false;
function scheduleConvRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    renderConv();
    screen.render();
  }, 40);
}

function renderInput() {
  const prefix = mode === "plan" ? "{magenta-fg}PLAN{/} " : "{green-fg}BUILD{/} ";
  const cur = cursor < inputBuffer.length ? inputBuffer[cursor] : " ";
  const before = inputBuffer.slice(0, cursor);
  const after = inputBuffer.slice(cursor + 1);
  const line = prefix + escapeBlessed(before) + "{black-bg}{white-fg}" + escapeBlessed(cur) + "{/}" + escapeBlessed(after);
  const hint = "{gray-fg}Enter 发送 · Shift+Tab 模式 · @ 文件 · ! 命令 · /help · Ctrl+C 退出{/}";
  inputBox.setContent(line + "\n" + hint);
}

function renderRight() {
  const w = Math.max(10, rightWidth - 2);
  const lines = [];
  lines.push("{bold}lkbclaw{/}");
  lines.push("─".repeat(Math.min(w, 20)));
  lines.push("模式: {" + (mode === "plan" ? "magenta-fg" : "green-fg") + "}" + mode.toUpperCase() + "{/}");
  lines.push("模型: " + escapeBlessed(config.model));
  lines.push("供应商: " + escapeBlessed(config.providerName));
  lines.push("");
  lines.push("TOKENS: " + sessionTokens);
  if (lastUsage) lines.push("USED: " + lastUsage.prompt_tokens + "+" + lastUsage.completion_tokens);
  lines.push("轮次: " + cards.filter((c) => c.type === "chat").length);
  lines.push("");
  lines.push("目录:");
  for (const l of wrap(process.cwd(), w, " ")) lines.push(l);
  lines.push("");
  lines.push("TODO:");
  if (todos.length === 0) lines.push(" (空)");
  todos.forEach((t, i) => lines.push(" " + (t.done ? "[x]" : "[ ]") + " " + (i + 1) + ". " + escapeBlessed(t.text)));
  lines.push("");
  lines.push("状态: " + (busy ? "{yellow-fg}思考中…{/}" : "{green-fg}就绪{/}"));
  rightBox.setContent(lines.join("\n"));
}

function safeResolve(p) {
  const base = process.cwd();
  const full = path.isAbsolute(p) ? p : path.resolve(base, p);
  if (!full.startsWith(base + path.sep) && full !== base) return null;
  return full;
}

let fileIndexCache = null;
function getFileIndex() {
  if (fileIndexCache) return fileIndexCache;
  const root = process.cwd();
  const out = [];
  const walk = (dir, rel, depth) => {
    if (out.length > 2000) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      if (e.name.startsWith(".")) continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (depth < 6) walk(path.join(dir, e.name), r, depth + 1);
      } else {
        out.push(r);
      }
    }
  };
  walk(root, "", 0);
  out.sort((a, b) => a.length - b.length);
  fileIndexCache = out;
  return out;
}

function computeSuggestions() {
  const before = inputBuffer.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at === -1) {
    suggestActive = false;
    return;
  }
  const afterAt = before.slice(at + 1);
  if (/\s/.test(afterAt)) {
    suggestActive = false;
    return;
  }
  const q = afterAt.toLowerCase();
  const idx = getFileIndex().filter((f) => f.toLowerCase().includes(q)).slice(0, 60);
  suggestions = idx;
  suggestAt = at;
  suggestSel = 0;
  suggestActive = suggestions.length > 0;
}

function renderSuggest() {
  if (!suggestActive) {
    suggestBox.hide();
    return;
  }
  suggestBox.clearItems();
  for (const s of suggestions) suggestBox.addItem(s);
  suggestBox.select(suggestSel);
  suggestBox.show();
}

function acceptSuggestion() {
  if (!suggestActive || !suggestions[suggestSel]) return;
  const pick = suggestions[suggestSel];
  const head = inputBuffer.slice(0, suggestAt);
  const tail = inputBuffer.slice(cursor);
  inputBuffer = head + "@" + pick + " " + tail;
  cursor = head.length + pick.length + 2;
  suggestActive = false;
  suggestBox.hide();
  renderInput();
  screen.render();
}

function moveSuggest(d) {
  if (!suggestActive) return;
  suggestSel = clamp(suggestSel + d, 0, suggestions.length - 1);
  suggestBox.select(suggestSel);
  screen.render();
}

function expandAtFiles(text) {
  const re = /@([^\s]+)/g;
  let m;
  const appended = [];
  while ((m = re.exec(text))) {
    const full = safeResolve(m[1]);
    if (!full) continue;
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    try {
      let content = fs.readFileSync(full, "utf8");
      if (content.length > 50000) content = content.slice(0, 50000) + "\n...[截断]";
      const ext = path.extname(full).slice(1) || "";
      appended.push("\n\n参考文件 " + m[1] + ":\n```" + ext + "\n" + content + "\n```");
    } catch {
      continue;
    }
  }
  return appended.length ? text + appended.join("") : text;
}

function formatShell(res) {
  if (!res) return "(无输出)";
  let out = "";
  if (res.stdout) out += res.stdout;
  if (res.stderr) out += (out && !out.endsWith("\n") ? "\n" : "") + res.stderr;
  if (res.error) out += "\n[error] " + res.error;
  return out.trim() || "(无输出)";
}

async function runShell(cmd) {
  const card = { type: "shell", shell: cmd, output: "(执行中…)" };
  cards.push(card);
  renderConv();
  screen.render();
  try {
    const res = await executeTool("run_command", { command: cmd });
    card.output = formatShell(res);
  } catch (e) {
    card.output = "[error] " + (e && e.message ? e.message : e);
  }
  renderConv();
  screen.render();
}

async function downloadFile(url, dest) {
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return "下载失败 HTTP " + r.status;
    const buf = Buffer.from(await r.arrayBuffer());
    let target = dest || path.basename(new URL(url).pathname) || "download.bin";
    target = path.resolve(process.cwd(), target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    return "已保存: " + target + " (" + buf.length + " bytes)";
  } catch (e) {
    return "下载失败: " + (e && e.message ? e.message : e);
  }
}

async function handleCommand(text) {
  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = text.slice(cmd.length + 2).trim();

  if (cmd === "help") {
    cards.push({
      type: "error",
      text:
        "命令: /help /tools /clear /save [path] /load [path] /history /model [name] /provider [name] /mode [plan|build] /todo add|done|rm|list|clear <text> /download <url> [dest] /quit",
    });
    viewTop = 0;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "tools") {
    cards.push({
      type: "error",
      text: "可用工具:\n" + tools.map((t) => "  - " + t.name + ": " + t.description).join("\n"),
    });
    viewTop = 0;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "clear") {
    cards.length = 0;
    messages.length = 1;
    updateSystem();
    viewTop = 0;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "model") {
    if (arg) {
      config.model = arg;
      cards.push({ type: "error", text: "已切换模型: " + config.model });
    } else {
      cards.push({ type: "error", text: "Model: " + config.model + "\nBase: " + config.apiBase });
    }
    viewTop = 0;
    renderConv();
    renderRight();
    screen.render();
    return;
  }
  if (cmd === "provider") {
    if (arg) {
      try {
        setProvider(arg);
        cards.push({ type: "error", text: "已切换 provider: " + config.providerName + " (model: " + config.model + ")" });
      } catch (e) {
        cards.push({ type: "error", text: "切换失败: " + e.message });
      }
    } else {
      cards.push({ type: "error", text: "Provider: " + config.providerName });
    }
    viewTop = 0;
    renderConv();
    renderRight();
    screen.render();
    return;
  }
  if (cmd === "mode") {
    if (arg === "plan" || arg === "build") setMode(arg);
    else cards.push({ type: "error", text: "用法: /mode plan | build" });
    viewTop = 0;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "history") {
    cards.push({ type: "error", text: "当前对话: " + cards.filter((c) => c.type === "chat").length + " 轮" });
    viewTop = 0;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "save") {
    const p = arg || path.resolve(process.cwd(), ".lkb-history.json");
    try {
      fs.writeFileSync(p, JSON.stringify(messages.slice(1), null, 2), "utf8");
      cards.push({ type: "error", text: "已保存 " + (messages.length - 1) + " 条消息到 " + p });
    } catch (e) {
      cards.push({ type: "error", text: "保存失败: " + e.message });
    }
    viewTop = 0;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "load") {
    const p = arg || path.resolve(process.cwd(), ".lkb-history.json");
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      messages.length = 0;
      messages.push({ role: "system", content: SYSTEM_PROMPT });
      updateSystem();
      for (const m of data) messages.push(m);
      cards.length = 0;
      cards.push({ type: "error", text: "已从 " + p + " 载入 " + data.length + " 条消息" });
    } catch (e) {
      cards.push({ type: "error", text: "载入失败: " + e.message });
    }
    viewTop = 0;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "todo") {
    const sub = parts[1] ? parts[1].toLowerCase() : "list";
    const rest = parts.slice(2).join(" ");
    if (sub === "add") {
      if (rest) todos.push({ text: rest, done: false });
    } else if (sub === "done") {
      const i = parseInt(rest, 10) - 1;
      if (todos[i]) todos[i].done = true;
    } else if (sub === "rm") {
      const i = parseInt(rest, 10) - 1;
      if (todos[i]) todos.splice(i, 1);
    } else if (sub === "clear") {
      todos.length = 0;
    }
    renderRight();
    screen.render();
    return;
  }
  if (cmd === "download") {
    const url = parts[1];
    const dest = parts.slice(2).join(" ");
    if (!url) {
      cards.push({ type: "error", text: "用法: /download <url> [dest]" });
    } else {
      const card = { type: "shell", shell: "download " + url, output: "(下载中…)" };
      cards.push(card);
      viewTop = 0;
      renderConv();
      screen.render();
      const res = await downloadFile(url, dest);
      card.output = res;
    }
    viewTop = 0;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "quit" || cmd === "exit") {
    quit();
    return;
  }
  cards.push({ type: "error", text: "未知命令: /" + cmd + " (输入 /help 查看)" });
  viewTop = 0;
  renderConv();
  screen.render();
}

async function doSend() {
  const text = inputBuffer;
  inputBuffer = "";
  cursor = 0;
  renderInput();
  if (!text.trim()) return;

  if (text.startsWith("/")) {
    await handleCommand(text);
    return;
  }
  if (text.startsWith("!")) {
    await runShell(text.slice(1).trim());
    return;
  }

  const expanded = expandAtFiles(text);
  const card = addChatCard(text);
  messages.push({ role: "user", content: expanded });
  busy = true;
  renderRight();
  viewTop = 0;
  renderConv();
  screen.render();

  const onText = (t) => {
    card.assistant += t;
    scheduleConvRender();
  };
  const onReasoning = (t) => {
    card.reasoning += t;
  };
  const onTool = (name, args, result) => {
    card.tools.push({ name, args, result });
    scheduleConvRender();
  };
  const onUsage = (u) => {
    lastUsage = u;
    sessionTokens += u.total_tokens || 0;
    renderRight();
  };

  try {
    for await (const chunk of chat(messages, {
      onTool,
      onUsage,
      onReasoning,
      temperature: config.temperature,
    })) {
      onText(chunk);
    }
  } catch (e) {
    card.assistant += "\n\n[错误] " + (e && e.message ? e.message : e);
  }
  busy = false;
  viewTop = 0;
  renderConv();
  renderRight();
  screen.render();
}

function scrollConv(d) {
  viewTop = clamp(viewTop + d, 0, Math.max(0, convLines.length - 1));
  renderConv();
  screen.render();
}

function insertChar(ch) {
  inputBuffer = inputBuffer.slice(0, cursor) + ch + inputBuffer.slice(cursor);
  cursor++;
  renderInput();
  computeSuggestions();
  renderSuggest();
  screen.render();
}

function deleteChar() {
  if (cursor === 0) return;
  inputBuffer = inputBuffer.slice(0, cursor - 1) + inputBuffer.slice(cursor);
  cursor--;
  renderInput();
  computeSuggestions();
  renderSuggest();
  screen.render();
}

function deleteForward() {
  if (cursor >= inputBuffer.length) return;
  inputBuffer = inputBuffer.slice(0, cursor) + inputBuffer.slice(cursor + 1);
  renderInput();
  computeSuggestions();
  renderSuggest();
  screen.render();
}

function quit() {
  if (screen) screen.destroy();
  process.exit(0);
}

function onKey(ch, key) {
  if (!key) {
    if (ch) insertChar(ch);
    return;
  }
  const k = key.name;
  const shift = key.shift;

  if (shift && k === "tab") {
    setMode(mode === "plan" ? "build" : "plan");
    return;
  }

  if (suggestActive) {
    if (k === "tab" || k === "enter" || k === "right") {
      acceptSuggestion();
      return;
    }
    if (k === "up") {
      moveSuggest(-1);
      return;
    }
    if (k === "down") {
      moveSuggest(1);
      return;
    }
    if (k === "escape") {
      suggestActive = false;
      suggestBox.hide();
      screen.render();
      return;
    }
  } else {
    if (k === "enter") {
      if (!busy) doSend();
      return;
    }
    if (k === "up") {
      scrollConv(-1);
      return;
    }
    if (k === "down") {
      scrollConv(1);
      return;
    }
    if (k === "pageup") {
      scrollConv(-Math.max(1, convHeight - 2));
      return;
    }
    if (k === "pagedown") {
      scrollConv(Math.max(1, convHeight - 2));
      return;
    }
    if (k === "c" && key.ctrl) {
      quit();
      return;
    }
  }

  if (k === "backspace") {
    deleteChar();
    return;
  }
  if (k === "delete") {
    deleteForward();
    return;
  }
  if (k === "left") {
    if (cursor > 0) cursor--;
    renderInput();
    screen.render();
    return;
  }
  if (k === "right") {
    if (cursor < inputBuffer.length) cursor++;
    renderInput();
    screen.render();
    return;
  }
  if (k === "home") {
    cursor = 0;
    renderInput();
    screen.render();
    return;
  }
  if (k === "end") {
    cursor = inputBuffer.length;
    renderInput();
    screen.render();
    return;
  }
  if (k === "escape") {
    inputBuffer = "";
    cursor = 0;
    suggestActive = false;
    suggestBox.hide();
    renderInput();
    screen.render();
    return;
  }
  if (ch && !key.ctrl && !key.meta && k !== "tab" && k !== "enter") {
    insertChar(ch);
  }
}

export async function main() {
  await ensureConfig();
  updateSystem();

  screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "lkbclaw",
  });

  refreshLayout();

  convBox = blessed.box({
    parent: screen,
    left: "0%",
    top: "0%",
    width: "72%",
    height: "-3",
    tags: true,
    scrollable: false,
    border: { type: "line" },
    label: " 对话 ",
    style: { border: { fg: "cyan" } },
  });

  inputBox = blessed.box({
    parent: screen,
    left: "0%",
    bottom: 0,
    width: "72%",
    height: 3,
    tags: true,
    border: { type: "line" },
    style: { border: { fg: "green" } },
  });

  rightBox = blessed.box({
    parent: screen,
    right: 0,
    width: "28%",
    top: 0,
    height: "100%",
    tags: true,
    border: { type: "line" },
    label: " 信息 ",
    style: { border: { fg: "magenta" } },
    scrollable: true,
  });

  suggestBox = blessed.list({
    parent: screen,
    left: "0%",
    bottom: 3,
    width: "60%",
    height: 8,
    tags: false,
    hidden: true,
    border: { type: "line" },
    label: " 文件 ",
    style: {
      border: { fg: "yellow" },
      selected: { bg: "blue", fg: "white" },
      item: { fg: "white" },
    },
  });

  screen.key(["C-c"], () => quit());

  screen.on("keypress", onKey);
  screen.on("resize", () => {
    refreshLayout();
    renderConv();
    renderRight();
    renderInput();
    screen.render();
  });

  renderConv();
  renderRight();
  renderInput();
  screen.render();

  const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.startsWith("--"));
  const argPrompt = rawArgs.join(" ").trim();
  if (argPrompt && !argPrompt.startsWith("/")) {
    inputBuffer = argPrompt;
    cursor = argPrompt.length;
    doSend();
  }
}

import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
