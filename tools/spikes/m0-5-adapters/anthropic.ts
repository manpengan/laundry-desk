import Anthropic from '@anthropic-ai/sdk';
import { LlmAdapter, Message, ToolDefinition, StreamEvent, ContentPart } from './types';

export class AnthropicAdapter implements LlmAdapter {
  name = 'anthropic';
  private client: Anthropic;
  private model: string;
  private hasApiKey: boolean = false;

  constructor(model = 'claude-3-5-sonnet-20241022') {
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'mock-key') {
      this.hasApiKey = true;
    }
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || 'mock-key',
    });
    this.model = model;
  }

  private mapMessages(messages: Message[]): { system?: string; messages: any[] } {
    const systemMessage = messages.find((m) => m.role === 'system');
    const system = typeof systemMessage?.content === 'string'
      ? systemMessage.content
      : systemMessage?.content
        ? (systemMessage.content as any[]).map((c) => c.text).join('\n')
        : undefined;

    const filtered = messages.filter((m) => m.role !== 'system');
    const mapped = filtered.map((m) => {
      let content: any;
      if (typeof m.content === 'string') {
        content = m.content;
      } else {
        content = m.content.map((part) => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text };
          } else if (part.type === 'tool_use') {
            return {
              type: 'tool_use',
              id: part.id,
              name: part.name,
              input: part.input,
            };
          } else if (part.type === 'tool_result') {
            return {
              type: 'tool_result',
              tool_use_id: part.tool_use_id,
              content: part.content,
              is_error: part.is_error,
            };
          } else if (part.type === 'image') {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.source.media_type,
                data: part.source.data,
              },
            };
          }
          return part;
        });
      }
      return { role: m.role, content };
    });

    return { system, messages: mapped };
  }

  private mapTools(tools: ToolDefinition[]): any[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  async generate(messages: Message[], tools: ToolDefinition[], options?: any) {
    if (!this.hasApiKey) {
      return this.mockGenerate(messages);
    }

    const { system, messages: mappedMessages } = this.mapMessages(messages);
    const mappedTools = this.mapTools(tools);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: mappedMessages,
      tools: mappedTools,
      temperature: options?.temperature,
    });

    const parts: ContentPart[] = response.content.map((block: any) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      throw new Error(`Unsupported content block: ${block.type}`);
    });

    return {
      message: {
        role: 'assistant' as const,
        content: parts,
      },
      raw: response,
    };
  }

  async generateStream(
    messages: Message[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void,
    options?: any
  ) {
    if (!this.hasApiKey) {
      return this.mockGenerateStream(messages, onEvent);
    }

    const { system, messages: mappedMessages } = this.mapMessages(messages);
    const mappedTools = this.mapTools(tools);

    const stream = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: mappedMessages,
      tools: mappedTools,
      temperature: options?.temperature,
      stream: true,
    });

    const parts: ContentPart[] = [];
    let currentToolUse: any = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        currentToolUse = {
          id: event.content_block.id,
          name: event.content_block.name,
          input_string: '',
        };
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          onEvent({ type: 'text', text: event.delta.text });
        } else if (event.delta.type === 'input_json_delta') {
          if (currentToolUse) {
            currentToolUse.input_string += event.delta.partial_json;
            onEvent({
              type: 'tool_use',
              tool_use: {
                id: currentToolUse.id,
                name: currentToolUse.name,
                input_string: currentToolUse.input_string,
              },
            });
          }
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolUse) {
          parts.push({
            type: 'tool_use',
            id: currentToolUse.id,
            name: currentToolUse.name,
            input: JSON.parse(currentToolUse.input_string || '{}'),
          });
          currentToolUse = null;
        }
      }
    }

    onEvent({ type: 'done' });

    return {
      message: {
        role: 'assistant' as const,
        content: parts,
      },
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

  private async mockGenerate(messages: Message[]) {
    console.log('[Anthropic Mock] [MOCK_MODE] Received prompt. Simulating Tool Use...');
    if (!this.isToolResultStage(messages)) {
      const parts: ContentPart[] = [
        { type: 'text', text: '[Anthropic Mock] [MOCK_MODE] 正在调取天气及洗衣店营业指标...' },
        { type: 'tool_use', id: 'call_ant_1', name: 'get_weather', input: { city: '上海' } },
        { type: 'tool_use', id: 'call_ant_2', name: 'get_store_stats', input: { store_id: 'store_123', metrics: ['revenue', 'order_count'] } }
      ];
      return {
        message: { role: 'assistant' as const, content: parts },
        raw: { mocked: true }
      };
    }

    const parts: ContentPart[] = [
      { type: 'text', text: '{\n  "weather_summary": "上海天气晴朗，气温 25 度。",\n  "store_metrics": {\n    "revenue": 500000,\n    "order_count": 120\n  }\n}' }
    ];
    return {
      message: { role: 'assistant' as const, content: parts },
      raw: { mocked: true }
    };
  }

  private async mockGenerateStream(messages: Message[], onEvent: (event: StreamEvent) => void) {
    console.log('[Anthropic Mock Stream] [MOCK_MODE] Starting stream simulation...');
    if (!this.isToolResultStage(messages)) {
      onEvent({ type: 'text', text: '[Anthropic Mock] [MOCK_MODE] 正在执行：' });
      onEvent({ type: 'tool_use', tool_use: { id: 'call_ant_1', name: 'get_weather', input_string: '{"city": "上海"}' } });
      onEvent({ type: 'tool_use', tool_use: { id: 'call_ant_2', name: 'get_store_stats', input_string: '{"store_id": "store_123", "metrics": ["revenue", "order_count"]}' } });
      onEvent({ type: 'done' });
      return {
        message: {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use', id: 'call_ant_1', name: 'get_weather', input: { city: '上海' } },
            { type: 'tool_use', id: 'call_ant_2', name: 'get_store_stats', input: { store_id: 'store_123', metrics: ['revenue', 'order_count'] } }
          ]
        },
        raw: { mocked: true }
      };
    }

    const jsonOutput = '{\n  "weather_summary": "上海天气晴朗，气温 25 度。",\n  "store_metrics": {\n    "revenue": 500000,\n    "order_count": 120\n  }\n}';
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
      raw: { mocked: true }
    };
  }
}
