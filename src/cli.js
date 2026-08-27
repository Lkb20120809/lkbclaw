#!/usr/bin/env node
import blessed from "blessed";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

let PKG_VERSION = "0.2.1";
try {
  const pj = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (pj && pj.version) PKG_VERSION = pj.version;
} catch {}
import { config, setProvider } from "./config.js";
import { chat, SYSTEM_PROMPT } from "./agent.js";
import { tools, executeTool } from "./tools.js";
import { ensureConfig } from "./setup.js";

/* ============ ANSI 文本配色（真彩色，兼容 16 色终端） ============ */
const C = {
  user: "{#7ee787-fg}",
  claude: "{#d4d4d4-fg}",
  tool: "{#56d4dd-fg}",
  dim: "{#8b949e-fg}",
  add: "{#3fb950-fg}",
  del: "{#f85149-fg}",
  warn: "{#d29922-fg}",
  err: "{#da3633-fg}",
  brand: "{#ff5a4d-fg}",
  head: "{#cdd9e5-fg}",
  reset: "{/}",
};
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const LOGO = [
  "        __",
  "   ____/ /___  ___  ___",
  "  / __  / __ \\/ _ \\/ _ \\",
  " / /_/ / /_/ /  __/  __/",
  " \\__,_/\\____/\\___/\\___/   lkbclaw",
];

const messages = [{ role: "system", content: SYSTEM_PROMPT }];
let mode = "build";
const turns = [];
let sessionTokens = 0;
let lastUsage = null;
const todos = [];
let viewTop = 0;

const getVal = () => (inputBox ? inputBox.value || "" : "");
const getCur = () => (inputBox ? inputBox.cursor || 0 : 0);
function setVal(v, c) {
  if (!inputBox) return;
  inputBox.value = v;
  inputBox.cursor = c == null ? v.length : Math.max(0, Math.min(c, v.length));
}
let busy = false;
let pinBottom = true;
let spinnerIdx = 0;
let showToolDetails = false;
let lastCtrlC = 0;
let statusNote = "";

let suggestions = [];
let suggestSel = 0;
let suggestActive = false;
let suggestAt = -1;

let screen, convBox, inputBox, promptBox, headerBox, statusBox, suggestBox;
let convLines = [];
let convWidth = 80;
let convHeight = 20;
let colLeft = 1;

function escapeBlessed(s) {
  return String(s).replace(/[{}]/g, (c) => (c === "{" ? "{{" : "}}"));
}
function stripTags(s) {
  return String(s).replace(/\{[^}]*\}/g, "");
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function truncateStr(s, max) {
  if (typeof s !== "string") s = String(s);
  return s.length > max ? s.slice(0, max) + ` …[截断 ${s.length} 字]` : s;
}

function wrapTagged(text, width, indent, open, close) {
  const res = [];
  const lines = String(text).split("\n");
  for (const raw of lines) {
    if (raw.length === 0) {
      res.push(indent);
      continue;
    }
    let line = raw;
    while (stripTags(line).length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      const seg = line.slice(0, cut);
      res.push(indent + open + escapeBlessed(seg) + close);
      line = line.slice(cut).replace(/^\s+/, "");
    }
    res.push(indent + open + escapeBlessed(line) + close);
  }
  return res;
}

let _branch = null;
let _branchAt = 0;
function gitBranch() {
  const now = Date.now();
  if (_branch !== null && now - _branchAt < 30000) return _branch;
  try {
    _branch = execSync("git rev-parse --abbrev-ref HEAD 2>nul", { cwd: process.cwd() })
      .toString()
      .trim() || "—";
  } catch {
    _branch = "—";
  }
  _branchAt = now;
  return _branch;
}

function updateSystem() {
  messages[0].content = SYSTEM_PROMPT + (mode === "plan" ? PLAN_NOTE : "");
}
const PLAN_NOTE =
  "\n\n[PLAN MODE] 只分析、规划，不改动任何文件；待用户确认后再执行。";

