export interface GeneratedImage {
  id: string;
  url: string;
  prompt: string;
  size: string;
  quality: string;
  model: string;
  format: string;
  kind: 'generate' | 'edit' | 'source';
  conversationId?: string;
  parentId?: string;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  imageCount: number;
  thumbUrl: string | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  imageIds: string[];
  skill?: string;
  attachmentName?: string;
  /** 本轮用户上传原图在 images 表中的 id（kind='source'），可用于历史渲染与多模态引用 */
  attachmentImageId?: string;
  createdAt: string;
}

export interface ChatAttachment {
  name: string;
  mimeType: string;
  data: string; // base64（不含 data:... 前缀）
}

export interface ChatRequest {
  conversationId: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  attachment?: ChatAttachment | null;
  /** 路由层已落盘的上传原图 id（kind='source'），agent 直接复用，不再重复落盘 */
  sourceImageId?: string | null;
  settings: {
    model: string;
    size: string;
    quality: string;
    n: number;
    output_format: string;
    output_compression: number;
    background: string;
    moderation: string;
  };
  skill?: string | null;
}

export interface SkillPreset {
  name: string;
  label: string;
  description: string;
  template: string;
  overrides: Record<string, string | number>;
  source: string;
  enabled: boolean;
}

export type SseEvent =
  | { type: 'status'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; id: string; status: 'ok' | 'error'; duration: number }
  | { type: 'image'; image: GeneratedImage }
  | { type: 'text'; delta: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; conversationId: string };
