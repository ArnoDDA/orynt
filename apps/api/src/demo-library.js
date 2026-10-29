import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';

const required = ['productPhoto', 'fidelityStill', 'shot1Frame', 'shot2Frame', 'shot1Video', 'shot2Video', 'finalVideo'];
const labels = { productPhoto: '官网产品图', fidelityStill: '产品还原度测试图', shot1Frame: '第一镜头场景静帧', shot2Frame: '第二镜头场景静帧', shot1Video: '第一镜头视频', shot2Video: '第二镜头视频', finalVideo: '完整广告' };
const formats = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'video/mp4': 'mp4' };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// An acceptance applies to the exact product, evidence, plan, receipts and media hashes.
export function demoContentHash(manifest) {
  const { review, ...content } = manifest;
  return digest(JSON.stringify(canonical(content)));
}
const httpUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };

export class DemoLibrary {
  constructor(root = fileURLToPath(new URL('../../../.local/demo-baselines/', import.meta.url))) { this.root = root; }
  async load() {
    const directory = resolve(this.root, 'owala-commute/v1');
    let manifest;
    try { manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')); }
    catch { return { view: { id: 'owala-commute', title: 'Owala 随身出行广告', ready: false, integrity: false, issues: ['演示资料尚未准备，请先建立本地案例快照。'], media: {}, scenes: [], evidence: [] }, files: new Map() }; }
    const issues = [], files = new Map(), media = {};
    if (manifest.schemaVersion !== 1 || manifest.id !== 'owala-commute' || manifest.version !== 'v1') issues.push('案例版本不匹配。');
    const contentHash = demoContentHash(manifest);
    for (const name of required) {
      const asset = manifest.assets?.[name];
      if (!asset) { issues.push(`${labels[name]}尚未制作。`); continue; }
      try {
        if (!formats[asset.mime] || !/^[\w-]+\.(png|webp|jpg|mp4)$/.test(asset.file) || !asset.file.endsWith(`.${formats[asset.mime]}`) || name.endsWith('Video') !== (asset.mime === 'video/mp4')) throw new Error();
        const rootPath = await realpath(directory), filePath = await realpath(resolve(directory, asset.file));
        if (!filePath.startsWith(rootPath + sep)) throw new Error();
        const info = await stat(filePath);
        if (!info.isFile() || info.size !== asset.bytes || info.size > 50_000_000) throw new Error();
        const bytes = await readFile(filePath);
        if (!bytes.length || bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw new Error();
        files.set(name, { bytes, mime: asset.mime });
        media[name] = { url: `/api/demo/owala-commute/media/${name}?revision=${contentHash}`, sha256: asset.sha256, mime: asset.mime, bytes: asset.bytes };
      } catch { issues.push(`${labels[name]}文件缺失或校验失败。`); }
    }
    const integrity = !issues.length;
    const technical = manifest.technical;
    const technicalReady = technical?.status === 'passed' && technical.finalSha256 === manifest.assets?.finalVideo?.sha256 && technical.duration >= 14.8 && technical.duration <= 15.2 && technical.width >= 720 && technical.height / technical.width > 1.75 && technical.height / technical.width < 1.8 && technical.hasAudio === true;
    if (!technicalReady) issues.push('完整成片的技术检查尚未通过。');
    const review = manifest.review;
    const reviewed = review?.status === 'accepted' && review.contentHash === contentHash && typeof review.reviewer === 'string' && review.reviewer.trim() && Number.isFinite(Date.parse(review.reviewedAt));
    if (!reviewed) issues.push('当前版本尚未通过完整广告的人工质量验收。');
    const evidence = (manifest.evidence || []).map(e => ({ id: e.id, url: httpUrl(e.url), observedAt: e.observedAt, advertiser: e.advertiser, copy: e.copy }));
    if (!evidence.length || evidence.some(e => !e.url || !e.copy)) issues.push('缺少可追溯的市场来源。');
    const ready = integrity && technicalReady && !!reviewed && evidence.length > 0 && evidence.every(e => e.url && e.copy);
    // A technically verified, explicitly published candidate has a separate review
    // channel. It never becomes an accepted replay merely because it is playable.
    const reviewMedia = {}, reviewFiles = new Map();
    const qualityReview = manifest.qualityReview;
    if (!ready && integrity && technicalReady && qualityReview?.status === 'candidate' && qualityReview.finalSha256 === manifest.assets.finalVideo.sha256) {
      for (const name of ['shot1Video', 'shot2Video', 'finalVideo']) {
        reviewMedia[name] = { ...media[name], url: media[name].url.replace('/media/', '/review-media/') };
        reviewFiles.set(name, files.get(name));
      }
    }
    // Draft stills are inspectable. Unaccepted videos never masquerade as a ready demonstration.
    if (!ready) for (const name of ['shot1Video', 'shot2Video', 'finalVideo']) { delete media[name]; files.delete(name); }
    // Allowlist the public projection; internal receipts or future private metadata stay local.
    const plan = Object.fromEntries(['schemaVersion','id','version','title','description','frozenAt','market','creative','scenes','simulation'].map(key => [key, manifest[key]]));
    return { files, reviewFiles, view: { ...plan, product: { ...manifest.product, url: httpUrl(manifest.product?.url), imageUrl: httpUrl(manifest.product?.imageUrl) }, evidence, media, reviewMedia, qualityReview: reviewFiles.size ? { status: 'candidate', notes: Array.isArray(qualityReview.notes) ? qualityReview.notes.filter(n => typeof n === 'string') : [] } : null, contentHash, ready, integrity, issues, review: { status: reviewed ? 'accepted' : 'pending', reviewedAt: reviewed ? review.reviewedAt : null }, technical: { status: technicalReady ? 'passed' : 'pending' } } };
  }
  async read() { return (await this.load()).view; }
  async media(name, revision, { review = false } = {}) {
    const loaded = await this.load(), files = review ? loaded.reviewFiles : loaded.files;
    if (revision !== loaded.view.contentHash || !files?.has(name)) return null;
    return files.get(name);
  }
}
