import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const run=promisify(execFile),cache=new Map();
const bundled=join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
// A derivative never changes the source or its acceptance hash. Fall back to
// the source if the optional preview environment is unavailable.
export async function imagePreview(file) {
  const key=createHash('sha256').update(file.bytes).digest('hex');
  if(cache.has(key))return cache.get(key);
  const pending=(async()=>{
    const directory=await mkdtemp(join(tmpdir(),'orynt-image-preview-'));
    try {
      await writeFile(join(directory,'source'),file.bytes,{mode:0o600});
      await run(process.env.ORYNT_VIDEO_PYTHON||(existsSync(bundled)?bundled:'python3'),['-B',fileURLToPath(new URL('../../../services/video-production/image_preview.py',import.meta.url)),directory],{timeout:20_000,maxBuffer:100_000});
      return {bytes:await readFile(join(directory,'preview.jpg')),mime:'image/jpeg'};
    } catch {return file;}
    finally {await rm(directory,{recursive:true,force:true});}
  })();
  cache.set(key,pending);
  while(cache.size>12)cache.delete(cache.keys().next().value);
  return pending;
}
