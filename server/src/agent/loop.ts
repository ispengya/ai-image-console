/**
 * @deprecated 已被 pi-agent.ts 取代。原自研 function calling 循环，保留作参考实现，不参与运行。
 * 路由 routes/chat.ts 现导入 agent/pi-agent.js。
 */
import fs from 'node:fs';
import { z } from 'zod';
import { config } from '../config.js';
import { toolDefinitions, generateImageParams, editImageParams } from './schemas.js';
import { storage } from '../services/storage.js';
import { generateImages, editImages, normalizeError, ApiError } from '../services/openai.js';
import { findSkill } from '../skills/loader.js';
import type { ChatRequest, SseEvent, SkillPreset, GeneratedImage } from '../types.js';

type Emit = (event: SseEvent) => void;

type LlmMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
};

function buildSystemPrompt(req: ChatRequest, skills: SkillPreset[]): string {
  const s = req.settings;
  const skillLines = skills
    .filter((x) => x.enabled)
    .map((x) => `- /${x.name}：${x.description}${Object.keys(x.overrides).length ? `（预设 ${JSON.stringify(x.overrides)}）` : ''}`)
    .join('\n');
  return `你是图像工作台的图片生成 Agent。根据用户意图调用工具：
- generate_image：用户要求生成、画一张、出图时调用。
- edit_image：用户要求修改、重绘、换风格，或上传了图片并要求处理时调用。上传图片优先于最近生成的图（use_last_image=false）。

用户安装的画图 skill（提示词模板 + 参数预设）：
${skillLines || '- （无）'}

当前生成设置默认值（工具参数未指定时按此填写）：
model=${s.model}, size=${s.size}, quality=${s.quality}, n=${s.n}, output_format=${s.output_format}, background=${s.background}

用户明确说「横版/竖版」「透明背景」「来 N 张」「高质量/快速」时覆盖对应默认值。
回复保持简洁，中文回答。生成完图片后简短说明即可，不要重复输出参数。`;
}

/** 处理 /skill 指令：展开模板并返回参数预设 */
function expandSkill(req: ChatRequest, skills: SkillPreset[]): { message: string; overrides: Record<string, unknown> } {
  if (!req.skill) return { message: req.message, overrides: {} };
  const skill = findSkill(req.skill, skills);
  if (!skill) throw new ApiError('SKILL_NOT_FOUND', `未找到 skill「/${req.skill}」或其已停用`, 400);
  let args = req.message.trim();
  const prefix = new RegExp(`^/${req.skill}\\s*`);
  args = args.replace(prefix, '').trim();
  const expanded = skill.template.replace('{input}', args || skill.label);
  return { message: expanded, overrides: skill.overrides };
}

