import type { FastifyInstance } from 'fastify';
import { storage, isValidConversationId } from '../services/storage.js';

export async function conversationRoutes(app: FastifyInstance) {
  // 会话列表
  app.get('/api/conversations', async () => ({ conversations: storage.listConversations() }));

  // 某会话的图片历史（includeSources=1 时含用户上传原图）
  app.get('/api/conversations/:id/images', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidConversationId(id)) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '会话 ID 格式非法' });
    }
    const q = request.query as { includeSources?: string };
    const includeSources = q?.includeSources === '1' || q?.includeSources === 'true';
    return { images: storage.listImages(200, id, includeSources) };
  });

  // 某会话的消息历史（文本 + 本轮图片 ID，时间正序）
  app.get('/api/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidConversationId(id)) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '会话 ID 格式非法' });
    }
    return { messages: storage.listMessages(id) };
  });

  // 删除会话（连带数据库记录与磁盘目录）
  app.delete('/api/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidConversationId(id)) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '会话 ID 格式非法' });
    }
    const removed = storage.deleteConversation(id);
    return { ok: removed };
  });
}
