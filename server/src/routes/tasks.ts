import type { FastifyInstance } from 'fastify';
import { listRunningTasks } from '../services/task-registry.js';

export async function taskRoutes(app: FastifyInstance) {
  // 当前正在后台运行的会话任务（供前端刷新后恢复运行状态）
  app.get('/api/tasks', async () => ({ running: listRunningTasks() }));
}
