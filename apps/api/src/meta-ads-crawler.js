import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const workerPath = fileURLToPath(new URL('../../../services/crawler/meta_ads_crawler.py', import.meta.url));
const defaultRoot = fileURLToPath(new URL('../../../.local/crawler/meta/', import.meta.url));
const localPython = fileURLToPath(new URL('../../../.local/python/bin/python', import.meta.url));
const defaultPython = existsSync(localPython) ? localPython : 'python3';
const bundledBrowsers = fileURLToPath(new URL('../../../.local/browsers/', import.meta.url));

function safeSegment(value) {
  const segment = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  if (!segment) throw new Error('Meta crawler workspace identifier is invalid.');
  return segment;
}

export class LocalMetaAdsCrawler {
  constructor({ python = defaultPython, root = defaultRoot, timeoutMs = 90_000, maxAds = 12, mode = 'auto' } = {}) {
    this.python = python;
    this.root = resolve(root);
    this.timeoutMs = timeoutMs;
    this.maxAds = Math.max(1, Math.min(Number(maxAds) || 12, 30));
    this.mode = ['auto', 'demo', 'live'].includes(mode) ? mode : 'auto';
  }

  async collect({ query, campaignId, jobId }) {
    const workspace = resolve(this.root, safeSegment(campaignId), safeSegment(jobId));
    if (!workspace.startsWith(`${this.root}/`)) throw new Error('Meta crawler workspace escaped its local root.');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const output = await this.#run([
      workerPath,
      '--query', String(query || '').slice(0, 160),
      '--workspace', workspace,
      '--limit', String(this.maxAds),
      '--mode', this.mode
    ]);
    let bundle;
    try { bundle = JSON.parse(output); } catch { throw new Error('LOCAL_META_CRAWLER_INVALID_OUTPUT'); }
    if (!Array.isArray(bundle.sources) || !Array.isArray(bundle.evidence) || !bundle.coverage) {
      throw new Error('LOCAL_META_CRAWLER_INVALID_OUTPUT');
    }
    const prefix = `local-meta://${safeSegment(campaignId)}/${safeSegment(jobId)}/`;
    for (const item of bundle.evidence) {
      item.rawEvidenceRef = `${prefix}${item.rawEvidenceRef}`;
    }
    for (const item of bundle.sources) {
      if (item.rawEvidenceRef) item.rawEvidenceRef = `${prefix}${item.rawEvidenceRef}`;
    }
    return bundle;
  }

  async hydrate({ evidence, directAdIds = [] }) {
    const root = await realpath(this.root).catch(() => this.root);
    const records = await Promise.all(evidence.slice(0,30).map(async item => {
      let rawAd = null;
      try {
        const reference = String(item.rawEvidenceRef || '');
        if (!/^local-meta:\/\/[\w-]+\/[\w-]+\/raw\/[a-f0-9]{64}\.json$/.test(reference)) throw new Error();
        const path = await realpath(resolve(this.root,reference.slice('local-meta://'.length)));
        if (!path.startsWith(root+'/')) throw new Error();
        const raw = JSON.parse(await readFile(path,'utf8'));
        const url = new URL(item.sourceUrl);
        if (url.origin !== 'https://www.facebook.com' || url.pathname !== '/ads/library/' || url.searchParams.get('id') !== String(raw.ad_archive_id)) throw new Error();
        rawAd = raw;
      } catch { /* Missing original records remain explicitly unavailable. */ }
      return { id:item.id, rawAd, direct:!!rawAd && directAdIds.includes(String(rawAd.ad_archive_id)) };
    }));
    return JSON.parse(await this.#run([workerPath,'--hydrate'],{evidence:records}));
  }

  #run(args, input = null) {
    return new Promise((accept, reject) => {
      const child = spawn(this.python, args, {
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8',
          ...(existsSync(bundledBrowsers) ? { PLAYWRIGHT_BROWSERS_PATH: bundledBrowsers } : {})
        }
      });
      let stdout = '', stderr = '', settled = false;
      if(input){child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));}
      const fail = error => { if (!settled) { settled = true; reject(error); } };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        fail(new Error('LOCAL_META_CRAWLER_TIMEOUT'));
      }, this.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 12_000_000) {
          child.kill('SIGTERM');
          fail(new Error('LOCAL_META_CRAWLER_OUTPUT_TOO_LARGE'));
        }
      });
      child.stderr.on('data', chunk => { if (stderr.length < 32_000) stderr += chunk; });
      child.on('error', error => { clearTimeout(timer); fail(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (settled) return;
        if (code !== 0) return fail(new Error(`LOCAL_META_CRAWLER_FAILED:${stderr.trim().slice(0, 500)}`));
        settled = true;
        accept(stdout);
      });
    });
  }
}