function setMode(m) {
  mode = m;
  updateSystem();
  renderHeader();
  renderStatus();
  screen.render();
}

function addTurn(userText) {
  const t = { role: "user", user: userText, assistant: "", reasoning: "", tools: [] };
  turns.push(t);
  return t;
}

function refreshLayout() {
  const maxW = Math.min(screen.width - 4, 110);
  convWidth = Math.max(40, maxW);
  colLeft = Math.max(1, Math.floor((screen.width - convWidth) / 2) - 3);
  convHeight = Math.max(5, screen.height - 7);
  if (headerBox) {
    headerBox.position.left = colLeft;
    headerBox.width = convWidth;
  }
  if (convBox) {
    convBox.position.left = colLeft;
    convBox.position.top = 2;
    convBox.width = convWidth;
    convBox.height = convHeight;
  }
  if (statusBox) {
    statusBox.position.left = colLeft;
    statusBox.width = convWidth;
  }
  if (inputBox) {
    inputBox.position.left = colLeft + 2;
    inputBox.position.bottom = 0;
    inputBox.width = Math.max(10, convWidth - 2);
    inputBox.height = 3;
  }
  if (promptBox) {
    promptBox.position.left = colLeft;
    promptBox.position.bottom = 2;
    promptBox.width = 2;
    promptBox.height = 1;
  }
  if (suggestBox) {
    suggestBox.position.left = colLeft;
    suggestBox.width = Math.min(Math.floor(convWidth * 0.85), convWidth);
  }
}

/* ============ 工具树 + diff 渲染 ============ */
function toolLines(tool, w) {
  const out = [];
  const st = tool.result && tool.result.error
    ? C.err + "✗" + C.reset
    : C.add + "✓" + C.reset;
  out.push(`  ${C.tool}├─ 🔧 ${tool.name} ${st}${C.reset}`);
  if (showToolDetails) {
    out.push(...wrapTagged("args: " + JSON.stringify(tool.args || {}), w - 4, "  │ ", C.dim, C.reset));
    if (tool.name === "edit_file" && tool.args) {
      String(tool.args.old_string || "")
        .split("\n")
        .forEach((l) => out.push("  │ " + C.del + "- " + escapeBlessed(l) + C.reset));
      String(tool.args.new_string || "")
        .split("\n")
        .forEach((l) => out.push("  │ " + C.add + "+ " + escapeBlessed(l) + C.reset));
    } else if (tool.name === "write_file" && tool.args) {
      String(tool.args.content || "")
        .split("\n")
        .slice(0, 60)
        .forEach((l) => out.push("  │ " + C.add + "+ " + escapeBlessed(l) + C.reset));
    } else {
      const r = typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result || "", null, 2);
      out.push(...wrapTagged("result: " + truncateStr(r, 2000), w - 4, "  │ ", C.dim, C.reset));
    }
  }
  return out;
}

function buildTurnLines(turn, w) {
  const out = [];
  if (turn.role === "user") {
    out.push(C.user + "▍ You" + C.reset);
    out.push(...wrapTagged(turn.user, w - 2, "  ", C.user, C.reset).map((l) => l.replace(/^\s{2}/, "  ")));
    if (turn.assistant && turn.assistant.trim()) {
      out.push(...wrapTagged("↳ " + turn.assistant.trim(), w - 2, "  ", C.dim, C.reset));
    }
    out.push("");
  } else {
    out.push(C.tool + "▍ Claude" + C.reset);
    if (turn.reasoning && turn.reasoning.trim()) {
      out.push(...wrapTagged("💭 " + turn.reasoning.trim().slice(0, 1200), w - 2, "  ", C.dim, C.reset));
    }
    if (turn.assistant && turn.assistant.trim()) {
      out.push(...wrapTagged(turn.assistant, w - 2, "  ", C.claude, C.reset));
    }
    for (const t of turn.tools) out.push(...toolLines(t, w));
    out.push("");
  }
  return out;
}

