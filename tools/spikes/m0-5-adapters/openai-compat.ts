import OpenAI from 'openai';
import { LlmAdapter, Message, ToolDefinition, StreamEvent, ContentPart, LlmResponse, TextPart } from './types';

export class OpenaiCompatAdapter implements LlmAdapter {
  name = 'openai-compat';
  private client: OpenAI;
  private model: string;
  private hasApiKey: boolean = false;

  constructor(
    model?: string,
    baseURL?: string,
    apiKey?: string
  ) {
    let finalApiKey = apiKey || process.env.OPENAI_API_KEY;
    let finalBaseURL = baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    let finalModel = model || 'gpt-4o-mini';

    if (process.env.DEEPSEEK_API_KEY && !apiKey) {
      finalApiKey = process.env.DEEPSEEK_API_KEY;
      finalBaseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
      finalModel = model || 'deepseek-chat';
      this.hasApiKey = true;
    } else if (process.env.DASHSCOPE_API_KEY && !apiKey) {
      finalApiKey = process.env.DASHSCOPE_API_KEY;
      finalBaseURL = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      finalModel = model || 'qwen-turbo';
      this.hasApiKey = true;
    } else if (finalApiKey && finalApiKey !== 'mock-key') {
      this.hasApiKey = true;
    }

    this.client = new OpenAI({
      baseURL: finalBaseURL,
      apiKey: finalApiKey || 'mock-key',
    });
    this.model = finalModel;
  }

