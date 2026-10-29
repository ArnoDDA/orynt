import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { normalizeShotDirection } from '../../../packages/domain/src/shot-direction.js';
import { composeProduct } from './product-compositor.js';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../services/video-production/layout.py', import.meta.url));
const bundledPython = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const binary = name => existsSync(`/opt/homebrew/bin/${name}`) ? `/opt/homebrew/bin/${name}` : name;
const error = (code, message) => Object.assign(new Error(message), { code });

export class LocalVideoAssembler {
  constructor({ ffmpeg = process.env.ORYNT_FFMPEG || binary('ffmpeg'), ffprobe = process.env.ORYNT_FFPROBE || binary('ffprobe'), python = process.env.ORYNT_VIDEO_PYTHON || (existsSync(bundledPython) ? bundledPython : 'python3') } = {}) { Object.assign(this, { ffmpeg, ffprobe, python }); }
  async check() {
    try {
      await Promise.all([run(this.ffmpeg, ['-version']), run(this.ffprobe, ['-version']), run(this.python, ['-B', '-c', 'from PIL import Image, ImageFont'])]);
    } catch { throw error('VIDEO_EDITOR_UNAVAILABLE', '本地剪辑环境尚未就绪，需要 FFmpeg、FFprobe 和带 Pillow 的 Python。尚未提交镜头生成。'); }
  }
  async productPreview(background,productImage,{ratio,index}) { return composeProduct({...this,background,productImage,ratio,index}); }
  async productShot(background,productImage,{ratio,index}) { return composeProduct({...this,background,productImage,ratio,index,video:true}); }
  async probe(path, { duration, ratio, audio } = {}) {
    const { stdout } = await run(this.ffprobe, ['-v','error','-show_entries','format=duration:stream=codec_type,width,height,r_frame_rate','-of','json',path], { timeout:30_000 });
    const media = JSON.parse(stdout), video = media.streams.find(s => s.codec_type === 'video');
    if (!video) throw error('INVALID_VIDEO', '生成文件没有可播放的视频轨道。');
    const actualDuration = Number(media.format.duration), [rw, rh] = ratio.split(':').map(Number), issues = [];
    if (!Number.isFinite(actualDuration) || actualDuration <= 0 || Math.abs(actualDuration - duration) > .65) issues.push('时长与要求不符');
    if (Math.abs(video.width / video.height - rw / rh) > .025) issues.push('画幅与要求不符');
    if (Math.min(video.width, video.height) < 720) issues.push('画面分辨率低于 720p');
    const hasAudio = media.streams.some(s => s.codec_type === 'audio');
    if (audio === true && !hasAudio) issues.push('缺少声音轨道');
    return { duration:actualDuration, width:video.width, height:video.height, fps:video.r_frame_rate, hasAudio, issues };
  }
  async inspect(bytes, expected) {
    const directory = await mkdtemp(join(tmpdir(), 'orynt-shot-'));
    try {
      const path = join(directory,'shot.mp4'); await writeFile(path,bytes,{mode:0o600});
      const technical = await this.probe(path, expected);
      await run(this.ffmpeg, ['-hide_banner','-loglevel','error','-ss',String(Math.min(1,technical.duration/2)),'-i',path,'-frames:v','1','-vf','scale=270:-1,format=yuvj420p','-y',join(directory,'frame.jpg')], {timeout:30_000});
      return { technical, thumbnailBase64:(await readFile(join(directory,'frame.jpg'))).toString('base64') };
    } finally { await rm(directory,{recursive:true,force:true}); }
  }
  async inspectKeyframe(bytes, {ratio}) {
    const directory=await mkdtemp(join(tmpdir(),'orynt-keyframe-'));
    try {
      const path=join(directory,'image');await writeFile(path,bytes,{mode:0o600});
      const {stdout}=await run(this.ffprobe,['-v','error','-show_entries','stream=width,height','-of','json',path],{timeout:30_000});
      const image=JSON.parse(stdout).streams?.[0], [w,h]=ratio.split(':').map(Number);
      if(!image?.width||!image.height||image.width*image.height>40_000_000)throw error('INVALID_KEYFRAME','关键帧无法解码或图片尺寸过大。');
      // ffprobe can read dimensions from a truncated header. Decode the frame
      // before offering approval, so a corrupt payload cannot become a reference.
      try {
        await run(this.ffmpeg,['-hide_banner','-loglevel','error','-xerror','-i',path,'-frames:v','1','-f','null','-'],{timeout:30_000,maxBuffer:1_000_000});
      } catch { throw error('INVALID_KEYFRAME','关键帧图片不完整或无法解码；已有生成回执已保留。'); }
      const issues=[];
      if(Math.abs(image.width/image.height-w/h)>.025)issues.push('画幅与要求不符');
      if(Math.min(image.width,image.height)<720)issues.push('图片分辨率低于 720p');
      return {width:image.width,height:image.height,issues};
    } catch (cause) {
      if(cause.code==='INVALID_KEYFRAME')throw cause;
      throw error('INVALID_KEYFRAME','关键帧无法读取或解码；已有生成回执已保留。');
    } finally { await rm(directory,{recursive:true,force:true}); }
  }
  async assemble(request, config) {
    if (request.localEdit) return this.assembleEditorial(request, config);
    const directory = await mkdtemp(join(tmpdir(), 'orynt-edit-'));
    const p = request.production, width = config.ratio === '16:9' ? 1280 : 720, height = config.ratio === '9:16' ? 1280 : 720;
    const ff = args => run(this.ffmpeg, ['-hide_banner','-loglevel','error',...args], {timeout:180_000,maxBuffer:1_000_000});
    try {
      for (const shot of p.shots.slice(0,2)) await writeFile(join(directory,`raw-${shot.index}.mp4`),Buffer.from(shot.base64,'base64'),{mode:0o600});
      await writeFile(join(directory,'product-source'),Buffer.from(p.productImage.base64,'base64'),{mode:0o600});
      await ff(['-i',join(directory,'product-source'),'-frames:v','1','-y',join(directory,'product.png')]);
      await writeFile(join(directory,'layout.json'),JSON.stringify({width,height,duration:config.duration,brandName:p.brandName,product:p.product,copy:p.copy,music:p.music}),{mode:0o600});
      await run(this.python,['-B',script,directory],{timeout:90_000,maxBuffer:1_000_000,env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'en_US.UTF-8',...(process.env.ORYNT_FONT?{ORYNT_FONT:process.env.ORYNT_FONT}:{})}});
      for (const shot of p.shots.slice(0,2)) await ff(['-i',join(directory,`raw-${shot.index}.mp4`),'-loop','1','-i',join(directory,`overlay-${shot.index}.png`),'-filter_complex',`[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=24,setpts=PTS-STARTPTS[bg];[bg][1:v]overlay=0:0:format=auto,format=yuv420p[v]`,'-map','[v]','-t',String(shot.targetDuration),'-an','-c:v','libx264','-preset','fast','-crf','19','-y',join(directory,`clip-${shot.index}.mp4`)]);
      await ff(['-loop','1','-i',join(directory,'endcard.png'),'-t',String(p.shots[2].targetDuration),'-vf','fps=24,format=yuv420p','-an','-c:v','libx264','-preset','fast','-crf','19','-y',join(directory,'clip-2.mp4')]);
      const args = [0,1,2].flatMap(i=>['-i',join(directory,`clip-${i}.mp4`)]);
      if (p.music !== 'none') args.push('-i',join(directory,'music.wav'));
      args.push('-filter_complex',`[0:v][1:v][2:v]concat=n=3:v=1:a=0,fade=t=out:st=${config.duration-.3}:d=0.3[v]`,'-map','[v]');
      if (p.music !== 'none') args.push('-map','3:a','-c:a','aac','-b:a','128k','-ac','2');
      args.push('-c:v','libx264','-preset','fast','-crf','19','-t',String(config.duration),'-movflags','+faststart','-y',join(directory,'final.mp4'));
      await ff(args);
      const technical = await this.probe(join(directory,'final.mp4'),{duration:config.duration,ratio:config.ratio,audio:p.music!=='none'});
      const bytes = await readFile(join(directory,'final.mp4'));
      if (bytes.length > 20*1024*1024) throw error('ASSET_TOO_LARGE','成片超过本地 20 MB 限制，请缩短时长后重新制作。');
      return {base64:bytes.toString('base64'),filename:'orynt-ad.mp4',technical,manifest:{workflow:'shot_pipeline',qualityChecks:p.qualityChecks,deliveryPromise:p.deliveryPromise,editVersion:p.editVersion||1,productImageId:p.productImage.assetId,productImageTreatment:p.productTreatment||'local_original_endcard',music:p.music,copy:p.copy,shots:p.shots.map(s=>({index:s.index,version:s.version,text:s.text,...(s.productComposition?{productComposition:s.productComposition}:{}),...(s.kind==='generated_shot'?{direction:normalizeShotDirection(s.direction),controlMode:s.keyframe?'agent_image_reference':'text_only',...(s.keyframe?{keyframe:{version:s.keyframe.version,source:s.keyframe.source,purpose:s.keyframe.purpose,sha256:s.keyframe.sha256,review:s.keyframe.review,technical:s.keyframe.technical,productComposition:s.keyframe.productPreview?.composition},controlEvidence:s.providerState?.controlEvidence||{status:'unverified'}}:{})}:{}),kind:s.kind,start:s.start,end:s.end,providerMediaId:s.providerState?.mediaId||null,reusedFrom:s.reusedFrom||null,technical:s.technical||null})),configId:config.id,cardVersionId:request.cardVersionId}};
    } finally { await rm(directory,{recursive:true,force:true}); }
  }
  async assembleEditorial(request, config) {
    const p=request.production;
    if(p.editStyle!=='editorial_continuing_video'||config.ratio!=='9:16'||Number(config.duration)!==15||p.shots.slice(0,2).length!==2||p.shots.slice(0,2).some(s=>!s.base64))throw error('INVALID_EDITORIAL_SOURCE','此剪辑版本需要完整的两段竖屏原始镜头。');
    await this.check();
    const directory=await mkdtemp(join(tmpdir(),'orynt-editorial-'));
    const ff=args=>run(this.ffmpeg,['-hide_banner','-loglevel','error','-threads','2',...args],{timeout:360_000,maxBuffer:1_000_000});
    try {
      const inputs=[];
      for(const [i,shot] of p.shots.slice(0,2).entries()) {
        const bytes=Buffer.from(shot.base64,'base64');
        inputs.push({index:i,sha256:createHash('sha256').update(bytes).digest('hex'),version:shot.version});
        await writeFile(join(directory,`raw-${i}.mp4`),bytes,{mode:0o600});
      }
      await writeFile(join(directory,'layout.json'),JSON.stringify({brandName:p.brandName,product:p.product,copy:p.copy,music:p.music}),{mode:0o600});
      await run(this.python,['-B',fileURLToPath(new URL('../../../services/video-production/editorial_layout.py',import.meta.url)),directory],{timeout:90_000,maxBuffer:1_000_000});
      await ff(['-i',join(directory,'raw-0.mp4'),'-loop','1','-i',join(directory,'overlay-0.png'),'-filter_complex_threads','1','-filter_complex','[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=24,settb=AVTB,setpts=PTS-STARTPTS[bg];[1:v]format=rgba,fade=t=in:st=0:d=0.28:alpha=1[words];[bg][words]overlay=0:0:format=auto,format=yuv420p[v]','-map','[v]','-an','-t','3.2','-c:v','libx264','-preset','fast','-crf','18','-y',join(directory,'opening.mp4')]);
      await ff(['-i',join(directory,'raw-1.mp4'),...['overlay-1','closing-scrim','closing-title','closing-cta'].flatMap(name=>['-loop','1','-i',join(directory,name+'.png')]),'-filter_complex_threads','1','-filter_complex',
        '[0:v]trim=duration=10,setpts=1.2*(PTS-STARTPTS),scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,tpad=stop_mode=clone:stop_duration=0.1,trim=duration=12,settb=AVTB[bg];'+
        '[1:v]format=rgba,fade=t=in:st=0:d=0.28:alpha=1,fade=t=out:st=7.65:d=0.35:alpha=1[detail];[2:v]format=rgba,fade=t=in:st=7.85:d=0.6:alpha=1[shade];[3:v]format=rgba,fade=t=in:st=8.05:d=0.5:alpha=1[title];[4:v]format=rgba,fade=t=in:st=8.75:d=0.55:alpha=1[cta];'+
        "[bg][detail]overlay=0:0:format=auto[a];[a][shade]overlay=0:0:format=auto[b];[b][title]overlay=x=0:y='12*max(0,1-(t-8.05)/0.65)':format=auto[c];[c][cta]overlay=x=0:y='10*max(0,1-(t-8.75)/0.65)':format=auto,format=yuv420p[v]",
        '-map','[v]','-an','-t','12','-c:v','libx264','-preset','fast','-crf','18','-y',join(directory,'city.mp4')]);
      const args=['-i',join(directory,'opening.mp4'),'-i',join(directory,'city.mp4')];
      if(p.music!=='none')args.push('-i',join(directory,'music.wav'));
      args.push('-filter_complex_threads','1','-filter_complex','[0:v]settb=AVTB,setpts=PTS-STARTPTS[a];[1:v]settb=AVTB,setpts=PTS-STARTPTS[b];[a][b]xfade=transition=fade:duration=0.2:offset=3,format=yuv420p[v]','-map','[v]');
      if(p.music!=='none')args.push('-map','2:a','-c:a','aac','-b:a','192k','-ac','2');
      args.push('-t','15','-c:v','libx264','-preset','fast','-crf','18','-movflags','+faststart','-y',join(directory,'final.mp4'));
      await ff(args);
      const technical=await this.probe(join(directory,'final.mp4'),{duration:15,ratio:'9:16',audio:p.music!=='none'}),bytes=await readFile(join(directory,'final.mp4'));
      if(technical.issues.length)throw error('INVALID_EDITORIAL_OUTPUT',technical.issues.join('、'));
      if(bytes.length>20*1024*1024)throw error('ASSET_TOO_LARGE','成片超过 20 MB，原版和镜头均已保留。');
      return {base64:bytes.toString('base64'),filename:'orynt-editorial.mp4',technical,manifest:{workflow:'local_editorial',localEdit:request.localEdit,editVersion:p.editVersion||1,configId:config.id,cardVersionId:request.cardVersionId,copy:p.copy,music:p.music,inputs,timeline:[{source:0,start:0,end:3.2},{source:1,start:3,end:15},{source:'animated_typography_over_continuing_video',start:11,end:15}],review:{status:'pending'}}};
    } finally { await rm(directory,{recursive:true,force:true}); }
  }
}
