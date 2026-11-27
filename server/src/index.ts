import { config } from './config.js';
import { buildApp } from './app.js';
import { loadSkills } from './skills/loader.js';

const app = await buildApp();

// 进程级兜底：本地工具宁可记日志也不能静默崩掉——进程一死，
// 前端所有在途请求只会显示 Failed to fetch，完全无法定位
process.on('unhandledRejection', (reason) => {
  app.log.error(reason, 'unhandledRejection（未处理的 Promise 拒绝）');
});
process.on('uncaughtException', (err) => {
  app.log.error(err, 'uncaughtException（未捕获异常）');
});

const skills = loadSkills();
app.log.info(`已加载 ${skills.length} 个 skill`);
app.log.info(`对话 API: ${config.chatBaseUrl} · 模型 ${config.chatModel}`);
app.log.info(`图像 API: ${config.imageBaseUrl} · 模型 ${config.imageModel}`);

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const url = config.publicBaseUrl || `http://127.0.0.1:${config.port}`;
  app.log.info(`\n  图像工作台已启动 →  ${url}\n`);
  openBrowser(url);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

/** 启动后用系统默认浏览器打开地址；BROWSER=none 可关闭，失败不影响服务 */
function openBrowser(url: string) {
  if (config.browser.toLowerCase() === 'none') return;
  import('node:child_process').then(({ exec }) => {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, (err) => {
      if (err) app.log.warn(`自动打开浏览器失败，请手动访问：${url}`);
    });
  }).catch(() => {});
}
