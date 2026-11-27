/**
 * Pi Agent 引擎
 * 用 @earendil-works/pi-coding-agent 的 SDK 驱动工具调用循环，
 * 替换掉原先手写的 function calling loop。出图/编辑/存储/SSE 协议沿用现有实现，前端零改动。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadPi } from './pi-loader.js';
import { getModel } from '@earendil-works/pi-ai/compat';
import { Type } from 'typebox';
import { config, isImageConfigured } from '../config.js';
import { storage } from '../services/storage.js';
import { generateImages, editImages, ApiError, normalizeError } from '../services/openai.js';
import { findSkill } from '../skills/loader.js';
import { prepareContext } from '../services/context-compression.js';
import { generateImageParams, editImageParams } from './schemas.js';
import type { ChatRequest, SseEvent, SkillPreset, GeneratedImage } from '../types.js';

type Emit = (event: SseEvent) => void;

/** /skill 指令展开：模板替换 + 参数预设 */
function expandSkill(req: ChatRequest, skills: SkillPreset[]): { message: string; overrides: Record<string, unknown> } {
  if (!req.skill) return { message: req.message, overrides: {} };
  const skill = findSkill(req.skill, skills);
  if (!skill) throw new ApiError('SKILL_NOT_FOUND', `未找到 skill「/${req.skill}」或其已停用`, 400);
  let args = req.message.trim().replace(new RegExp(`^/${req.skill}\\s*`), '').trim();
  // 带 {input} 的模板：替换占位符；无占位符的 skill（完整 agent 指令型）：正文下发，用户请求附在末尾
  let expanded: string;
  if (skill.template.includes('{input}')) {
    expanded = skill.template.replace('{input}', args || skill.label);
  } else {
    expanded = args ? `${skill.template}\n\n---\n\n用户本次请求：${args}` : skill.template;
  }
  return { message: expanded, overrides: skill.overrides };
}

/** 合并参数：设置默认 < skill 预设 < 模型显式参数 */
function mergeParams(settings: ChatRequest['settings'], skillOverrides: Record<string, unknown>, args: Record<string, unknown>) {
  const defined = (o?: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    if (o) for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
    return out;
  };
  return { ...settings, ...defined(skillOverrides), ...defined(args) };
}

