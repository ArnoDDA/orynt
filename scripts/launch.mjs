import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { DemoLibrary } from '../apps/api/src/demo-library.js';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
let distribution;
try { distribution = JSON.parse(await readFile(new URL('../distribution.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (distribution) {
  const demo = await new DemoLibrary().load();
  if (!demo.view.integrity || demo.view.technical.status !== 'passed' || !(demo.view.media.finalVideo || demo.view.reviewMedia?.finalVideo)) {
    throw new Error('体验素材校验失败，请重新完整解压原始压缩包。');
  }
  console.log('Orynt.ai · 本地体验版\n固定演示使用真实结果回放；投放与回收数据为模拟。');
}
const { createApplication } = await import('../apps/api/src/server.js');
const application = createApplication();
const firstPort = Number(process.env.PORT || 4173);
if (!Number.isInteger(firstPort) || firstPort < 0 || firstPort > 65535) {
  await application.close();
  throw new Error('PORT 必须是 0–65535 之间的整数。');
}
let port = firstPort;
application.server.on('error', error => {
  if (error.code === 'EADDRINUSE' && !process.env.PORT && port < firstPort + 20) {
    application.server.listen(++port, '127.0.0.1');
    return;
  }
  console.error(`启动失败：${error.code || error.message}`);
  application.repository.close();
  process.exit(1);
});
application.server.on('listening', () => {
  const url = `http://127.0.0.1:${application.server.address().port}/#/home`;
  console.log(`\n打开体验：${url}\n点击首页「体验完整流程」开始。\n请保留此窗口；关闭窗口或按 Ctrl-C 将停止服务。\n`);
  if (process.env.ORYNT_NO_OPEN === '1') return;
  const command = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('请手动在浏览器打开以上地址。'));
  child.unref();
});
application.server.listen(port, '127.0.0.1');
const stop = () => application.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
