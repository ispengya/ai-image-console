/**
 * 运行中的 Agent 任务注册表（内存态）。
 * 前端刷新后可从 /api/tasks 恢复"哪些会话还在后台跑"，侧栏据此继续显示运行状态。
 */
interface RunningTask {
  conversationId: string;
  startedAt: number;
}

const running = new Map<string, RunningTask>();

export function startTask(conversationId: string): void {
  running.set(conversationId, { conversationId, startedAt: Date.now() });
}

export function endTask(conversationId: string): void {
  running.delete(conversationId);
}

export function listRunningTasks(): RunningTask[] {
  return Array.from(running.values());
}
