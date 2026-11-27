import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { chatRoutes } from './routes/chat.js';
import { configRoutes } from './routes/config.js';
import { skillRoutes } from './routes/skills.js';
import { imageRoutes } from './routes/images.js';
import { conversationRoutes } from './routes/conversations.js';
import { taskRoutes } from './routes/tasks.js';

/** 组装应用（不监听端口）：index.ts 启动时用，单测用 app.inject() 直接打 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });

  // 必须在注册任何路由插件之前设置：Fastify 的封装上下文会捕获当时的 errorHandler，
  // 之后再设置对已注册的子上下文不生效（bodyLimit 的 413 会退回默认文案）
  app.setErrorHandler((err: any, _req, reply) => {
    app.log.error(err);
    // 保留原始状态码：bodyLimit 超限是 413 而不是 500，否则前端/日志都看不出真实原因
    const statusCode = typeof err?.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    const message = statusCode === 413
      ? '请求体过大：附件图片超过服务器 30MB 上限，请压缩后重试'
      : err instanceof Error ? err.message : String(err);
    reply.code(statusCode).send({ error: err?.code || 'INTERNAL_ERROR', message });
  });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
  await app.register(chatRoutes);
  await app.register(configRoutes);
  await app.register(skillRoutes);
  await app.register(imageRoutes);
  await app.register(conversationRoutes);
  await app.register(taskRoutes);

  // 首页显式返回 index.html（避免把整个项目根目录暴露成静态文件）
  const frontendDir = path.resolve(import.meta.dirname, '..', '..');
  const indexHtmlPath = path.join(frontendDir, 'index.html');
  app.get('/', (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send(fs.createReadStream(indexHtmlPath));
  });

  // 静态资源仅托管 assets/ 目录（logo/favicon 等），不放行 server/data 等敏感目录
  await app.register(fastifyStatic, {
    root: path.join(frontendDir, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
  });

  return app;
}
