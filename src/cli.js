#!/usr/bin/env node
import blessed, { displayWidth, wcwidth as charWidth } from "./tui.js";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

let PKG_VERSION = "1.3.1";
try {
  const pj = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (pj && pj.version) PKG_VERSION = pj.version;
} catch {}
import { config, setProvider } from "./config.js";
import { chat, SYSTEM_PROMPT, summarizeConversation } from "./agent.js";
import { tools, executeTool } from "./tools.js";
import { pruneMessages } from "./harness.js";
import { countTokens } from "./tokens.js";
import { ensureConfig } from "./setup.js";
import { loadSessions, upsertSession, findSession, newSessionId } from "./sessions.js";

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
  sel: "{#56d4dd-fg}",
  reset: "{/}",
};
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const LOGO = [
  "\x1b[97m██     ██  ██    █████ \x1b[0m    \x1b[90m █████    ██       ███     ██    ██\x1b[0m",
  "\x1b[97m██     ██ ██     ██  ██\x1b[0m    \x1b[90m██   █    ██      ██  █    ██    ██\x1b[0m",
  "\x1b[97m██     ████      █████ \x1b[0m    \x1b[90m██       ██      ██████   ██ ██ ██\x1b[0m",
  "\x1b[97m██     ██ ██     ██  ██\x1b[0m    \x1b[90m██       ██      ██  █    ███████ \x1b[0m",
  "\x1b[97m██     ██  ██    ██  ██\x1b[0m    \x1b[90m██       ██      ██  █    ███  ███\x1b[0m",
  "\x1b[97m██     ██  ██    █████ \x1b[0m    \x1b[90m █████    ██      ██  █    ██    ██\x1b[0m",
];

const messages = [{ role: "system", content: SYSTEM_PROMPT }];
let projectMemory = "";
let currentSessionId = null;
function deriveTitle() {
  const firstUser = messages.find((m) => m.role === "user");
  let t = firstUser
    ? typeof firstUser.content === "string"
      ? firstUser.content
      : JSON.stringify(firstUser.content)
    : "";
  t = t.replace(/\s+/g, " ").trim();
  return (t || "新对话").slice(0, 40);
}
let mode = "build";
const turns = [];
let sessionTokens = 0;
let lastUsage = null;
const todos = [];
let inputBuffer = "";
let cursor = 0;
let viewTop = 0;
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

let sidebarVisible = true;
let layoutMode = "default";
let toastTimer = null;

const COMMANDS = [
  "/help", "/tools", "/clear", "/compress", "/save", "/load", "/list", "/tools-detail", "/history",
  "/model", "/provider", "/mode plan", "/mode build",
  "/todo add", "/todo done", "/todo rm", "/todo list", "/todo clear",
  "/usage", "/download", "/diff", "/compare", "/init", "/grill-me", "/quit",
];

let screen, convBox, inputBox, headerBox, statusBox, suggestBox, sidebarBox, toastBox;
let convLines = [];
let convWidth = 80;
let convHeight = 20;
let colLeft = 1;

