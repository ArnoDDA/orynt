import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const localPython = join(projectRoot, '.local/template-python/bin/python');
const legacyPython = join(projectRoot, '.local/video-python/bin/python');

export class LocalVideoTemplateAnalyzer {
  constructor({
    python = process.env.ORYNT_TEMPLATE_PYTHON || (existsSync(localPython) ? localPython : existsSync(legacyPython) ? legacyPython : process.platform === 'win32' ? 'python' : 'python3'),
    script = join(projectRoot, 'services/video-template/analyze_template.py')
  } = {}) {
    this.python = python;
    this.script = script;
  }

  async analyze(template) {
    const directory = await mkdtemp(join(tmpdir(), 'orynt-template-'));
    try {
      const extension = template.mime === 'video/webm' ? '.webm' : '.mp4';
      const input = join(directory, `input${extension}`);
      const output = join(directory, 'frames');
      await writeFile(input, Buffer.from(template.base64, 'base64'), { mode: 0o600 });
      const { stdout } = await run(this.python, [this.script, input, '--output-dir', output], {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PYTHONNOUSERSITE: '1' }
      });
      const result = JSON.parse(stdout);
      result.scenes = await Promise.all((result.scenes || []).map(async scene => {
        const filename = basename(String(scene.keyframeFile || ''));
        const path = resolve(output, filename);
        if (!filename || !path.startsWith(`${resolve(output)}${sep}`) || extname(filename).toLowerCase() !== '.jpg') {
          throw new Error('本地分析器返回了无效的关键帧路径。');
        }
        const keyframe = await readFile(path);
        return { ...scene, keyframeBase64: keyframe.toString('base64') };
      }));
      return result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
