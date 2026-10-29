import test from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../src/core.js';
import { Repository } from '../src/repository.js';
import { LocalJobRunner } from '../src/job-runner.js';
import { YouMindVideoProvider, extractVideoResultForTest } from '../src/youmind-video-provider.js';
import { buildVideoPrompt } from '../src/video-prompt.js';

function setup(videoProvider) {
  const repository = new Repository(':memory:');
  const core = new Core(repository);
  let n = 0;
  const command = (action, resourceId, data = {}) => core.command(action, resourceId, data, `video-test-${++n}`);
  const campaign = command('campaign.create', null, { brandUrl: 'https://example.com', name: '视频生成测试', objective: '验证视频链路', product: '测试产品', audience: '测试受众' });
  const brandId = core.state().campaigns.find(item => item.id === campaign.campaignId).brandId;
  const brandAsset = command('brandAsset.add', brandId, {
    name: 'Test Logo.svg', mime: 'image/svg+xml', type: 'logo',
    promptHint: '深绿色几何标志，珊瑚红圆形点缀',
    base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#163f36"/></svg>').toString('base64')
  });
  command('snapshot.confirm', campaign.campaignId, { product: '测试产品', claim: '让测试更简单', audience: '测试受众', limitations: '不作未经证实的效果承诺' });
  command('discovery.start', campaign.campaignId);
  core.tick(); core.tick(); core.tick({ discovery: { provider: 'test', coverage: { fetchedPages: 1 }, sources: [{ sourceType: 'brand_website', sourceUrl: 'https://example.com', status: 'available' }], evidence: [{ sourceType: 'brand_website', sourceUrl: 'https://example.com', title: '产品信息', contentSummary: '测试产品可帮助测试受众完成任务', contentHash: 'video-test' }] } });
  command('cards.generate', campaign.campaignId); core.tick(); core.tick(); core.tick();
  const card = core.state().cards[0];
  const adopted = command('card.adopt', card.id);
  const config = command('config.create', adopted.packageId, { angleId: adopted.angleIds[0], ratio: '9:16', duration: 15, language: '中文', notes: '保持画面简洁', brandAssetIds: [brandAsset.assetId] });
  const generation = command('generation.start', config.configId, { mode: 'video', angleId: adopted.angleIds[0] });
  const runner = new LocalJobRunner({ core, repository, crawler: null, metaCrawler: null, videoProvider });
  return { repository, core, runner, generation };
}

test('video runner submits once, resumes provider polling, and publishes a local YouMind asset', async () => {
  let polls = 0, creates = 0;
  const bytes = Buffer.alloc(20); bytes.write('ftyp', 4, 'ascii');
  const provider = {
    available: true,
    async create({ prompt }) { creates++; assert.match(prompt, /Hook|Proof|产品主张/); assert.match(prompt, /Test Logo\.svg|深绿色几何标志/); return { chatId: 'chat-video-1', confirmationSent: true }; },
    async poll() { polls++; return polls === 1 ? { status: 'pending' } : { status: 'succeeded', mediaId: 'media-1', url: 'https://cdn.youmindassets.com/video.mp4', title: '测试视频', duration: 4 }; },
    async download() { return bytes; }
  };
  const context = setup(provider);
  try {
    for (let i = 0; i < 8; i++) await context.runner.tick();
    const state = context.core.state();
    const request = state.generationRequests.find(item => item.id === context.generation.generationRequestId);
    const asset = context.repository.read().assets.find(item => item.id === request.assetId);
    assert.equal(creates, 1);
    assert.equal(request.status, 'succeeded');
    assert.equal(request.provider, 'youmind');
    assert.equal(asset.source, 'youmind_seedance');
    assert.equal(asset.providerMediaId, 'media-1');
    assert.equal(asset.mime, 'video/mp4');
    assert.equal(asset.providerQuality, null);
    assert.equal(asset.providerRatio, null);
    assert.equal(asset.base64, bytes.toString('base64'));
    assert.equal(state.jobs.find(item => item.id === request.jobId).status, 'succeeded');
  } finally { context.repository.close(); }
});

