// 性能基准：固定一组任务，跑 N 轮，记录耗时与 token 消耗。
// 用法： node bench/benchmark.mjs            （默认 2 轮）
//       BENCH_RUNS=3 node bench/benchmark.mjs
// 需要可用的模型配置（providers.json / .env 的 AGNES_API_KEY）。
import { config } from "../src/config.js";
import { ensureConfig } from "../src/setup.js";
import { chat } from "../src/agent.js";

const TASKS = [
  "用一句话解释什么是闭包，并给出一个最小 JS 示例。",
  "列出 3 个常见的数组去重方法，并说明区别。",
  "用 3 行说明什么是 token，以及它和字符的关系。",
];
const RUNS = Math.max(1, Number(process.env.BENCH_RUNS || 2));

await ensureConfig();

let totalPrompt = 0;
let totalCompletion = 0;
let totalMs = 0;
let calls = 0;

for (let i = 0; i < RUNS; i++) {
  for (const task of TASKS) {
    const messages = [
      { role: "system", content: "你是简洁的助手，用中文回答，代码放代码块。" },
      { role: "user", content: task },
    ];
    const t0 = Date.now();
    let promptTokens = 0;
    let completionTokens = 0;
    let text = "";
    for await (const chunk of chat(messages, {
      model: config.model,
      temperature: 0.2,
      onUsage: (u) => {
        promptTokens += u.prompt_tokens || 0;
        completionTokens += u.completion_tokens || 0;
      },
    })) {
      text += chunk;
    }
    const ms = Date.now() - t0;
    totalMs += ms;
    totalPrompt += promptTokens;
    totalCompletion += completionTokens;
    calls++;
    console.log(
      `  [${i + 1}/${RUNS}] ${ms}ms  prompt=${promptTokens} completion=${completionTokens}  ${task.slice(0, 18)}…`
    );
  }
}

console.log("\n=== 基准结果 ===");
console.log(`模型: ${config.model}`);
console.log(`任务数: ${TASKS.length} × ${RUNS} 轮 = ${calls} 次调用`);
console.log(`总耗时: ${(totalMs / 1000).toFixed(2)}s`);
console.log(`平均每次: ${(totalMs / calls).toFixed(0)}ms`);
console.log(`token: prompt ${totalPrompt} / completion ${totalCompletion} / 合计 ${totalPrompt + totalCompletion}`);
console.log(`平均每次 token: ${Math.round((totalPrompt + totalCompletion) / calls)}`);
