import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { chatRoutes } from './routes/chat.js';
import { configRoutes } from './routes/config.js';
import { skillRoutes } from './routes/skills.js';
import { imageRoutes } from './routes/images.js';
import { conversationRoutes } from './routes/conversations.js';
import { loadSkills } from './skills/loader.js';

const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });

await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
await app.register(chatRoutes);
await app.register(configRoutes);
await app.register(skillRoutes);
await app.register(imageRoutes);
await app.register(conversationRoutes);

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

app.setErrorHandler((err, _req, reply) => {
  app.log.error(err);
  reply.code(500).send({ error: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
});

const skills = loadSkills();
app.log.info(`已加载 ${skills.length} 个 skill`);
app.log.info(`对话 API: ${config.chatBaseUrl} · 模型 ${config.chatModel}`);
app.log.info(`图像 API: ${config.imageBaseUrl} · 模型 ${config.imageModel}`);

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const url = config.publicBaseUrl || `http://127.0.0.1:${config.port}`;
  app.log.info(`\n  图像工作台已启动 →  ${url}\n`);
  openBrowser(url);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

/** 启动后用系统默认浏览器打开地址；BROWSER=none 可关闭，失败不影响服务 */
function openBrowser(url: string) {
  if (config.browser.toLowerCase() === 'none') return;
  import('node:child_process').then(({ exec }) => {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, (err) => {
      if (err) app.log.warn(`自动打开浏览器失败，请手动访问：${url}`);
    });
  }).catch(() => {});
}
