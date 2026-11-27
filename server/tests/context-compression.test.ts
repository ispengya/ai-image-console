/**
 * 上下文压缩单测：
 * - planFold 纯函数：触发条件与折叠条数（不打真实 API）
 * - prepareContext 的"剔除本轮重复消息 + 关闭压缩时原样返回"路径（关闭压缩走不到 API 调用）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-compress-'));

const { config } = await import('../src/config.js');
const { storage } = await import('../src/services/storage.js');
const { planFold, prepareContext } = await import('../src/services/context-compression.js');

// 单测绝不打真实对话 API：关掉压缩，只测不触发模型调用的路径
config.contextCompression = false;

test('planFold：默认阈值下条数与字符两种触发方式', () => {
  // keep=6, batch=threshold-keep=6：条数超过 keep+batch=12 才触发
  assert.deepEqual(
    planFold({ uncoveredLen: 12, uncoveredChars: 100, threshold: 12, keepRecent: 6, maxChars: 6000 }),
    { keep: 6, batch: 6, shouldFold: false, foldCount: 0 },
  );
  assert.deepEqual(
    planFold({ uncoveredLen: 13, uncoveredChars: 100, threshold: 12, keepRecent: 6, maxChars: 6000 }),
    { keep: 6, batch: 6, shouldFold: true, foldCount: 7 }, // 只折除最近 6 条外的部分
  );
  // 字符超阈值：条数不多也触发，但只折得动 keep 之外的部分
  assert.deepEqual(
    planFold({ uncoveredLen: 7, uncoveredChars: 7000, threshold: 12, keepRecent: 6, maxChars: 6000 }),
    { keep: 6, batch: 6, shouldFold: true, foldCount: 1 },
  );
});

test('planFold：未压缩队列不足 keep 时，即使字符爆了也不折（保底不丢原文）', () => {
  const plan = planFold({ uncoveredLen: 6, uncoveredChars: 99999, threshold: 12, keepRecent: 6, maxChars: 6000 });
  assert.equal(plan.shouldFold, true);
  assert.equal(plan.foldCount, 0);
});

test('planFold：keep/batch 下限保护', () => {
  const plan = planFold({ uncoveredLen: 3, uncoveredChars: 10, threshold: 2, keepRecent: 1, maxChars: 6000 });
  assert.equal(plan.keep, 2);
  assert.equal(plan.batch, 2);
});

test('prepareContext：本轮用户消息已在库里时不重复注入', async () => {
  const emits: any[] = [];
  storage.ensureConversation('cc-1', '压缩');
  storage.saveMessage({ conversationId: 'cc-1', role: 'user', content: '第一句' });
  storage.saveMessage({ conversationId: 'cc-1', role: 'assistant', content: '回复一' });
  storage.saveMessage({ conversationId: 'cc-1', role: 'user', content: '当前的提问' });

  const bundle = await prepareContext('cc-1', '当前的提问', (e) => emits.push(e));
  assert.equal(bundle.folded, 0);
  assert.equal(bundle.summary, '');
  assert.deepEqual(bundle.recent.map((m) => m.content), ['第一句', '回复一']); // 不含本轮重复消息

  // 当前消息与库尾不一致时（异常路径）则全部保留
  const bundle2 = await prepareContext('cc-1', '另一个问题', (e) => emits.push(e));
  assert.equal(bundle2.recent.length, 3);
});

test('prepareContext：空会话返回空上下文且不发任何事件', async () => {
  const emits: any[] = [];
  const bundle = await prepareContext('cc-empty', '你好', (e) => emits.push(e));
  assert.deepEqual(bundle.recent, []);
  assert.equal(bundle.folded, 0);
  assert.equal(emits.length, 0);
});
