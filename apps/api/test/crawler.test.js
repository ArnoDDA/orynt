import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Repository } from '../src/repository.js';
import { Core } from '../src/core.js';
import { LocalJobRunner } from '../src/job-runner.js';

test('cancelled discovery results cannot advance a retried attempt', async () => {
  const repository = new Repository(), core = new Core(repository); let seq = 0, release, calls = 0;
  const command = (action, id, body = {}) => core.command(action, id, body, `discovery-retry-${++seq}`);
  try {
    const campaign = command('campaign.create', null, {brandUrl:'https://example.com',product:'Bottle'});
    command('snapshot.confirm', campaign.campaignId, {skip:true});
    const {jobId} = command('discovery.start', campaign.campaignId);
    const bundle = notice => ({sources:[],evidence:[],coverage:{},limitations:[notice]});
    const runner = new LocalJobRunner({core,repository,metaCrawler:null,crawler:{collect:()=>{
      calls++; return calls === 1 ? new Promise(resolve=>{release=resolve;}) : Promise.resolve(bundle('NEW_ATTEMPT'));
    }}});
    await runner.tick(); const pending = runner.tick();
    command('job.cancel',jobId); command('job.retry',jobId);
    release(bundle('OLD_ATTEMPT')); await pending;
    let job=repository.read().jobs.find(j=>j.id===jobId);
    assert.equal(job.providerResult,undefined);
    assert.equal(job.steps.find(s=>s.key==='check_source_coverage').status,'queued');
    await runner.tick(); await runner.tick();
    job=repository.read().jobs.find(j=>j.id===jobId);
    assert.equal(job.status,'succeeded'); assert.equal(calls,2);
    assert.ok(repository.read().discoveries[0].limitations.includes('NEW_ATTEMPT'));
    assert.ok(!repository.read().discoveries[0].limitations.includes('OLD_ATTEMPT'));
  } finally { repository.close(); }
});

test('the local crawler safety and extraction tests pass without network access', () => {
  const directory = fileURLToPath(new URL('../../../services/crawler/', import.meta.url));
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-p', 'test_*.py'], {
    cwd: directory,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('Discovery imports local crawler sources and evidence exactly once', async () => {
  const repository = new Repository();
  const core = new Core(repository);
  let sequence = 0, calls = 0, metaCalls = 0;
  const command = (action, resourceId, body = {}) => core.command(action, resourceId, body, `crawler-test-${++sequence}`);
  const created = command('campaign.create', null, { brandUrl: 'https://example.com', name: '真实采集测试', product: '具体产品名称' });
  const brand = repository.read().brands.find(item => item.id === repository.read().campaigns[0].brandId);
  command('brand.update', brand.id, { name: 'Example Brand' });
  command('snapshot.confirm', created.campaignId, { skip: true });
  const queued = command('discovery.start', created.campaignId);
  const crawler = {
    async collect() {
      calls++;
      return {
        provider: 'orynt_local_website',
        coverage: { attemptedPages: 1, fetchedPages: 1, failedPages: 0, robotsBlockedPages: 0, maxPages: 6 },
        limitations: ['当前仅覆盖品牌自有官网。'],
        sources: [{ sourceType: 'brand_website', sourceUrl: 'https://example.com/', status: 'available', observedAt: '2026-09-16T00:00:00Z', rawEvidenceRef: 'local-crawler://campaign/job/raw/page.html' }],
        evidence: [{ evidenceId: 'external-id', sourceType: 'brand_website', sourceUrl: 'https://example.com/', observedAt: '2026-09-16T00:00:00Z', ingestedAt: '2026-09-16T00:00:01Z', title: 'Example', contentSummary: 'A traceable public brand statement.', rawEvidenceRef: 'local-crawler://campaign/job/raw/page.html', contentHash: 'abc' }]
      };
    }
  };
  const metaCrawler = {
    async collect({ query }) {
      metaCalls++;
      assert.equal(query, 'Example Brand');
      return {
        provider: 'orynt_local_meta_ads', mode: 'demo_fallback',
        coverage: { metaSamples: 1, liveMetaAds: 0, demoMetaAds: 1, externalSignals: 0, maxAds: 20 },
        limitations: ['Meta 当前使用结构化演示样本。'],
        sources: [{ provider: 'orynt_local_meta_ads', sourceType: 'meta_ad_library_demo', sourceUrl: 'local-demo://meta/demo-1', status: 'demo', observedAt: '2026-09-16T00:00:00Z', rawEvidenceRef: 'local-meta://campaign/job/raw/meta.json' }],
        evidence: [{ evidenceId: 'meta-demo-id', sourceType: 'meta_ad_library_demo', sourceUrl: 'local-demo://meta/demo-1', observedAt: '2026-09-16T00:00:00Z', ingestedAt: '2026-09-16T00:00:01Z', title: 'Meta demo', contentSummary: '演示样本，不代表真实广告。', rawEvidenceRef: 'local-meta://campaign/job/raw/meta.json', contentHash: 'meta-abc', attributes: { demo: true, displayFormat: 'VIDEO' } }]
      };
    }
  };
  let runner = new LocalJobRunner({ core, repository, crawler, metaCrawler });
  await runner.tick();
  await runner.tick();
  assert.ok(repository.read().jobs.find(item => item.id === queued.jobId).providerResult, 'crawler result should survive a process restart');
  runner = new LocalJobRunner({ core, repository, crawler, metaCrawler });
  await runner.tick();

  const state = repository.read();
  const job = state.jobs.find(item => item.id === queued.jobId);
  assert.equal(job.status, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(metaCalls, 1);
  assert.equal(job.providerResult, undefined);
  assert.equal(state.discoverySources.length, 2);
  assert.equal(state.evidence.length, 2);
  assert.equal(state.evidence[0].sourceUrl, 'https://example.com/');
  assert.match(state.evidence[0].rawEvidenceRef, /^local-crawler:\/\//);
  assert.equal(state.evidence[1].attributes.displayFormat, 'VIDEO');
  assert.equal(state.discoverySources[1].status, 'demo');
  assert.equal(state.discoveries[0].coverage.evidence, 2);
  assert.equal(state.discoveries[0].coverage.metaSamples, 1);
  assert.equal(state.discoveries[0].coverage.externalSignals, 0);
  repository.close();
});
