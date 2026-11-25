import fs from 'node:fs';
import OpenAI, { toFile } from 'openai';
import { config } from '../config.js';
import type { ChatAttachment } from '../types.js';

// 图像 API client：独立使用 imageBaseUrl / imageApiKey，与对话 API 完全分离
// client 可热更新：控制台设置页改图像 Key/BaseURL 后调用 refreshOpenAIClient() 即可生效
let _openai = new OpenAI({ apiKey: config.imageApiKey || 'sk-placeholder', baseURL: config.imageBaseUrl, timeout: 180_000 });
export function getOpenAI(): OpenAI { return _openai; }
export function refreshOpenAIClient(): void {
  _openai = new OpenAI({ apiKey: config.imageApiKey || 'sk-placeholder', baseURL: config.imageBaseUrl, timeout: 180_000 });
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 500) {
    super(message);
  }
}

/** 把上游错误归类为明确错误码 */
export function normalizeError(err: any): ApiError {
  const status = err?.status ?? err?.response?.status;
  const raw = err?.message ?? String(err);
  if (status === 401 || /invalid api key|incorrect api key|401/i.test(raw)) {
    return new ApiError('INVALID_API_KEY', 'OpenAI API Key 无效或已过期，请检查 server/.env 中的 OPENAI_API_KEY', 401);
  }
  if (status === 429 || /rate limit|quota|429/i.test(raw)) {
    return new ApiError('RATE_LIMITED', `调用额度或频率受限：${raw}`, 429);
  }
  if (status === 400) {
    return new ApiError('BAD_REQUEST', `OpenAI 拒绝了请求参数：${raw}`, 400);
  }
  return new ApiError('UPSTREAM_ERROR', `模型服务调用失败：${raw}`, 500);
}

type GenerateOpts = {
  model: string;
  prompt: string;
  n: number;
  size: string;
  quality: string;
  output_format: string;
  output_compression: number;
  background: string;
  moderation: string;
};

/** 文生图：返回 base64 数组 */
export async function generateImages(o: GenerateOpts): Promise<string[]> {
  try {
    const params: any = {
      model: o.model,
      prompt: o.prompt,
      n: o.n,
      size: o.size === 'auto' ? undefined : o.size,
      quality: o.quality === 'auto' ? undefined : o.quality,
      background: o.model.startsWith('gpt-image') ? o.background : undefined,
      moderation: o.model.startsWith('gpt-image') ? o.moderation : undefined,
    };
    // dall-e-3 不支持 n>1
    if (!o.model.startsWith('gpt-image')) params.n = undefined;
    if (o.model.startsWith('gpt-image')) {
      params.output_format = o.output_format;
      if (o.output_format !== 'png') params.output_compression = o.output_compression;
    }
    const res: any = await getOpenAI().images.generate(params);
    return (res.data ?? []).map((item: any) => {
      if (item.b64_json) return item.b64_json;
      if (item.url) throw new ApiError('UNEXPECTED_FORMAT', '上游返回了 URL 而非 base64，当前版本仅支持 base64 落盘', 500);
      throw new ApiError('EMPTY_RESULT', '图像接口返回空数据', 500);
    });
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    throw normalizeError(err);
  }
}

/** 从 base64 魔数推断图片 MIME，上传附件未带可靠 MIME 时兜底 */
function sniffImageMime(base64: string): string {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('UklGR')) return 'image/webp';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  return 'image/png';
}

function normalizeImageMime(mime?: string | null): string | null {
  const m = mime?.toLowerCase().split(';')[0].trim();
  if (m === 'image/jpg') return 'image/jpeg';
  return m === 'image/png' || m === 'image/jpeg' || m === 'image/webp' ? m : null;
}

type EditOpts = {
  model: string;
  prompt: string;
  n: number;
  size: string;
  quality: string;
  output_format: string;
  attachment?: ChatAttachment | null;
  lastImageBuffer?: Buffer | null;
};

/** 图片编辑：原图为上传图或最近生成的图，multipart 传参 */
export async function editImages(o: EditOpts): Promise<string[]> {
  const raw = o.attachment?.data || (o.lastImageBuffer ? o.lastImageBuffer.toString('base64') : null);
  if (!raw) {
    throw new ApiError('NO_SOURCE_IMAGE', '没有可用于编辑的图片：请先上传图片或先生成一张图', 400);
  }
  // ReadStream 无法让 OpenAI SDK 推断 MIME（会被发成 application/octet-stream，部分端点直接 400），
  // 用 toFile 显式给出文件名与 Content-Type。
  const source = raw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  const mime = normalizeImageMime(o.attachment?.mimeType) ?? sniffImageMime(source);
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
  const image = await toFile(Buffer.from(source, 'base64'), `source.${ext}`, { type: mime });
  try {
    const params: any = {
      model: o.model,
      image,
      prompt: o.prompt,
      n: o.n,
      size: o.size === 'auto' ? undefined : o.size,
      quality: o.quality === 'auto' ? undefined : o.quality,
      output_format: o.output_format,
    };
    const res: any = await getOpenAI().images.edit(params);
    return (res.data ?? []).map((item: any) => {
      if (item.b64_json) return item.b64_json;
      throw new ApiError('EMPTY_RESULT', '编辑接口返回空数据', 500);
    });
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    throw normalizeError(err);
  }
}

/** 连接测试：列出模型，验证 Key 与端点 */
export async function testConnection(): Promise<{ ok: boolean; message: string; code?: string }> {
  try {
    const res = await getOpenAI().models.list();
    return { ok: true, message: `图像 API 连接正常 · ${config.imageBaseUrl} · 可用模型 ${res.data.length} 个` };
  } catch (err: any) {
    const e = normalizeError(err);
    return { ok: false, code: e.code, message: e.message };
  }
}

/** 读取最近生成图的 Buffer，供 edit_image 使用 */
export function readLastImage(filepath: string): Buffer {
  return fs.readFileSync(filepath);
}
