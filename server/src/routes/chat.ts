import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAgent } from '../agent/pi-agent.js';
import { loadSkills } from '../skills/loader.js';
import { isChatConfigured } from '../config.js';
import { storage, isValidConversationId } from '../services/storage.js';
import { startTask, endTask, recordTaskEvent } from '../services/task-registry.js';
import type { SseEvent } from '../types.js';

const bodySchema = z.object({
  conversationId: z.string().min(1).regex(/^[A-Za-z0-9_-]{1,64}$/, '会话 ID 格式非法'),
  message: z.string().default(''),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).default([]),
  systemPrompt: z.string().optional(),
  attachment: z.object({
    name: z.string(),
    mimeType: z.string().default('image/png'),
    data: z.string().min(1),
  }).nullable().optional(),
  skill: z.string().nullable().optional(),
  /** 拖入的会话内产物图 id，作为编辑来源（不重新落盘上传图） */
  editImageId: z.string().optional().nullable(),
  settings: z.object({
    model: z.string(),
    size: z.string(),
    quality: z.string(),
    n: z.number().int().min(1).max(10),
    output_format: z.string(),
    output_compression: z.number(),
    background: z.string(),
    moderation: z.string(),
  }),
});

export async function chatRoutes(app: FastifyInstance) {
  // SSE 对话
  app.post('/api/chat', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error.message });
    }

    const conversationId = parsed.data.conversationId;
    if (!isValidConversationId(conversationId)) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: '会话 ID 格式非法' });
    }
    // 会话落库（首次自动创建标题）；即使后续调用失败，会话本身也保留
    storage.ensureConversation(conversationId, parsed.data.message);

    // 附件大小记日志：粘贴大图导致失败时能在控制台一眼看到量级
    if (parsed.data.attachment) {
      request.log.info(
        { conversationId, attachmentBytes: parsed.data.attachment.data.length, name: parsed.data.attachment.name },
        'chat 请求携带附件',
      );
    }

    // 上传原图先落盘到会话 sources/ 目录，拿到 id 后写入消息，历史里即可还原图片
    let sourceImageId: string | null = null;
    if (parsed.data.attachment) {
      const savedSource = storage.saveSourceImage({
        base64: parsed.data.attachment.data,
        name: parsed.data.attachment.name,
        mimeType: parsed.data.attachment.mimeType,
        conversationId,
      });
      sourceImageId = savedSource.id;
    }
    storage.saveMessage({
      conversationId,
      role: 'user',
      content: parsed.data.message,
      skill: parsed.data.skill || undefined,
      attachmentName: parsed.data.attachment?.name || (parsed.data.editImageId ? '引用的产物图' : undefined),
      // 产物引用直接复用已有图片 id，历史刷新时同样能还原缩略图
      attachmentImageId: sourceImageId ?? parsed.data.editImageId ?? undefined,
    });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // SSE 转发同时记录助手回复与本轮产出，供切换会话时原样恢复
    let assistantText = '';
    const imageIds: string[] = [];
    const errors: string[] = [];
    const emit = (event: SseEvent) => {
      if (event.type === 'text') assistantText += event.delta;
      if (event.type === 'image') imageIds.push(event.image.id);
      if (event.type === 'error') errors.push(`错误 [${event.code}]：${event.message}`);
      // 缓存事件供前端刷新后回放；必须在 startTask 之后、endTask 清理之前
      recordTaskEvent(conversationId, event);
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // 先注册任务再发第一条事件，确保刷新回放能拿到完整事件序列（含"请求已接收"）
    // 同会话已有任务在跑时明确拒绝，不让两条 SSE 流写同一份事件缓存、互相覆盖结束标记
    if (!startTask(conversationId)) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', code: 'TASK_ALREADY_RUNNING', message: '当前会话有任务进行中，请等它完成后再发送。' })}\n\n`);
      reply.raw.end();
      return;
    }
    emit({ type: 'status', text: '请求已接收' });
    try {
      if (!isChatConfigured()) {
        emit({ type: 'error', code: 'MISSING_CHAT_API_KEY', message: '尚未配置「对话 API」的 Key。请打开左侧「设置」页，在「对话 API」分组填入 Key 并保存。' });
      } else {
        const skills = loadSkills();
        await runAgent({ ...parsed.data, sourceImageId } as any, skills, emit);
      }
      const replyText = assistantText.trim() || errors[0] || '';
      if (replyText) {
        storage.saveMessage({ conversationId, role: 'assistant', content: replyText, imageIds });
      }
    } catch (err: any) {
      const code = err?.code || 'INTERNAL_ERROR';
      const message = err?.message || '服务内部错误';
      emit({ type: 'error', code, message });
      storage.saveMessage({
        conversationId,
        role: 'assistant',
        content: `错误 [${code}]：${message}`,
        imageIds,
      });
    } finally {
      // done 事件也要进缓存，回放端据此结束并重载落库后的最终消息
      emit({ type: 'done', conversationId });
      endTask(conversationId); // 任何异常路径都会清除运行标记，杜绝图标滞留
      reply.raw.end();
    }
  });
}
