import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { YouMindVideoProvider, extractVideoResultForTest as extractVideoResult } from '../apps/api/src/youmind-video-provider.js';

// A single isolated visual-quality test. Resuming never creates another paid task.
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local/quality-shot/coffee-shot-01');
const receiptPath = join(directory, 'request.json');
const run = promisify(execFile);
const prompt = [
  'Generate exactly ONE continuous 5-second video shot using Seedance 2.0, vertical 9:16, high quality, no audio. Generate the video now; no storyboard, image, HTML animation or code. Do not ask for a further credit confirmation.',
  'Premium live-action coffee commercial, photorealistic macro cinematography. Close-up of a small ivory ceramic cup on a dark walnut cafe counter. A thin continuous stream of freshly brewed black coffee enters the cup from just above the top edge of the frame. The liquid surface rises slightly, with physically plausible amber ripples and a delicate natural crema ring. Keep the cup only half full so there is no overflow.',
  'One simple composition throughout: cup centered in the lower two-thirds, warm soft window light from camera left, subtle backlit steam, realistic ceramic glaze and coffee reflections, rich natural brown and cream colors, soft out-of-focus cafe background, shallow depth of field. Slow, very subtle camera push-in; no cuts, transitions, zoom jumps or scene changes.',
  'The cup, its handle, table and lighting must remain consistent for the whole shot. No people, hands, packaging, logos, labels, subtitles or readable text. No invented product claims. No vector graphics, line drawings, sketches, flat illustration, geometric animation, cartoon, clay style, CGI appearance or motion-graphic placeholders.',
  'Use the requested 5-second duration and 9:16 frame. If these settings are unsupported, report the limitation rather than substituting another duration, ratio, or a low-quality preview. Only generate this one shot; do not generate alternatives.'
].join('\n');

async function loadReceipt() {
  try { return JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function save(receipt) {
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
}

async function main() {
  const action = process.argv[2] || 'status';
  if (!['start', 'poll', 'finish', 'collect', 'status'].includes(action)) throw new Error('Use start, poll, finish, collect or status.');
  let receipt = await loadReceipt();
  if (action === 'status') {
    console.log(JSON.stringify(receipt ? { status: receipt.status, submittedAt: receipt.submittedAt, videoPath: receipt.videoPath, technical: receipt.technical, error: receipt.error } : { status: 'not_started' }));
    return;
  }
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load local provider configuration.'); }
  const provider = new YouMindVideoProvider();
  if (!provider.available) throw new Error('YouMind is not configured; no task was submitted.');
  if (action === 'start') {
    if (receipt) throw new Error('This test already has a receipt. Use poll or finish; no second task was submitted.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    receipt = { status: 'submitting', submittedAt: new Date().toISOString(), requested: { duration: 5, ratio: '9:16', quality: 'high', audio: false }, prompt };
    // Exclusive creation prevents a second process from submitting the same experiment.
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
    try {
      const result = await provider.create({ prompt });
      Object.assign(receipt, result, { status: 'submitted' });
      await save(receipt);
      console.log(JSON.stringify({ status: receipt.status, confirmationSent: receipt.confirmationSent }));
    } catch (error) {
      Object.assign(receipt, { status: 'submission_uncertain', error: { code: error.code || 'SUBMISSION_ERROR', message: error.message } });
      await save(receipt);
      throw error;
    }
    return;
  }
  if (!receipt?.chatId) throw new Error('No resumable provider task exists. Check status before submitting.');
  if (action === 'collect') {
    // Read-only recovery of every already-generated result, including legacy duplicate submissions.
    // No confirmation messages or new generation requests are sent here.
    const response = await provider.call('listMessages', { chatId: receipt.chatId });
    const results = (response.messages || []).filter(message => message.role === 'assistant')
      .flatMap(message => (message.blocks || []).map(block => extractVideoResult([{ blocks: [block] }]))).filter(Boolean);
    const unique = [...new Map(results.map(result => [result.mediaId, result])).values()];
    receipt.variants = [];
    for (const [index, result] of unique.entries()) {
      const number = String(index + 1).padStart(2, '0');
      const videoPath = join(directory, `coffee-shot-${number}.mp4`);
      if (!(receipt.status === 'downloaded' && videoPath === receipt.videoPath && result.mediaId === receipt.result?.mediaId)) {
        await writeFile(videoPath, await provider.download(result), { mode: 0o600 });
      }
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', videoPath], { timeout: 30_000 });
      const media = JSON.parse(stdout), video = media.streams.find(stream => stream.codec_type === 'video');
      const framesPath = join(directory, `coffee-shot-${number}-frames.jpg`);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vf', 'fps=4,scale=216:-1,tile=5x4', '-frames:v', '1', '-y', framesPath], { timeout: 30_000 });
      receipt.variants.push({ mediaId: result.mediaId, videoPath, framesPath, duration: Number(media.format.duration), width: video?.width, height: video?.height, visualReview: 'pending' });
      await save(receipt);
    }
    console.log(JSON.stringify({ generatedResults: receipt.variants.length, variants: receipt.variants }));
    return;
  }
  if (receipt.status === 'downloaded') { console.log(JSON.stringify({ status: receipt.status, videoPath: receipt.videoPath, technical: receipt.technical })); return; }
  const result = await provider.poll({ chatId: receipt.chatId, prompt: receipt.prompt, confirmationSent: receipt.confirmationSent });
  Object.assign(receipt, { status: result.status, stage: result.stage, ...(result.confirmationSent !== undefined ? { confirmationSent: result.confirmationSent } : {}), lastPolledAt: new Date().toISOString() });
  if (result.status === 'succeeded') receipt.result = result;
  await save(receipt);
  if (result.status !== 'succeeded' || action === 'poll') {
    console.log(JSON.stringify({ status: receipt.status, stage: receipt.stage, lastPolledAt: receipt.lastPolledAt }));
    return;
  }
  const bytes = await provider.download(result);
  const videoPath = join(directory, 'coffee-shot-01.mp4');
  await writeFile(videoPath, bytes, { mode: 0o600 });
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', videoPath], { timeout: 30_000 });
  const media = JSON.parse(stdout), video = media.streams.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('The downloaded file has no video track.');
  const duration = Number(media.format.duration), ratio = video.width / video.height;
  const issues = [];
  if (Math.abs(duration - receipt.requested.duration) > .5) issues.push('duration_mismatch');
  if (Math.abs(ratio - 9 / 16) > .02) issues.push('aspect_ratio_mismatch');
  if (video.width < 720 || video.height < 1280) issues.push('below_720x1280');
  if (media.streams.some(stream => stream.codec_type === 'audio')) issues.push('unexpected_audio_track');
  const framesPath = join(dirname(videoPath), 'keyframes.jpg');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vf', 'fps=1,scale=320:-1,tile=5x1', '-frames:v', '1', '-y', framesPath], { timeout: 30_000 });
  Object.assign(receipt, { status: 'downloaded', videoPath, framesPath, technical: { duration, width: video.width, height: video.height, fps: video.r_frame_rate, bytes: bytes.length, issues }, visualReview: 'pending' });
  await save(receipt);
  console.log(JSON.stringify({ status: receipt.status, videoPath, framesPath, technical: receipt.technical }));
}

main().catch(error => { console.error(JSON.stringify({ code: error.code || 'QUALITY_SHOT_ERROR', message: error.message })); process.exitCode = 1; });
