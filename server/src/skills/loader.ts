import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { SkillPreset } from '../types.js';

/**
 * 只扫描 config.skillsDir（默认 server/skills）下每个含 SKILL.md 的子目录。
 * SKILL.md 格式示例：
 * ---
 * name: logo-design
 * description: 简约矢量标志，默认透明背景
 * quality: high
 * background: transparent
 * size: 1024x1024
 * ---
 * 简约现代 LOGO 设计：{input}，矢量风格，扁平化
 *
 * frontmatter 中除 name/description/enabled 外的字段都作为工具参数预设（overrides），
 * 会在 zod 校验前 merge 进工具调用参数。
 */
function parseSkillFile(content: string, source: string): SkillPreset | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fmMatch) return null;
  const meta: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) meta[key] = value;
  }
  if (!meta.name) return null;
  const overrides: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (['name', 'description', 'label', 'enabled'].includes(k)) continue;
    if (/^-?\d+(\.\d+)?$/.test(v)) overrides[k] = Number(v);
    else overrides[k] = v;
  }
  return {
    name: meta.name,
    label: meta.label || meta.name,
    description: meta.description || '',
    template: fmMatch[2].trim(),
    overrides,
    source,
    enabled: meta.enabled !== 'false',
  };
}

function loadFrom(dir: string): SkillPreset[] {
  const skills: SkillPreset[] = [];
  if (!fs.existsSync(dir)) return skills;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    try {
      const skill = parseSkillFile(fs.readFileSync(file, 'utf-8'), file);
      if (skill) skills.push(skill);
    } catch (err) {
      console.warn(`[skills] 解析失败：${file}`, err);
    }
  }
  return skills;
}

/** 只从项目自己的 skill 目录（默认 server/skills）加载 */
export function loadSkills(): SkillPreset[] {
  return loadFrom(config.skillsDir);
}

export function findSkill(name: string, skills: SkillPreset[]): SkillPreset | null {
  return skills.find((s) => s.name === name && s.enabled) ?? null;
}
