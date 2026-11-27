/**
 * Pi SDK 按需加载 + 后台预热。
 *
 * pi-coding-agent 的 barrel 入口会连带加载 TUI 渲染、全 provider catalog、
 * 扩展加载器等本服务根本用不到的模块，首次 import 约 5 秒。
 * 让 HTTP 服务先监听、Pi 在后台并行初始化；首个请求若预热未完成，
 * 也只需 await 同一个 Promise，不会重复加载。
 */
import type * as PiSdk from '@earendil-works/pi-coding-agent';

let loading: Promise<typeof PiSdk> | null = null;

export function loadPi(): Promise<typeof PiSdk> {
  if (!loading) {
    loading = import('@earendil-works/pi-coding-agent').catch((err) => {
      loading = null; // 冷启动失败不钉死进程，下次请求可重试
      throw err;
    });
  }
  return loading;
}

/** 启动后调用：触发后台预热，不阻塞监听 */
export function warmupPi(): void {
  void loadPi().catch(() => {}); // 错误留给实际请求时抛出，避免未处理拒绝
}