function escapeBlessed(s) {
  return String(s);
}
function stripTags(s) {
  return String(s).replace(/\{[^}]*\}/g, "");
}
function dispWidth(s) {
  return displayWidth(stripTags(s));
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function truncateStr(s, max) {
  if (typeof s !== "string") s = String(s);
  return s.length > max ? s.slice(0, max) + ` …[截断 ${s.length} 字]` : s;
}

function rpadNum(n, w) {
  const s = String(n);
  return s.length >= w ? s.slice(-w) : " ".repeat(w - s.length) + s;
}
function diffLines(a, b) {
  const A = String(a).split("\n");
  const B = String(b).split("\n");
  const n = A.length, m = B.length;
  if (n * m > 4000000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ op: " ", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: "-", text: A[i] }); i++; }
    else { ops.push({ op: "+", text: B[j] }); j++; }
  }
  while (i < n) { ops.push({ op: "-", text: A[i] }); i++; }
  while (j < m) { ops.push({ op: "+", text: B[j] }); j++; }
  return ops;
}
function formatUnified(ops, w) {
  const ctx = 3;
  let oN = 0, nN = 0;
  const L = ops.map((d) => ({
    op: d.op,
    text: d.text,
    o: d.op === "+" ? null : (oN += 1, oN),
    n: d.op === "-" ? null : (nN += 1, nN),
  }));
  const out = [];
  const N = L.length;
  let i = 0;
  while (i < N) {
    while (i < N && L[i].op === " ") i++;
    if (i >= N) break;
    const hs = Math.max(0, i - ctx);
    let je = i;
    while (je < N && L[je].op !== " ") je++;
    const he = Math.min(N, je + ctx);
    let oldBase = 0, newBase = 0;
    for (let k = 0; k < hs; k++) { if (L[k].op !== "+") oldBase++; if (L[k].op !== "-") newBase++; }
    let oldCnt = 0, newCnt = 0;
    for (let k = hs; k < he; k++) { if (L[k].op !== "+") oldCnt++; if (L[k].op !== "-") newCnt++; }
    out.push(C.dim + `@@ -${oldBase + 1},${oldCnt} +${newBase + 1},${newCnt} @@` + C.reset);
    for (let k = hs; k < he; k++) {
      const d = L[k];
      const t = truncateStr(d.text, w - 4);
      if (d.op === " ") out.push(" " + t);
      else if (d.op === "-") out.push(C.del + "-" + t + C.reset);
      else out.push(C.add + "+" + t + C.reset);
    }
    i = he;
  }
  return out;
}
function formatSideBySide(ops, w) {
  const avail = Math.max(16, w - 2);
  const numW = 4;
  const sep = " │ ";
  const colW = Math.max(4, Math.floor((avail - numW * 2 - sep.length * 3) / 2));
  const rows = [];
  let o = 0, n = 0;
  for (const d of ops) {
    if (d.op === " ") {
      rows.push(rpadNum(o + 1, numW) + " │ " + truncateStr(d.text, colW) + sep + rpadNum(n + 1, numW) + " │ " + truncateStr(d.text, colW));
      o++; n++;
    } else if (d.op === "-") {
      rows.push(C.del + rpadNum(o + 1, numW) + " │ " + truncateStr(d.text, colW) + sep + "    │ " + " ".repeat(colW) + C.reset);
      o++;
    } else {
      rows.push("    │ " + " ".repeat(colW) + sep + C.add + rpadNum(n + 1, numW) + " │ " + truncateStr(d.text, colW) + C.reset);
      n++;
    }
  }
  return rows;
}
function colorGitDiff(s) {
  return String(s).split("\n").map((l) =>
    l.startsWith("@@") ? C.dim + l + C.reset
      : l.startsWith("+") ? C.add + l + C.reset
      : l.startsWith("-") ? C.del + l + C.reset
      : l
  ).join("\n");
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
    while (dispWidth(line) > width) {
      const chars = Array.from(line);
      let cut = 0;
      let w = 0;
      for (let i = 0; i < chars.length; i++) {
        const cw = charWidth(chars[i]);
        if (w + cw > width) break;
        w += cw;
        cut = i + 1;
      }
      let sp = line.lastIndexOf(" ", cut);
      if (sp > 0 && sp < cut) cut = sp;
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

function loadProjectMemory() {
  const p = path.join(process.cwd(), ".lkbclaw");
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  } catch {}
  return "";
}
const PLAN_NOTE =
  "\n\n[PLAN MODE] 只分析、规划，不改动任何文件；待用户确认后再执行。";
const GRILL_NOTE =
  "\n\n[GRILL MODE · 拷问模式] 你现在是严格的资深架构师，在用户开始编码/实现前，必须把他想做的事情彻底问清楚。" +
  "规则：\n" +
  "1. 一次只问一个问题，不要连珠炮；\n" +
  "2. 每个问题先给出你的【推荐答案】，用户只需确认或修正；\n" +
  "3. 按依赖关系遍历决策树：有些问题必须等前面的决策确定后才能问，逐个确认；\n" +
  "4. 能自己读代码库（read_file / list_files / grep_files）回答的，不要浪费用户时间；\n" +
  "5. 递归追问，直到你们对所有关键决策达成共同理解，再结束拷问；\n" +
  "6. 本模式只拷问需求与设计，不要写代码、不要改动任何文件。";

function updateSystem() {
  messages[0].content =
    SYSTEM_PROMPT +
    (mode === "plan" ? PLAN_NOTE : "") +
    (mode === "grill" ? GRILL_NOTE : "") +
    (projectMemory ? "\n\n【项目记忆 .lkbclaw】\n" + projectMemory : "");
}

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
  const sidebarW = 30;
  const reserved = sidebarVisible ? sidebarW + 2 : 0;
  const margin = layoutMode === "compact" ? 1 : 2;
  const maxW = Math.min(screen.width - margin * 2 - reserved, 200);
  convWidth = Math.max(40, maxW);
  colLeft = Math.max(margin, Math.floor((screen.width - reserved - convWidth) / 2));
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
    inputBox.position.left = colLeft;
    inputBox.width = convWidth;
    inputBox.height = 4;
    inputBox.border = { type: "round" };
  }
  if (sidebarBox) {
    sidebarBox.position.left = screen.width - sidebarW - 1;
    sidebarBox.position.top = 2;
    sidebarBox.width = sidebarW;
    sidebarBox.height = screen.height - 5;
  }
  if (toastBox) {
    const w = Math.min(44, convWidth);
    toastBox.position.left = colLeft + convWidth - w;
    toastBox.position.top = 0;
    toastBox.width = w;
    toastBox.height = 2;
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
    if (tool.name === "edit_file" && tool.args && tool.args.old_string) {
      const ops = diffLines(tool.args.old_string, tool.args.new_string);
      if (ops) {
        out.push(C.tool + "▍ diff (unified)" + C.reset);
        for (const l of formatUnified(ops, w)) out.push("  " + l);
        out.push(C.tool + "▍ diff (side-by-side)" + C.reset);
        for (const l of formatSideBySide(ops, w)) out.push("  " + l);
      } else {
        out.push("  " + C.dim + "(改动过大，无法生成 diff)" + C.reset);
      }
    } else if (tool.name === "edit_file" && tool.args) {
      String(tool.args.new_string || "")
        .split("\n")
        .slice(0, 60)
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
    out.push(C.tool + "▍ " + config.model + C.reset);
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
  const innerW = convWidth - 2;
  const innerH = convHeight - 2;
  if (turns.length === 0) {
    const off = Math.max(0, Math.floor(innerH * 0.2));
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
    for (const t of turns) all.push(...buildTurnLines(t, innerW));
    convLines = all;
  }
  const maxTop = Math.max(0, convLines.length - innerH);
  if (pinBottom) viewTop = Math.max(0, convLines.length - innerH);
  viewTop = clamp(viewTop, 0, maxTop);
  const win = convLines.slice(viewTop, viewTop + innerH);
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
    (mode === "plan" ? ` · ${C.warn}PLAN${C.reset}` : "") +
    (mode === "grill" ? ` · ${C.err}GRILL${C.reset}` : "");
  const pad = Math.max(1, innerW - (dispWidth(left) + dispWidth(right)));
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
  if (sidebarBox && sidebarVisible) renderSidebar();
}

function renderInput() {
  const prompt = C.brand + "❯ " + C.reset;
  const disp = escapeBlessed(inputBuffer).replace(/\n/g, "\n  ");
  inputBox.setContent(prompt + disp);
}

function positionCursor() {
  try {
    const before = inputBuffer.slice(0, cursor);
    const lines = ("❯ " + before).split("\n");
    const row = lines.length - 1;
    const col = displayWidth(lines[row]);
    const absX = clamp(colLeft + col, 0, screen.width - 1);
    const absY = clamp(screen.height - 3 + row, 0, screen.height - 1);
    screen.program.cursorPos(absX, absY);
    screen.program.showCursor();
  } catch {}
}

let _cursorPin = null;
function pinCursor() {
  if (_cursorPin) clearTimeout(_cursorPin);
  _cursorPin = setTimeout(positionCursor, 0);
}

function setStatusNote(n) {
  statusNote = n;
  renderStatus();
  screen.render();
}

/* ============ 侧边栏 / 命令面板 / Toast ============ */
function sbTrunc(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function renderSidebar() {
  if (!sidebarBox) return;
  if (!sidebarVisible) {
    sidebarBox.hide();
    return;
  }
  const lines = [];
  lines.push(C.head + "▍ 侧边栏" + C.reset);
  lines.push(C.dim + "会话 " + turns.filter((t) => t.role === "user").length + " 轮 · 模式 " + mode + C.reset);
  lines.push(C.dim + "模型 " + sbTrunc(config.model, 24) + C.reset);
  lines.push(C.dim + "目录 " + sbTrunc(process.cwd(), 26) + C.reset);
  lines.push(C.dim + "分支 " + sbTrunc(gitBranch(), 24) + C.reset);
  lines.push("");
  lines.push(C.tool + "▍ 待办 Todo" + C.reset);
  if (todos.length === 0) lines.push(C.dim + "  (空)" + C.reset);
  else
    todos.forEach((t, i) => {
      const mark = t.done ? C.add + "[x]" + C.reset : "[ ]";
      lines.push("  " + mark + " " + (i + 1) + ". " + sbTrunc(t.text, 22));
    });
  lines.push("");
  lines.push(C.tool + "▍ 用量 Usage" + C.reset);
  lines.push(C.dim + "  本次会话 " + sessionTokens + " tok" + C.reset);
  if (lastUsage) {
    lines.push(
      C.dim +
        "  prompt " + (lastUsage.prompt_tokens || 0) +
        " · comp " + (lastUsage.completion_tokens || 0) +
        " · total " + (lastUsage.total_tokens || 0) +
        C.reset
    );
    const cache =
      lastUsage.prompt_tokens_details && lastUsage.prompt_tokens_details.cached_tokens
        ? Math.round((lastUsage.prompt_tokens_details.cached_tokens / Math.max(1, lastUsage.prompt_tokens)) * 100)
        : 0;
    lines.push(C.dim + "  cache " + cache + "%" + C.reset);
  } else {
    lines.push(C.dim + "  (暂无数据)" + C.reset);
  }
  sidebarBox.setContent(lines.join("\n"));
  sidebarBox.show();
}

function showToast(msg) {
  if (!toastBox) return;
  toastBox.setContent(C.warn + " " + msg + C.reset);
  toastBox.show();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastBox.hide();
    screen.render();
  }, 2600);
}

