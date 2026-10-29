const failure = (code, message, status) => Object.assign(new Error(message), { code, ...(status ? { status } : {}) });

// Server-side only. Never return credentials, raw provider errors or request bodies.
export class ClaudeTextProvider {
  constructor({ apiKey = process.env.CLAUDE_API_KEY, endpoint = process.env.CLAUDE_API_BASE_URL || 'https://api.anthropic.com', model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929', fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    Object.assign(this, { apiKey, endpoint: endpoint.replace(/\/$/, ''), model, fetch: fetchImpl, timeoutMs });
  }

  get available() { return Boolean(this.apiKey && this.model && this.fetch); }

  async generate({ prompt, system, maxTokens = 1024 }) {
    if (!this.available) throw failure('CLAUDE_NOT_CONFIGURED', 'Claude 接口尚未配置。');
    if (typeof prompt !== 'string' || !prompt.trim() || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      throw failure('CLAUDE_INVALID_INPUT', 'Claude 输入或输出长度无效。');
    }
    let url;
    try {
      url = new URL(`${this.endpoint.endsWith('/v1') ? this.endpoint : `${this.endpoint}/v1`}/messages`);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { throw failure('CLAUDE_INVALID_ENDPOINT', 'Claude 接口地址必须是有效的 HTTPS 地址。'); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...(system ? { system } : {}) })
      });
      if (!response.ok) {
        await response.body?.cancel();
        const messages = { 401: 'Claude 接口拒绝了密钥（HTTP 401）。', 403: 'Claude 接口拒绝访问（HTTP 403）。', 404: 'Claude 模型或接口不存在（HTTP 404）。', 429: 'Claude 接口额度不足或请求受限（HTTP 429）。' };
        throw failure('CLAUDE_REQUEST_FAILED', messages[response.status] || `Claude 请求失败（HTTP ${response.status}）。`, response.status);
      }
      let data;
      try { data = await response.json(); } catch { throw failure('CLAUDE_INVALID_RESPONSE', 'Claude 返回了无效响应。'); }
      const text = (Array.isArray(data.content) ? data.content : []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
      if (!text) throw failure('CLAUDE_INVALID_RESPONSE', 'Claude 未返回文本内容。');
      return { text, model: data.model || this.model, stopReason: data.stop_reason, usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens } };
    } catch (error) {
      if (error.name === 'AbortError') throw failure('CLAUDE_TIMEOUT', 'Claude 请求超时。');
      if (error.code?.startsWith('CLAUDE_')) throw error;
      throw failure('CLAUDE_CONNECTION_FAILED', '无法连接 Claude 接口。');
    } finally { clearTimeout(timer); }
  }
}
