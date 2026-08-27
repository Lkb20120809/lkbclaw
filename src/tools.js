import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// 危险命令沙盒：命中以下模式的命令默认被拦截（设置 LKB_ALLOW_DANGEROUS=1 可放行）
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\s+\//,
  /\brm\s+-rf?\s+~\//,
  /\brm\s+-rf?\s+\*\s*$/,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=\/dev\//,
  /:\s*\(\)\s*\{/,
  /\bshutdown\b/,
  /\bhalt\b/,
  /\bformat\s+[a-z]:/i,
  /\b>\s*\/dev\/sd[a-z]/,
  /\bchmod\s+-R\s+000\b/,
  /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash)\b/,
];

function isDangerous(cmd) {
  const c = (cmd || "").toString();
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(c)) return "命中危险模式 " + re;
  }
  return null;
}

// 审计：记录每次工具调用到 .lkb-tool-audit.log（可用 LKB_TOOL_AUDIT 改路径）
function auditLog(name, args, result) {
  try {
    const entry = {
      t: new Date().toISOString(),
      tool: name,
      args: typeof args === "string" ? args : JSON.stringify(args),
      ok: !result || !(result.error || result.blocked),
      blocked: !!(result && result.blocked),
      error: result && result.error ? String(result.error).slice(0, 300) : undefined,
    };
    const f = process.env.LKB_TOOL_AUDIT || ".lkb-tool-audit.log";
    fs.appendFileSync(f, JSON.stringify(entry) + "\n");
  } catch {}
}

function resolveSafe(p) {
  const base = process.cwd();
  const full = path.isAbsolute(p) ? p : path.resolve(base, p);
  return path.normalize(full);
}

async function readFile({ path: p, limit = 2000 }) {
  try {
    const full = resolveSafe(p);
    const data = await fsp.readFile(full, "utf8");
    const lines = data.split("\n");
    if (lines.length > limit) {
      return {
        content:
          lines.slice(0, limit).join("\n") +
          `\n... (truncated, total ${lines.length} lines)`,
      };
    }
    return { content: data };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function writeFile({ path: p, content }) {
  try {
    const full = resolveSafe(p);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, "utf8");
    return { ok: true };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function listFiles({ path: p = "." }) {
  try {
    const full = resolveSafe(p);
    const entries = await fsp.readdir(full, { withFileTypes: true });
    return {
      entries: entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
      })),
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function runCommand({ command, timeout = 60000 }) {
  const reason = isDangerous(command);
  if (reason && process.env.LKB_ALLOW_DANGEROUS !== "1") {
    return {
      blocked: true,
      error:
        "已拦截危险命令（" + reason + "）。如确认环境安全需执行，请设置 LKB_ALLOW_DANGEROUS=1。",
    };
  }
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout || "", stderr: stderr || "" };
  } catch (e) {
    return {
      stdout: e.stdout || "",
      stderr: e.stderr || "",
      error: e.message || String(e),
    };
  }
}

function matchInclude(name, include) {
  if (!include) return true;
  if (include.includes("*") || include.includes("?")) {
    const re = new RegExp(
      "^" +
        include
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$"
    );
    return re.test(name);
  }
  return name === include;
}

async function* walkDir(root, include) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walkDir(full, include);
    } else if (e.isFile()) {
      if (matchInclude(e.name, include)) yield full;
    }
  }
}

async function grepFiles({ pattern, path: p = ".", include }) {
  try {
    const re = new RegExp(pattern);
    const out = [];
    let total = 0;
    const PER_FILE = 200;
    const MAX_TOTAL = 5000;
    for await (const f of walkDir(p, include)) {
      let content;
      try {
        content = await fsp.readFile(f, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      let fcount = 0;
      for (let i = 0; i < lines.length; i++) {
        if (fcount >= PER_FILE) break;
        if (re.test(lines[i])) {
          out.push(`${f}:${i + 1}:${lines[i]}`);
          fcount++;
          total++;
          if (total >= MAX_TOTAL) break;
        }
      }
      if (total >= MAX_TOTAL) break;
    }
    if (out.length === 0) return { matches: "", note: "no matches" };
    return { matches: out.join("\n") };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

async function editFile({ path: p, old_string, new_string, replace_all = false }) {
  try {
    if (old_string === "") return { error: "old_string 不能为空" };
    const full = resolveSafe(p);
    const data = await fsp.readFile(full, "utf8");
    const count = data.split(old_string).length - 1;
    if (count === 0) return { error: "old_string not found in file" };
    if (!replace_all && count > 1) {
      return {
        error: `old_string is not unique (found ${count} times); make it unique or set replace_all=true`,
      };
    }
    const replaced = data.split(old_string).join(new_string);
    await fsp.writeFile(full, replaced, "utf8");
    return { ok: true, replaced: replace_all ? count : 1 };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

const GIT_ALLOWED = [
  "status", "diff", "log", "show", "branch", "add", "commit",
  "checkout", "switch", "restore", "pull", "fetch", "stash",
  "tag", "merge", "rebase", "reset",
];

async function git({ operation, args = "" }) {
  if (!GIT_ALLOWED.includes(operation)) {
    return { error: `git operation '${operation}' is not allowed` };
  }
  if (operation === "reset" && /\s--hard\b/.test(args)) {
    return { error: "git reset --hard is blocked for safety" };
  }
  const parts = ["git", operation];
  if (args.trim()) parts.push(args.trim());
  const child = spawn(parts[0], parts.slice(1), { shell: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`exit code ${code}`));
      } else {
        resolve();
      }
    });
    child.on("error", reject);
  });
  return { stdout: stdout || "", stderr: stderr || "" };
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeUddg(href) {
  try {
    const u = new URL(href, "https://html.duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href;
  }
}

async function webSearch({ query, max = 5 }) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; lkbclaw/0.1)" },
    });
    if (!r.ok) return { error: `search HTTP ${r.status}` };
    const html = await r.text();
    const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    const snippets = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
      i: m.index,
      text: stripTags(m[1]),
    }));
    const results = [];
    for (let idx = 0; idx < links.length && results.length < max; idx++) {
      const linkEnd = links[idx].index + links[idx][0].length;
      // 取该链接之后、下一个链接之前的第一条 snippet，避免按数组下标错位
      const snip = snippets.find((s) => s.i > linkEnd);
      results.push({
        title: stripTags(links[idx][2]),
        url: decodeUddg(links[idx][1]),
        snippet: snip ? snip.text : "",
      });
    }
    if (results.length === 0) return { results: [], note: "no results" };
    return { results };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function webFetch({ url, limit = 8000 }) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return { error: "只支持 https:// URL" };
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; lkbclaw/0.1)" },
      redirect: "follow",
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const text = await r.text();
    let clean = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (clean.length > limit) clean = clean.slice(0, limit) + "...";
    return { url, content: clean };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

