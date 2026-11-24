import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { storage } from '../services/storage.js';

export async function imageRoutes(app: FastifyInstance) {
  // 历史列表
  app.get('/api/images', async () => ({ images: storage.listImages() }));

  // 图片文件
  app.get('/api/images/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = storage.getImagePath(id);
    if (!found || !fs.existsSync(found.filepath)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '图片不存在' });
    }
    reply.header('Content-Type', found.mime);
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(found.filepath));
  });
}
