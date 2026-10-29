import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Repository } from '../apps/api/src/repository.js';
import { createApplication } from '../apps/api/src/server.js';

const directory = await mkdtemp(join(tmpdir(), 'orynt-flow-check-'));
const database = join(directory, 'verification.sqlite');
let application;
let reloaded;
try {
  let videoPath = process.env.ORYNT_CHECK_VIDEO;
  if (!videoPath) {
    videoPath = join(directory, 'synthetic-fixture.mp4');
    try {
      await promisify(execFile)(process.env.ORYNT_FFMPEG || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=24',
        '-t', '4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath
      ], { timeout: 30_000 });
    } catch {
      throw new Error('Install FFmpeg (with libx264), set ORYNT_FFMPEG, or supply ORYNT_CHECK_VIDEO for this optional integration check.');
    }
  }
  const video = await readFile(videoPath);
  assert.equal(video.toString('ascii', 4, 8), 'ftyp');
  const crawler = {
    async collect() {
      return {
        provider: 'local_verification_fixture', coverage: { fetchedPages: 1 }, limitations: ['Offline verification fixture, not live research.'],
        sources: [{ sourceType: 'brand_website', sourceUrl: 'https://example.com', status: 'available' }],
        evidence: [{ sourceType: 'brand_website', sourceUrl: 'https://example.com', title: 'Verification product', contentSummary: 'Coffee for a simple morning routine.', contentHash: 'offline-package-check' }]
      };
    }
  };
  let providerCalls = 0;
  const videoProvider = {
    available: true,
    async create({ prompt }) {
      assert.ok(prompt.length > 100);
      providerCalls++;
      return { chatId: 'offline-verification-chat', confirmationSent: true };
    },
    async poll() { return { status: 'succeeded', mediaId: 'offline-video', url: 'https://cdn.youmindassets.com/offline-verification.mp4', duration: 4 }; },
    async download() { return video; }
  };
  application = createApplication({ repository: new Repository(database), tickMs: 0, crawler, metaCrawler: null, videoProvider });
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening');
  const origin = `http://127.0.0.1:${application.server.address().port}`;
  const get = async path => {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    return response;
  };
  const session = await (await get('/api/session')).json();
  const command = async (action, resourceId, data = {}) => {
    const response = await fetch(`${origin}/api/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Session': session.token, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ action, resourceId, data })
    });
    const body = await response.json();
    assert.ok(response.ok, `${action}: ${JSON.stringify(body.error)}`);
    return body.result;
  };
  const settle = async jobId => {
    for (let index = 0; index < 15; index++) {
      await application.jobRunner.tick();
      const job = application.core.state().jobs.find(item => item.id === jobId);
      if (job.status === 'succeeded') return;
      assert.notEqual(job.status, 'failed', JSON.stringify(job.error));
    }
    assert.fail(`Job did not finish: ${jobId}`);
  };
  await get('/api/health');
  for (const path of ['/', '/app.js', '/ui.css', '/lucide.js', '/api-client.js']) await get(path);
  const created = await command('campaign.create', null, {
    brandUrl: 'https://example.com', name: 'Offline package verification', product: 'Morning coffee', audience: 'Coffee drinkers', objective: 'Compare opening scenes'
  });
  const brandId = application.core.state().campaigns.find(item => item.id === created.campaignId).brandId;
  const logo = await readFile(new URL('../demo-assets/northline-coffee-logo.svg', import.meta.url));
  const brandAsset = await command('brandAsset.add', brandId, { name: 'Verification logo.svg', type: 'logo', mime: 'image/svg+xml', base64: logo.toString('base64') });
  await get(`/api/brand-assets/${brandAsset.assetId}/preview`);
  await command('snapshot.confirm', created.campaignId, { product: 'Morning coffee', audience: 'Coffee drinkers', claim: 'Make the morning simpler', limitations: 'No unverified health claims' });
  const discovery = await command('discovery.start', created.campaignId);
  await settle(discovery.jobId);
  const cards = await command('cards.generate', created.campaignId);
  await settle(cards.jobId);
  const card = application.core.state().cards.find(item => item.campaignId === created.campaignId);
  assert.ok(card);
  const adopted = await command('card.adopt', card.id);
  const template = await command('template.import', adopted.packageId, { angleId: adopted.angleIds[0], filename: 'reference.mp4', base64: video.toString('base64') });
  await settle(template.jobId);
  const analyzed = application.core.state().videoTemplates.find(item => item.id === template.templateId);
  assert.equal(analyzed.status, 'ready');
  assert.ok(analyzed.sceneCount > 0);
  await get(`/api/video-templates/${template.templateId}/keyframes/0`);
  const config = await command('config.create', adopted.packageId, { angleId: adopted.angleIds[0], ratio: '9:16', duration: 15, language: 'English', brandAssetIds: [brandAsset.assetId], templateId: template.templateId });
  const storyboard = await command('generation.start', config.configId, { mode: 'storyboard', angleId: adopted.angleIds[0] });
  await settle(storyboard.jobId);
  const draft = application.core.state().assets.find(item => item.generationRequestId === storyboard.generationRequestId);
  assert.equal(draft.type, 'storyboard');
  await get(`/api/assets/${draft.id}/preview`);
  const generation = await command('generation.start', config.configId, { mode: 'video', angleId: adopted.angleIds[0] });
  await settle(generation.jobId);
  const asset = application.core.state().assets.find(item => item.generationRequestId === generation.generationRequestId);
  assert.equal(asset.type, 'video');
  assert.equal(providerCalls, 1);
  const downloaded = await (await get(`/api/assets/${asset.id}/download`)).arrayBuffer();
  assert.deepEqual(Buffer.from(downloaded), video);
  const ranged = await fetch(`${origin}/api/assets/${asset.id}/preview`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  await command('asset.launch-ready', asset.id, { reviewed: true });
  const plan = await command('plan.save', created.campaignId, { assetIds: [asset.id], channel: 'Meta', audience: 'Coffee drinkers', hypothesis: 'Morning scene increases CTR', metric: 'CTR' });
  await command('plan.simulate-launch', plan.planId);
  const metrics = await command('metrics.simulate', plan.planId, { confirmSimulation: true });
  const state = await (await get('/api/state')).json();
  assert.equal(state.campaigns.find(item => item.id === created.campaignId).stage, 'learning');
  assert.equal(state.conclusions.find(item => item.id === metrics.conclusionId).simulation, true);
  assert.equal(state.assets.find(item => item.id === asset.id).sourceCardVersionId, card.currentVersionId);
  assert.equal(state.metricSnapshots.filter(item => item.planId === plan.planId).length, 4);
  await application.close();
  application = null;
  reloaded = new Repository(database);
  assert.equal(reloaded.read().campaigns.find(item => item.id === created.campaignId).stage, 'learning');
  console.log('PASS: HTTP startup, brand assets, discovery fixture, Cards, real template analysis, storyboard, video-provider fixture, MP4 download/range, simulated launch, metrics, learning and restart persistence.');
  console.log('No external requests or paid generation. The saved demo database was not modified.');
} finally {
  if (application) await application.close();
  reloaded?.close();
  await rm(directory, { recursive: true, force: true });
}
