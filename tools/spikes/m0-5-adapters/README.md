# M0-5 Spike: 三适配器 (Anthropic / OpenAI-Compat / Gemini) 多模型兼容矩阵

本模块实现了 V2 架构中核心 AI 路由的适配器层技术验证，支持并行工具调用、流式事件输出、上下文回填及严格 JSON 结构化解析。

## 核心设计特性

1. **统一消息信封**：在 `types.ts` 中定义，抹平了各大 Provider 对 Content Parts, Tool Call 结构和 Tool Result 回填的格式差异。
2. **多厂商路由**：`openai-compat` 适配器具备自动路由国内大模型的能力，支持 `DEEPSEEK_API_KEY`（DeepSeek API）和 `DASHSCOPE_API_KEY`（阿里通义千问兼容模式），可动态指定 URL 与 model。
3. **Zod 参数强校验**：大模型生成 Tool Call 意图后，首先流经 Zod 门禁校验层（`run.ts` 定义），验证通过后才路由至本地工具，彻底消除注入与结构残缺隐患。
4. **透明 Mock / Real 机制**：未提供对应的 API Key 环境变量时，适配器安全回退至 Mock 模式，输出带有明确 `[MOCK_MODE]` 横幅标识的仿真流与工具调用，杜绝数据造假。

## 环境变量配置
真实模式需提供以下环境变量，如未提供则自动切入带明警横幅的 Mock 模式（仓库内不落任何凭据）：
- `ANTHROPIC_API_KEY`：用于 Claude 模型。
- `GEMINI_API_KEY`：用于 Gemini 2.5 系列原生 SDK。
- `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`：DeepSeek 专属。
- `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL`：阿里通义千问。
- `OPENAI_API_KEY` / `OPENAI_BASE_URL`：OpenAI 标准。

## 六维方言及接口比对矩阵

| 特性 | Anthropic (Claude) | OpenAI / Compat (GPT/DeepSeek/Qwen) | Gemini (GoogleGenAI SDK) |
| :--- | :--- | :--- | :--- |
| **System 消息** | API 顶层 `system` 属性传入（不可混入 messages） | 混入 messages 数组中，`role: 'system'` | config 顶层 `systemInstruction` 属性传入 |
| **Assistant 角色名称** | `'assistant'` | `'assistant'` | `'model'` |
| **多 Tool 并行支持** | 允许，单次 assistant 回复 content 数组中附带多个 `{ type: 'tool_use' }` | 允许，Choice Message 中附带 `tool_calls` 数组（各含 unique id） | 允许，候选 Parts 数组中包含多个 `functionCall` |
| **工具定义格式 (JSON Schema)** | `input_schema` 内含 parameters 规范 | `type: 'function'` 包裹下的 parameters 规范 | `functionDeclarations` 数组直接接收 JSON 结构 |
| **流式 Tool Delta 处理** | 监听 `content_block_delta`，流式累加 `input_json_delta` | 监听 `delta.tool_calls` 各索引 chunk 累加 `arguments` 字符串 | 原生 SDK 的 `generateContentStream` 处理，Delta 级触发 `functionCalls` |
| **Token 用量统计字段** | `usage.input_tokens` 和 `usage.output_tokens` | `usage.prompt_tokens` 和 `usage.completion_tokens` | `usageMetadata.promptTokenCount` 和 `usageMetadata.candidatesTokenCount` |

## 运行演练与证据复现

在项目根目录下执行以下命令，即可依次启动三大适配器并打印完整闭环终端日志：
```bash
npx tsx tools/spikes/m0-5-adapters/run.ts
```
演练输出详情请参见 [evidence/m0-5-evidence.log](evidence/m0-5-evidence.log)。
