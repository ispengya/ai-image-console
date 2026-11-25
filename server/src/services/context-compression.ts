/**
 * 上下文压缩服务
 * 会话消息越来越长时，把较早的消息交给对话模型摘要成一段结构化文字，
 * 与最近若干条原文一起注入 Pi Agent，避免每轮把整段历史硬塞进 System Prompt。
 * 摘要写入 SQLite 按会话持久化，刷新页面 / 重建 Pi session 后依然有效。
 */
import OpenAI from 'openai';
import { config, isChatConfigured } from '../config.js';
import { storage } from '../services/storage.js';
import type { SseEvent } from '../types.js';

type Emit = (event: SseEvent) => void;
type Msg = { role: 'user' | 'assistant'; content: string };

export interface ContextBundle {
  /** 已折叠历史的摘要；无压缩时为 '' */
  summary: string;
  /** 未折叠、原样注入的最近消息 */
  recent: Msg[];
  /** 本轮折叠进摘要的消息条数 */
  folded: number;
  /** 压缩前/后注入文本字符数（供前端提示） */
  beforeChars: number;
  afterChars: number;
}

const SUMMARY_SYSTEM = `你是上下文压缩器。把一段图片生成对话的旧消息压缩成中文摘要，供后续 Agent 继续对话时参考。
要求：
- 用简洁的分条文字，不要寒暄，不要解释你在做什么，只输出摘要本身。
- 必须保留：用户想生成的画面目标、风格/配色/构图/尺寸等偏好、已经确认或否定的方案、提到的图片编号与对应关系、尚未完成的要求。
- 用户明确的约束（例如「不要文字」「透明背景」）原意保留。
- 控制在 800 字以内；宁可少写，不要编造原文没有的信息。`;

function charCount(msgs: Msg[]): number {
  return msgs.reduce((n, m) => n + (m.content || '').length, 0);
}

/** 单条消息渲染成摘要输入的一行 */
function line(m: Msg): string {
  const who = m.role === 'user' ? '用户' : '助手';
  const text = (m.content || '').replace(/\s+/g, ' ').trim();
  return `${who}：${text}`;
}

/**
 * 准备上下文：返回「历史摘要 + 最近原文」。
 * 触发条件：待折叠队列长度超过 (threshold - keepRecent)，或字符数超过 maxChars。
 * 这样每轮只增量折叠一次，不会每条新消息都调用模型。
 */
export async function prepareContext(
  conversationId: string,
  currentMessage: string,
  emit: Emit,
): Promise<ContextBundle> {
  let all = storage.listAllMessages(conversationId);
  // chat.ts 已把本轮用户消息落库；它还会作为 prompt 单独下发，不能重复注入历史
  const last = all[all.length - 1];
  if (last && last.role === 'user' && last.content === currentMessage) all = all.slice(0, -1);

  const recentLimit = Math.max(10, config.contextKeepRecent);
  const tail = all;
  const empty: ContextBundle = {
    summary: '', recent: tail.slice(-recentLimit), folded: 0,
    beforeChars: charCount(tail.slice(-recentLimit)), afterChars: charCount(tail.slice(-recentLimit)),
  };
  if (!config.contextCompression || !isChatConfigured() || tail.length === 0) return empty;

  const stored = storage.getSummary(conversationId);
  const covered = stored?.coveredCount ?? 0;
  const uncovered = tail.slice(covered);
  const keep = Math.max(2, config.contextKeepRecent);
  const batch = Math.max(2, config.contextThreshold - keep);
  const uncoveredChars = charCount(uncovered);
  const shouldFold = uncovered.length > keep + batch || uncoveredChars > config.contextMaxChars;

  if (!shouldFold || uncovered.length <= keep) {
    const recent = tail.slice(covered).slice(-recentLimit);
    return {
      summary: stored?.summary ?? '',
      recent,
      folded: 0,
      beforeChars: charCount(tail.slice(-recentLimit)),
      afterChars: charCount(recent) + (stored?.summary?.length ?? 0),
    };
  }

  // 折叠除最近 keep 条外的未摘要消息；旧摘要一起送模型做增量合并
  const foldCount = uncovered.length - keep;
  const toFold = uncovered.slice(0, foldCount);
  const beforeChars = charCount(tail);
  emit({ type: 'status', text: `正在压缩历史上下文（${toFold.length} 条）…` });

  try {
    const client = new OpenAI({ apiKey: config.chatApiKey, baseURL: config.chatBaseUrl, timeout: 60_000 });
    const prior = stored?.summary
      ? `此前累积的摘要（请在其基础上合并新消息，不要丢弃仍有效的结论）：\n${stored.summary}\n\n`
      : '';
    const userContent = `${prior}以下是新增的对话消息，请一并压缩：\n${toFold.map(line).join('\n')}`;
    const res: any = await client.chat.completions.create({
      model: config.chatModel,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      max_tokens: 1200,
    });
    const summary = String(res?.choices?.[0]?.message?.content ?? '').trim();
    if (!summary) throw new Error('对话模型返回了空摘要');

    const newCovered = covered + foldCount;
    storage.saveSummary(conversationId, summary, newCovered);
    const recent = tail.slice(newCovered).slice(-recentLimit);
    const afterChars = summary.length + charCount(recent);
    emit({
      type: 'context_compressed',
      folded: foldCount,
      covered: newCovered,
      beforeChars,
      afterChars,
      summaryChars: summary.length,
    });
    return { summary, recent, folded: foldCount, beforeChars, afterChars };
  } catch (err: any) {
    // 压缩失败不阻塞出图：保留原文继续，并明确告知用户（不降级为 mock）
    const message = err?.message || String(err);
    emit({ type: 'status', text: `上下文压缩失败，已保留原文继续：${message}` });
    const recent = tail.slice(covered).slice(-recentLimit);
    return {
      summary: stored?.summary ?? '',
      recent,
      folded: 0,
      beforeChars,
      afterChars: charCount(recent) + (stored?.summary?.length ?? 0),
    };
  }
}
