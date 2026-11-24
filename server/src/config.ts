import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env') });

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}
function envBool(name: string, fallback = false): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const runtimeConfigPath = path.resolve(import.meta.dirname, '..', 'data', 'runtime-config.json');

/** 运行时配置：对话 API 与图像 API 各自独立 */
interface RuntimeConfig {
  chatApiKey?: string;
  chatBaseUrl?: string;
  chatModel?: string;
  chatVision?: boolean;
  systemPrompt?: string;
  imageApiKey?: string;
  imageBaseUrl?: string;
  imageModel?: string;
}

export const DEFAULT_SYSTEM_PROMPT =
  '你是一个图片生成助手。根据用户描述调用 generate_image 生成图片；用户上传图片并要求修改时调用 edit_image。参数未明确时按生成设置的默认值执行。';

function loadRuntimeConfig(): RuntimeConfig {
  try {
    if (fs.existsSync(runtimeConfigPath)) return JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf-8'));
  } catch (e) {
    console.warn('[config] 读取运行时配置失败，忽略：', e);
  }
  return {};
}

let runtime = loadRuntimeConfig();

export interface AppConfig {
  // 对话 API（驱动 Pi Agent 的 function calling）
  chatApiKey: string;
  chatBaseUrl: string;
  chatModel: string;
  chatVision: boolean;
  systemPrompt: string;
  // 图像 API（gpt-image-1 文生图/编辑）
  imageApiKey: string;
  imageBaseUrl: string;
  imageModel: string;
  // 服务
  port: number;
  corsOrigin: string;
  outputDir: string;
  skillsDir: string;
  publicBaseUrl: string;
  browser: string;
}

const OFFICIAL = 'https://api.openai.com/v1';
// 旧变量 OPENAI_* 作为两者的初始默认，运行时各自可独立覆盖
const legacyKey = env('OPENAI_API_KEY', '');
const legacyBase = env('OPENAI_BASE_URL', OFFICIAL);

export const config: AppConfig = {
  chatApiKey: runtime.chatApiKey ?? env('CHAT_API_KEY', legacyKey),
  chatBaseUrl: (runtime.chatBaseUrl ?? env('CHAT_BASE_URL', legacyBase)).replace(/\/+$/, ''),
  chatModel: runtime.chatModel ?? env('CHAT_MODEL', 'gpt-4o'),
  chatVision: runtime.chatVision ?? envBool('CHAT_VISION', false),
  systemPrompt: runtime.systemPrompt ?? env('SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT),

  imageApiKey: runtime.imageApiKey ?? env('IMAGE_API_KEY', legacyKey),
  imageBaseUrl: (runtime.imageBaseUrl ?? env('IMAGE_BASE_URL', OFFICIAL)).replace(/\/+$/, ''),
  imageModel: runtime.imageModel ?? env('IMAGE_MODEL', 'gpt-image-1'),

  port: Number(env('PORT', '3001')),
  corsOrigin: env('CORS_ORIGIN', '*'),
  outputDir: path.resolve(import.meta.dirname, '..', env('OUTPUT_DIR', './outputs')),
  skillsDir: path.resolve(import.meta.dirname, '..', env('SKILLS_DIR', './skills')),
  publicBaseUrl: env('PUBLIC_BASE_URL', ''),
  browser: env('BROWSER', 'auto'),
};

fs.mkdirSync(config.outputDir, { recursive: true });

const configured = (k: string) => !!k && k !== 'sk-...';
export function isChatConfigured(): boolean { return configured(config.chatApiKey); }
export function isImageConfigured(): boolean { return configured(config.imageApiKey); }

/** 更新运行时配置：写盘 + 热更新内存 config。未传字段保持不变；传空字符串表示清空。 */
export function updateRuntimeConfig(patch: RuntimeConfig): void {
  if (patch.chatApiKey !== undefined) config.chatApiKey = patch.chatApiKey.trim();
  if (patch.chatBaseUrl !== undefined) config.chatBaseUrl = patch.chatBaseUrl.trim().replace(/\/+$/, '') || OFFICIAL;
  if (patch.chatModel !== undefined) config.chatModel = patch.chatModel.trim();
  if (patch.chatVision !== undefined) config.chatVision = !!patch.chatVision;
  if (patch.systemPrompt !== undefined) config.systemPrompt = patch.systemPrompt.trim();
  if (patch.imageApiKey !== undefined) config.imageApiKey = patch.imageApiKey.trim();
  if (patch.imageBaseUrl !== undefined) config.imageBaseUrl = patch.imageBaseUrl.trim().replace(/\/+$/, '') || OFFICIAL;
  if (patch.imageModel !== undefined) config.imageModel = patch.imageModel.trim();

  runtime = {
    chatApiKey: config.chatApiKey,
    chatBaseUrl: config.chatBaseUrl,
    chatModel: config.chatModel,
    chatVision: config.chatVision,
    systemPrompt: config.systemPrompt,
    imageApiKey: config.imageApiKey,
    imageBaseUrl: config.imageBaseUrl,
    imageModel: config.imageModel,
  };
  fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
  fs.writeFileSync(runtimeConfigPath, JSON.stringify(runtime, null, 2), { mode: 0o600 });
}

// 启动提示：无 Key 只告警，不退出；仍无 mock
if (!isChatConfigured() || !isImageConfigured()) {
  console.warn('[config] 对话 API 或图像 API 的 Key 尚未全部配置：控制台可正常打开，请到「设置」页分别填入。');
  console.warn('[config] （不会降级为 mock；缺失对应 Key 时调用会返回明确的 MISSING_*_API_KEY 错误）');
}
