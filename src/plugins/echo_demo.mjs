// lkbclaw 工具插件示例
// 放置于 <模块目录>/plugins/ 或 LKB_PLUGINS_DIR 指向的目录，
// 默认导出 { name, description, parameters, run, permission } 即可被自动加载。
//
// permission 取值（仅作元数据，便于将来做权限分级）：
//   readonly | write | dangerous
//
// 注意：run_command 自带危险命令拦截（沙盒），其它工具当前不强制权限。

export default {
  name: "echo_demo",
  description: "示例插件：原样返回输入文本（演示插件化工具系统）。",
  permission: "readonly",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "要回显的文本" },
    },
    required: ["text"],
  },
  run: async ({ text }) => {
    return { echoed: String(text || "") };
  },
};
