import fs from "node:fs";

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function threshold() {
  return LEVELS[(process.env.LKB_LOG_LEVEL || "INFO").toUpperCase()] || 20;
}

// 结构化日志：按级别写入 JSON 行到 LKB_LOG_FILE（默认 .lkb-gateway.log）。
// 设置 LKB_LOG_CONSOLE=1 时同时打印到终端；LKB_LOG_LEVEL 可调整级别（DEBUG/INFO/WARN/ERROR）。
export function log(level, msg, meta = {}) {
  const lv = LEVELS[level] || 20;
  if (lv < threshold()) return;
  const entry = { t: new Date().toISOString(), level, msg, ...meta };
  const f = process.env.LKB_LOG_FILE || ".lkb-gateway.log";
  try {
    fs.appendFileSync(f, JSON.stringify(entry) + "\n");
  } catch {}
  if (process.env.LKB_LOG_CONSOLE === "1") {
    console.log(`[${level}] ${msg}`, Object.keys(meta).length ? JSON.stringify(meta) : "");
  }
}

export const debug = (m, x) => log("DEBUG", m, x);
export const info = (m, x) => log("INFO", m, x);
export const warn = (m, x) => log("WARN", m, x);
export const error = (m, x) => log("ERROR", m, x);
