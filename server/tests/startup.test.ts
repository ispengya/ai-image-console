/**
 * 启动性能回归：Pi SDK 首次 import 约 5 秒（TUI + 全 provider catalog），
 * 必须走后台预热，不能出现在 HTTP 监听的静态依赖链上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve(import.meta.dirname, '..', 'src');
const read = (p: string) => fs.readFileSync(path.join(src, p), 'utf-8');

test('pi-agent 不静态导入 pi-coding-agent，改为按需 loadPi()', () => {
  const agent = read('agent/pi-agent.ts');
  assert.ok(
    !/from\s+['"]@earendil-works\/pi-coding-agent['"]/.test(agent),
    '静态 import 会重新把 5 秒的 Pi 加载拖回启动链路',
  );
  assert.ok(/await loadPi\(\)/.test(agent), 'runAgent 应在真正执行时才加载 Pi');
});

test('pi-loader 用单次动态 import 并缓存 Promise', () => {
  const loader = read('agent/pi-loader.ts');
  assert.ok(/import\(['"]@earendil-works\/pi-coding-agent['"]\)/.test(loader));
  assert.ok(/loading\s*=\s*null/.test(loader), '加载失败必须允许重试，不能钉死进程');
});

test('入口触发后台预热但不 await，不阻塞监听', () => {
  const entry = read('index.ts');
  assert.ok(/^warmupPi\(\);/m.test(entry), 'warmupPi 必须是顶层非 await 调用');
  assert.ok(!/await\s+warmupPi\(/.test(entry), 'await 会让它重新变成启动阻塞');
});