/* ============ 文件 @ 补全 ============ */
function safeResolve(p) {
  const base = process.cwd();
  const full = path.isAbsolute(p) ? p : path.resolve(base, p);
  return path.normalize(full);
}
let fileIndexCache = null;
let fileIndexCacheCwd = null;
function getFileIndex() {
  if (fileIndexCache && fileIndexCacheCwd === process.cwd()) return fileIndexCache;
  fileIndexCacheCwd = process.cwd();
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
  if (at !== -1) {
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
    return;
  }
  if (before.startsWith("/") && !/\s/.test(before.slice(1))) {
    const q = before.slice(1).toLowerCase();
    const idx = COMMANDS.filter((c) => c.toLowerCase().includes(q)).slice(0, 60);
    suggestions = idx;
    suggestAt = 0;
    suggestSel = 0;
    suggestActive = suggestions.length > 0;
    return;
  }
  suggestActive = false;
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
  if (pick.startsWith("/")) {
    inputBuffer = head + pick + " " + tail;
    cursor = head.length + pick.length + 1;
  } else {
    inputBuffer = head + "@" + pick + " " + tail;
    cursor = head.length + pick.length + 2;
  }
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

  // cd 需要真正切换进程工作目录，否则仅作用于子 shell，侧边栏 / @ 补全会停留在旧目录
  // 仅处理纯 cd（不含 ; && || | > 等 Shell 运算符），否则交给子 shell 自行解释
  const cdMatch = cmd.match(/^\s*cd\b\s*([^;&|<>]*?)\s*$/);
  if (cdMatch) {
    let target = cdMatch[1].trim().replace(/^["']|["']$/g, "");
    try {
      if (!target || target === "~" || target === "$HOME") {
        target = process.env.HOME || process.env.USERPROFILE || process.cwd();
      }
      const resolved = path.isAbsolute(target)
        ? path.normalize(target)
        : path.resolve(process.cwd(), target);
      process.chdir(resolved);
      fileIndexCache = null;
      fileIndexCacheCwd = process.cwd();
      renderHeader();
      renderSidebar();
      turn.assistant = "已切换到目录: " + process.cwd();
    } catch (e) {
      turn.assistant = "[error] cd 失败: " + (e && e.message ? e.message : e);
    }
    renderConv();
    screen.render();
    return;
  }

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
function scanProject() {
  const root = process.cwd();
  const name = path.basename(root);
  const ignore = new Set([
    ".git", "node_modules", "dist", "build", ".next", ".cache", "coverage",
    ".venv", "__pycache__", "target", "vendor", ".opencode", "out", ".idea", ".vscode",
  ]);
  const stack = [];
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    let s = "Node.js / npm";
    if (pkg.dependencies) {
      if (pkg.dependencies.react) s += " (React)";
      if (pkg.dependencies.vue) s += " (Vue)";
      if (pkg.dependencies.next) s += " (Next.js)";
      if (pkg.dependencies.express) s += " (Express)";
    }
    stack.push(s);
  } catch {}
  for (const f of ["requirements.txt", "pyproject.toml", "setup.py", "go.mod", "Cargo.toml", "pom.xml", "Makefile", "composer.json", "Gemfile", "build.gradle", "pyproject.toml"]) {
    if (fs.existsSync(path.join(root, f))) stack.push(f);
  }
  const tree = [];
  let count = 0;
  const walk = (dir, depth) => {
    if (depth > 3 || count > 220) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.isDirectory() ? 1 : 0) - (b.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (ignore.has(e.name)) continue;
      if (count++ > 220) return;
      const tag = e.isDirectory() ? "/" : "";
      tree.push("  ".repeat(depth) + e.name + tag);
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  let readme = "";
  for (const rf of ["README.md", "readme.md", "README.txt", "README"]) {
    const rp = path.join(root, rf);
    if (fs.existsSync(rp)) {
      try { readme = fs.readFileSync(rp, "utf8").split("\n").slice(0, 80).join("\n"); } catch {}
      break;
    }
  }
  return {
    name,
    stack,
    pkgScripts: (pkg && pkg.scripts) || null,
    pkgDeps: (pkg && pkg.dependencies) || null,
    tree: tree.join("\n"),
    readme,
  };
}
function buildLocalInit(scan) {
  const lines = [];
  lines.push(`# ${scan.name}`);
  lines.push("");
  lines.push("> 由 `/init` 自动生成的项目说明（lkbclaw 记忆文件）。后续会话会读取它来快速理解本仓库。");
  lines.push("");
  lines.push("## 项目简介");
  lines.push(`- 目录名：${scan.name}`);
  if (scan.stack.length) lines.push("- 技术栈：" + scan.stack.join("、"));
  lines.push("");
  lines.push("## 目录结构");
  lines.push("```");
  lines.push(scan.tree || "（空目录）");
  lines.push("```");
  lines.push("");
  if (scan.pkgScripts) {
    lines.push("## 常用命令");
    lines.push("");
    for (const [k, v] of Object.entries(scan.pkgScripts)) lines.push(`- npm run ${k} → \`${v}\``);
    lines.push("");
  }
  if (scan.readme) {
    lines.push("## README 摘要");
    lines.push("");
    lines.push(scan.readme);
    lines.push("");
  }
  lines.push("## 约定");
  lines.push("- 修改代码优先使用 edit_file 精确替换；新建或大幅重写文件时用 write_file。");
  lines.push("- 提交前先 `git status` / `git diff` 了解情况；保持清晰的中文 commit message，不要强制推送。");
  lines.push("- 改完代码后用 `run_tests` 或 `run_command` 跑测试/lint 验证。");
  return lines.join("\n");
}
function stripFences(s) {
  let t = String(s).trim();
  const m = t.match(/^```(?:markdown)?\s*([\s\S]*?)\s*```$/i);
  if (m) return m[1].trim();
  t = t.replace(/^```(?:markdown)?\s*/i, "").replace(/\s*```$/, "");
  return t.trim();
}
async function generateInitDoc(scan) {
  const instruction =
    "你正在为命令行 AI 编程助手 lkbclaw 生成项目记忆文件 .lkbclaw（类似 CLAUDE.md / AGENTS.md）。" +
    "根据下方仓库扫描信息，写一份简洁、结构化、对未来的 lkbclaw 会话有用的 Markdown 项目说明，帮助它快速理解本仓库并遵守工程约定。" +
    "必须只输出 Markdown 正文，不要用代码块包裹，不要任何额外解释或结束语。" +
    "建议结构：\n# 项目名\n## 项目简介\n## 目录结构（用代码块）\n## 常用命令\n## 约定与注意事项\n## 关键文件说明";
  const messages = [
    { role: "system", content: instruction },
    { role: "user", content: "仓库扫描信息（JSON）：\n" + JSON.stringify(scan, null, 2) },
  ];
  let doc = "";
  try {
    for await (const ch of chat(messages, {
      model: config.model,
      temperature: 0.2,
      stream: true,
      maxRounds: 1,
      onUsage: (u) => { lastUsage = u; sessionTokens += u.total_tokens || 0; renderStatus(); },
    })) doc += ch;
  } catch {
    doc = "";
  }
  doc = stripFences(doc);
  if (!doc || doc.trim().length < 20) doc = buildLocalInit(scan);
  return doc.trim() + "\n";
}

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
      "命令: /help /tools /clear /compress [保留轮数] /save [标题|路径] /load <id|路径> /list /history /tools-detail /model [name] /provider [name] /mode [plan|build|grill] /todo add|done|rm|list|clear <text> /usage /download <url> [dest] /diff [文件|目录] /compare <文件A> <文件B> /init [--force] /grill-me [想法] /quit" + "\n提示: 需求太模糊时输入会自动进入拷问(grill)模式，把决策逐个问清；发 /mode build 退出。Tab 可折叠/展开工具详情。"
    );
    return;
  }
  if (cmd === "tools") {
    info("可用工具:\n" + tools.map((t) => "  - " + t.name + ": " + t.description).join("\n"));
    return;
  }
  if (cmd === "tools-detail") {
    showToolDetails = !showToolDetails;
    info("工具详情: " + (showToolDetails ? "展开（显示参数与完整结果）" : "折叠（仅显示摘要）"));
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "clear") {
    turns.length = 0;
    messages.length = 1;
    currentSessionId = null;
    updateSystem();
    pinBottom = true;
    renderConv();
    screen.render();
    return;
  }
  if (cmd === "list" || cmd === "sessions") {
    const list = loadSessions()
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!list.length) {
      info("暂无已保存会话。用 /save 存入会话库，或打开浏览器 UI 创建。");
      return;
    }
    info(
      "已保存会话（最近优先）:\n" +
        list
          .map(
            (s, i) =>
              `  ${i + 1}. ${C.tool}[#${s.id}]${C.reset} ${s.title || "(无标题)"} — ${(
                s.messages || []
              ).length} 条 · ${new Date(s.updatedAt || 0).toLocaleString()}`
          )
          .join("\n") +
        `\n载入: /load <id>`
    );
    return;
  }
  if (cmd === "compress") {
    const est = (ms) => ms.reduce((a, m) => a + countTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")), 0);
    const before = est(messages);
    const keep = Math.max(2, Math.min(6, parseInt(arg, 10) || 4));
    const compressed = await pruneMessages(messages, { keepRecent: keep });
    messages.length = 0;
    messages.push(...compressed);
    const after = est(messages);
    info(
      `上下文已压缩（保留最近 ${keep} 轮完整，更早的工具调用成对压缩为摘要）。\n估算 token: ${before} → ${after}（模型实际仍可见最近 ${keep} 轮原始内容）`
    );
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
    if (arg === "plan" || arg === "build" || arg === "grill") setMode(arg);
    else info("用法: /mode plan | build | grill");
    return;
  }
  if (cmd === "grill-me" || cmd === "grill") {
    setMode("grill");
    if (arg.trim()) {
      info(C.err + "已进入拷问(grill)模式，开始就你的想法展开追问…" + C.reset);
      await sendUserMessage(arg.trim());
    } else {
      info(
        C.err + "已进入拷问(grill)模式。" + C.reset +
        "\n把你想做但还没想清楚的计划/需求发出来，我会每次只问一个问题并给出推荐答案，直到我们完全对齐。发 /mode build 可退出。"
      );
    }
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
    if (arg && (arg.includes(path.sep) || arg.includes("/") || arg.toLowerCase().endsWith(".json"))) {
      const p = arg;
      try {
        fs.writeFileSync(p, JSON.stringify(messages.slice(1), null, 2), "utf8");
        info("已导出 " + (messages.length - 1) + " 条消息到 " + p);
      } catch (e) {
        info("保存失败: " + e.message);
      }
      return;
    }
    const title = arg || deriveTitle();
    const prev = currentSessionId ? findSession(currentSessionId) : null;
    const sess = {
      id: currentSessionId || newSessionId(),
      title: title.slice(0, 120),
      messages: messages.slice(1),
      createdAt: (prev && prev.createdAt) || Date.now(),
      updatedAt: Date.now(),
    };
    upsertSession(sess);
    currentSessionId = sess.id;
    info("已存入会话库 " + C.tool + "[#" + sess.id + "]" + C.reset + " " + sess.title + "（" + sess.messages.length + " 条）。载入: /load " + sess.id);
    return;
  }
  if (cmd === "load") {
    if (!arg) {
      info("用法: /load <会话id 或 文件路径> （先用 /list 查看会话 id）");
      return;
    }
    const s = findSession(arg);
    if (s) {
      messages.length = 0;
      messages.push({ role: "system", content: SYSTEM_PROMPT });
      updateSystem();
      for (const m of s.messages || []) if (m.role !== "system") messages.push(m);
      turns.length = 0;
      currentSessionId = s.id;
      pinBottom = true;
      info("已载入会话 " + C.tool + "[#" + s.id + "]" + C.reset + " " + s.title + "（" + (s.messages || []).length + " 条）");
      renderConv();
      screen.render();
      return;
    }
    const p = arg;
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      messages.length = 0;
      messages.push({ role: "system", content: SYSTEM_PROMPT });
      updateSystem();
      for (const m of data) if (m.role !== "system") messages.push(m);
      turns.length = 0;
      currentSessionId = null;
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
    renderSidebar();
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
  if (cmd === "diff") {
    const target = arg.trim();
    try {
      const res = await executeTool("git", { operation: "diff", args: target ? "-- " + target : "" });
      if (res.error) info("获取 diff 失败: " + res.error);
      else if (!res.stdout || !res.stdout.trim()) info("工作区无未提交改动（" + (target || "全部") + "）");
      else {
        const t = addTurn("/diff " + target);
        t.assistant = colorGitDiff(res.stdout);
        renderConv();
        screen.render();
      }
    } catch (e) {
      info("获取 diff 失败: " + (e && e.message ? e.message : e));
    }
    return;
  }
  if (cmd === "compare") {
    const parts2 = arg.trim().split(/\s+/);
    const fa = parts2[0], fb = parts2[1];
    if (!fa || !fb) { info("用法: /compare <文件A> <文件B>"); return; }
    try {
      const A = fs.readFileSync(safeResolve(fa), "utf8");
      const B = fs.readFileSync(safeResolve(fb), "utf8");
      const ops = diffLines(A, B);
      if (!ops) { info("文件过大，无法对比（请对比较小的文件）"); return; }
      const t = addTurn("/compare " + fa + " " + fb);
      t.assistant =
        C.tool + "▍ diff " + escapeBlessed(fa) + " ↔ " + escapeBlessed(fb) + C.reset +
        "\n" + formatUnified(ops, 200).join("\n");
      renderConv();
      screen.render();
    } catch (e) {
      info("对比失败: " + (e && e.message ? e.message : e));
    }
    return;
  }
  if (cmd === "init") {
    const force = arg.trim() === "--force" || /\s+--force\b/.test(arg);
    const target = path.join(process.cwd(), ".lkbclaw");
    if (fs.existsSync(target) && !force) {
      info("当前目录已存在 .lkbclaw，未覆盖。如需重新生成请使用 /init --force");
      return;
    }
    setStatusNote("正在分析项目并生成 .lkbclaw…");
    renderConv();
    screen.render();
    try {
      const scan = scanProject();
      const doc = await generateInitDoc(scan);
      fs.writeFileSync(target, doc, "utf8");
      projectMemory = doc;
      updateSystem();
      const t = addTurn("/init" + (force ? " --force" : ""));
      t.assistant =
        C.add + "已生成 .lkbclaw（" + doc.length + " 字节）✓" + C.reset +
        "\n" + C.dim + "位于：" + C.reset + escapeBlessed(target) +
        "\n" + C.dim + "预览（前 12 行）：" + C.reset + "\n" +
        doc.split("\n").slice(0, 12).join("\n");
      statusNote = "";
      renderConv();
      screen.render();
    } catch (e) {
      statusNote = "";
      info("生成 .lkbclaw 失败: " + (e && e.message ? e.message : e));
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
  if (text.startsWith("#")) {
    const turn = addTurn("# " + text.slice(1).trim());
    turn.assistant = C.dim + "已记录为记忆指令（本会话内提示）。" + C.reset;
    renderConv();
    screen.render();
    return;
  }

  if (mode !== "grill" && looksVague(text)) {
    setMode("grill");
    turns.push({
      role: "assistant",
      user: "",
      assistant:
        C.err + "需求还不够明确，已自动进入拷问(grill)模式：" + C.reset +
        C.dim + "我会一次只问一个问题并给出推荐答案，把关键决策逐个确认清楚后再动手。发 /mode build 可随时退出。" + C.reset,
      reasoning: "",
      tools: [],
    });
    renderConv();
    screen.render();
  }
  await sendUserMessage(text);
}

function looksVague(text) {
  const t = text.trim();
  if (t.length < 8) return false;
  if (t.includes("?") || t.includes("？")) return false;
  if (!/(做|实现|设计|开发|搭建|写个|搞个|需求|计划|应用|系统|功能|项目|方案|架构|想|打算|准备|重构|加个|弄个)/.test(t)) return false;
  const concrete =
    /(```|\.js|\.ts|\.tsx|\.jsx|\.py|\.go|\.rs|\.java|\.c(pp)?|\.rb|\.php|步骤|首先|第一步|用\s*[\w\u4e00-\u9fa5]+|框架|api|数据库|文件|目录|配置|npm|pnpm|yarn|git|docker|k8s|http|端口|\/|[\\.\\w]+\\.(json|md|yml|yaml|toml|env))/i;
  if (concrete.test(t)) return false;
  return t.length < 120;
}

async function sendUserMessage(text) {
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
      summarize: summarizeConversation,
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
  const maxTop = Math.max(0, convLines.length - (convHeight - 2));
  const next = clamp(viewTop + d, 0, maxTop);
  viewTop = next;
  pinBottom = next >= maxTop;
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
  if (key && key.name === "mouse") {
    const step = Math.max(1, Math.floor((convHeight - 2) / 4));
    if (key.wheel === -1) scrollConv(-step);
    else if (key.wheel === 1) scrollConv(step);
    return;
  }

  if (!key) {
    if (ch) insertChar(ch);
    return;
  }
  const k = key.name;
  const shift = key.shift;

  if (k === "b" && key.ctrl) {
    sidebarVisible = !sidebarVisible;
    refreshLayout();
    renderConv();
    renderHeader();
    renderStatus();
    renderInput();
    renderSidebar();
    screen.render();
    showToast(sidebarVisible ? "侧边栏 开 (Ctrl-B)" : "侧边栏 关 (Ctrl-B)");
    return;
  }
  if (k === "l" && key.ctrl) {
    layoutMode = layoutMode === "default" ? "wide" : layoutMode === "wide" ? "compact" : "default";
    if (layoutMode === "wide") sidebarVisible = true;
    refreshLayout();
    renderConv();
    renderHeader();
    renderStatus();
    renderInput();
    renderSidebar();
    screen.render();
    showToast(
      "布局: " +
        (layoutMode === "default" ? "默认" : layoutMode === "wide" ? "宽屏(侧栏常驻)" : "紧凑") +
        " (Ctrl-L 切换)"
    );
    return;
  }

  if (shift && k === "tab") {
    setMode(mode === "plan" || mode === "grill" ? "build" : "plan");
    return;
  }
  if (k === "tab" && !suggestActive) {
    showToolDetails = !showToolDetails;
    setStatusNote(showToolDetails ? "工具详情: 展开" : "工具详情: 折叠");
    setTimeout(() => setStatusNote(""), 1200);
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
  } else {
    if (k === "enter") {
      if (shift) insertChar("\n");
      else if (!busy) doSend();
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
    if (k === "c" && key.ctrl) {
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
  if (ch && !key.ctrl && !key.meta && k !== "tab") {
    insertChar(ch);
  }
}

export async function main() {
  await ensureConfig();
  projectMemory = loadProjectMemory();
  updateSystem();

  screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "lkbclaw",
  });

  headerBox = blessed.box({
    parent: screen,
    top: 0,
    left: colLeft,
    width: convWidth,
    height: 1,
    tags: true,
  });

  convBox = blessed.box({
    parent: screen,
    left: colLeft,
    top: 2,
    width: convWidth,
    height: convHeight,
    tags: true,
    scrollable: false,
  });

  statusBox = blessed.box({
    parent: screen,
    left: colLeft,
    bottom: 4,
    width: convWidth,
    height: 1,
    tags: true,
  });

  inputBox = blessed.box({
    parent: screen,
    left: colLeft,
    bottom: 0,
    width: convWidth,
    height: 3,
    tags: true,
  });

  suggestBox = blessed.list({
    parent: screen,
    left: colLeft,
    bottom: 3,
    width: Math.min(Math.floor(convWidth * 0.85), convWidth),
    height: 8,
    tags: false,
    hidden: true,
    border: { type: "round" },
    label: " 文件 ",
    style: {
      border: { fg: "cyan" },
      selected: { bg: "cyan", fg: "black" },
      item: { fg: "white" },
    },
  });

  sidebarBox = blessed.box({
    parent: screen,
    left: 0,
    top: 2,
    width: 30,
    height: 10,
    tags: true,
    hidden: true,
    border: { type: "round" },
    label: " 侧边栏 ",
    style: { border: { fg: "cyan" } },
  });

  toastBox = blessed.box({
    parent: screen,
    left: 0,
    top: 0,
    width: 44,
    height: 2,
    tags: true,
    hidden: true,
  });

  refreshLayout();

  screen.on("keypress", onKey);
  screen.on("render", () => {
    positionCursor();
    pinCursor();
  });
  screen.on("resize", () => {
    refreshLayout();
    renderConv();
    renderHeader();
    renderStatus();
    renderInput();
    screen.render();
  });

  renderConv();
  renderHeader();
  renderStatus();
  renderInput();
  screen.render();

  const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.startsWith("--"));
  const argPrompt = rawArgs.join(" ").trim();
  if (argPrompt && !argPrompt.startsWith("/")) {
    inputBuffer = argPrompt;
    cursor = argPrompt.length;
    await doSend();
    process.exit(0);
  }
}

import { pathToFileURL } from "node:url";
const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
