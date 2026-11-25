import type { FastifyInstance } from 'fastify';
import { listRunningTasks, getTaskEvents } from '../services/task-registry.js';
import { isValidConversationId } from '../services/storage.js';

export async function taskRoutes(app: FastifyInstance) {
  // 当前正在后台运行的会话任务（供前端刷新后恢复运行状态）
  app.get('/api/tasks', async () => ({ running: listRunningTasks() }));

  // 回放某任务的 SSE 事件：前端刷新后从 afterSeq 之后续上 thinking/工具/文本/图片
  app.get('/api/tasks/:conversationId/events', async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string };
    const afterSeq = Number((request.query as { after?: string }).after) || 0;
    if (!isValidConversationId(conversationId)) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '会话 ID 格式非法' });
    }
    const data = getTaskEvents(conversationId, afterSeq);
    if (!data) return reply.code(404).send({ error: 'TASK_NOT_FOUND', message: '任务不存在或缓存已过期' });
    return data;
  });
}
