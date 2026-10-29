// Two explicitly authorized image experiments. No video submissions or automatic paid retries.
import { mkdir, readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { YouMindVideoProvider } from '../apps/api/src/youmind-video-provider.js';
import { extractImageResult, productReferenceEvidence } from '../apps/api/src/youmind-images.js';
import { LocalVideoAssembler } from '../apps/api/src/video-assembler.js';
import { digest, demoContentHash } from '../apps/api/src/demo-library.js';

const [action, sceneId] = process.argv.slice(2);
if (!['shot1', 'shot2'].includes(sceneId)) throw new Error('Choose shot1 or shot2.');
const project = fileURLToPath(new URL('../', import.meta.url));
const packDir = join(project, '.local/demo-baselines/owala-commute/v1');
const dir = join(project, '.local/product-reference-quality/owala-commute-v1', sceneId);
const receiptPath = join(dir, 'request.json');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async receipt => {
  await writeFile(join(dir, 'request.pending.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  await rename(join(dir, 'request.pending.json'), receiptPath);
};
const imageTools = messages => (messages || []).flatMap(m => m.blocks || []).filter(b => ['generate_image','image_generate','generateImage'].includes(b.toolName));
const chatIdOf = v => !v || typeof v !== 'object' ? null : typeof v.chatId === 'string' ? v.chatId : Object.values(v).map(chatIdOf).find(Boolean) || null;

async function main() {
  const manifestBytes = await readFile(join(packDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const scene = manifest.scenes.find(s => s.id === sceneId);
  const photoBytes = await readFile(join(packDir, manifest.assets.productPhoto.file));
  if (digest(photoBytes) !== manifest.assets.productPhoto.sha256) throw new Error('Frozen product photo changed.');
  let receipt;
  try { receipt = await json(receiptPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (action === 'prepare') {
    if (receipt) { console.log(JSON.stringify({ scene: sceneId, status: receipt.status, preserved: true })); return; }
    const original = await json(join(project, '.local/product-reference-quality/owala-still-01/request.json'));
    if (original.referenceHash !== manifest.assets.productPhoto.sha256 || original.sourceUrl !== manifest.product.imageUrl || !original.referenceId) throw new Error('Original identity reference does not match frozen case.');
    const prompt = [
      'Generate exactly ONE photorealistic premium advertising still, portrait 9:16. Use gpt-image-2 for this controlled comparison. One image only; no video, alternatives or automatic follow-up generations. This single image is authorized.',
      'The attached file is the official public product identity reference. Pass its actual image into the image generation tool source_image_urls/reference-image input. If image conditioning is unavailable, stop without generating. Do not use text alone or replace the source image.',
      scene.imagePrompt,
      'The hero bottle should occupy approximately 60–65 percent of the frame height, fully visible including its base and carry loop. Preserve believable product scale and keep the upper quarter quiet for later typography.',
      `Public source photograph: ${manifest.product.imageUrl}`,
      'Return the single generated original image. Preserve the actual image tool reference inputs in the result. No additional generation without a new request.'
    ].join('\n\n');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    receipt = { schemaVersion: 1, sceneId, sceneTitle: scene.title, status: 'prepared', createdAt: new Date().toISOString(), sourceUrl: original.sourceUrl, referenceId: original.referenceId, referenceHash: original.referenceHash, sceneHash: digest(JSON.stringify(scene)), caseHashAtPreparation: demoContentHash(manifest), prompt, authorization: { maxImages: 1, video: false, scope: 'public_product_photo_and_scene_description' } };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ scene: sceneId, status: receipt.status, promptHash: digest(prompt), sourceHash: receipt.referenceHash })); return;
  }
  if (!receipt || receipt.sceneHash !== digest(JSON.stringify(scene)) || receipt.referenceHash !== manifest.assets.productPhoto.sha256) throw new Error('Prepare or restore the exact scene plan first.');
  if (action === 'attach') {
    if (manifest.review?.status === 'accepted') throw new Error('Accepted baseline is immutable; prepare a new version instead.');
    if (receipt.status !== 'downloaded' || receipt.referenceEvidence?.status !== 'product_reference_confirmed' || receipt.technical?.issues?.length) throw new Error('No verified downloadable reference-conditioned still.');
    const bytes = await readFile(join(dir, receipt.imageFile));
    if (digest(bytes) !== receipt.sha256) throw new Error('Generated file changed.');
    const file = `${sceneId}-frame.${receipt.imageFile.split('.').at(-1)}`, key = `${sceneId}Frame`;
    if (manifest.assets[key] && manifest.assets[key].sha256 !== receipt.sha256) throw new Error('Existing candidate is preserved; use a new case version.');
    await copyFile(join(dir, receipt.imageFile), join(packDir, file));
    manifest.assets[key] = { file, mime: receipt.mime, bytes: bytes.length, sha256: receipt.sha256 };
    manifest.provenance ||= {};
    manifest.provenance[key] = { provider: 'YouMind', chatId: receipt.chatId, mediaId: receipt.result.mediaId, model: receipt.actualModel, submittedAt: receipt.submittedAt, prompt: receipt.prompt, sceneHash: receipt.sceneHash, referenceSha256: receipt.referenceHash, referenceEvidence: receipt.referenceEvidence, technical: receipt.technical, review: { status: 'pending', scope: 'scene_still_only' } };
    manifest.review = { status: 'pending' };
    try { await writeFile(join(packDir, `manifest-before-${sceneId}.json`), manifestBytes, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    // Reject a concurrent pack change instead of overwriting it.
    if (!manifestBytes.equals(await readFile(join(packDir, 'manifest.json')))) throw new Error('Baseline changed during attachment.');
    await writeFile(join(packDir, 'manifest.pending.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await rename(join(packDir, 'manifest.pending.json'), join(packDir, 'manifest.json'));
    console.log(JSON.stringify({ scene: sceneId, attached: true, sha256: receipt.sha256, review: 'pending', caseHash: demoContentHash(manifest) })); return;
  }
  process.loadEnvFile(join(project, '.env'));
  const provider = new YouMindVideoProvider({ endpoint: 'https://youmind.com', requestTimeoutMs: 45_000 });
  if (action === 'start') {
    if (receipt.status !== 'prepared') throw new Error('Submission already attempted; poll existing receipt, never resubmit.');
    const reference = await provider.readProductReference({ fileId: receipt.referenceId, sha256: receipt.referenceHash });
    if (reference.status !== 'ready') throw new Error('Public reference is not ready; no generation submitted.');
    const submittedAt = new Date().toISOString();
    await writeFile(join(dir, 'submission-claim.json'), JSON.stringify({ submittedAt, promptHash: digest(receipt.prompt) }), { flag: 'wx', mode: 0o600 });
    Object.assign(receipt, { status: 'submission_uncertain', submittedAt, referenceUrl: reference.url }); await save(receipt);
    const response = await provider.call('createChat', { message: receipt.prompt, atReferences: [{ type: 'file', id: receipt.referenceId, name: 'Official black Owala FreeSip Twist 18oz product photograph', instruction: 'Pass this exact photo into the image generation tool reference-image input. Keep the product silhouette, lid, carry loop, black color and branding. Generate one complete lifestyle scene only; never video.' }] });
    await writeFile(join(dir, 'submission-response.json'), JSON.stringify(response, null, 2), { mode: 0o600 });
    Object.assign(receipt, { chatId: chatIdOf(response), status: chatIdOf(response) ? 'submitted' : 'submission_uncertain' }); await save(receipt);
    console.log(JSON.stringify({ scene: sceneId, status: receipt.status, chatId: receipt.chatId })); return;
  }
  if (action === 'poll') {
    if (receipt.status === 'downloaded') { console.log(JSON.stringify({ scene: sceneId, status: receipt.status, imageFile: receipt.imageFile, sha256: receipt.sha256, technical: receipt.technical })); return; }
    if (!receipt.chatId) throw new Error('No resumable chat ID; inspect existing receipt before any new submission.');
    const response = await provider.call('listMessages', { chatId: receipt.chatId });
    await writeFile(join(dir, 'messages.json'), JSON.stringify(response, null, 2), { mode: 0o600 });
    const tools = imageTools(response.messages), result = extractImageResult(response.messages);
    const assistant = (response.messages || []).filter(m => m.role === 'assistant').at(-1);
    receipt.observation = { checkedAt: new Date().toISOString(), assistantStatus: assistant?.status, imageToolCalls: tools.length, toolStatuses: tools.map(t => ({ name: t.toolName, status: t.status })) };
    if (result) {
      const evidence = productReferenceEvidence(response.messages, receipt.referenceUrl, result.url);
      Object.assign(receipt, { status: 'generated', result, referenceEvidence: evidence }); await save(receipt);
      if (tools.length !== 1 || evidence.status !== 'product_reference_confirmed') throw new Error('Unexpected image count or missing actual product conditioning proof; result retained, not attached.');
      const tool = tools[0]; let args = tool.toolArguments || tool.toolInput;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      receipt.actualModel = args?.model || tool.toolResult?.model || 'unreported';
      const { bytes, mime } = await provider.downloadKeyframe(result);
      receipt.technical = await new LocalVideoAssembler().inspectKeyframe(bytes, { ratio: '9:16' });
      receipt.imageFile = `generated.${mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'}`;
      await writeFile(join(dir, receipt.imageFile), bytes, { mode: 0o600 });
      Object.assign(receipt, { status: 'downloaded', mime, bytes: bytes.length, sha256: digest(bytes), review: { status: 'pending' } }); await save(receipt);
    } else { await save(receipt); }
    console.log(JSON.stringify({ scene: sceneId, status: receipt.status, chatId: receipt.chatId, imageFile: receipt.imageFile, actualModel: receipt.actualModel, referenceEvidence: receipt.referenceEvidence?.status, technical: receipt.technical, observation: receipt.observation })); return;
  }
  throw new Error('Use prepare, start, poll or attach followed by shot1 or shot2.');
}
main().catch(e => { console.error(JSON.stringify({ code: e.code, message: e.message })); process.exitCode = 1; });
