import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTextProvider } from '../src/claude-text-provider.js';

test('Claude uses Messages API and returns text without exposing credentials', async () => {
  const provider = new ClaudeTextProvider({ apiKey: 'test-secret', endpoint: 'https://api.anthropic.com/v1/', fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], 'test-secret');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body).messages, [{ role: 'user', content: 'Check' }]);
    assert.equal(JSON.parse(options.body).max_tokens, 16);
    return Response.json({ model: 'reported-model', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 8, output_tokens: 1 }, stop_reason: 'end_turn' });
  } });
  const result = await provider.generate({ prompt: 'Check', maxTokens: 16 });
  assert.equal(result.text, 'OK');
  assert.equal(result.model, 'reported-model');
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 1 });
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});

test('Claude auth failure is sanitized and never automatically retried', async () => {
  let calls = 0;
  const provider = new ClaudeTextProvider({ apiKey: 'test-secret', fetchImpl: async () => {
    calls++;
    return new Response('sensitive provider diagnostic test-secret', { status: 401 });
  } });
  await assert.rejects(provider.generate({ prompt: 'Check' }), error => error.code === 'CLAUDE_REQUEST_FAILED' && error.status === 401 && !error.message.includes('test-secret'));
  assert.equal(calls, 1);
});

test('Claude rejects invalid input and insecure endpoints before sending credentials', async () => {
  let calls = 0;
  const provider = new ClaudeTextProvider({ apiKey: 'test-secret', endpoint: 'http://example.com', fetchImpl: async () => { calls++; } });
  await assert.rejects(provider.generate({ prompt: '' }), { code: 'CLAUDE_INVALID_INPUT' });
  await assert.rejects(provider.generate({ prompt: 'Check' }), { code: 'CLAUDE_INVALID_ENDPOINT' });
  assert.equal(calls, 0);
});

test('Claude timeout and empty responses cannot be mistaken for a successful generation', async () => {
  const timedOut = new ClaudeTextProvider({ apiKey: 'test-secret', timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('internal'), { name: 'AbortError' })), { once: true })) });
  await assert.rejects(timedOut.generate({ prompt: 'Check' }), { code: 'CLAUDE_TIMEOUT' });
  const empty = new ClaudeTextProvider({ apiKey: 'test-secret', fetchImpl: async () => Response.json({ content: [] }) });
  await assert.rejects(empty.generate({ prompt: 'Check' }), { code: 'CLAUDE_INVALID_RESPONSE' });
});
