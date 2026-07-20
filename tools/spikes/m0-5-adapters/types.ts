export type MessageRole = 'user' | 'assistant' | 'system';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  input: any;
}

export interface ToolResultPart {
  type: 'tool_result';
  tool_use_id: string;
  name: string; // 对齐新映射，必填工具名称，拒绝 hardcode
  content: string;
  is_error?: boolean;
}

export interface ImagePart {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type ContentPart = TextPart | ToolUsePart | ToolResultPart | ImagePart;

export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface StreamEvent {
  type: 'text' | 'tool_use' | 'done';
  text?: string;
  tool_use?: {
    id: string;
    name: string;
    input_string: string;
  };
}

export interface LlmAdapter {
  name: string;
  generate(
    messages: Message[],
    tools: ToolDefinition[],
    options?: { temperature?: number }
  ): Promise<{ message: Message; raw: any }>;

  generateStream(
    messages: Message[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void,
    options?: { temperature?: number }
  ): Promise<{ message: Message; raw: any }>;
}