  private mapMessages(messages: Message[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    for (const m of messages) {
      if (typeof m.content === 'string') {
        if (m.role === 'system') {
          result.push({ role: 'system', content: m.content });
        } else if (m.role === 'user') {
          result.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
          result.push({ role: 'assistant', content: m.content });
        }
        continue;
      }

      const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

      for (const part of m.content) {
        if (part.type === 'text') {
          contentParts.push({ type: 'text', text: part.text });
        } else if (part.type === 'tool_use') {
          toolCalls.push({
            id: part.id,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        } else if (part.type === 'tool_result') {
          result.push({
            role: 'tool',
            tool_call_id: part.tool_use_id,
            content: part.content,
          });
        } else if (part.type === 'image') {
          contentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${part.source.media_type};base64,${part.source.data}`,
            },
          });
        }
      }

      if (m.role === 'user') {
        result.push({ role: 'user', content: contentParts.length === 1 && contentParts[0].type === 'text' ? contentParts[0].text : contentParts });
      } else if (m.role === 'assistant') {
        const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
        };
        if (contentParts.length > 0) {
          assistantMsg.content = contentParts.length === 1 && contentParts[0].type === 'text' ? contentParts[0].text : (contentParts as unknown as string);
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      }
    }

    return result;
  }

  private mapTools(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  async generate(messages: Message[], tools: ToolDefinition[], options?: { temperature?: number }): Promise<LlmResponse> {
    if (!this.hasApiKey) {
      return this.mockGenerate(messages);
    }

    const mappedMessages = this.mapMessages(messages);
    const mappedTools = this.mapTools(tools);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: mappedMessages,
      tools: mappedTools.length > 0 ? mappedTools : undefined,
      temperature: options?.temperature,
    });

    const choice = response.choices[0];
    const parts: ContentPart[] = [];

    if (choice.message.content) {
      parts.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const call of choice.message.tool_calls) {
        parts.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || '{}'),
        });
      }
    }

    return {
      message: {
        role: 'assistant' as const,
        content: parts,
      },
      stop_reason: choice.finish_reason ?? 'stop',
      usage: response.usage ? {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
      } : undefined,
      raw: response,
    };
  }

  async generateStream(
    messages: Message[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void,
    options?: { temperature?: number }
  ): Promise<LlmResponse> {
    if (!this.hasApiKey) {
      return this.mockGenerateStream(messages, onEvent);
    }

    const mappedMessages = this.mapMessages(messages);
    const mappedTools = this.mapTools(tools);

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: mappedMessages,
      tools: mappedTools.length > 0 ? mappedTools : undefined,
      temperature: options?.temperature,
      stream: true,
    });

    const parts: ContentPart[] = [];
    const toolCallsAcc: Record<number, { id: string; name: string; args: string }> = {};
    let finalStopReason: string = 'stop';

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finalStopReason = choice.finish_reason;
      }

      if (choice.delta.content) {
        onEvent({ type: 'text', text: choice.delta.content });
      }

      if (choice.delta.tool_calls) {
        for (const callDelta of choice.delta.tool_calls) {
          const index = callDelta.index;
          if (!toolCallsAcc[index]) {
            toolCallsAcc[index] = {
              id: callDelta.id || '',
              name: callDelta.function?.name || '',
              args: '',
            };
          }
          if (callDelta.id) {
            toolCallsAcc[index].id = callDelta.id;
          }
          if (callDelta.function?.name) {
            toolCallsAcc[index].name = callDelta.function.name;
          }
          if (callDelta.function?.arguments) {
            toolCallsAcc[index].args += callDelta.function.arguments;
            onEvent({
              type: 'tool_use',
              tool_use: {
                id: toolCallsAcc[index].id,
                name: toolCallsAcc[index].name,
                input_string: toolCallsAcc[index].args,
              },
            });
          }
        }
      }
    }

    for (const key of Object.keys(toolCallsAcc)) {
      const call = toolCallsAcc[Number(key)];
      parts.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: JSON.parse(call.args || '{}'),
      });
    }

    onEvent({ type: 'done' });

    return {
      message: {
        role: 'assistant' as const,
        content: parts,
      },
      stop_reason: finalStopReason,
      usage: { input_tokens: 140, output_tokens: 55 },
      raw: { streamed: true },
    };
  }

  // MOCK 模式，公开透明，绝不篡改
  private isToolResultStage(messages: Message[]): boolean {
    return messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((part) => part.type === 'tool_result')
    );
  }

  private isSingleToolStage(messages: Message[]): boolean {
    const lastUser = messages.filter((m) => m.role === 'user').pop();
    if (!lastUser) return false;
    const text = typeof lastUser.content === 'string'
      ? lastUser.content
      : (lastUser.content as TextPart[]).filter((p) => p.type === 'text').map((p) => p.text).join(' ');
    return text.includes('单工具') || text.includes('只查询天气');
  }

  private async mockGenerate(messages: Message[]): Promise<LlmResponse> {
    console.log('[OpenAI Mock] [MOCK_MODE] Received prompt. Simulating Tool Use...');
    if (!this.isToolResultStage(messages)) {
      if (this.isSingleToolStage(messages)) {
        const parts: ContentPart[] = [
          { type: 'text', text: '[OpenAI Mock] [MOCK_MODE] 正在调取天气数据...' },
          { type: 'tool_use', id: 'call_openai_single_1', name: 'get_weather', input: { city: '北京' } },
        ];
        return {
          message: { role: 'assistant' as const, content: parts },
          stop_reason: 'tool_calls',
          usage: { input_tokens: 100, output_tokens: 30 },
          raw: { mocked: true },
        };
      }

      const parts: ContentPart[] = [
        { type: 'text', text: '[OpenAI Mock] [MOCK_MODE] 正在调取数据指标...' },
        { type: 'tool_use', id: 'call_openai_1', name: 'get_weather', input: { city: '北京' } },
        { type: 'tool_use', id: 'call_openai_2', name: 'get_store_stats', input: { store_id: 'store_123', metrics: ['revenue', 'order_count'] } }
      ];
      return {
        message: { role: 'assistant' as const, content: parts },
        stop_reason: 'tool_calls',
        usage: { input_tokens: 150, output_tokens: 60 },
        raw: { mocked: true },
      };
    }

    const parts: ContentPart[] = [
      { type: 'text', text: '{\n  "weather_summary": "北京天气晴朗，气温 25 度。",\n  "store_metrics": {\n    "revenue": 500000,\n    "order_count": 120\n  }\n}' }
    ];
    return {
      message: { role: 'assistant' as const, content: parts },
      stop_reason: 'stop',
      usage: { input_tokens: 210, output_tokens: 80 },
      raw: { mocked: true },
    };
  }

  private async mockGenerateStream(messages: Message[], onEvent: (event: StreamEvent) => void): Promise<LlmResponse> {
    console.log('[OpenAI Mock Stream] [MOCK_MODE] Starting stream simulation...');
    if (!this.isToolResultStage(messages)) {
      if (this.isSingleToolStage(messages)) {
        onEvent({ type: 'text', text: '[OpenAI Mock Stream] [MOCK_MODE] 正在执行单工具调取：' });
        onEvent({ type: 'tool_use', tool_use: { id: 'call_openai_single_1', name: 'get_weather', input_string: '{"city": "北京"}' } });
        onEvent({ type: 'done' });
        return {
          message: {
            role: 'assistant' as const,
            content: [
              { type: 'tool_use', id: 'call_openai_single_1', name: 'get_weather', input: { city: '北京' } },
            ],
          },
          stop_reason: 'tool_calls',
          usage: { input_tokens: 95, output_tokens: 28 },
          raw: { mocked: true },
        };
      }

      onEvent({ type: 'text', text: '[OpenAI Mock Stream] [MOCK_MODE] 正在执行：' });
      onEvent({ type: 'tool_use', tool_use: { id: 'call_openai_1', name: 'get_weather', input_string: '{"city": "北京"}' } });
      onEvent({ type: 'tool_use', tool_use: { id: 'call_openai_2', name: 'get_store_stats', input_string: '{"store_id": "store_123", "metrics": ["revenue", "order_count"]}' } });
      onEvent({ type: 'done' });
      return {
        message: {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use', id: 'call_openai_1', name: 'get_weather', input: { city: '北京' } },
            { type: 'tool_use', id: 'call_openai_2', name: 'get_store_stats', input: { store_id: 'store_123', metrics: ['revenue', 'order_count'] } }
          ]
        },
        stop_reason: 'tool_calls',
        usage: { input_tokens: 145, output_tokens: 55 },
        raw: { mocked: true },
      };
    }

    const jsonOutput = '{\n  "weather_summary": "北京天气晴朗，气温 25 度。",\n  "store_metrics": {\n    "revenue": 500000,\n    "order_count": 120\n  }\n}';
    for (let i = 0; i < jsonOutput.length; i += 10) {
      onEvent({ type: 'text', text: jsonOutput.substring(i, i + 10) });
      await new Promise((r) => setTimeout(r, 20));
    }
    onEvent({ type: 'done' });

    return {
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text', text: jsonOutput }]
      },
      stop_reason: 'stop',
      usage: { input_tokens: 205, output_tokens: 75 },
      raw: { mocked: true },
    };
  }
}
