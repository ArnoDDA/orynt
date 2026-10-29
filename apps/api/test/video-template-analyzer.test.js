import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalVideoTemplateAnalyzer } from '../src/video-template-analyzer.js';

const run = promisify(execFile);

test('local template analyzer reads a real MP4 and extracts private keyframes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orynt-analyzer-test-'));
  try {
    const video = join(directory, 'reference.mp4');
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=1.2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=1.2',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
      '-c:v', 'mpeg4', '-q:v', '3', video
    ]);
    const analyzer = new LocalVideoTemplateAnalyzer();
    const result = await analyzer.analyze({ mime: 'video/mp4', base64: (await readFile(video)).toString('base64') });
    assert.ok(result.duration > 2);
    assert.equal(result.width, 320);
    assert.equal(result.height, 180);
    assert.ok(result.scenes.length >= 1 && result.scenes.length <= 12);
    assert.ok(result.scenes.every(scene => Buffer.from(scene.keyframeBase64, 'base64').length > 100));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
