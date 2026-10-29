// Rebuildable local edit. Never calls a provider or accepts a candidate on behalf of a user.
import { readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest, demoContentHash } from '../apps/api/src/demo-library.js';
import { LocalVideoAssembler } from '../apps/api/src/video-assembler.js';
const version=process.argv[3]||'v1';
if(!['v1','v2'].includes(version))throw new Error('Choose v1 or v2.');
const root=fileURLToPath(new URL('../',import.meta.url)),pack=join(root,'.local/demo-baselines/owala-commute/v1'),dir=join(root,`.local/product-reference-quality/owala-commute-v1/edit-${version}`);
const outputFile=`owala-everyday-candidate-${version}.mp4`;
const run=promisify(execFile),ff=args=>run('/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-threads','2',...args],{timeout:360000,maxBuffer:3000000});
async function main(){
 const action=process.argv[2]||'render',manifestBytes=await readFile(join(pack,'manifest.json')),m=JSON.parse(manifestBytes);
 if(m.review?.status==='accepted')throw new Error('Accepted baseline is immutable.');
 for(const key of ['productPhoto','shot1Frame','shot2Frame','shot1Video','shot2Video']){
  const a=m.assets[key];if(!a||digest(await readFile(join(pack,a.file)))!==a.sha256)throw new Error(`Missing verified ${key}`);
 }
 if(action==='render'){
  if(version==='v2'){
   // Preserve the accepted opening edit byte-for-byte. Continue the city shot
   // into the close instead of cutting to a static catalogue photo.
   await copyFile(join(root,'.local/product-reference-quality/owala-commute-v1/edit-v1/clip-0.mp4'),join(dir,'clip-0.mp4'));
   await ff(['-i',join(pack,m.assets.shot2Video.file),'-loop','1','-i',join(dir,'overlay-1.png'),'-loop','1','-i',join(dir,'closing-scrim.png'),'-loop','1','-i',join(dir,'closing-title.png'),'-loop','1','-i',join(dir,'closing-cta.png'),'-filter_complex_threads','1','-filter_complex',
    '[0:v]trim=duration=10,setpts=1.2*(PTS-STARTPTS),scale=1080:1920:flags=lanczos,setsar=1,minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,tpad=stop_mode=clone:stop_duration=0.1,trim=duration=12,settb=AVTB[bg];'+
    '[1:v]format=rgba,fade=t=in:st=0:d=0.28:alpha=1,fade=t=out:st=7.65:d=0.35:alpha=1[detail];'+
    '[2:v]format=rgba,fade=t=in:st=7.85:d=0.6:alpha=1[shade];'+
    '[3:v]format=rgba,fade=t=in:st=8.05:d=0.5:alpha=1[title];'+
    '[4:v]format=rgba,fade=t=in:st=8.75:d=0.55:alpha=1[cta];'+
    '[bg][detail]overlay=0:0:format=auto[a];[a][shade]overlay=0:0:format=auto[b];'+
    "[b][title]overlay=x=0:y='12*max(0,1-(t-8.05)/0.65)':format=auto[c];"+
    "[c][cta]overlay=x=0:y='10*max(0,1-(t-8.75)/0.65)':format=auto,format=yuv420p[v]",
    '-map','[v]','-an','-t','12','-c:v','libx264','-preset','fast','-crf','18','-y',join(dir,'city-through-closing.mp4')]);
   await ff(['-i',join(dir,'clip-0.mp4'),'-i',join(dir,'city-through-closing.mp4'),'-i',join(dir,'sound-design.wav'),'-filter_complex_threads','1','-filter_complex','[0:v]settb=AVTB,setpts=PTS-STARTPTS[a];[1:v]settb=AVTB,setpts=PTS-STARTPTS[b];[a][b]xfade=transition=fade:duration=0.2:offset=3,format=yuv420p[v];[2:a]loudnorm=I=-20:TP=-1.5:LRA=7,aresample=48000[audio]','-map','[v]','-map','[audio]','-t','15','-c:v','libx264','-preset','fast','-crf','18','-c:a','aac','-b:a','192k','-ac','2','-movflags','+faststart','-y',join(dir,outputFile)]);
  }else{
  for(const [index,duration] of [[0,3.2],[1,8.2]])await ff(['-i',join(pack,m.assets[`shot${index+1}Video`].file),'-loop','1','-i',join(dir,`overlay-${index}.png`),'-filter_complex_threads','1','-filter_complex','[0:v]scale=1080:1920:flags=lanczos,setsar=1,fps=24,settb=AVTB,setpts=PTS-STARTPTS[bg];[1:v]format=rgba,fade=t=in:st=0:d=0.28:alpha=1[words];[bg][words]overlay=0:0:format=auto,format=yuv420p[v]','-map','[v]','-an','-t',String(duration),'-c:v','libx264','-preset','fast','-crf','18','-y',join(dir,`clip-${index}.mp4`)]);
  await ff(['-loop','1','-framerate','24','-i',join(dir,'endcard.png'),'-t','4','-vf','setsar=1,format=yuv420p','-an','-c:v','libx264','-preset','fast','-crf','18','-y',join(dir,'clip-2.mp4')]);
  await ff(['-i',join(dir,'clip-0.mp4'),'-i',join(dir,'clip-1.mp4'),'-i',join(dir,'clip-2.mp4'),'-i',join(dir,'sound-design.wav'),'-filter_complex_threads','1','-filter_complex','[0:v]settb=AVTB,setpts=PTS-STARTPTS[a];[1:v]settb=AVTB,setpts=PTS-STARTPTS[b];[2:v]settb=AVTB,setpts=PTS-STARTPTS[c];[a][b]xfade=transition=fade:duration=0.2:offset=3[v1];[v1][c]xfade=transition=fade:duration=0.2:offset=11,format=yuv420p[v];[3:a]loudnorm=I=-20:TP=-1.5:LRA=7,aresample=48000[audio]','-map','[v]','-map','[audio]','-t','15','-c:v','libx264','-preset','fast','-crf','18','-c:a','aac','-b:a','192k','-ac','2','-movflags','+faststart','-y',join(dir,'owala-everyday-candidate-v1.mp4')]);
  }
  const final=join(dir,outputFile);
  const technical=await new LocalVideoAssembler().probe(final,{duration:15,ratio:'9:16',audio:true});
  await ff(['-xerror','-i',final,'-f','null','-']);
  await ff(['-i',final,'-vf','fps=1,scale=216:-1,tile=5x3','-frames:v','1','-y',join(dir,'final-contact-sheet.jpg')]);
  const {stderr}=await run('/opt/homebrew/bin/ffmpeg',['-hide_banner','-i',final,'-af','ebur128=peak=true','-f','null','-'],{timeout:60000,maxBuffer:3000000});
  const content=await readFile(final);
  const timeline=version==='v2'?[{source:'shot1Video',start:0,end:3.2},{source:'shot2Video',start:3,end:15,retiming:{sourceDuration:10,editedDuration:12,interpolation:'motion_compensated_24fps'}},{source:'local_closing_typography_over_continuing_video',start:11,end:15}]:[{source:'shot1Video',start:0,end:3.2},{source:'shot2Video',start:3,end:11.2},{source:'official_product_photo_endcard',start:11,end:15}];
  const receipt={schemaVersion:1,editVersion:version,status:'candidate',createdAt:new Date().toISOString(),caseHashBeforeEdit:demoContentHash(m),sha256:digest(content),bytes:content.length,technical,workflow:'approved_product_reference_stills_to_seedance_video_to_local_edit',timeline,transitions:{type:'crossfade',seconds:.2},audio:{source:'original_local_composition',duration:15,analysis:stderr.slice(stderr.lastIndexOf('Summary:'))},inputs:Object.fromEntries(Object.entries(m.assets).filter(([k])=>k!=='finalVideo').map(([k,a])=>[k,a.sha256])),localSources:{layout:digest(await readFile(join(root,'scripts/demo-ad-layout.py'))),edit:digest(await readFile(fileURLToPath(import.meta.url)))},review:{status:'pending'}};
  await writeFile(join(dir,'edit-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:receipt.status,file:final,sha256:receipt.sha256,technical,audio:receipt.audio.analysis}));return;
 }
 if(action==='attach'){
  const r=JSON.parse(await readFile(join(dir,'edit-receipt.json'))),content=await readFile(join(dir,outputFile));
  if(digest(content)!==r.sha256||r.technical.issues.length)throw new Error('Candidate technical checks or identity failed.');
  for(const [key,hash]of Object.entries(r.inputs))if(m.assets[key]?.sha256!==hash)throw new Error('Edit inputs changed.');
  if(!manifestBytes.equals(await readFile(join(pack,'manifest.json'))))throw new Error('Concurrent baseline edit.');
  try{await writeFile(join(pack,`manifest-before-edit-${version}.json`),manifestBytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  const filename=version==='v1'?'final-video.mp4':`final-video-${version}.mp4`;
  await copyFile(join(dir,outputFile),join(pack,filename));
  m.assets.finalVideo={file:filename,mime:'video/mp4',bytes:content.length,sha256:r.sha256};
  if(version==='v2')Object.assign(m.scenes[2],{title:'让日常继续',description:'延续城市窗边的视频运镜，广告语先出现，产品名与官网入口随后淡入；产品保持在同一个真实生成场景中。',visualAsset:'shot2Frame',treatment:'continuing_video_with_local_typography'});
  m.technical={status:'passed',finalSha256:r.sha256,...r.technical};
  m.provenance.finalVideo=r;
  m.qualityReview={status:'candidate',finalSha256:r.sha256,notes:['两个镜头均使用已确认的场景图作为真实首帧输入。','请重点检查瓶盖、提环与标识在运动中是否稳定，以及镜头切换后的产品一致性。','完整广告待人工确认；当前播放的是已保存候选结果，不是现场生成。']};
  m.review={status:'pending'};
  await writeFile(join(pack,'manifest.pending.json'),JSON.stringify(m,null,2)+'\n',{mode:0o600});await rename(join(pack,'manifest.pending.json'),join(pack,'manifest.json'));
  console.log(JSON.stringify({attached:true,review:'pending',caseHash:demoContentHash(m),sha256:r.sha256}));return;
 }
 throw new Error('Use render or attach.');
}
main().catch(e=>{console.error(JSON.stringify({code:e.code,message:e.message}));process.exitCode=1;});
