# M0-5 Spike: 三适配器 (Anthropic / OpenAI-Compat / Gemini) 多模型兼容矩阵

本模块实现了 V2 架构中核心 AI 路由的适配器层技术验证，支持单工具/并行双工具调用、非流式与流式事件输出、上下文回填及严格 JSON 结构化解析。

## 结果摘要

- **适配器数量**：3 个（`AnthropicAdapter`, `OpenaiCompatAdapter`, `GeminiAdapter`）
- **功能点覆盖**：
  - 非流式 `generate()` 与流式 `generateStream()` 覆盖率 100%
  - 单工具调用 (`get_weather`) 与 并行双工具调用 (`get_weather` + `get_store_stats`) 覆盖率 100%
  - Zod 门禁强校验（`GetWeatherSchema`, `GetStoreStatsSchema`）防注入 100% 拦截
- **稳定性闭环**：每个 Adapter 连续 3 次演练全部通过（共 18 组测试案例 100% 成功）

## 声明

> **自查声明**：已通过 `git log -p` 进行全局代码与日志审查，自查确认仓库内**零硬编码 / 零明文密钥**（API Key 一律由环境变量注入，未提供时安全进入带 `[MOCK_MODE]` 横幅的仿真模式）。

## 环境变量配置

真实模式需提供以下环境变量，如未提供则自动切入带明警横幅的 Mock 模式（仓库内不落任何凭据）：
- `ANTHROPIC_API_KEY`：用于 Claude 模型。
- `GEMINI_API_KEY`：用于 Gemini 2.5 系列原生 SDK (`@google/genai`)。
- `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`：DeepSeek 专属路线。
- `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL`：阿里通义千问路线。
- `OPENAI_API_KEY` / `OPENAI_BASE_URL`：OpenAI 标准路线。

## 六维方言及接口比对矩阵

| 比对维度 | Anthropic (Claude) | OpenAI / Compat (GPT/DeepSeek/Qwen) | Gemini (GoogleGenAI SDK) |
| :--- | :--- | :--- | :--- |
| **1. System 消息** | API 顶层 `system` 属性传入（不可混入 messages） | 混入 messages 数组中，`role: 'system'` | config 顶层 `systemInstruction` 属性传入 |
| **2. Assistant 角色** | `'assistant'` | `'assistant'` | `'model'` |
| **3. 多 Tool 并行支持** | 允许，单回复 content 中返回多个 `{ type: 'tool_use' }` | 允许，Choice Message 中返回包含多元素的 `tool_calls` 数组 | 允许，候选 Parts 数组中包含多个 `functionCall` 元素 |
| **4. 工具定义格式** | 顶层 `name`, `description`, `input_schema` | 包装于 `type: 'function'` 之下的 parameters 规范 | Native 结构，定义在 `functionDeclarations` 中 |
| **5. 流式 Tool Delta 处理** | 监听 `content_block_delta`，流式累加 `input_json_delta` | 监听 `delta.tool_calls` 各索引 chunk 累加 `arguments` 字符串 | 原生 SDK 的 `generateContentStream` 处理，Delta 级触发 `functionCall` |
| **6. 结束条件与 Token 用量** | 结束原因 `response.stop_reason`；用量 `response.usage` (`input_tokens`/`output_tokens`) | 结束原因 `choice.finish_reason`；用量 `response.usage` (`prompt_tokens`/`completion_tokens`) | 结束原因 `candidate.finishReason`；用量 `response.usageMetadata` (`promptTokenCount`/`candidatesTokenCount`) |

## 运行演练与证据复现

在项目根目录下执行以下命令，即可依次启动三大适配器并打印完整 3 轮连续闭环终端日志：
```bash
npx tsx tools/spikes/m0-5-adapters/run.ts
```
演练无删减控制台输出详情请参见 [evidence/m0-5-evidence.log](evidence/m0-5-evidence.log)。
