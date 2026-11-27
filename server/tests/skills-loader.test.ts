/**
 * Skill 加载单测：用临时 fixture 目录，不依赖用户真实安装的 skills。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 先建 fixture，再让 config 指向它
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-skills-'));
process.env.SKILLS_DIR = tmpDir;
process.env.OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aic-skills-out-'));

function writeSkill(dir: string, content: string | null) {
  const p = path.join(tmpDir, dir);
  fs.mkdirSync(p, { recursive: true });
  if (content !== null) fs.writeFileSync(path.join(p, 'SKILL.md'), content);
}

writeSkill('logo', `---
name: logo-design
description: 简约矢量标志
quality: high
size: 1024x1024
n: 2
background: transparent
---
简约现代 LOGO：{input}，扁平化`);

writeSkill('disabled', `---
name: old-skill
enabled: false
---
模板 {input}`);

writeSkill('no-frontmatter', '没有 frontmatter 的正文');
writeSkill('no-name', `---
description: 缺 name 的 skill
---
正文`);
writeSkill('empty-dir', null); // 无 SKILL.md

const { loadSkills, findSkill } = await import('../src/skills/loader.js');

test('loadSkills：只加载合法 SKILL.md，字段解析正确', () => {
  const skills = loadSkills();
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['logo-design', 'old-skill']); // 无 frontmatter / 无 name / 无文件 都被跳过

  const logo = skills.find((s) => s.name === 'logo-design')!;
  assert.equal(logo.description, '简约矢量标志');
  assert.equal(logo.label, 'logo-design'); // label 缺省回退 name
  assert.equal(logo.enabled, true);
  assert.equal(logo.template, '简约现代 LOGO：{input}，扁平化');
  // frontmatter 额外字段进 overrides，数字字符串转 number
  assert.deepEqual(logo.overrides, { quality: 'high', size: '1024x1024', n: 2, background: 'transparent' });

  const disabled = skills.find((s) => s.name === 'old-skill')!;
  assert.equal(disabled.enabled, false);
});

test('findSkill：只匹配启用中的 skill', () => {
  const skills = loadSkills();
  assert.equal(findSkill('logo-design', skills)?.name, 'logo-design');
  assert.equal(findSkill('old-skill', skills), null); // 停用视为不存在
  assert.equal(findSkill('nope', skills), null);
});