function renderConv() {
  if (turns.length === 0) {
    const off = Math.max(0, Math.floor(convHeight * 0.2));
    convLines = [
      ...Array(off).fill(""),
      ...LOGO,
      "",
      C.dim + "  终端 AI 编程代理 · 输入需求开始，或 /help 查看命令" + C.reset,
      C.dim + "  Enter 发送 · Shift+Enter 换行 · ! shell · / 命令 · # 记忆 · Ctrl-C 中断" + C.reset,
      "",
    ];
  } else {
    const all = [];
    for (const t of turns) all.push(...buildTurnLines(t, convWidth));
    convLines = all;
  }
  const maxTop = Math.max(0, convLines.length - 1);
  if (pinBottom) viewTop = Math.max(0, convLines.length - convHeight);
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

function renderHeader() {
  if (!headerBox) return;
  const innerW = convWidth;
  const left = `${C.brand}◆ lkbclaw${C.reset} ${C.dim}v${PKG_VERSION}${C.reset}`;
  const right =
    `${escapeBlessed(config.model)} · ${C.dim}${escapeBlessed(process.cwd())}${C.reset} · ⎇ ${escapeBlessed(gitBranch())}` +
    (mode === "plan" ? ` · ${C.warn}PLAN${C.reset}` : "");
  const pad = Math.max(1, innerW - (stripTags(left).length + stripTags(right).length));
  headerBox.setContent(left + " ".repeat(pad) + right);
}

function renderStatus() {
  if (!statusBox) return;
  const cap = 200000;
  const filled = Math.min(12, Math.round((sessionTokens / cap) * 12));
  const bar = "▓".repeat(filled) + "░".repeat(12 - filled);
  const cache = lastUsage && lastUsage.prompt_tokens_details && lastUsage.prompt_tokens_details.cached_tokens
    ? Math.round((lastUsage.prompt_tokens_details.cached_tokens / Math.max(1, lastUsage.prompt_tokens)) * 100)
    : 0;
  const spin = busy ? C.brand + SPIN[spinnerIdx] + C.reset : C.add + "●" + C.reset;
  const note = statusNote ? C.warn + statusNote + C.reset : (busy ? C.dim + "工作中…" + C.reset : C.dim + "就绪" + C.reset);
  statusBox.setContent(
    `${escapeBlessed(config.model)} │ ${C.brand}${bar}${C.reset} ${sessionTokens} tok │ ⎇ ${escapeBlessed(gitBranch())} │ cache ${cache}% │ ${spin} ${note}`
  );
}

function renderInput() {
  screen.render();
}

function setStatusNote(n) {
  statusNote = n;
  renderStatus();
  screen.render();
}

/* ============ 文件 @ 补全 ============ */
function safeResolve(p) {
  const base = process.cwd();
  const full = path.isAbsolute(p) ? p : path.resolve(base, p);
  return path.normalize(full);
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
  const before = getVal().slice(0, getCur());
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
  const v = getVal();
  const c = getCur();
  const head = v.slice(0, suggestAt);
  const tail = v.slice(c);
  const nv = head + "@" + pick + " " + tail;
  setVal(nv, head.length + pick.length + 2);
  suggestActive = false;
  suggestBox.hide();
  screen.render();
}
function moveSuggest(d) {
  if (!suggestActive) return;
  suggestSel = clamp(suggestSel + d, 0, suggestions.length - 1);
  suggestBox.select(suggestSel);
  screen.render();
}
function expandAtFiles(text) {
  const re = /(^|\s)@([^\s]+)/g;
  let m;
  const appended = [];
  while ((m = re.exec(text))) {
    const full = safeResolve(m[2]);
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

/* ============ shell / 下载 ============ */
function formatShell(res) {
  if (!res) return "(无输出)";
  let out = "";
  if (res.stdout) out += res.stdout;
  if (res.stderr) out += (out && !out.endsWith("\n") ? "\n" : "") + res.stderr;
  if (res.error) out += "\n[error] " + res.error;
  return out.trim() || "(无输出)";
}
async function runShell(cmd) {
  const turn = addTurn("! " + cmd);
  renderConv();
  screen.render();
  try {
    const res = await executeTool("run_command", { command: cmd });
    turn.assistant = formatShell(res);
  } catch (e) {
    turn.assistant = "[error] " + (e && e.message ? e.message : e);
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

/* ============ 命令 ============ */
async function handleCommand(text) {
  const parts = text.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = text.slice(cmd.length + 2).trim();
  const info = (s) => {
    const t = addTurn("/" + cmd);
    t.assistant = s;
    renderConv();
    screen.render();
  };
  if (cmd === "help") {
    info(
      "命令: /help /tools /clear /save [path] /load [path] /history /model [name] /provider [name] /mode [plan|build] /todo add|done|rm|list|clear <text> /usage /download <url> [dest] /quit"
    );
    return;
  }
  if (cmd === "tools") {
    info("可用工具:\n" + tools.map((t) => "  - " + t.name + ": " + t.description).join("\n"));
    return;
  }
  if (cmd === "clear") {
    turns.length = 0;
    messages.length = 1;
    updateSystem();
    pinBottom = true;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "model") {
    if (arg) {
      config.model = arg;
      info("已切换模型: " + config.model);
    } else info("Model: " + config.model + "\nBase: " + config.apiBase);
    renderHeader();
    renderStatus();
    screen.render();
    return;
  }
  if (cmd === "provider") {
    if (arg) {
      try {
        setProvider(arg);
        info("已切换 provider: " + config.providerName + " (model: " + config.model + ")");
      } catch (e) {
        info("切换失败: " + e.message);
      }
    } else info("Provider: " + config.providerName);
    renderHeader();
    renderStatus();
    screen.render();
    return;
  }
  if (cmd === "mode") {
    if (arg === "plan" || arg === "build") setMode(arg);
    else info("用法: /mode plan | build");
    return;
  }
  if (cmd === "history") {
    info("当前对话: " + turns.filter((t) => t.role === "user").length + " 轮");
    return;
  }
  if (cmd === "usage") {
    const cap = 200000;
    const filled = Math.min(20, Math.round((sessionTokens / cap) * 20));
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    info(
      "本次会话 token 用量\n" +
        `  ${C.brand}${bar}${C.reset} ${sessionTokens} / ${cap}\n` +
        (lastUsage ? `  最近一轮 prompt ${lastUsage.prompt_tokens} · completion ${lastUsage.completion_tokens} · total ${lastUsage.total_tokens}` : "  （暂无用量数据）")
    );
    return;
  }
  if (cmd === "save") {
    const p = arg || path.resolve(process.cwd(), ".lkb-history.json");
    try {
      fs.writeFileSync(p, JSON.stringify(messages.slice(1), null, 2), "utf8");
      info("已保存 " + (messages.length - 1) + " 条消息到 " + p);
    } catch (e) {
      info("保存失败: " + e.message);
    }
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
      turns.length = 0;
      pinBottom = true;
      info("已从 " + p + " 载入 " + data.length + " 条消息");
    } catch (e) {
      info("载入失败: " + e.message);
    }
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
    info(
      "待办:\n" +
        (todos.length === 0
          ? "  (空)"
          : todos.map((t, i) => `  ${t.done ? C.add + "[x]" + C.reset : "[ ]"} ${i + 1}. ${t.text}`).join("\n"))
    );
    return;
  }
  if (cmd === "download") {
    const url = parts[1];
    const dest = parts.slice(2).join(" ");
    if (!url) {
      info("用法: /download <url> [dest]");
    } else {
      const turn = addTurn("/download " + url);
      renderConv();
      screen.render();
      turn.assistant = await downloadFile(url, dest);
      renderConv();
      screen.render();
    }
    return;
  }
  if (cmd === "quit" || cmd === "exit") {
    quit();
    return;
  }
  info("未知命令: /" + cmd + " (输入 /help 查看)");
}

/* ============ 发送 ============ */
let abortCtrl = null;
let spinTimer = null;
function startSpin() {
  if (spinTimer) return;
  spinTimer = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPIN.length;
    renderStatus();
    screen.render();
  }, 90);
}
function stopSpin() {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
  }
}

async function doSend() {
  const text = getVal();
  setVal("", 0);
  if (!text.trim()) return;

  if (text.startsWith("/")) {
    await handleCommand(text);
    return;
  }
  if (text.startsWith("!")) {
    await runShell(text.slice(1).trim());
    return;
  }
  if (text.startsWith("#")) {
    const turn = addTurn("# " + text.slice(1).trim());
    turn.assistant = C.dim + "已记录为记忆指令（本会话内提示）。" + C.reset;
    renderConv();
    screen.render();
    return;
  }

  const expanded = expandAtFiles(text);
  const turn = addTurn(text);
  const assistantTurn = { role: "assistant", user: "", assistant: "", reasoning: "", tools: [] };
  turns.push(assistantTurn);
  messages.push({ role: "user", content: expanded });
  busy = true;
  pinBottom = true;
  startSpin();
  renderStatus();
  renderConv();
  screen.render();

  const onText = (t) => {
    assistantTurn.assistant += t;
    scheduleConvRender();
  };
  const onReasoning = (t) => {
    assistantTurn.reasoning += t;
    scheduleConvRender();
  };
  const onTool = (name, args, result) => {
    assistantTurn.tools.push({ name, args, result });
    scheduleConvRender();
  };
  const onUsage = (u) => {
    lastUsage = u;
    sessionTokens += u.total_tokens || 0;
    renderStatus();
  };

  abortCtrl = new AbortController();
  const timeoutMs = 120000;
  const reqTimer = setTimeout(() => abortCtrl.abort(new Error("timeout")), timeoutMs);
  try {
    for await (const chunk of chat(messages, {
      model: config.model,
      onTool,
      onUsage,
      onReasoning,
      stream: true,
      temperature: config.temperature,
      signal: abortCtrl.signal,
    })) {
      onText(chunk);
    }
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.message === "timeout");
    if (aborted) {
      turn.assistant += "\n\n" + C.warn + (e.message === "timeout" ? "[请求超时：模型接口未在 120s 内返回]" : "[已中断]") + C.reset;
    } else turn.assistant += "\n\n" + C.err + "[错误] " + (e && e.message ? e.message : e) + C.reset;
  } finally {
    clearTimeout(reqTimer);
  }
  busy = false;
  stopSpin();
  statusNote = "";
  pinBottom = true;
  renderStatus();
  renderConv();
  screen.render();
}

