import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { YouMindVideoProvider } from '../apps/api/src/youmind-video-provider.js';
import { extractImageResult } from '../apps/api/src/youmind-images.js';

// Isolated, one-image experiment. Never queues video or resubmits a paid call.
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, '.local/product-reference-quality/owala-still-01');
const receiptPath = join(dir, 'request.json');
const sourceUrl = 'https://owalalife.sg/cdn/shop/files/18oz_Black_Twist_-_SC.webp?v=1761536398';
const prompt = [
  'Generate exactly ONE high-quality photorealistic product advertising still, portrait 9:16. No video, no alternatives, no follow-up generations. This single image generation is approved.',
  'Input image 1 is the actual black Owala FreeSip Twist product photograph attached as a file reference. Use it as the image-generation tool reference-image input, not merely as textual context. You may import or inspect this public photo to obtain a usable image input. If image conditioning is unavailable, STOP and explain; do not generate from text alone.',
  'Use case: ads-marketing. Scene: one complete studio photograph of this exact black bottle standing upright on a simple matte light-grey studio tabletop, with a seamless warm off-white background. A soft side key light and restrained edge light reveal the black powder-coated surface and lid. The base rests firmly on the tabletop with a physically coherent soft contact shadow. Integrate product and surroundings under the same light and perspective, not a flat sticker or floating cutout.',
  'Composition: full bottle and loop visible, hero product occupies about 65% of frame height, slightly below center, with quiet negative space above for later typography. Near-frontal view faithful to the reference, restrained premium commercial photography, crisp product detail and natural material texture.',
  'Preserve the reference bottle silhouette, slim proportions, exact black color, cap shape, carry loop geometry and visible Owala branding. Do not invent a different cap, handle, spout, or label. Do not open or rotate the bottle. No hands, people, other containers, props, water splashes, illustration, line drawing, synthetic mockup look, title, caption or added marketing claims.',
  `Public source image: ${sourceUrl}`,
  'Before using the image-generation tool, include the actual referenced image in its reference-image/image-edit parameter. Return the single generated original image and identify the reference input used. Do not automatically retry if the first attempt fails.'
].join('\n\n');

async function save(r) { await writeFile(receiptPath, JSON.stringify(r, null, 2), { mode: 0o600 }); }
function chatIdOf(v) {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.chatId === 'string') return v.chatId;
  if (typeof v.id === 'string' && v.messages) return v.id;
  return Object.values(v).map(chatIdOf).find(Boolean) || null;
}
function summary(response) {
  return { status: response.status, messages: (response.messages || []).map(m => ({
    role: m.role, status: m.status,
    content: m.content,
    blocks: (m.blocks || []).filter(b => b.type === 'content' || ['image_generate', 'generate_image', 'generateImage'].includes(b.toolName)).map(b => ({ type: b.type, status: b.status, text: b.type === 'content' ? b.data : undefined, toolName: b.toolName, arguments: b.toolArguments, result: b.toolResult }))
  })) };
}
async function main() {
  const action = process.argv[2];
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  process.loadEnvFile(join(root, '.env'));
  const provider = new YouMindVideoProvider({ endpoint: 'https://youmind.com' });
  if (action === 'import') {
    if (receipt) throw new Error('Receipt exists; reference import will not be repeated.');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(root, '.local/orynt.sqlite'), { readOnly: true });
    let asset;
    try { asset = JSON.parse(db.prepare('SELECT payload FROM product_entities WHERE collection_name=? AND entity_id=?').get('brandAssets', 'brand_asset_041259af-85d3-48de-8a1c-fd02e835cdb9').payload); }
    finally { db.close(); }
    const bytes = Buffer.from(asset.base64.replace(/^data:[^,]+,/, ''), 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (asset.sourceUrl !== sourceUrl || hash !== 'e37bffa8fdc6cf0393ebd87b36aebcc96decd5630ed5607ad318beaa95d93655') throw new Error('Reference identity changed.');
    await writeFile(join(dir, 'reference.png'), bytes, { flag: 'wx', mode: 0o600 });
    receipt = { status: 'reference_import_submitting', sourceUrl, referenceHash: hash, prompt, createdAt: new Date().toISOString() };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    const response = await provider.call('createFileByUrl', { url: sourceUrl, title: 'Owala black FreeSip Twist — public product photo' });
    Object.assign(receipt, { status: 'reference_imported', importResponse: response });
    await save(receipt);
    console.log(JSON.stringify(response));
    return;
  }
  if (!receipt) throw new Error('No reference receipt.');
  if (action === 'file') {
    const id = process.argv[3];
    if (!id) throw new Error('Supply the imported file ID.');
    const response = await provider.call('getFile', { id });
    Object.assign(receipt, { referenceId: id, referenceResponse: response });
    await save(receipt);
    console.log(JSON.stringify(response));
    return;
  }
  if (action === 'start') {
    if (receipt.status !== 'reference_imported' || !receipt.referenceId) throw new Error('No verified reference or submission already attempted.');
    if (receipt.referenceResponse?.type !== 'image' || !receipt.referenceResponse?.file?.url?.endsWith(receipt.referenceHash)) throw new Error('Imported reference image identity is not verified.');
    Object.assign(receipt, { status: 'image_submission_uncertain', submittedAt: new Date().toISOString() });
    await save(receipt);
    const response = await provider.call('createChat', { message: prompt, atReferences: [{ type: 'file', id: receipt.referenceId, name: 'Actual black Owala FreeSip Twist product photo', instruction: 'Identity reference. Pass this image into the image-generation tool reference-image input. Preserve bottle, cap and loop geometry. Generate one still only, never video.' }] });
    receipt.chatId = chatIdOf(response);
    receipt.submissionResponse = response;
    receipt.status = receipt.chatId ? 'submitted' : 'image_submission_uncertain';
    await save(receipt);
    console.log(JSON.stringify({ status: receipt.status, chatId: receipt.chatId, response: summary(response) }));
    return;
  }
  if (action === 'poll') {
    if (!receipt.chatId) throw new Error('No resumable chat. Do not resubmit.');
    const response = await provider.call('listMessages', { chatId: receipt.chatId });
    await writeFile(join(dir, 'messages.json'), JSON.stringify(response, null, 2), { mode: 0o600 });
    const result = extractImageResult(response.messages);
    if (result) {
      receipt.result = result;
      receipt.status = 'generated';
      await save(receipt);
      const { bytes, mime } = await provider.downloadKeyframe(result);
      const imagePath = join(dir, `generated.${mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'}`);
      await writeFile(imagePath, bytes, { mode: 0o600 });
      Object.assign(receipt, { status: 'downloaded', imagePath, bytes: bytes.length });
      await save(receipt);
    }
    console.log(JSON.stringify({ status: receipt.status, imagePath: receipt.imagePath, response: summary(response) }));
    return;
  }
  throw new Error('Use import, file <id>, start or poll.');
}
main().catch(e => { console.error(JSON.stringify({ code: e.code, message: e.message })); process.exitCode = 1; });