test('provider absence fails the video job explicitly instead of creating a fake asset', async () => {
  const context = setup({ available: false });
  try {
    for (let i = 0; i < 3; i++) await context.runner.tick();
    const job = context.repository.read().jobs.find(item => item.id === context.generation.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'VIDEO_PROVIDER_UNAVAILABLE');
    assert.equal(context.repository.read().assets.filter(item => item.type === 'video').length, 0);
  } finally { context.repository.close(); }
});

test('video runner persists a later confirmation so subsequent polls do not send it again', async () => {
  let polls = 0;
  const bytes = Buffer.alloc(20); bytes.write('ftyp', 4, 'ascii');
  const context = setup({
    available: true,
    async create() { return { chatId: 'chat-later-confirm', confirmationSent: false }; },
    async poll({ confirmationSent, prompt }) {
      assert.match(prompt, /时长：约 15 秒/);
      polls++;
      assert.equal(confirmationSent, polls > 1);
      return polls === 1
        ? { status: 'pending', confirmationSent: true, stage: 'confirmation_sent' }
        : { status: 'succeeded', mediaId: 'later-media', url: 'https://cdn.youmindassets.com/later.mp4' };
    },
    async download() { return bytes; }
  });
  try {
    for (let i = 0; i < 8; i++) await context.runner.tick();
    const job = context.repository.read().jobs.find(item => item.id === context.generation.jobId);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.providerState.confirmationSent, true);
    assert.equal(polls, 2);
  } finally { context.repository.close(); }
});

test('YouMind video extraction only accepts the generated MP4 tool result', () => {
  const result = extractVideoResultForTest([{ blocks: [{ type: 'tool', toolName: 'generate_seedance_video', toolResult: { gen_media_id: 'media-1', title: 'x' }, toolOutput: { value: '<video cdn_url="https://cdn.youmindassets.com/gen-images/x.mp4"></video>' } }] }]);
  assert.deepEqual(result, { mediaId: 'media-1', url: 'https://cdn.youmindassets.com/gen-images/x.mp4', title: 'x', duration: undefined, format: undefined });
});

test('video prompt uses the selected angle, supports 30 seconds, and sends only template timing', () => {
  const job = { input: { generationRequestId: 'request-1' } };
  const state = {
    generationRequests: [{ id: 'request-1', configId: 'config-1', cardVersionId: 'version-1', angleId: 'angle-1', campaignId: 'campaign-1' }],
    configs: [{ id: 'config-1', duration: 30, ratio: '9:16', language: '中文', brandAssetIds: [], templateId: 'template-1' }],
    cardVersions: [{ id: 'version-1', content: { creativeRoute: { hook: '旧 Card Hook', proof: '旧 Card Proof', style: '旧风格' }, claim: '已确认主张', audience: '目标受众' } }],
    angles: [{ id: 'angle-1', hook: '当前角度 Hook', proof: '当前角度 Proof', visualLanguage: '当前视觉语言' }],
    videoTemplates: [{ id: 'template-1', status: 'ready', duration: 12, base64: 'must-not-appear', scenes: [{ start: 0, end: 4, keyframeBase64: 'must-not-appear' }, { start: 4, end: 12, keyframeBase64: 'must-not-appear' }] }],
    brands: [], brandAssets: [], campaigns: [{ id: 'campaign-1', brandId: 'brand-1' }]
  };
  const prompt = buildVideoPrompt(state, job);
  assert.match(prompt, /时长：约 30 秒/);
  assert.match(prompt, /不使用低画质预览/);
  assert.match(prompt, /不要自行缩短时长或降级画质/);
  assert.match(prompt, /当前角度 Hook/);
  assert.doesNotMatch(prompt, /旧 Card Hook/);
  assert.match(prompt, /镜头 1 为 0-4 秒/);
  assert.doesNotMatch(prompt, /must-not-appear/);
});

