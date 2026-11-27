/**
 * 存储层单测：会话/消息/图片/摘要的 SQLite 双写行为。
 * 用临时 OUTPUT_DIR 隔离，绝不碰真实 server/outputs 数据。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import storage 之前设置：storage 在模块加载时按 config.outputDir 建库
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-storage-'));
process.env.OUTPUT_DIR = tmpDir;

const { storage, isValidConversationId } = await import('../src/services/storage.js');
const { config } = await import('../src/config.js');

const B64 = Buffer.from('fake-image-bytes').toString('base64');

function seedConversation(id: string, imageCount: number) {
  storage.ensureConversation(id, `会话 ${id}`);
  const imgs = [];
  for (let i = 0; i < imageCount; i++) {
    imgs.push(storage.saveImage({
      base64: B64, format: 'png', prompt: `图 ${i + 1}`, size: '1024x1024',
      quality: 'high', model: 'gpt-image-1', kind: 'generate', conversationId: id,
    }));
  }
  return imgs;
}

before(() => {
  assert.equal(config.outputDir, path.resolve(tmpDir), 'OUTPUT_DIR 必须指向临时目录');
});

test('会话 id 校验：防路径穿越', () => {
  assert.equal(isValidConversationId('abc-DEF_123'), true);
  assert.equal(isValidConversationId(''), false);
  assert.equal(isValidConversationId('..'), false);
  assert.equal(isValidConversationId('a/b'), false);
  assert.equal(isValidConversationId('a\\b'), false);
  assert.equal(isValidConversationId('x'.repeat(65)), false);
});

test('ensureConversation：标题只写一次，之后仅刷新 updated_at', () => {
  storage.ensureConversation('c-title', '第一个标题');
  storage.ensureConversation('c-title', '后来的标题');
  const conv = storage.listConversations().find((c) => c.id === 'c-title');
  assert.equal(conv?.title, '第一个标题');
});

test('消息：落库后按时间正序返回，元数据完整', () => {
  storage.ensureConversation('c-msg', '消息');
  storage.saveMessage({ conversationId: 'c-msg', role: 'user', content: '画一只猫', skill: 'ip-as-logo' });
  storage.saveMessage({ conversationId: 'c-msg', role: 'assistant', content: '已生成', imageIds: ['img-1'] });

  const msgs = storage.listMessages('c-msg');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].skill, 'ip-as-logo');
  assert.equal(msgs[1].role, 'assistant');
  assert.deepEqual(msgs[1].imageIds, ['img-1']);

  // limit 截断取最新，而不是最早
  const one = storage.listMessages('c-msg', 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].content, '已生成');
});

test('图片：落盘 + 落库 + 序号递增，文件真实存在', () => {
  const [a, b] = seedConversation('c-img', 2);
  assert.equal(a.index, 1);
  assert.equal(b.index, 2);

  const found = storage.getImagePath(a.id);
  assert.ok(found);
  assert.equal(found.mime, 'image/png');
  assert.equal(fs.existsSync(found.filepath), true);

  // getImageData 往返一致
  const data = storage.getImageData(a.id);
  assert.equal(data?.base64, B64);
});

test('图片：listImages 按会话隔离且 source 不计数不编号', () => {
  seedConversation('c-list', 3);
  storage.saveSourceImage({ base64: B64, name: 'up.png', mimeType: 'image/png', conversationId: 'c-list' });

  const imgs = storage.listImages(50, 'c-list');
  assert.equal(imgs.length, 3); // 默认不含 source
  assert.deepEqual(imgs.map((i) => i.index).sort(), [1, 2, 3]);

  const withSources = storage.listImages(50, 'c-list', true);
  assert.equal(withSources.length, 4);
  assert.equal(withSources.find((i) => i.kind === 'source')?.index, undefined);

  // 会话列表的 imageCount/thumbUrl 只统计生成产物
  const conv = storage.listConversations().find((c) => c.id === 'c-list');
  assert.equal(conv?.imageCount, 3);
  assert.ok(conv?.thumbUrl?.startsWith('/api/images/'));
});

test('摘要：保存/更新/清空/随会话删除', () => {
  storage.ensureConversation('c-sum', '摘要');
  storage.saveSummary('c-sum', '旧摘要', 8);
  assert.deepEqual(
    storage.getSummary('c-sum'),
    { summary: '旧摘要', coveredCount: 8, updatedAt: storage.getSummary('c-sum')!.updatedAt },
  );
  storage.saveSummary('c-sum', '新摘要', 15); // upsert 覆盖
  assert.equal(storage.getSummary('c-sum')?.summary, '新摘要');
  assert.equal(storage.getSummary('c-sum')?.coveredCount, 15);

  storage.clearSummary('c-sum');
  assert.equal(storage.getSummary('c-sum'), null);
});

test('deleteConversation：库记录与会话目录一起清除', () => {
  const [img] = seedConversation('c-del', 1);
  storage.saveMessage({ conversationId: 'c-del', role: 'user', content: 'hi' });
  storage.saveSummary('c-del', 's', 1);
  const dir = path.dirname(storage.getImagePath(img.id)!.filepath);

  assert.equal(storage.deleteConversation('c-del'), true);
  assert.equal(storage.listConversations().some((c) => c.id === 'c-del'), false);
  assert.equal(storage.listMessages('c-del').length, 0);
  assert.equal(storage.listImages(50, 'c-del').length, 0);
  assert.equal(storage.getSummary('c-del'), null);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(storage.deleteConversation('c-del'), false); // 重复删除返回 false
});

test('getLastGenerated / getLastSource 只取本会话最新', () => {
  seedConversation('c-last', 2);
  storage.saveSourceImage({ base64: B64, name: 's.png', mimeType: 'image/png', conversationId: 'c-last' });
  const last = storage.getLastGenerated('c-last');
  assert.equal(last?.prompt, '图 2');
  assert.equal(storage.getLastSource('c-last')?.kind, 'source');
  assert.equal(storage.getLastGenerated('c-empty'), null);
});
