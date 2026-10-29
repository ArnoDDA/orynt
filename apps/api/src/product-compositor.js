import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../services/video-production/product_layer.py', import.meta.url));
const fail = message => Object.assign(new Error(message), { code: 'PRODUCT_COMPOSITION_FAILED' });
export const compositionSize = ratio => ratio === '9:16' ? {width:720,height:1280} : ratio === '16:9' ? {width:1280,height:720} : {width:720,height:720};

export async function composeProduct({ python, ffmpeg, background, productImage, ratio, index = 0, video = false }) {
  if (!productImage?.base64) throw fail('缺少真实产品图，未提交新的生成。');
  const directory = await mkdtemp(join(tmpdir(), 'orynt-product-layer-'));
  try {
    const source = Buffer.from(productImage.base64, 'base64');
    await writeFile(join(directory,'product-source'),source,{mode:0o600});
    const size=compositionSize(ratio);
    await writeFile(join(directory,'composition.json'),JSON.stringify({...size,index}),{mode:0o600});
    if(!video&&background)await writeFile(join(directory,'background-source'),background,{mode:0o600});
    const {stdout}=await run(python,['-B',script,directory],{timeout:60_000,maxBuffer:1_000_000,env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'en_US.UTF-8',PYTHONNOUSERSITE:'1'}});
    const composition={...JSON.parse(stdout),productImageId:productImage.assetId,sourceSha256:createHash('sha256').update(source).digest('hex'),...(background?{backgroundSha256:createHash('sha256').update(background).digest('hex')}: {})};
    if(!video)return {base64:(await readFile(join(directory,background?'product-preview.jpg':'product-layer.png'))).toString('base64'),mime:background?'image/jpeg':'image/png',composition};
    await writeFile(join(directory,'background.mp4'),background,{mode:0o600});
    await run(ffmpeg,['-hide_banner','-loglevel','error','-i',join(directory,'background.mp4'),'-loop','1','-i',join(directory,'product-layer.png'),'-filter_complex',`[0:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},setsar=1,fps=24,gblur=sigma=12[bg];[bg][1:v]overlay=0:0:shortest=1:format=auto,format=yuv420p[v]`,'-map','[v]','-an','-c:v','libx264','-preset','fast','-crf','18','-movflags','+faststart','-y',join(directory,'composed.mp4')],{timeout:180_000,maxBuffer:1_000_000});
    const bytes=await readFile(join(directory,'composed.mp4'));
    if(bytes.length>20*1024*1024)throw fail('本地产品合成镜头超过 20 MB，原始背景和产品图已保留。');
    return {bytes,composition};
  } catch(error) {
    if(error.code==='PRODUCT_COMPOSITION_FAILED')throw error;
    throw fail('产品图本地合成未完成，请检查图片是否可读取；已有背景与生成回执会保留，不会重新生成。');
  } finally { await rm(directory,{recursive:true,force:true}); }
}