function scrollConv(d) {
  pinBottom = false;
  viewTop = clamp(viewTop + d, 0, Math.max(0, convLines.length - 1));
  renderConv();
  screen.render();
}

function quit() {
  if (screen) screen.destroy();
  process.exit(0);
}

function onKey(ch, key) {
  const k = key ? key.name : null;
  const shift = key ? key.shift : false;
  const ctrl = key ? key.ctrl : false;

  if (shift && k === "tab") {
    setMode(mode === "plan" ? "build" : "plan");
    return;
  }
  if (k === "tab" && !suggestActive) {
    showToolDetails = !showToolDetails;
    setStatusNote(showToolDetails ? "工具详情: 展开" : "工具详情: 折叠");
    setTimeout(() => setStatusNote(""), 1200);
    setVal(getVal().split("\t").join(""));
    renderConv();
    screen.render();
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
  }

  if (k === "enter") {
    if (shift) return; // 原生 textarea 插入换行
    if (!busy) {
      setVal(getVal().replace(/\n$/, "")); // 去掉 textarea 刚插入的换行
      doSend();
    }
    return;
  }
  if (k === "up") {
    scrollConv(-Math.max(1, Math.floor(convHeight / 2)));
    return;
  }
  if (k === "down") {
    scrollConv(Math.max(1, Math.floor(convHeight / 2)));
    return;
  }
  if (k === "pageup") {
    scrollConv(-convHeight + 2);
    return;
  }
  if (k === "pagedown") {
    scrollConv(convHeight - 2);
    return;
  }
  if (k === "c" && ctrl) {
    if (busy) {
      if (abortCtrl) abortCtrl.abort();
      setStatusNote("正在中断…");
    } else {
      const now = Date.now();
      if (now - lastCtrlC < 800) quit();
      else {
        lastCtrlC = now;
        setStatusNote("再按一次 Ctrl-C 退出");
        setTimeout(() => {
          if (Date.now() - lastCtrlC >= 800) setStatusNote("");
        }, 900);
      }
    }
    return;
  }
  if (k === "escape") {
    setVal("", 0);
    suggestActive = false;
    suggestBox.hide();
    screen.render();
    return;
  }

  // 其余按键（可打印字符、backspace、方向键、home/end、delete）交给聚焦的
  // textbox 原生处理；其内置编辑监听先于本函数执行，故此处 value/cursor 已是最新。
  if (
    k === "backspace" || k === "delete" || k === "left" ||
    k === "right" || k === "home" || k === "end" ||
    (ch && !ctrl && !key.meta && k !== "tab")
  ) {
    computeSuggestions();
    renderSuggest();
    screen.render();
    return;
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

  headerBox = blessed.box({
    parent: screen,
    top: 0,
    left: colLeft,
    width: convWidth,
    height: 1,
    tags: true,
    keyable: false,
  });

  convBox = blessed.box({
    parent: screen,
    left: colLeft,
    top: 2,
    width: convWidth,
    height: convHeight,
    tags: true,
    scrollable: false,
    keyable: false,
  });

  statusBox = blessed.box({
    parent: screen,
    left: colLeft,
    bottom: 3,
    width: convWidth,
    height: 1,
    tags: true,
    keyable: false,
  });

  inputBox = blessed.textarea({
    parent: screen,
    left: colLeft + 2,
    bottom: 0,
    width: Math.max(10, convWidth - 2),
    height: 3,
    tags: false,
    inputOnClick: false,
    mouse: false,
    style: { fg: "white" },
  });
  promptBox = blessed.box({
    parent: screen,
    left: colLeft,
    bottom: 2,
    width: 2,
    height: 1,
    tags: true,
    keyable: false,
    content: C.brand + "❯" + C.reset,
  });
  inputBox.focus();

  suggestBox = blessed.list({
    parent: screen,
    left: colLeft,
    bottom: 3,
    width: Math.min(Math.floor(convWidth * 0.85), convWidth),
    height: 8,
    tags: false,
    hidden: true,
    keyable: false,
    border: { type: "round" },
    label: " 文件 ",
    style: {
      border: { fg: "cyan" },
      selected: { bg: "cyan", fg: "black" },
      item: { fg: "white" },
    },
  });

  screen.on("keypress", onKey);
  screen.on("resize", () => {
    refreshLayout();
    renderConv();
    renderHeader();
    renderStatus();
    screen.render();
  });

  renderConv();
  renderHeader();
  renderStatus();
  screen.render();

  const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.startsWith("--"));
  const argPrompt = rawArgs.join(" ").trim();
  if (argPrompt && !argPrompt.startsWith("/")) {
    setVal(argPrompt, argPrompt.length);
    await doSend();
    process.exit(0);
  }
}

import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
