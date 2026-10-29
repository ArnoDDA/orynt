import { fileURLToPath } from 'node:url';
import { ClaudeTextProvider } from '../apps/api/src/claude-text-provider.js';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env.claude', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(JSON.stringify({ ok: false, code: 'CLAUDE_CONFIG_ERROR', message: '无法加载本地 Claude 配置。' }));
    process.exit(1);
  }
}

const provider = new ClaudeTextProvider();
try {
  if (!provider.available) throw Object.assign(new Error('Claude 接口尚未配置。'), { code: 'CLAUDE_NOT_CONFIGURED' });
  if (process.argv.includes('--live')) {
    const result = await provider.generate({ prompt: 'Reply with exactly OK.', maxTokens: 16 });
    if (result.text !== 'OK') throw Object.assign(new Error('接口返回了文本，但未通过最小响应检查。'), { code: 'CLAUDE_CHECK_FAILED' });
    console.log(JSON.stringify({ ok: true, mode: 'live', model: result.model, usage: result.usage }));
  } else {
    console.log(JSON.stringify({ ok: true, mode: 'configuration_only', model: provider.model, message: '配置已加载，尚未发送请求；使用 --live 做连通性测试。' }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'CLAUDE_CHECK_FAILED', ...(error.status ? { status: error.status } : {}), message: error.code?.startsWith('CLAUDE_') ? error.message : 'Claude 测试未完成。' }));
  process.exitCode = 1;
}
