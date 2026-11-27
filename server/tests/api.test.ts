/**
 * API 层回归测试：用 app.inject() 不打真实端口。
 * 锁死：非法请求 400、超大请求体 413（且不能被错误处理器吞成 500）、
 * 任务列表/会话列表/首页这些基础端点可用。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

process.env.OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-api-'));
process.env.BROWSER = 'none';

const { buildApp } = await import('../src/app.js');
let app: FastifyInstance;

before(async () => { app = await buildApp(); });
after(async () => { await app.close(); });

const VALID_BODY = {
  conversationId: 'test-conv',
  message: '你好',
  history: [],
  settings: {
    model: 'gpt-image-1', size: '1024x1024', quality: 'high', n: 1,
    output_format: 'png', output_compression: 80, background: 'auto', moderation: 'auto',
  },
};

test('GET / 返回前端页面', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
  assert.ok(res.body.includes('chat-input'));
});

test('GET /api/tasks 返回运行任务列表结构', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/tasks' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.running));
});

test('GET /api/conversations 可用', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/conversations' });
  assert.equal(res.statusCode, 200);
});

test('POST /api/chat：非法会话 id 返回 400 而非崩掉', async () => {
  for (const bad of ['..', 'a/b', '']) {
    const res = await app.inject({
      method: 'POST', url: '/api/chat',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...VALID_BODY, conversationId: bad }),
    });
    assert.equal(res.statusCode, 400, `conversationId=${bad} 应 400`);
    assert.equal(res.json().error, 'INVALID_REQUEST');
  }
});

test('POST /api/chat：缺 settings 返回 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/chat',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ conversationId: 'test-conv', message: 'hi' }),
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/chat：超大请求体返回 413 和友好文案，不被吞成 500', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/chat',
    headers: { 'content-type': 'application/json' },
    // 31MB base64 附件，超过 30MB bodyLimit
    payload: JSON.stringify({
      ...VALID_BODY,
      attachment: { name: 'big.png', mimeType: 'image/png', data: 'a'.repeat(31 * 1024 * 1024) },
    }),
  });
  assert.equal(res.statusCode, 413);
  assert.match(res.json().message, /请求体过大/);
});