/** 系统提示：注入 skill 列表、设置默认值、最近的对话历史 */
function buildSystemPrompt(req: ChatRequest, skills: SkillPreset[], skillTag: string, hasVisionImage = false, context?: { summary: string; recent: Array<{ role: 'user' | 'assistant'; content: string }> }): string {
  const s = req.settings;
  const skillLines = skills
    .filter((x) => x.enabled)
    .map((x) => `- /${x.name}：${x.description}`)
    .join('\n');
  // 上下文压缩后：摘要（更早的对话）+ 最近若干条原样历史。
  // 未传 context（例如直接调用 agent）时回退到前端 history 的最近 10 条。
  const summary = context?.summary?.trim() || '';
  const sourceHistory = context ? context.recent : req.history.slice(-10);
  const historyLines = sourceHistory
    .map((h) => `${h.role === 'user' ? '用户' : '助手'}：${h.content}`)
    .join('\n');
  const summarySection = summary
    ? `\n更早的对话摘要（压缩保留，涉及图片编号/偏好的信息以此为准）：\n${summary}\n`
    : '';
  // 本会话可编辑图片清单（按生成顺序编号），供模型把「第一张」映射到 image_index
  const editable = storage.listImages(100, req.conversationId, false).reverse();
  const imageLines = editable.length
    ? editable.map((img) => `第${img.index}张（id=${img.id}）：${img.prompt.slice(0, 40)}${img.prompt.length > 40 ? '…' : ''}`).join('\n')
    : '- （暂无）';
  const attachmentHint = hasVisionImage
    ? `\n本次会话有用户上传的图片，已作为视觉内容附在消息中。你可以看到并描述画面内容；若用户要求修改，基于实际画面调用 edit_image 并设 use_last_image=false。`
    : req.attachment
      ? `\n用户上传了一张图片（${req.attachment.name}），但当前对话模型未开启图片识别，你看不到画面内容。不要声称看到了图片；请让用户描述画面或修改要求，再调用 edit_image 并设 use_last_image=false。`
      : '';
  // 前端每次都会带 systemPrompt；直接调 API 时回退到服务端配置（环境变量 / 设置页保存值）
  const customPrompt = (req.systemPrompt ?? config.systemPrompt ?? '').trim();
  const customSection = customPrompt
    ? `用户自定义 System Prompt（在满足下方工具契约的前提下优先）：
${customPrompt}

`
    : '';
  return `${customSection}你是图片工作台的图片生成 Agent。工具契约是硬性要求，必须遵守：
- generate_image：用户要求生成、画一张、出图时调用。
- edit_image：用户要求修改、重绘、换风格时调用。
  选图优先级：用户说「第 N 张 / 第一张 / 刚才那张」时，用 image_index=N 精确指定（N 从 1 开始，按生成顺序）；给出 id 时用 image_id；否则 use_last_image=false 表示用用户上传的图，true 表示用最近生成的图。

本会话已生成的图片（用户说的编号对应这里的「第N张」）：
${imageLines}
${req.editImageId ? `\n用户拖入了一张产物图（id=${req.editImageId}）要求编辑，直接以它为目标，无需再推断「第几张」。` : ''}

你还拥有 Pi 的文件工具 read / bash / edit / write（工作目录是项目根目录）。当 skill 需要了解产品上下文（如 README、package.json、设计文档）时，先用这些工具读取相关文件再提案，不要仅凭目录名猜测。除用户明确要求外，不要修改任何文件。

已安装的画图 skill（提示词模板 + 参数预设）：
${skillLines || '- （无）'}
${skillTag ? `本次使用了 skill ${skillTag}，prompt 已按模板展开，参数预设已应用，无需重复套用其它风格。` : ''}

当前生成设置默认值（工具参数未指定时按此填写）：
model=${s.model}, size=${s.size}, quality=${s.quality}, n=${s.n}, output_format=${s.output_format}, background=${s.background}

用户明确说「横版/竖版」「透明背景」「来 N 张」「高质量/快速」时覆盖对应默认值。${attachmentHint}

需要澄清时先提问，不要调用任何工具：当风格、主体、配色、版式等关键信息缺失，导致生成结果会很不确定时，直接用文字向用户提 1-3 个简短问题（可给出推荐选项，例如「风格要 A 极简 / B 写实？不指定我默认 A」），然后停止本轮回复等待用户回答；不要边猜边生成。用户回答后再在下一轮按答案调用工具。若只是小细节 unspecified，按默认值执行即可，不必追问。

回复保持简洁，中文回答。生成完图片后简短说明即可，不要重复输出参数。

${summarySection}
最近的对话历史（仅供参考）：
${historyLines || '- （无）'}`;
}

/** 保存出图结果并发 SSE 事件 */
function saveAndEmit(images: string[], opts: {
  format: string; prompt: string; size: string; quality: string; model: string;
  kind: 'generate' | 'edit'; emit: Emit; toolCallId: string; started: number;
  conversationId: string; parentId?: string | null;
}): GeneratedImage[] {
  const saved = images.map((base64) => storage.saveImage({
    base64,
    format: opts.format,
    prompt: opts.prompt,
    size: opts.size,
    quality: opts.quality,
    model: opts.model,
    kind: opts.kind,
    conversationId: opts.conversationId,
    parentId: opts.parentId,
  }));
  for (const image of saved) opts.emit({ type: 'image', image });
  // tool_result 由 session.subscribe 的 tool_execution_end 统一发出，覆盖内置与自定义工具
  return saved;
}

