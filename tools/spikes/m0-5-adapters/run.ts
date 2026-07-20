import { z } from 'zod';
import { AnthropicAdapter } from './anthropic';
import { OpenaiCompatAdapter } from './openai-compat';
import { GeminiAdapter } from './gemini';
import { Message, ToolDefinition, LlmAdapter } from './types';

// 1. 工具参数的 Zod 严格校验 Schema 定义
const GetWeatherSchema = z.object({
  city: z.string().min(1, '城市名称不能为空')
});

const GetStoreStatsSchema = z.object({
  store_id: z.string().min(1, '店面ID不能为空'),
  metrics: z.array(z.string()).min(1, '必须选择至少一个统计指标')
});

// 定义测试使用的 tools 定义 (转为 JSON schema)
const mockTools: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: '获取指定城市的天气状况。',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名称，如北京、上海' }
      },
      required: ['city']
    }
  },
  {
    name: 'get_store_stats',
    description: '获取指定洗衣店的营业统计指标。',
    input_schema: {
      type: 'object',
      properties: {
        store_id: { type: 'string', description: '店面ID' },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: '营业数据指标列表，如 revenue、order_count'
        }
      },
      required: ['store_id', 'metrics']
    }
  }
];

// 本地模拟工具执行逻辑
function executeTool(name: string, args: any): string {
  console.log(`[Tool Runner] Executing tool '${name}' with validated args:`, args);
  if (name === 'get_weather') {
    return JSON.stringify({
      city: args.city,
      condition: 'Sunny',
      temperature: '25C',
      humidity: '60%'
    });
  } else if (name === 'get_store_stats') {
    return JSON.stringify({
      store_id: args.store_id,
      revenue: 500000,
      order_count: 120,
      currency: 'CNY'
    });
  }
  return JSON.stringify({ error: 'Tool not found' });
}

// 通过 Zod 门禁校验后，才执行工具
function validateAndExecuteTool(name: string, input: any): string {
  console.log(`[Zod Gate] Validating inputs for tool '${name}' via Zod schema...`);
  if (name === 'get_weather') {
    const validatedArgs = GetWeatherSchema.parse(input);
    return executeTool(name, validatedArgs);
  } else if (name === 'get_store_stats') {
    const validatedArgs = GetStoreStatsSchema.parse(input);
    return executeTool(name, validatedArgs);
  }
  throw new Error(`[Zod Gate] No Zod validator schema registered for tool '${name}'`);
}

// 测试用例 1: 非流式 generate() + 单工具
async function runSingleToolNonStreamTest(adapter: LlmAdapter) {
  console.log(`\n--- [Test Case 1] Non-Stream generate() + Single Tool Call ---`);
  const messages: Message[] = [
    { role: 'system', content: '你是一个专业的洗衣店助手。请根据用户的问题调用工具。' },
    { role: 'user', content: '请帮我只查询天气（单工具用例），查看上海的天气。' }
  ];

  const genResult = await adapter.generate(messages, mockTools);
  console.log(`[generate() Result] Stop Reason: '${genResult.stop_reason}', Usage:`, genResult.usage);

  const assistantParts = genResult.message.content;
  if (!Array.isArray(assistantParts)) {
    throw new Error('Assistant did not return a structured part array.');
  }

  const toolCalls = assistantParts.filter(p => p.type === 'tool_use');
  console.log(`[Single Tool Test] Assistant requested ${toolCalls.length} tool call(s).`);

  if (toolCalls.length === 0) {
    throw new Error('Single tool test failed: No tool call generated.');
  }

  messages.push(genResult.message);
  for (const call of toolCalls) {
    if (call.type !== 'tool_use') continue;
    const resultJson = validateAndExecuteTool(call.name, call.input);
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: call.id, name: call.name, content: resultJson }]
    });
  }

  const finalRes = await adapter.generate(messages, mockTools);
  console.log(`[generate() Final] Stop Reason: '${finalRes.stop_reason}', Usage:`, finalRes.usage);
  console.log(`✔ Single Tool Non-Stream Test PASS for adapter [${adapter.name.toUpperCase()}]`);
}