function defined(obj: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/** 参数合并优先级：设置默认值 < skill 预设 < LLM 显式参数 */
function mergeParams(settings: ChatRequest['settings'], skillOverrides: Record<string, unknown>, args: Record<string, unknown>) {
  return {
    ...settings,
    ...defined(skillOverrides),
    ...defined(args),
  };
}

export async function runAgent(req: ChatRequest, skills: SkillPreset[], emit: Emit): Promise<void> {
  const conversationId = crypto.randomUUID();
  const { message, overrides: skillOverrides } = expandSkill(req, skills);

  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(req, skills) },
    ...req.history.map((h) => ({ role: h.role, content: h.content }) as LlmMessage),
    { role: 'user', content: message },
  ];

  const maxRounds = 5;
  let toolCallIndex = 0;

  for (let round = 0; round < maxRounds; round++) {
    emit({ type: 'status', text: round === 0 ? '模型推理中…' : '继续推理…' });

    const completion: any = await openaiChat(messages);
    const choice = completion.choices?.[0];
    if (!choice) throw new ApiError('EMPTY_RESULT', '模型未返回任何结果', 500);
    const assistantMessage = choice.message;

    // 文本回复：分片推送
    if (assistantMessage?.content) {
      const text = assistantMessage.content as string;
      for (let i = 0; i < text.length; i += 24) {
        emit({ type: 'text', delta: text.slice(i, i + 24) });
      }
    }

    const toolCalls: any[] = assistantMessage?.tool_calls ?? [];
    if (!toolCalls.length) {
      emit({ type: 'done', conversationId });
      return;
    }

    messages.push({
      role: 'assistant',
      content: assistantMessage.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const id = call.id || `call_${++toolCallIndex}`;
      const name = call.function?.name as string;
      let rawArgs: Record<string, unknown> = {};
      try {
        rawArgs = JSON.parse(call.function?.arguments || '{}');
      } catch {
        rawArgs = {};
      }
      emit({ type: 'tool_call', id, name, arguments: rawArgs });

      const started = Date.now();
      try {
        const merged = mergeParams(req.settings, skillOverrides, rawArgs);
        const images: GeneratedImage[] = [];

        if (name === 'generate_image') {
          const params = generateImageParams.parse(merged);
          emit({ type: 'status', text: `正在生成 ${params.n} 张图片…` });
          const base64List = await generateImages(params);
          for (let i = 0; i < base64List.length; i++) {
            images.push(storage.saveImage({
              base64: base64List[i],
              format: params.output_format,
              prompt: params.prompt,
              size: params.size,
              quality: params.quality,
              model: params.model,
              kind: 'generate',
              conversationId: (req as any).conversationId || 'legacy',
            }));
          }
        } else if (name === 'edit_image') {
          const params = editImageParams.parse(merged);
          emit({ type: 'status', text: '正在编辑图片…' });
          let lastBuffer = null;
          if (params.use_last_image) {
            const list = storage.listImages(1);
            if (list.length) {
              const found = storage.getImagePath(list[0].id);
              if (found) lastBuffer = fs.readFileSync(found.filepath);
            }
          }
          const base64List = await editImages({
            model: params.model,
            prompt: params.prompt,
            n: params.n,
            size: params.size,
            quality: params.quality,
            output_format: params.output_format,
            attachment: params.use_last_image ? null : req.attachment ?? null,
            lastImageBuffer: lastBuffer,
          });
          for (let i = 0; i < base64List.length; i++) {
            images.push(storage.saveImage({
              base64: base64List[i],
              format: params.output_format,
              prompt: params.prompt,
              size: params.size,
              quality: params.quality,
              model: params.model,
              kind: 'edit',
              conversationId: (req as any).conversationId || 'legacy',
            }));
          }
        } else {
          throw new ApiError('UNKNOWN_TOOL', `未知工具：${name}`, 400);
        }

        for (const image of images) emit({ type: 'image', image });
        emit({ type: 'tool_result', id, status: 'ok', duration: Date.now() - started });

        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify({
            ok: true,
            images: images.map((i) => ({ url: i.url, id: i.id, size: i.size, quality: i.quality })),
          }),
        });
      } catch (err: any) {
        const apiErr = err instanceof z.ZodError
          ? new ApiError('INVALID_TOOL_ARGS', `工具参数校验失败：${err.errors.map((e) => e.message).join('; ')}`, 400)
          : err instanceof ApiError ? err : normalizeError(err);
        emit({ type: 'tool_result', id, status: 'error', duration: Date.now() - started });
        emit({ type: 'error', code: apiErr.code, message: apiErr.message });
        messages.push({
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify({ ok: false, error: apiErr.message }),
        });
      }
    }
  }

  emit({ type: 'error', code: 'MAX_ROUNDS', message: 'Agent 达到最大推理轮数，请简化请求后重试' });
  emit({ type: 'done', conversationId });
}

async function openaiChat(messages: LlmMessage[]): Promise<any> {
  const { getOpenAI, normalizeError: norm } = await import('../services/openai.js');
  try {
    return await getOpenAI().chat.completions.create({
      model: config.chatModel,
      messages: messages as any,
      tools: toolDefinitions as any,
      tool_choice: 'auto',
    });
  } catch (err: any) {
    throw norm(err);
  }
}
