/**
 * 任务注册表单测：运行状态、事件缓存回放、结束语义。
 * 刷新后"内容续得上 + 图标不滞留"全靠这套行为，必须锁死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTask, endTask, recordTaskEvent, listRunningTasks, getTaskEvents,
} from '../src/services/task-registry.js';

test('startTask 后出现在运行列表，重复 start 会重置事件缓存', () => {
  startTask('conv-a');
  recordTaskEvent('conv-a', { type: 'status', text: 'x' });
  assert.equal(listRunningTasks().some((t) => t.conversationId === 'conv-a'), true);

  startTask('conv-a'); // 同一会话再次开始 = 新一轮
  const snap = getTaskEvents('conv-a', 0);
  assert.equal(snap?.events.length, 0);
  assert.equal(snap?.done, false);
});

test('recordTaskEvent 顺序编号，getTaskEvents 支持增量拉取', () => {
  startTask('conv-b');
  recordTaskEvent('conv-b', { type: 'status', text: 's1' });
  recordTaskEvent('conv-b', { type: 'text', delta: 'he' });
  recordTaskEvent('conv-b', { type: 'text', delta: 'llo' });

  const all = getTaskEvents('conv-b', 0);
  assert.equal(all?.events.length, 3);
  assert.deepEqual(all?.events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(all?.latestSeq, 3);
  assert.equal(all?.done, false);

  const inc = getTaskEvents('conv-b', 2);
  assert.equal(inc?.events.length, 1);
  assert.equal(inc?.events[0].seq, 3);
  assert.deepEqual(inc?.events[0].event, { type: 'text', delta: 'llo' });
});

test('endTask 后不再出现在运行列表，但事件缓存仍可回放', () => {
  startTask('conv-c');
  recordTaskEvent('conv-c', { type: 'thinking', delta: 'hmm' });
  recordTaskEvent('conv-c', { type: 'done', conversationId: 'conv-c' });
  endTask('conv-c');

  assert.equal(listRunningTasks().some((t) => t.conversationId === 'conv-c'), false);

  const snap = getTaskEvents('conv-c', 0);
  assert.equal(snap?.done, true);
  assert.equal(snap?.events.length, 2);
});

test('未知会话：getTaskEvents 返回 null，record/end 静默忽略不抛错', () => {
  assert.equal(getTaskEvents('nope', 0), null);
  recordTaskEvent('nope', { type: 'status', text: 'x' });
  endTask('nope');
});

test('多会话并发互不串扰', () => {
  startTask('conv-d1');
  startTask('conv-d2');
  recordTaskEvent('conv-d1', { type: 'text', delta: 'one' });
  recordTaskEvent('conv-d2', { type: 'text', delta: 'two' });
  endTask('conv-d1');

  const running = listRunningTasks().map((t) => t.conversationId);
  assert.equal(running.includes('conv-d1'), false);
  assert.equal(running.includes('conv-d2'), true);

  assert.equal(getTaskEvents('conv-d1', 0)?.events.length, 1);
  assert.equal(getTaskEvents('conv-d2', 0)?.events.length, 1);
  assert.deepEqual(getTaskEvents('conv-d2', 0)?.events[0].event, { type: 'text', delta: 'two' });
  endTask('conv-d2');
});
