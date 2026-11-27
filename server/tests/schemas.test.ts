/**
 * 工具参数 zod schema 单测：模型给的参数必须被兜住，默认值要与前端设置面板一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateImageParams, editImageParams, toolDefinitions } from '../src/agent/schemas.js';

test('generate_image：只给 prompt 时填充全部默认值', () => {
  const p = generateImageParams.parse({ prompt: '一只猫' });
  assert.equal(p.n, 1);
  assert.equal(p.size, '1024x1024');
  assert.equal(p.quality, 'high');
  assert.equal(p.model, 'gpt-image-1');
  assert.equal(p.output_format, 'png');
  assert.equal(p.output_compression, 100);
  assert.equal(p.background, 'auto');
  assert.equal(p.moderation, 'auto');
});

test('generate_image：非法参数被拒绝', () => {
  assert.throws(() => generateImageParams.parse({ prompt: '' })); // 空 prompt
  assert.throws(() => generateImageParams.parse({ prompt: 'x', n: 0 }));
  assert.throws(() => generateImageParams.parse({ prompt: 'x', n: 11 }));
  assert.throws(() => generateImageParams.parse({ prompt: 'x', size: '2048x2048' }));
  assert.throws(() => generateImageParams.parse({ prompt: 'x', output_compression: 101 }));
  assert.throws(() => generateImageParams.parse({})); // 缺 prompt
});

test('generate_image：边界值放行', () => {
  assert.equal(generateImageParams.parse({ prompt: 'x', n: 10 }).n, 10);
  assert.equal(generateImageParams.parse({ prompt: 'x', output_compression: 0 }).output_compression, 0);
});

test('edit_image：默认跟随最近图，选图参数可选且优先', () => {
  const p = editImageParams.parse({ prompt: '改成蓝色' });
  assert.equal(p.use_last_image, true);
  assert.equal(p.size, 'auto'); // 编辑默认 auto，与生成不同
  assert.equal(p.image_index, undefined);
  assert.equal(p.image_id, undefined);

  const byIndex = editImageParams.parse({ prompt: 'x', image_index: 1 });
  assert.equal(byIndex.image_index, 1);
  assert.throws(() => editImageParams.parse({ prompt: 'x', image_index: 0 })); // 序号从 1 开始
});

test('toolDefinitions 与 zod 字段保持一致（防止喂给模型的 schema 漂移）', () => {
  const genProps = Object.keys((toolDefinitions[0] as any).function.parameters.properties);
  const editProps = Object.keys((toolDefinitions[1] as any).function.parameters.properties);
  assert.deepEqual(genProps.sort(), Object.keys(generateImageParams.shape).sort());
  assert.deepEqual(editProps.sort(), Object.keys(editImageParams.shape).sort());
  assert.deepEqual((toolDefinitions[0] as any).function.parameters.required, ['prompt']);
  assert.deepEqual((toolDefinitions[1] as any).function.parameters.required, ['prompt']);
});
