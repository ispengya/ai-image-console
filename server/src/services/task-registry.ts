/**
 * Agent 任务注册表（进程内存态）。
 * - 刷新后前端可从 /api/tasks 恢复"哪些会话还在后台跑"。
 * - 同时缓存本轮 SSE 事件序列（带序号），刷新后经 /api/tasks/:id/events 回放，
 *   让正在运行的任务在前端重新连上后能续上 thinking / 工具 / 文本 / 图片内容。
 */
import type { SseEvent } from '../types.js';

interface TaskState {
  conversationId: string;
  startedAt: number;
  events: Array<{ seq: number; event: SseEvent }>;
  done: boolean;
}

const tasks = new Map<string, TaskState>();
/** 任务结束后保留事件缓存的时间，供刷新后回放；超时清理避免内存无限增长 */
const KEEP_MS = 10 * 60 * 1000;

/** 同一会话只允许一个运行中的任务（多标签页/直调 API 会撞车）；成功注册返回 true */
export function startTask(conversationId: string): boolean {
  const existing = tasks.get(conversationId);
  if (existing && !existing.done) return false;
  tasks.set(conversationId, { conversationId, startedAt: Date.now(), events: [], done: false });
  return true;
}

/** 记录一条 SSE 事件（chat.ts 的 emit 统一调用） */
export function recordTaskEvent(conversationId: string, event: SseEvent): void {
  const t = tasks.get(conversationId);
  if (!t) return;
  t.events.push({ seq: t.events.length + 1, event });
}

export function endTask(conversationId: string): void {
  const t = tasks.get(conversationId);
  if (!t) return;
  t.done = true;
  // 延迟清理：刷新页面后短时间内仍能拿到完整事件；期间 listRunningTasks 已不再暴露它
  setTimeout(() => {
    if (tasks.get(conversationId) === t) tasks.delete(conversationId);
  }, KEEP_MS).unref?.();
}

export interface RunningTask { conversationId: string; startedAt: number }

export function listRunningTasks(): RunningTask[] {
  return Array.from(tasks.values())
    .filter((t) => !t.done)
    .map((t) => ({ conversationId: t.conversationId, startedAt: t.startedAt }));
}

/** 回放：返回 afterSeq 之后的事件、当前是否已结束、最新序号 */
export function getTaskEvents(conversationId: string, afterSeq: number): {
  events: Array<{ seq: number; event: SseEvent }>;
  done: boolean;
  latestSeq: number;
} | null {
  const t = tasks.get(conversationId);
  if (!t) return null;
  return {
    events: t.events.filter((e) => e.seq > afterSeq),
    done: t.done,
    latestSeq: t.events.length ? t.events[t.events.length - 1].seq : 0,
  };
}