export async function runAgent(req: ChatRequest, skills: SkillPreset[], emit: Emit): Promise<void> {
  // 只在真正要跑 Agent 时加载 Pi SDK（启动时已后台预热，多数情况这里瞬时返回）
  const pi = await loadPi();
  const conversationId = req.conversationId;
  const { message, overrides: skillOverrides } = expandSkill(req, skills);

  // 上传原图由路由层落盘并给出 id（兼容直接调用 agent 的场景：此处补落盘）
  let sourceImageId: string | null = req.sourceImageId ?? null;
  if (!sourceImageId && req.attachment) {
    const savedSource = storage.saveSourceImage({
      base64: req.attachment.data,
      name: req.attachment.name,
      mimeType: req.attachment.mimeType,
      conversationId,
    });
    sourceImageId = savedSource.id;
  }

  // 视觉输入：本次上传优先；否则回退到本会话最近一张上传图，让历史对话里追问图片内容也能识别
  let visionImage: { data: string; mimeType: string } | undefined;
  if (config.chatVision) {
    if (req.attachment) {
      visionImage = { data: req.attachment.data, mimeType: req.attachment.mimeType };
    } else if (req.editImageId) {
      const data = storage.getImageData(req.editImageId);
      if (data) visionImage = { data: data.base64, mimeType: data.mime };
    } else {
      const lastSource = storage.getLastSource(conversationId);
      if (lastSource) {
        const data = storage.getImageData(lastSource.id);
        if (data) visionImage = { data: data.base64, mimeType: data.mime };
      }
    }
  }

  // 模型运行时：始终写一份包含当前对话模型的 models.json，
  // 这样自由填写的模型名（含官方端点上的新模型）也能被 Pi 识别
  const modelsPath = writeTempModelsConfig(config.chatBaseUrl, config.chatModel, config.chatVision);
  const modelRuntime = await pi.ModelRuntime.create({ modelsPath });
  await modelRuntime.setRuntimeApiKey('openai', config.chatApiKey);
  let model = modelRuntime.getModel('openai', config.chatModel);
  if (!model) model = getModel('openai', config.chatModel as any) ?? undefined;
  if (!model) {
    throw new ApiError('MODEL_NOT_FOUND', `找不到对话模型 ${config.chatModel}，请检查 CHAT_MODEL / models.json 配置`, 400);
  }

  // 上下文压缩：超阈值时用对话模型把旧消息摘要化并落库，再与最近原文一起注入
  const context = await prepareContext(conversationId, req.message, emit);
  const systemPrompt = buildSystemPrompt(req, skills, req.skill ? `/${req.skill}` : '', !!visionImage, context);
  // 隔离本机 Pi 用户配置：默认 getAgentDir() 会读 ~/.pi/agent（settings/extensions/skills），
  // 用户本机装的扩展会在这里被加载并可能报错。本项目只用项目内 server/skills 与内置文件工具。
  const isolatedAgentDir = path.join(process.cwd(), 'server', 'data', 'pi-agent');
  fs.mkdirSync(isolatedAgentDir, { recursive: true });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: isolatedAgentDir,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    noExtensions: true,      // 不加载 settings.json / ~/.pi 里的任何扩展
    noSkills: true,          // 画图 skill 由 server/skills 自己注入
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const sessionManager = pi.SessionManager.inMemory();

  const { session } = await pi.createAgentSession({
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    // 不设 noTools：启用 Pi 内置的 read/bash/edit/write 四个工具 + 下面的自定义图像工具
    // 思考级别可配置；模型不支持 reasoning 时 Pi 自动忽略，不会产生 thinking_delta
    thinkingLevel: (config.chatThinking || 'off') as any,
    customTools: [
      {
        name: 'generate_image',
        label: 'Generate Image',
        description: '根据用户描述的画面生成全新图片。当用户要求画图/生成图/出图时调用。',
        parameters: Type.Object({
          prompt: Type.String({ description: '图片内容的详细描述' }),
          n: Type.Optional(Type.Number({ description: '生成数量，1-10' })),
          size: Type.Optional(Type.String({ enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] })),
          quality: Type.Optional(Type.String({ enum: ['low', 'medium', 'high', 'auto'] })),
          model: Type.Optional(Type.String({ description: '图像模型，如 gpt-image-1' })),
          output_format: Type.Optional(Type.String({ enum: ['png', 'jpeg', 'webp'] })),
          output_compression: Type.Optional(Type.Number()),
          background: Type.Optional(Type.String({ enum: ['auto', 'opaque', 'transparent'] })),
          moderation: Type.Optional(Type.String({ enum: ['auto', 'low'] })),
        }),
        async execute(toolCallId: string, params: any) {
          const started = Date.now();
          if (!isImageConfigured()) {
            emit({ type: 'error', code: 'MISSING_IMAGE_API_KEY', message: '尚未配置「图像 API」的 Key。请打开左侧「设置」页，在「图像 API」分组填入 Key 并保存。' });
            return { content: [{ type: 'text', text: '图像 API Key 未配置' }], details: {}, isError: true } as any;
          }
          emit({ type: 'status', text: `正在生成 ${params.n || req.settings.n} 张图片…` });
          try {
            const merged = mergeParams(req.settings, skillOverrides, params);
            const parsed = generateImageParams.parse(merged);
            const base64List = await generateImages(parsed);
            const saved = saveAndEmit(base64List, {
              format: parsed.output_format, prompt: parsed.prompt, size: parsed.size,
              quality: parsed.quality, model: parsed.model, kind: 'generate', emit,
              toolCallId, started, conversationId,
            });
            return {
              content: [{ type: 'text', text: `已生成 ${saved.length} 张图片：${saved.map((i) => i.url).join(', ')}` }],
              details: { images: saved.map((i) => ({ url: i.url, id: i.id, index: i.index, size: i.size, quality: i.quality })) },
            };
          } catch (err: any) {
            return toolError(err, emit, toolCallId, started);
          }
        },
      } as any,
      {
        name: 'edit_image',
        label: 'Edit Image',
        description: '编辑用户上传的图片或最近生成的图片。当用户要求修改/重绘/换风格时调用。',
        parameters: Type.Object({
          prompt: Type.String({ description: '修改要求' }),
          n: Type.Optional(Type.Number()),
          size: Type.Optional(Type.String({ enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'] })),
          quality: Type.Optional(Type.String({ enum: ['low', 'medium', 'high', 'auto'] })),
          model: Type.Optional(Type.String()),
          output_format: Type.Optional(Type.String({ enum: ['png', 'jpeg', 'webp'] })),
          use_last_image: Type.Optional(Type.Boolean({ description: 'true=用最近生成的图，false=用用户上传的图' })),
          image_index: Type.Optional(Type.Number({ description: '按会话内生成序号编辑指定图，1=最早生成的第一张；优先于 use_last_image' })),
          image_id: Type.Optional(Type.String({ description: '按图片 id 编辑指定图；优先于 image_index' })),
        }),
        async execute(toolCallId: string, params: any) {
          const started = Date.now();
          if (!isImageConfigured()) {
            emit({ type: 'error', code: 'MISSING_IMAGE_API_KEY', message: '尚未配置「图像 API」的 Key。请打开左侧「设置」页，在「图像 API」分组填入 Key 并保存。' });
            return { content: [{ type: 'text', text: '图像 API Key 未配置' }], details: {}, isError: true } as any;
          }
          emit({ type: 'status', text: '正在编辑图片…' });
          try {
            const merged = mergeParams(req.settings, skillOverrides, params);
            const parsed = editImageParams.parse(merged);
            // 选图优先级：用户拖入的 editImageId > 模型 image_id / image_index > 上传图 > 最近生成图
            // 只在本会话产物里定位，避免跨会话串图
            const sessionImages = storage.listImages(200, conversationId, false);
            let selected: { id: string; buffer: Buffer } | null = null;

            if (req.editImageId) {
              const target = sessionImages.find((i) => i.id === req.editImageId);
              if (!target) throw new ApiError('NO_SOURCE_IMAGE', '拖入的图片不在当前会话中，请重新拖入', 400);
              const found = storage.getImagePath(target.id);
              if (!found) throw new ApiError('NO_SOURCE_IMAGE', '拖入的图片文件不存在', 400);
              selected = { id: target.id, buffer: fs.readFileSync(found.filepath) };
            } else if (parsed.image_id) {
              const target = sessionImages.find((i) => i.id === parsed.image_id);
              if (!target) throw new ApiError('NO_SOURCE_IMAGE', `当前会话中找不到 id 为 ${parsed.image_id} 的图片`, 400);
              const found = storage.getImagePath(target.id);
              if (!found) throw new ApiError('NO_SOURCE_IMAGE', '来源图片文件不存在', 400);
              selected = { id: target.id, buffer: fs.readFileSync(found.filepath) };
            } else if (parsed.image_index !== undefined) {
              const ordered = sessionImages.slice().reverse(); // 按生成顺序（1=最早）
              const target = ordered[parsed.image_index - 1];
              if (!target) throw new ApiError('NO_SOURCE_IMAGE', `当前会话只有 ${ordered.length} 张可编辑图片，没有第 ${parsed.image_index} 张`, 400);
              const found = storage.getImagePath(target.id);
              if (!found) throw new ApiError('NO_SOURCE_IMAGE', '来源图片文件不存在', 400);
              selected = { id: target.id, buffer: fs.readFileSync(found.filepath) };
            }

            let lastBuffer: Buffer | null = null;
            let parentId: string | null = null;
            let useUpload = false;
            if (selected) {
              lastBuffer = selected.buffer;
              parentId = selected.id;
            } else {
              useUpload = !!sourceImageId && parsed.use_last_image !== true;
              if (useUpload) {
                parentId = sourceImageId;
              } else if (parsed.use_last_image !== false) {
                const lastImage = storage.getLastGenerated(conversationId);
                if (!lastImage) throw new ApiError('NO_SOURCE_IMAGE', '当前会话还没有可编辑的图片：请先生成一张，或上传原图', 400);
                const found = storage.getImagePath(lastImage.id);
                if (!found) throw new ApiError('NO_SOURCE_IMAGE', '来源图片文件不存在', 400);
                lastBuffer = fs.readFileSync(found.filepath);
                parentId = lastImage.id;
              }
            }
            const base64List = await editImages({
              model: parsed.model,
              prompt: parsed.prompt,
              n: parsed.n,
              size: parsed.size,
              quality: parsed.quality,
              output_format: parsed.output_format,
              attachment: useUpload ? req.attachment : null,
              lastImageBuffer: !useUpload ? lastBuffer : null,
            });
            const saved = saveAndEmit(base64List, {
              format: parsed.output_format, prompt: parsed.prompt, size: parsed.size,
              quality: parsed.quality, model: parsed.model, kind: 'edit', emit,
              toolCallId, started, conversationId, parentId,
            });
            return {
              content: [{ type: 'text', text: `已编辑 ${saved.length} 张图片：${saved.map((i) => i.url).join(', ')}` }],
              details: { images: saved.map((i) => ({ url: i.url, id: i.id, index: i.index })) },
            };
          } catch (err: any) {
            return toolError(err, emit, toolCallId, started);
          }
        },
      } as any,
    ],
  } as any);

  // 统一订阅 Pi 会话事件：文本、思考、工具调用/结果（内置工具与自定义工具全覆盖）
  const pendingTools = new Map<string, { name: string; started: number }>();
  const unsubscribe = session.subscribe((event: any) => {
    // 助手文本增量
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta;
      if (delta) emit({ type: 'text', delta });
    }
    // 助手思考增量（模型支持 reasoning 且开启 chatThinking 时才有）
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta') {
      const delta = event.assistantMessageEvent.delta;
      if (delta) emit({ type: 'thinking', delta });
    }
    // 工具开始：所有工具（含 Pi 内置 read/bash/edit/write 与自定义图像工具）
    if (event.type === 'tool_execution_start') {
      pendingTools.set(event.toolCallId, { name: event.toolName, started: Date.now() });
      emit({
        type: 'tool_call',
        id: event.toolCallId,
        name: event.toolName,
        arguments: (event.args && typeof event.args === 'object' ? event.args : {}) as Record<string, unknown>,
      });
    }
    // 工具结束：带出结果文本，前端工具卡片可展示
    if (event.type === 'tool_execution_end') {
      const meta = pendingTools.get(event.toolCallId);
      pendingTools.delete(event.toolCallId);
      const duration = typeof event.durationMs === 'number'
        ? event.durationMs
        : meta ? Date.now() - meta.started : 0;
      emit({
        type: 'tool_result',
        id: event.toolCallId,
        status: event.isError ? 'error' : 'ok',
        duration,
        result: summarizeToolResult(event.result),
      });
    }
  });

  emit({ type: 'status', text: '模型推理中…' });
  try {
    // 仅在模型声明支持 vision 时，把本次上传或会话内最近上传图作为视觉内容一并发送
    const images = visionImage
      ? [{ type: 'image' as const, data: visionImage.data, mimeType: visionImage.mimeType }]
      : undefined;
    await session.prompt(message, { images });
  } catch (err: any) {
    const apiErr = err instanceof ApiError ? err : normalizeError(err);
    emit({ type: 'error', code: apiErr.code, message: apiErr.message });
  } finally {
    unsubscribe();
    session.dispose();
  }
}

