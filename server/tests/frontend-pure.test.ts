/**
 * 前端纯函数单测：直接从 index.html 抽取 escapeHtml / renderMarkdown / parseSlash
 * 的函数源码在 Node 里执行——测的就是线上那份代码，不是复制出来的副本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'index.html'), 'utf-8');

/** 按花括号配平抽取一个 function 声明的完整源码 */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html 中应存在 function ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`function ${name} 花括号未闭合`);
}

const factory = new Function(
  'SKILLS',
  `${extractFn(html, 'escapeHtml')}\n${extractFn(html, 'renderMarkdown')}\n${extractFn(html, 'parseSlash')}\n${extractFn(html, 'dataUrlBytes')}\nreturn { escapeHtml, renderMarkdown, parseSlash, dataUrlBytes };`,
) as (skills: any[]) => { escapeHtml: any; renderMarkdown: any; parseSlash: any; dataUrlBytes: any };

const SKILLS = [
  { name: 'ip-as-logo', description: 'logo', enabled: true },
  { name: 'old', description: '停用', enabled: false },
];
const { escapeHtml, renderMarkdown, parseSlash, dataUrlBytes } = factory(SKILLS);

test('附件草稿在点击发送时立即清空，任务结束不得再清（否则会误删新粘贴的图）', () => {
  const send = extractFn(html, 'sendChat');
  const respond = extractFn(html, 'agentRespond');
  const clearAt = send.indexOf('clearAttach();');
  const requestAt = send.indexOf('agentRespond(');
  assert.notEqual(clearAt, -1, 'sendChat 必须清空附件草稿');
  assert.ok(clearAt < requestAt, '清空必须发生在发起请求前');
  assert.ok(!respond.includes('clearAttach()'), 'agentRespond 结束时不得再次清空附件');
});

test('dataUrlBytes：正确估算 base64 解码后字节数（附件体积门禁依赖它）', () => {
  assert.equal(dataUrlBytes('data:image/png;base64,'), 0);
  assert.equal(dataUrlBytes('data:image/png;base64,aGk='), 2); // "hi"
  assert.equal(dataUrlBytes('data:image/jpeg;base64,aGVsbG8='), 5); // "hello"
  assert.equal(dataUrlBytes('aGVsbG8h'), 6); // 无 dataURL 头也能算
});

test('escapeHtml：转义五种危险字符', () => {
  assert.equal(escapeHtml('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(escapeHtml('普通文本'), '普通文本');
});

test('renderMarkdown：先转义再渲染，XSS 进不来', () => {
  const out = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'), '原始 script 标签必须被转义');
  assert.ok(out.includes('&lt;script&gt;'));
});

test('renderMarkdown：标题/列表/加粗/行内代码', () => {
  assert.equal(renderMarkdown('# 标题'), '<h1 class="md-h">标题</h1>');
  assert.equal(renderMarkdown('### 小标题'), '<h3 class="md-h">小标题</h3>');
  assert.equal(renderMarkdown('- 甲\n- 乙'), '<ul class="md-list"><li>甲</li><li>乙</li></ul>');
  assert.equal(renderMarkdown('1. 第一\n2. 第二'), '<ol class="md-list"><li>第一</li><li>第二</li></ol>');
  assert.equal(renderMarkdown('**重点**'), '<div class="md-p"><strong>重点</strong></div>');
  assert.equal(renderMarkdown('用 `npm test` 跑'), '<div class="md-p">用 <code class="md-code">npm test</code> 跑</div>');
});

test('renderMarkdown：代码块与空行', () => {
  const out = renderMarkdown('前文\n\n```\nconst a = 1;\n```');
  assert.ok(out.includes('<div class="md-gap"></div>'));
  assert.ok(out.includes('<pre class="md-pre"><code>const a = 1;</code></pre>'));
});

test('parseSlash：解析 /skill 指令', () => {
  assert.deepEqual(parseSlash('普通输入，不带指令'), null);
  assert.deepEqual(parseSlash('/ip-as-logo 画一个极简 logo'),
    { name: 'ip-as-logo', args: '画一个极简 logo', skill: SKILLS[0] });
  // 未知 skill：name/args 照解析，skill 为 null，由上层提示未安装
  const unknown = parseSlash('/not-exist 测试');
  assert.equal(unknown.name, 'not-exist');
  assert.equal(unknown.skill, null);
  // 只有指令没有参数
  assert.deepEqual(parseSlash('/ip-as-logo'), { name: 'ip-as-logo', args: '', skill: SKILLS[0] });
});
