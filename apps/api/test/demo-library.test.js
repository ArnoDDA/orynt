import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoLibrary, demoContentHash, digest } from '../src/demo-library.js';
import { createApplication } from '../src/server.js';
import { Repository } from '../src/repository.js';
import { renderDemoCase, renderDemoEntry } from '../../web/public/demo-flow.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orynt-demo-'));
  const dir = join(root, 'owala-commute/v1'); await mkdir(dir, { recursive: true });
  const plan = JSON.parse(await readFile(new URL('../../../demo-cases/owala-commute.json', import.meta.url), 'utf8'));
  const manifest = { ...plan, evidence: [{ id: 'real-copy-fixture', url: 'https://example.com/ads/1', copy: 'Everyday city adventures', advertiser: 'Brand', observedAt: '2026-10-28T00:00:00Z' }], assets: {}, technical: { status: 'passed', duration: 15, width: 720, height: 1280, hasAudio: true } };
  for (const name of ['productPhoto','fidelityStill','shot1Frame','shot2Frame','shot1Video','shot2Video','finalVideo']) {
    const video = name.endsWith('Video'), bytes = Buffer.from(`test-fixture-${name}`), file = `${name}.${video ? 'mp4' : 'png'}`;
    // Fixture bytes exercise integrity and delivery contracts, not media decoding or visual quality.
    manifest.assets[name] = { file, mime: video ? 'video/mp4' : 'image/png', sha256: digest(bytes), bytes: bytes.length };
    await writeFile(join(dir,file),bytes);
  }
  manifest.technical.finalSha256 = manifest.assets.finalVideo.sha256;
  const save = () => writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const accept = () => { manifest.review = { status: 'accepted', contentHash: demoContentHash(manifest), reviewer: 'fixture-reviewer', reviewedAt: '2026-10-28T00:00:00Z' }; };
  accept(); await save();
  return { root, dir, manifest, save, accept, library: new DemoLibrary(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('draft case exposes real stills but never presents unaccepted videos as a ready demo', async () => {
  const f = await fixture();
  try {
    f.manifest.review = { status: 'pending' }; await f.save();
    const demo = await f.library.read();
    assert.equal(demo.ready, false); assert.ok(demo.media.fidelityStill);
    assert.equal(demo.media.finalVideo, undefined);
    assert.equal(await f.library.media('finalVideo', demo.contentHash), null);
    const html = renderDemoCase(demo, 'film');
    assert.match(html, /不是成片/); assert.doesNotMatch(html, /<video|download=/);
    for (const name of ['shot1Frame', 'shot2Frame']) assert.ok(html.includes(demo.media[name].url.replaceAll('&', '&amp;')));
    assert.match(html, /已生成，待确认/);
    const storyboard = renderDemoCase(demo, 'storyboard');
    assert.match(storyboard, /静帧已生成 · 待确认/);
    assert.doesNotMatch(storyboard, /场景静帧尚未制作/);
    assert.match(renderDemoEntry(demo), /筹备中/);
  } finally { await f.cleanup(); }
});

test('evidence, scenes, receipt and media changes invalidate prior human acceptance', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.library.read()).ready, true);
    for (const change of [
      () => { f.manifest.scenes[0].description += ' different scene'; },
      () => { f.manifest.evidence[0].copy += ' changed'; },
      () => { f.manifest.provenance = { receipt: 'different-request' }; }
    ]) {
      change(); await f.save(); assert.equal((await f.library.read()).ready, false);
      f.accept(); await f.save(); assert.equal((await f.library.read()).ready, true);
    }
    f.manifest.technical.finalSha256 = 'wrong-file'; f.accept(); await f.save();
    assert.equal((await f.library.read()).ready, false);
  } finally { await f.cleanup(); }
});

test('explicit candidate review permits version-bound inspection without unlocking accepted replay', async () => {
  const f = await fixture(); let app;
  try {
    f.manifest.review = { status: 'pending' };
    f.manifest.qualityReview = { status: 'candidate', finalSha256: f.manifest.assets.finalVideo.sha256, notes: ['候选广告，待确认'] };
    await f.save();
    const demo = await f.library.read();
    assert.equal(demo.ready, false); assert.equal(demo.media.finalVideo, undefined);
    assert.ok(demo.reviewMedia.finalVideo.url.includes('/review-media/'));
    assert.equal(await f.library.media('finalVideo', demo.contentHash), null);
    assert.ok(await f.library.media('finalVideo', demo.contentHash, { review: true }));
    assert.equal(await f.library.media('finalVideo', 'obsolete', { review: true }), null);
    const html = renderDemoCase(demo, 'film');
    assert.match(html, /候选广告 · 待验收/); assert.match(html, /<video/);
    assert.doesNotMatch(html, /已验收成片回放/);
    app = createApplication({ repository: new Repository(':memory:'), tickMs: 0, demoLibrary: f.library, metaCrawler: null, videoProvider: { available: false }, textProvider: { available: false } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(base + demo.reviewMedia.finalVideo.url + '&download=1', { headers: { Range: 'bytes=0-3' } });
    assert.equal(response.status, 206); assert.match(response.headers.get('content-disposition'), /candidate-finalVideo\.mp4/);
    assert.equal((await response.arrayBuffer()).byteLength, 4);
    assert.equal((await fetch(base + demo.reviewMedia.finalVideo.url.replace('/review-media/', '/media/'))).status, 404);
    f.manifest.qualityReview.finalSha256 = 'wrong'; await f.save();
    assert.deepEqual((await f.library.read()).reviewMedia, {});
    f.manifest.qualityReview.finalSha256 = f.manifest.assets.finalVideo.sha256;
    f.manifest.technical.status = 'pending'; await f.save();
    assert.deepEqual((await f.library.read()).reviewMedia, {});
  } finally { if (app) await app.close(); await f.cleanup(); }
});

test('missing, corrupt and escaped files block replay instead of substituting another result', async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, f.manifest.assets.shot1Frame.file);
    const original = await readFile(path); await writeFile(path, 'corrupt');
    let demo = await f.library.read(); assert.equal(demo.ready, false); assert.equal(demo.media.shot1Frame, undefined);
    await writeFile(path, original);
    await rm(path); await symlink(join(f.dir, '../outside.png'), path);
    await writeFile(join(f.dir, '../outside.png'), original);
    demo = await f.library.read(); assert.equal(demo.ready, false); assert.equal(demo.media.shot1Frame, undefined);
    await rm(path); f.manifest.assets.shot1Frame.file = '../outside.png'; f.accept(); await f.save();
    assert.equal((await f.library.read()).ready, false);
    await rm(join(f.dir, 'manifest.json'));
    assert.equal((await f.library.read()).ready, false);
  } finally { await f.cleanup(); }
});

