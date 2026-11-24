import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import OpenAI from 'openai';
import {
  config, isChatConfigured, isImageConfigured, updateRuntimeConfig,
} from '../config.js';
import { refreshOpenAIClient, testConnection, normalizeError } from '../services/openai.js';

const bodySchema = z.object({
  chatApiKey: z.string().optional(),
  chatBaseUrl: z.string().optional(),
  chatModel: z.string().optional(),
  chatVision: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  imageApiKey: z.string().optional(),
  imageBaseUrl: z.string().optional(),
  imageModel: z.string().optional(),
});

export async function configRoutes(app: FastifyInstance) {
  // GET：只返回非敏感配置 + 两组 Key 的配置状态（绝不返回明文 Key）
  app.get('/api/config', async () => ({
    chatBaseUrl: config.chatBaseUrl,
    chatModel: config.chatModel,
    chatVision: config.chatVision,
    systemPrompt: config.systemPrompt,
    chatApiKeyConfigured: isChatConfigured(),
    imageBaseUrl: config.imageBaseUrl,
    imageModel: config.imageModel,
    imageApiKeyConfigured: isImageConfigured(),
    outputDir: config.outputDir,
    skillsDir: config.skillsDir,
  }));

  // PUT：保存两组配置（Key/BaseURL/模型），写盘 + 热更新 client
  app.put('/api/config', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error.message });
    }
    updateRuntimeConfig(parsed.data);
    refreshOpenAIClient();
    return {
      ok: true,
      chatApiKeyConfigured: isChatConfigured(),
      imageApiKeyConfigured: isImageConfigured(),
      chatBaseUrl: config.chatBaseUrl,
      chatModel: config.chatModel,
      chatVision: config.chatVision,
      systemPrompt: config.systemPrompt,
      imageBaseUrl: config.imageBaseUrl,
      imageModel: config.imageModel,
    };
  });

  // 测试图像 API 连接
  app.post('/api/test-connection/image', async () => testConnection());

  // 测试对话 API 连接（独立 client，用 chat 配置）
  app.post('/api/test-connection/chat', async () => {
    if (!isChatConfigured()) return { ok: false, code: 'MISSING_CHAT_API_KEY', message: '尚未配置对话 API Key' };
    try {
      const client = new OpenAI({ apiKey: config.chatApiKey, baseURL: config.chatBaseUrl, timeout: 30_000 });
      const res = await client.models.list();
      return { ok: true, message: `对话 API 连接正常 · ${config.chatBaseUrl} · 可用模型 ${res.data.length} 个` };
    } catch (err: any) {
      const e = normalizeError(err);
      return { ok: false, code: e.code, message: e.message };
    }
  });
}