test('YouMind automatic confirmation preserves the original production instructions', async () => {
  for (const duration of [15, 30]) {
    const calls = [];
    const prompt = `画幅：16:9；时长：约 ${duration} 秒；关闭音频；Seedance 2.0。\n使用正式生成画质。`;
    const provider = new YouMindVideoProvider({
      apiKey: 'test-key',
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), body: JSON.parse(options.body) });
        return { ok: true, text: async () => JSON.stringify({ chatId: 'chat-confirm', status: 'waiting_for_answer' }) };
      }
    });
    assert.deepEqual(await provider.create({ prompt }), { chatId: 'chat-confirm', confirmationSent: true });
    assert.equal(calls.length, 2);
    assert.ok(calls[1].url.endsWith('/sendMessage'));
    assert.equal(calls[1].body.chatId, 'chat-confirm');
    assert.ok(calls[1].body.message.endsWith(prompt));
    assert.doesNotMatch(calls[1].body.message, /最短可用时长|按低画质/);
  }
});

test('YouMind submits only once when generation does not require confirmation', async () => {
  let calls = 0;
  const provider = new YouMindVideoProvider({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls++;
      return { ok: true, text: async () => JSON.stringify({ chatId: 'chat-running', status: 'running' }) };
    }
  });
  assert.deepEqual(await provider.create({ prompt: '制作要求' }), { chatId: 'chat-running', confirmationSent: false });
  assert.equal(calls, 1);
});

test('YouMind does not treat the user prompt or tool instructions as a confirmation request', async () => {
  let calls = 0;
  const provider = new YouMindVideoProvider({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls++;
      return { ok: true, text: async () => JSON.stringify({ chatId: 'chat-active', messages: [
        { role: 'user', content: 'High quality; no further credit confirmation. 请不要再次确认生成。' },
        { role: 'assistant', status: 'generating', blocks: [{ type: 'tool', toolName: 'run_skill', toolOutput: { value: 'Please confirm credits before generating.' } }] }
      ] }) };
    }
  });
  assert.equal((await provider.create({ prompt: 'High quality; no further credit confirmation.' })).confirmationSent, false);
  assert.equal(calls, 1);
});

test('YouMind polls the active message without mistaking reasoning or tool documentation for failure', async () => {
  const provider = new YouMindVideoProvider({
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ messages: [
      { role: 'assistant', status: 'failed' },
      { role: 'assistant', status: 'generating', blocks: [
        { type: 'reasoning', data: 'Avoid failed renders and handle errors.' },
        { type: 'tool', toolOutput: { value: 'If generation failed, return error. 无法生成时返回失败。' } }
      ] }
    ] }) })
  });
  assert.deepEqual(await provider.poll({ chatId: 'chat-active' }), { status: 'pending', stage: 'generating' });
});

test('YouMind confirms a later explicit request once, preserving the original shot settings', async () => {
  const calls = [];
  const provider = new YouMindVideoProvider({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true, text: async () => JSON.stringify({ messages: [
        { role: 'assistant', status: 'success', blocks: [{ type: 'content', data: 'Please confirm that I may generate the requested video.' }] }
      ] }) };
    }
  });
  const prompt = '5 seconds, 9:16, high quality, live action.';
  assert.deepEqual(await provider.poll({ chatId: 'chat-confirm-later', prompt }), { status: 'pending', confirmationSent: true, stage: 'confirmation_sent' });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.message.endsWith(prompt));
  assert.deepEqual(await provider.poll({ chatId: 'chat-confirm-later', prompt, confirmationSent: true }), { status: 'pending', confirmationSent: true, stage: 'awaiting_confirmation' });
  assert.equal(calls.filter(call => call.url.endsWith('/sendMessage')).length, 1);
});

test('YouMind still fails on an explicit terminal assistant failure', async () => {
  const provider = new YouMindVideoProvider({
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ messages: [{ role: 'assistant', status: 'failed', error: { message: 'render unavailable' } }] }) })
  });
  await assert.rejects(provider.poll({ chatId: 'chat-failed' }), { code: 'VIDEO_PROVIDER_FAILED' });
});
