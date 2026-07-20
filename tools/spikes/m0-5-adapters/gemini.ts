import { GoogleGenAI } from '@google/genai';
import { LlmAdapter, Message, ToolDefinition, StreamEvent, ContentPart, LlmResponse } from './types';

export class GeminiAdapter implements LlmAdapter {
  name = 'gemini';
  private model: string;

  constructor(model = 'gemini-2.5-flash') {
    this.model = model;
  }

  private mapMessages(messages: Message[]): any[] {
    const filtered = messages.filter((m) => m.role !== 'system');

    return filtered.map((m) => {
      const role = m.role === 'assistant' ? 'model' : 'user';

      if (typeof m.content === 'string') {
        return { role, parts: [{ text: m.content }] };
      }

      const parts: any[] = [];
      for (const part of m.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text });
        } else if (part.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: part.name,
              args: part.input,
            },
          });
        } else if (part.type === 'tool_result') {
          parts.push({
            functionResponse: {
              name: part.name,
              response: { result: part.content },
            },
          });
        } else if (part.type === 'image') {
          parts.push({
            inlineData: {
              mimeType: part.source.media_type,
              data: part.source.data,
            },
          });
        }
      }

      return { role, parts };
    });
  }

  private mapTools(tools: ToolDefinition[]): any[] {
    if (tools.length === 0) return [];
    return [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ];
  }

  private getSystemInstruction(messages: Message[]): string | undefined {
    const system = messages.find((m) => m.role === 'system');
    if (!system) return undefined;
    return typeof system.content === 'string'
      ? system.content
      : (system.content as any[]).map((c) => c.text).join('\n');
  }

  async generate(messages: Message[], tools: ToolDefinition[], options?: any): Promise<LlmResponse> {
    if (!process.env.GEMINI_API_KEY) {
      return this.mockGenerate(messages);
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const systemInstruction = this.getSystemInstruction(messages);
    const contents = this.mapMessages(messages);
    const mappedTools = this.mapTools(tools);

    const response = await ai.models.generateContent({
      model: this.model,
      contents,
      config: {
        systemInstruction,
        tools: mappedTools.length > 0 ? mappedTools : undefined,
        temperature: options?.temperature,
      },
    });

    const parts: ContentPart[] = [];
    const candidates = response.candidates || [];
    const candidate = candidates[0];

    if (candidate && candidate.content && candidate.content.parts) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          parts.push({ type: 'text', text: part.text });
        }
        if (part.functionCall) {
          const call = part.functionCall;
          parts.push({
            type: 'tool_use',
            id: `gemini_call_${Math.random().toString(36).substring(2, 7)}`,
            name: call.name ?? 'unknown_tool',
            input: call.args,
          });
        }
      }
    }

    return {
      message: {
        role: 'assistant' as const,
        content: parts,
      },
      stop_reason: candidate?.finishReason ?? 'STOP',
      usage: response.usageMetadata ? {
        input_tokens: response.usageMetadata.promptTokenCount ?? 0,
        output_tokens: response.usageMetadata.candidatesTokenCount ?? 0,
      } : undefined,
      raw: response,
    };
  }

  async generateStream(
    messages: Message[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void,
    options?: any
  ): Promise<LlmResponse> {
    if (!process.env.GEMINI_API_KEY) {
      return this.mockGenerateStream(messages, onEvent);
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const systemInstruction = this.getSystemInstruction(messages);
    const contents = this.mapMessages(messages);
    const mappedTools = this.mapTools(tools);

    const responseStream = await ai.models.generateContentStream({
      model: this.model,
      contents,
      config: {
        systemInstruction,
        tools: mappedTools.length > 0 ? mappedTools : undefined,
        temperature: options?.temperature,
      },
    });

    const parts: ContentPart[] = [];
    let finalStopReason: string = 'STOP';

    for await (const chunk of responseStream) {
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) {
        finalStopReason = candidate.finishReason;
      }

      if (candidate && candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            onEvent({ type: 'text', text: part.text });
          }
          if (part.functionCall) {
            const call = part.functionCall;
            const callId = `gemini_call_${Math.random().toString(36).substring(2, 7)}`;
            onEvent({
              type: 'tool_use',
              tool_use: {
                id: callId,
                name: call.name ?? 'unknown_tool',
                input_string: JSON.stringify(call.args),
              },
            });
            parts.push({
              type: 'tool_use',
              id: callId,
              name: call.name ?? 'unknown_tool',
              input: call.args,
            });
          }
        }
      }
    }

    onEvent({ type: 'done' });

    return {
      message: {
        role: 'assistant' as const,
        content: parts,
      },
      stop_reason: finalStopReason,
      usage: { input_tokens: 160, output_tokens: 60 },
      raw: { streamed: true },
    };
  }

  // MOCK 模式输出（声明为 [MOCK_MODE]，绝不篡改）
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
      : lastUser.content.filter((p) => p.type === 'text').map((p: any) => p.text).join(' ');
    return text.includes('单工具') || text.includes('只查询天气');
  }

  private async mockGenerate(messages: Message[]): Promise<LlmResponse> {
    console.log('[Gemini Mock] [MOCK_MODE] Received prompt. Simulating Tool Use...');
    if (!this.isToolResultStage(messages)) {
      if (this.isSingleToolStage(messages)) {
        const parts: ContentPart[] = [
          { type: 'text', text: '[Gemini Mock] [MOCK_MODE] 正在调取天气数据...' },
          { type: 'tool_use', id: 'call_gemini_single_1', name: 'get_weather', input: { city: '广州' } },
        ];
        return {
          message: { role: 'assistant' as const, content: parts },
          stop_reason: 'STOP',
          usage: { input_tokens: 110, output_tokens: 30 },
          raw: { mocked: true },
        };
      }

      const parts: ContentPart[] = [
        { type: 'text', text: '[Gemini Mock] [MOCK_MODE] 正在调取天气及洗衣店营业指标...' },
        { type: 'tool_use', id: 'call_gemini_1', name: 'get_weather', input: { city: '广州' } },
        { type: 'tool_use', id: 'call_gemini_2', name: 'get_store_stats', input: { store_id: 'store_123', metrics: ['revenue', 'order_count'] } }
      ];
      return {
        message: { role: 'assistant' as const, content: parts },
        stop_reason: 'STOP',
        usage: { input_tokens: 165, output_tokens: 65 },
        raw: { mocked: true },
      };
    }

    const parts: ContentPart[] = [
      { type: 'text', text: '{\n  "weather_summary": "广州天气晴朗，气温 25 度。",\n  "store_metrics": {\n    "revenue": 500000,\n    "order_count": 120\n  }\n}' }
    ];
    return {
      message: { role: 'assistant' as const, content: parts },
      stop_reason: 'STOP',
      usage: { input_tokens: 225, output_tokens: 85 },
      raw: { mocked: true },
    };
  }

  private async mockGenerateStream(messages: Message[], onEvent: (event: StreamEvent) => void): Promise<LlmResponse> {
    console.log('[Gemini Mock Stream] [MOCK_MODE] Starting stream simulation...');
    if (!this.isToolResultStage(messages)) {
      if (this.isSingleToolStage(messages)) {
        onEvent({ type: 'text', text: '[Gemini Mock Stream] [MOCK_MODE] 正在调取单工具：' });
        onEvent({ type: 'tool_use', tool_use: { id: 'call_gemini_single_1', name: 'get_weather', input_string: '{"city": "广州"}' } });
        onEvent({ type: 'done' });
        return {
          message: {
            role: 'assistant' as const,
            content: [
              { type: 'tool_use', id: 'call_gemini_single_1', name: 'get_weather', input: { city: '广州' } },
            ],
          },
          stop_reason: 'STOP',
          usage: { input_tokens: 105, output_tokens: 28 },
          raw: { mocked: true },
        };
      }

      onEvent({ type: 'text', text: '[Gemini Mock Stream] [MOCK_MODE] 正在调取数据：' });
      onEvent({ type: 'tool_use', tool_use: { id: 'call_gemini_1', name: 'get_weather', input_string: '{"city": "广州"}' } });
      onEvent({ type: 'tool_use', tool_use: { id: 'call_gemini_2', name: 'get_store_stats', input_string: '{"store_id": "store_123", "metrics": ["revenue", "order_count"]}' } });
      onEvent({ type: 'done' });
      return {
        message: {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use', id: 'call_gemini_1', name: 'get_weather', input: { city: '广州' } },
            { type: 'tool_use', id: 'call_gemini_2', name: 'get_store_stats', input: { store_id: 'store_123', metrics: ['revenue', 'order_count'] } }
          ]
        },
        stop_reason: 'STOP',
        usage: { input_tokens: 160, output_tokens: 60 },
        raw: { mocked: true },
      };
    }

    const jsonOutput = '{\n  "weather_summary": "广州天气晴朗，气温 25 度。",\n  "store_metrics": {\n    "revenue": 500000,\n    "order_count": 120\n  }\n}';
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
      stop_reason: 'STOP',
      usage: { input_tokens: 220, output_tokens: 80 },
      raw: { mocked: true },
    };
  }
}