async function runTests({ command } = {}) {
  const cmd = command || "npm test";
  return runCommand({ command: cmd, timeout: 300000 });
}

const builtinTools = [
  {
    name: "read_file",
    description: "Read a file from the filesystem. Returns its text content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        limit: {
          type: "number",
          description: "Max lines to return (default 2000)",
        },
      },
      required: ["path"],
    },
    run: readFile,
  },
  {
    name: "write_file",
    description: "Write content to a file, creating parent dirs if needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Text content to write" },
      },
      required: ["path", "content"],
    },
    run: writeFile,
  },
  {
    name: "list_files",
    description: "List files and directories in a directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default current)" },
      },
      required: [],
    },
    run: listFiles,
  },
  {
    name: "run_command",
    description: "Execute a shell command and return stdout/stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        timeout: {
          type: "number",
          description: "Timeout in ms (default 60000)",
        },
      },
      required: ["command"],
    },
    run: runCommand,
  },
  {
    name: "grep_files",
    description: "Search file contents recursively with a regex pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "Search root (default current)" },
        include: { type: "string", description: "Glob filter e.g. *.js" },
      },
      required: ["pattern"],
    },
    run: grepFiles,
  },
  {
    name: "edit_file",
    description:
      "Precisely edit a file by replacing an exact substring. Prefer this over write_file when changing code. The old_string must match exactly (whitespace included) and be unique unless replace_all is true.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences (default false)",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    run: editFile,
  },
  {
    name: "git",
    description:
      "Run a git operation: status, diff, log, show, branch, add, commit, checkout, switch, restore, pull, fetch, stash, tag, merge, rebase, reset. Use for version control tasks. reset --hard is blocked.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "Git subcommand, e.g. status, diff, log, commit",
        },
        args: {
          type: "string",
          description: "Extra arguments, e.g. '-m \"fix bug\"' for commit",
        },
      },
      required: ["operation"],
    },
    run: git,
  },
  {
    name: "websearch",
    description:
      "Search the web for a query and return a list of result titles, URLs and snippets. Use this to find up-to-date information, docs, or facts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
    run: webSearch,
  },
  {
    name: "webfetch",
    description:
      "Fetch a web page URL and return its cleaned text content (HTML tags removed). Use to read documentation or articles.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Fully-qualified http(s) URL" },
        limit: { type: "number", description: "Max chars (default 8000)" },
      },
      required: ["url"],
    },
    run: webFetch,
  },
  {
    name: "run_tests",
    description:
      "Run the project test suite or a given command. Use after changing code to verify it still works. Defaults to 'npm test'.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Test command to run (default 'npm test')",
        },
      },
      required: [],
    },
    run: runTests,
  },
];

// 插件化工具系统：从 LKB_PLUGINS_DIR（默认 <模块目录>/plugins）加载第三方工具
// 每个插件文件默认导出一个对象：{ name, description, parameters, run, permission? }
// permission 取值：readonly | write | dangerous（仅作元数据，run_command 自带危险拦截）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
async function loadPlugins() {
  const dir = process.env.LKB_PLUGINS_DIR || path.resolve(__dirname, "plugins");
  const loaded = [];
  try {
    if (!fs.existsSync(dir)) return loaded;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
    for (const f of files) {
      try {
        const mod = await import(pathToFileURL(path.join(dir, f)).href);
        const p = mod.default || mod;
        if (p && p.name && typeof p.run === "function") {
          if (builtinTools.find((t) => t.name === p.name)) {
            console.warn(`插件 ${p.name} 与内置工具重名，已跳过`);
            continue;
          }
          loaded.push(p);
        }
      } catch (e) {
        console.warn(`插件加载失败 ${f}: ${e.message}`);
      }
    }
  } catch {}
  return loaded;
}

const plugins = await loadPlugins();
export const tools = [...builtinTools, ...plugins];

export const toolSchemas = tools.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

export async function executeTool(name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const r = { error: `Unknown tool: ${name}` };
    auditLog(name, args, r);
    return r;
  }
  try {
    const r = await tool.run(args || {});
    auditLog(name, args, r);
    return r;
  } catch (e) {
    const r = { error: String(e.message || e) };
    auditLog(name, args, r);
    return r;
  }
}