test('case view escapes source copy and keeps reset/next as read-only URL navigation', async () => {
  const f = await fixture();
  try {
    f.manifest.evidence[0].copy = '<img src=x onerror=alert(1)>';
    f.manifest.privateReceipt = { secret: 'must-not-reach-browser' };
    f.manifest.provenance = { internalPath: '/private/raw-receipt.json' };
    f.accept(); await f.save();
    const demo = await f.library.read();
    assert.equal(demo.privateReceipt, undefined); assert.equal(demo.provenance, undefined);
    const html = renderDemoCase(demo, 'market');
    assert.match(html, /&lt;img src=x/); assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /data-nav href="#\/demo\/owala-commute\?step=product"/);
    assert.match(renderDemoCase(demo,'film'), /已保存的真实生成结果/);
    assert.match(renderDemoCase(demo,'simulation'), /非真实投放结果/);
    assert.match(renderDemoCase(demo,'unknown'), /01 \/ 产品资料/);
  } finally { await f.cleanup(); }
});

test('three complete replays, reset and service recreation keep exact bytes without calling providers', async () => {
  const f = await fixture(); let calls = 0, app;
  const fail = async () => { calls++; throw new Error('Replay must not call a provider'); };
  const start = async () => {
    app = createApplication({ repository: new Repository(':memory:'), tickMs: 0, demoLibrary: new DemoLibrary(f.root), crawler: { collect: fail }, metaCrawler: null, videoProvider: { submit: fail }, textProvider: { available: false } });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${app.server.address().port}`;
  };
  try {
    let base = await start(), expected;
    for (let run = 0; run < 3; run++) {
      const before = app.repository.read();
      const demo = await (await fetch(`${base}/api/demo/owala-commute`)).json();
      assert.equal(demo.ready, true); expected ||= demo.contentHash; assert.equal(demo.contentHash, expected);
      for (const step of ['product','market','creative','storyboard','film','simulation','product']) assert.ok(renderDemoCase(demo, step).length);
      for (const [key, media] of Object.entries(demo.media)) {
        const response = await fetch(base + media.url);
        assert.equal(response.status, 200); assert.equal(digest(Buffer.from(await response.arrayBuffer())), f.manifest.assets[key].sha256);
      }
      const mediaUrl = demo.media.finalVideo.url;
      const range = await fetch(base + mediaUrl, { headers: { Range: 'bytes=-4' } });
      assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 4);
      assert.equal((await fetch(base + mediaUrl, { headers: { Range: 'bytes=99999-' } })).status, 416);
      assert.equal((await fetch(base + mediaUrl.replace(expected, 'obsolete'))).status, 404);
      assert.deepEqual(app.repository.read(), before); assert.equal(calls, 0);
      await app.close(); app = null;
      if (run < 2) base = await start();
    }
  } finally { if (app) await app.close(); await f.cleanup(); }
});

test('independent URL revalidation creates a normal project without rewriting the replay baseline or generating media', async () => {
  const f = await fixture(); const repository = new Repository(':memory:');
  const app = createApplication({ repository, tickMs: 0, demoLibrary: f.library, metaCrawler: null, videoProvider: { available: false }, textProvider: { available: false } });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`, before = await f.library.read();
    const session = await (await fetch(base + '/api/session')).json();
    const response = await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Session': session.token, 'Idempotency-Key': 'demo-independent-revalidation' }, body: JSON.stringify({ action: 'campaign.create', data: { brandUrl: before.product.url, importFromUrl: true, name: 'Independent revalidation' } }) });
    assert.equal(response.status, 202);
    assert.equal(repository.read().campaigns.length, 1); assert.equal(repository.read().jobs[0].type, 'product_import');
    assert.equal(repository.read().generationRequests.length, 0);
    assert.deepEqual(await f.library.read(), before);
  } finally { await app.close(); await f.cleanup(); }
});
