// Local snapshot only: no providers, no network, no writes to the product database.
import { readFile, mkdir, copyFile, writeFile, access } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { digest, DemoLibrary } from '../apps/api/src/demo-library.js';

const project = new URL('../', import.meta.url);
const root = new URL('.local/demo-baselines/owala-commute/v1/', project);
try { await access(new URL('manifest.json', root)); console.log('Existing baseline preserved.'); process.exit(0); } catch { /* First local snapshot. */ }
const plan = JSON.parse(await readFile(new URL('demo-cases/owala-commute.json', project), 'utf8'));
const receipt = JSON.parse(await readFile(new URL('.local/product-reference-quality/owala-still-01/request.json', project), 'utf8'));
const db = new DatabaseSync(fileURLToPath(new URL('.local/orynt.sqlite', project)), { readOnly: true });
let evidence;
try {
  const all = db.prepare("SELECT payload FROM product_entities WHERE collection_name='evidence'").all().map(row => JSON.parse(row.payload));
  evidence = plan.evidenceIds.map(id => {
    const e = all.find(e => e.id === id);
    if (!e?.attributes?.bodyText || !e.sourceUrl) throw new Error('Missing real source evidence.');
    return { id, url: e.sourceUrl, observedAt: e.observedAt, advertiser: e.attributes.advertiserName, copy: e.attributes.bodyText };
  });
} finally { db.close(); }
const photo = await readFile(new URL('.local/product-reference-quality/owala-still-01/reference.png', project));
if (digest(photo) !== 'e37bffa8fdc6cf0393ebd87b36aebcc96decd5630ed5607ad318beaa95d93655') throw new Error('Product photo fingerprint mismatch.');
await mkdir(root, { recursive: true, mode: 0o700 });
const assets = {};
for (const [key, source, file, mime] of [
  ['productPhoto', 'reference.png', 'product.png', 'image/png'],
  ['fidelityStill', 'generated.png', 'fidelity-still.png', 'image/png']
]) {
  const from = new URL(`.local/product-reference-quality/owala-still-01/${source}`, project);
  const bytes = await readFile(from);
  await copyFile(from, new URL(file, root));
  assets[key] = { file, mime, bytes: bytes.length, sha256: digest(bytes) };
}
const manifest = { ...plan, frozenAt: new Date().toISOString(), evidence, assets, provenance: {
  fidelityStill: { provider: 'YouMind', model: 'gpt-image-2-2026-04-21', chatId: receipt.chatId, referenceId: receipt.referenceId, referenceSha256: receipt.referenceHash, submittedAt: receipt.submittedAt, reviewScope: '用户仅认可影棚静帧的产品还原度；不是完整广告验收。' }
}, technical: { status: 'pending' }, review: { status: 'pending' } };
await writeFile(new URL('manifest.json', root), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const view = await new DemoLibrary().read();
console.log(JSON.stringify({ id: view.id, revision: view.contentHash, ready: view.ready, media: Object.keys(view.media), issues: view.issues }, null, 2));