// 测试用例 2: 流式 generateStream() + 并行双工具 + 最终 JSON 格式化输出
async function runParallelToolsStreamTest(adapter: LlmAdapter) {
  console.log(`\n--- [Test Case 2] Stream generateStream() + Parallel Dual Tools ---`);
  const messages: Message[] = [
    {
      role: 'system',
      content: '你是一个专业的洗衣店助手。请根据用户的问题进行回答。如果需要调取外部天气或统计数据，请合理调用工具。'
    },
    {
      role: 'user',
      content: '我想知道上海和北京的天气情况，另外帮我查询 store_123 的 revenue 和 order_count 营业数据。请合并你的查询，并把结果以 JSON 格式完整输出。'
    }
  ];

  console.log('[Step 1] Sending initial prompt. Watching streamed events...');
  
  const streamResult = await adapter.generateStream(messages, mockTools, (event) => {
    if (event.type === 'text' && event.text) {
      process.stdout.write(event.text);
    } else if (event.type === 'tool_use' && event.tool_use) {
      console.log(`\n[Stream Event] Tool Use Delta: ${event.tool_use.name} (id: ${event.tool_use.id}) input: ${event.tool_use.input_string}`);
    }
  });

  console.log('\n[Step 1 Complete] Stream finished.');
  console.log(`[Stream Result 1] Stop Reason: '${streamResult.stop_reason}', Usage:`, streamResult.usage);

  const assistantParts = streamResult.message.content;
  if (!Array.isArray(assistantParts)) {
    throw new Error('Assistant did not return a structured part array.');
  }

  const toolCalls = assistantParts.filter(p => p.type === 'tool_use');
  console.log(`Assistant requested ${toolCalls.length} tool calls.`);

  if (toolCalls.length === 0) {
    throw new Error('Parallel tools test failed: No tool calls generated.');
  }

  messages.push(streamResult.message);

  for (const call of toolCalls) {
    if (call.type !== 'tool_use') continue;
    const resultJson = validateAndExecuteTool(call.name, call.input);
    messages.push({
      role: 'user', 
      content: [
        {
          type: 'tool_result',
          tool_use_id: call.id,
          name: call.name,
          content: resultJson
        }
      ]
    });
  }

  console.log('\n[Step 2] Sending Tool Results to get final JSON summary...');
  
  let finalJsonOutput = '';
  const finalStreamRes = await adapter.generateStream(messages, mockTools, (event) => {
    if (event.type === 'text' && event.text) {
      finalJsonOutput += event.text;
      process.stdout.write(event.text);
    }
  });

  console.log('\n[Step 2 Complete] Final output stream finished.');
  console.log(`[Stream Result 2] Stop Reason: '${finalStreamRes.stop_reason}', Usage:`, finalStreamRes.usage);

  console.log('\n[Step 3] Performing strict JSON validation on final output...');
  let jsonStr = finalJsonOutput.trim();
  if (jsonStr.startsWith('```json')) jsonStr = jsonStr.substring(7);
  if (jsonStr.startsWith('```')) jsonStr = jsonStr.substring(3);
  if (jsonStr.endsWith('```')) jsonStr = jsonStr.substring(0, jsonStr.length - 3);
  jsonStr = jsonStr.trim();

  const parsed = JSON.parse(jsonStr);
  console.log('✔ JSON Verification Success! Parsed object:', parsed);
}

// 主演练流程 (各 Adapter 连续 3 次稳定性闭环验证)
async function main() {
  const adapters: LlmAdapter[] = [
    new AnthropicAdapter(),
    new OpenaiCompatAdapter(),
    new GeminiAdapter(),
  ];

  for (const adapter of adapters) {
    console.log(`\n==================================================`);
    console.log(`Starting M0-5 Stability Test Matrix for Adapter: [${adapter.name.toUpperCase()}]`);
    console.log(`==================================================`);

    for (let run = 1; run <= 3; run++) {
      console.log(`\n>>> [Adapter: ${adapter.name.toUpperCase()}] Iteration ${run}/3 Starting...`);
      await runSingleToolNonStreamTest(adapter);
      await runParallelToolsStreamTest(adapter);
      console.log(`✔ [Adapter: ${adapter.name.toUpperCase()}] Iteration ${run}/3 Complete & Stable!`);
    }
  }

  console.log(`\n==================================================`);
  console.log(`🎉 ALL ADAPTERS 3-ITERATION STABILITY TESTS PASSED!`);
  console.log(`==================================================\n`);
}

main().catch(err => {
  console.error('Fatal test execution error:', err);
  process.exit(1);
});