/**
 * 把工具返回值压缩为可展示的纯文本，供前端工具卡片显示。
 * 只取 text 内容块与轻量 details；跳过 base64 图片数据，避免 SSE 暴涨。
 */
function summarizeToolResult(result: any): string {
  if (result == null) return '';
  if (typeof result === 'string') return result.slice(0, 2000);
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (typeof block === 'string') parts.push(block);
  }
  const details = result.details;
  if (details && typeof details === 'object') {
    // 自定义图像工具的 details.images 里是 url/id，保留摘要；丢弃任何 data/base64 字段
    if (Array.isArray(details.images)) {
      parts.push(`images: ${details.images.map((i: any) => i.id || i.url || '?').join(', ')}`);
    } else {
      for (const [k, v] of Object.entries(details)) {
        if (/data|base64|buffer/i.test(k)) continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}: ${v}`);
      }
    }
  }
  if (!parts.length && typeof result === 'object') {
    try { parts.push(JSON.stringify(result).slice(0, 500)); } catch { /* ignore */ }
  }
  return parts.join('\n').slice(0, 2000);
}

/** 工具异常：发 error 事件，返回给模型错误文本继续对话（tool_result 由统一订阅发出） */
function toolError(err: any, emit: Emit, toolCallId: string, started: number) {
  const apiErr = err?.code
    ? err
    : err instanceof z.ZodError
      ? new ApiError('INVALID_TOOL_ARGS', `工具参数校验失败：${err.errors.map((e) => e.message).join('; ')}`, 400)
      : normalizeError(err);
  emit({ type: 'error', code: apiErr.code, message: apiErr.message });
  return {
    content: [{ type: 'text', text: `工具执行失败：${apiErr.message}` }],
    details: { error: apiErr.message },
    isError: true,
  };
}

/** 自定义 baseURL 时写临时 models.json（OpenAI 兼容端点） */
function writeTempModelsConfig(baseUrl: string, chatModel: string, supportsVision: boolean): string {
  const dir = path.join(os.tmpdir(), 'image-workbench-pi');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'models.json');
  const cfg = {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      openai: {
        baseUrl,
        api: 'openai-completions',
        models: [
          { id: chatModel, input: supportsVision ? ['text', 'image'] : ['text'] },
        ],
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}
