import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const workerPath = fileURLToPath(new URL('../../../services/crawler/orynt_crawler.py', import.meta.url));
const defaultRoot = fileURLToPath(new URL('../../../.local/crawler/', import.meta.url));

function safeSegment(value) {
  const segment = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  if (!segment) throw new Error('Crawler workspace identifier is invalid.');
  return segment;
}

export class LocalWebsiteCrawler {
  constructor({ python = 'python3', root = defaultRoot, timeoutMs = 90_000, maxPages = 6 } = {}) {
    this.python = python;
    this.root = resolve(root);
    this.timeoutMs = timeoutMs;
    this.maxPages = maxPages;
  }

  async collect({ url, campaignId, jobId }) {
    const workspace = resolve(this.root, safeSegment(campaignId), safeSegment(jobId));
    if (!workspace.startsWith(`${this.root}/`)) throw new Error('Crawler workspace escaped its local root.');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const args = [
      workerPath,
      '--url', String(url),
      '--workspace', workspace,
      '--max-pages', String(this.maxPages)
    ];
    const output = await this.#run(args);
    let bundle;
    try { bundle = JSON.parse(output); } catch { throw new Error('LOCAL_CRAWLER_INVALID_OUTPUT'); }
    if (!Array.isArray(bundle.sources) || !Array.isArray(bundle.evidence) || !bundle.coverage) {
      throw new Error('LOCAL_CRAWLER_INVALID_OUTPUT');
    }
    for (const item of bundle.evidence) {
      item.rawEvidenceRef = `local-crawler://${safeSegment(campaignId)}/${safeSegment(jobId)}/${item.rawEvidenceRef}`;
    }
    for (const item of bundle.sources) {
      if (item.rawEvidenceRef) item.rawEvidenceRef = `local-crawler://${safeSegment(campaignId)}/${safeSegment(jobId)}/${item.rawEvidenceRef}`;
    }
    return bundle;
  }

  #run(args) {
    return new Promise((accept, reject) => {
      const child = spawn(this.python, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8' }
      });
      let stdout = '', stderr = '', settled = false;
      const fail = error => { if (!settled) { settled = true; reject(error); } };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        fail(new Error('LOCAL_CRAWLER_TIMEOUT'));
      }, this.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.length > 4_000_000) { child.kill('SIGTERM'); fail(new Error('LOCAL_CRAWLER_OUTPUT_TOO_LARGE')); }
      });
      child.stderr.on('data', chunk => { if (stderr.length < 32_000) stderr += chunk; });
      child.on('error', error => { clearTimeout(timer); fail(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (settled) return;
        if (code !== 0) return fail(new Error(`LOCAL_CRAWLER_FAILED:${stderr.trim().slice(0, 500)}`));
        settled = true;
        accept(stdout);
      });
    });
  }
}
