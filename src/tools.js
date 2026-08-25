import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { glob } from "node:fs";
import { config } from "./config.js";

const execAsync = promisify(exec);

function resolveSafe(p) {
  const base = process.cwd();
  const full = path.isAbsolute(p) ? p : path.resolve(base, p);
  return full;
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

async function grepFiles({ pattern, path: p = ".", include }) {
  const args = [`-r`, `-n`, `-I`, `--max-count=200`, pattern, p];
  if (include) args.push(`--include=${include}`);
  try {
    const { stdout, stderr } = await execAsync(`grep ${args.map((a) => `"${a}"`).join(" ")}`);
    return { matches: stdout || "", stderr: stderr || "" };
  } catch (e) {
    if (e.code === 1) return { matches: "", note: "no matches" };
    return { error: e.message || String(e) };
  }
}

async function editFile({ path: p, old_string, new_string, replace_all = false }) {
  try {
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
  const command = `git ${operation} ${args}`.trim();
  return runCommand({ command, timeout: 120000 });
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
    const snippets = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
    const results = [];
    for (let i = 0; i < links.length && results.length < max; i++) {
      results.push({
        title: stripTags(links[i][2]),
        url: decodeUddg(links[i][1]),
        snippet: snippets[i] ? stripTags(snippets[i][1]) : "",
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

export const tools = [
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
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    return await tool.run(args || {});
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
