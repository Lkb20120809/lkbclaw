#!/usr/bin/env node
import { main as cliMain } from "./cli.js";
import { startGateway } from "./gateway.js";

function help() {
  console.log(`
lkbclaw - AI 开发助手

用法:
  lkbclaw              显示本帮助
  lkbclaw -cli         启动终端对话（可接提示词: lkbclaw -cli "你的需求"）
  lkbclaw -gateway     启动本地网关服务（默认端口 8787，可用 --port 指定）
  lkbclaw -h           显示本帮助

示例:
  lkbclaw -cli "用 edit_file 把 src/agent.js 里的温度改成 0.2"
  lkbclaw -gateway --port 9000
`);
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "-h" || cmd === "--help") {
  help();
  process.exit(0);
}

if (cmd === "-cli" || cmd === "-c") {
  cliMain();
} else if (cmd === "-gateway" || cmd === "-g") {
  let port = 8787;
  let host = "127.0.0.1";
  const i = args.indexOf("--port");
  if (i !== -1 && args[i + 1]) {
    const p = Number(args[i + 1]);
    if (p > 0 && p < 65536) port = p;
  }
  const hi = args.indexOf("--host");
  if (hi !== -1 && args[hi + 1]) host = args[hi + 1];
  startGateway(port, host).catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
} else {
  help();
  process.exit(1);
}
