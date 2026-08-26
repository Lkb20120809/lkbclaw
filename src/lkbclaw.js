#!/usr/bin/env node
import readline from "node:readline";
import { main as cliMain } from "./cli.js";
import { startGateway } from "./gateway.js";
import { encryptSecret } from "./keystore.js";

function help() {
  console.log(`
lkbclaw - AI 开发助手

用法:
  lkbclaw              显示本帮助
  lkbclaw -cli         启动终端对话（可接提示词: lkbclaw -cli "你的需求"）
  lkbclaw -gateway     启动本地网关服务（默认端口 8787，可用 --port 指定）
  lkbclaw -keygen      生成加密的 API Key 密文（用于密文共享给所有用户）
  lkbclaw -h           显示本帮助

示例:
  lkbclaw -cli "用 edit_file 把 src/agent.js 里的温度改成 0.2"
  lkbclaw -gateway --port 9000
  lkbclaw -keygen
`);
}

function readStdinAll() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.resume();
  });
}

async function keygen() {
  let plain;
  let pass;
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (p) => new Promise((r) => rl.question(p, (a) => r((a ?? "").trim())));
    plain = await ask("要加密的明文 API Key: ");
    pass = await ask("口令(留空=默认共享口令，所有用户可直接用): ");
    rl.close();
  } else {
    const data = await readStdinAll();
    const lines = data.split(/\r?\n/).map((l) => l.trim());
    plain = lines[0] || "";
    pass = lines[1] || "";
  }
  if (!plain) {
    console.error("错误: 明文 Key 不能为空");
    process.exit(1);
  }
  const token = encryptSecret(plain, pass ? pass : undefined);
  console.log("\n加密结果(密文):\n" + token);
  console.log("\n用法: 将上面的密文写入 .env 的 AGNES_API_KEY= 或 providers.json 的 apiKey 字段。");
  console.log("若使用了自定义口令，使用者需设置环境变量 LKB_KEY_PASSPHRASE=该口令 才能解密。");
}

async function run() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    help();
    return;
  }

  if (cmd === "-keygen" || cmd === "-encrypt") {
    await keygen();
    return;
  }

  if (cmd === "-cli" || cmd === "-c") {
    await cliMain();
    return;
  }

  if (cmd === "-gateway" || cmd === "-g") {
    let port = 8787;
    let host = "127.0.0.1";
    const i = args.indexOf("--port");
    if (i !== -1 && args[i + 1]) {
      const p = Number(args[i + 1]);
      if (p > 0 && p < 65536) port = p;
    }
    const hi = args.indexOf("--host");
    if (hi !== -1 && args[hi + 1]) host = args[hi + 1];
    await startGateway(port, host);
    return;
  }

  help();
}

run().then(() => process.exit(0)).catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
