// Two approved still-to-video calls. All recovery reads existing tasks; never resubmit.
import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { YouMindVideoProvider } from '../apps/api/src/youmind-video-provider.js';
import { digest, demoContentHash } from '../apps/api/src/demo-library.js';
import { LocalVideoAssembler } from '../apps/api/src/video-assembler.js';

const [action, sceneId] = process.argv.slice(2);
if (!['shot1','shot2'].includes(sceneId)) throw new Error('Choose shot1 or shot2.');
const root = fileURLToPath(new URL('../', import.meta.url));
const pack = join(root,'.local/demo-baselines/owala-commute/v1');
const dir = join(root,'.local/product-reference-quality/owala-commute-v1',sceneId,'video');
const receiptPath = join(dir,'request.json');
const json = async p => JSON.parse(await readFile(p,'utf8'));
const save = async r => { await writeFile(join(dir,'request.pending.json'),JSON.stringify(r,null,2)+'\n',{mode:0o600}); await rename(join(dir,'request.pending.json'),receiptPath); };
const run = promisify(execFile);
const videoTools = messages => (messages || []).flatMap(m=>m.blocks||[]).filter(b=>['generate_seedance_video','generateSeedanceVideo'].includes(b.toolName));

async function main(){
 const manifestBytes=await readFile(join(pack,'manifest.json')),manifest=JSON.parse(manifestBytes);
 const scene=manifest.scenes.find(s=>s.id===sceneId),still=await json(join(dir,'../request.json'));
 const bytes=await readFile(join(dir,'..',still.imageFile));
 if(still.status!=='downloaded'||digest(bytes)!==still.sha256||manifest.assets[`${sceneId}Frame`]?.sha256!==still.sha256)throw new Error('Approved still identity mismatch.');
 let receipt;try{receipt=await json(receiptPath);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(action==='prepare'){
  if(receipt){console.log(JSON.stringify({sceneId,status:receipt.status,preserved:true}));return;}
  await mkdir(dir,{recursive:true,mode:0o700});
  const prompt=[`Generate exactly ONE ${scene.generationDuration}-second video with Seedance 2.0, portrait 9:16, high quality (at least 720x1280), no audio. This one video is approved. No images, alternatives, additional takes, automatic retries or follow-up generation.`,
   `Use this exact approved generated image as the video tool first_frame_image.url (not a reconstructed text description): ${still.result.url}`,
   scene.videoPrompt,
   'Treat the supplied frame as locked product art direction. Keep realistic photographic detail, the contact shadow and wordmark unchanged throughout. No image dissolve, fake 2D product sticker, cartoon, sketch or graphics. Very restrained camera motion is preferable to product distortion.',
   'Use the exact CDN URL above without adding resize parameters or changing it to a file URL. If first-frame conditioning or the requested duration is unsupported, stop and report the limitation; do not switch to text-only generation. Generate only this single video, and return its original result.'].join('\n\n');
  receipt={schemaVersion:1,sceneId,status:'prepared',createdAt:new Date().toISOString(),caseHash:demoContentHash(manifest),sceneHash:digest(JSON.stringify(scene)),prompt,promptHash:digest(prompt),reference:{chatId:still.chatId,...still.result,sha256:still.sha256},requested:{duration:scene.generationDuration,ratio:'9:16',audio:false},authorization:{maxVideos:1,userApproved:true,scope:'approved_public_product_scene_still_to_video',automaticPaidRetries:false},stillReview:{status:'accepted',reviewer:'user',scope:'scene_still_only',sha256:still.sha256}};
  await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({sceneId,status:receipt.status,promptHash:receipt.promptHash}));return;
 }
 if(!receipt||receipt.reference.sha256!==still.sha256||receipt.sceneHash!==digest(JSON.stringify(scene)))throw new Error('Restore exact approved reference and scene.');
 if(action==='attach'){
  if(manifest.review?.status==='accepted')throw new Error('Accepted baseline is immutable.');
  if(receipt.status!=='downloaded'||receipt.result.controlEvidence?.status!=='first_frame_confirmed'||receipt.technical.issues.length)throw new Error('Verified conditioned video required.');
  const video=await readFile(join(dir,'generated.mp4'));
  if(digest(video)!==receipt.sha256)throw new Error('Video bytes changed.');
  const key=`${sceneId}Video`,file=`${sceneId}-video.mp4`;
  if(manifest.assets[key]&&manifest.assets[key].sha256!==receipt.sha256)throw new Error('Preserve existing take; use a new case version.');
  if(!manifestBytes.equals(await readFile(join(pack,'manifest.json'))))throw new Error('Concurrent baseline edit.');
  await copyFile(join(dir,'generated.mp4'),join(pack,file));
  manifest.assets[key]={file,mime:'video/mp4',bytes:video.length,sha256:receipt.sha256};
  manifest.provenance[key]={provider:'YouMind',chatId:receipt.chatId,mediaId:receipt.result.mediaId,prompt:receipt.prompt,promptHash:receipt.promptHash,submittedAt:receipt.submittedAt,referenceSha256:still.sha256,controlEvidence:receipt.result.controlEvidence,technical:receipt.technical,review:{status:'pending'}};
  manifest.provenance[`${sceneId}Frame`].review=receipt.stillReview;
  manifest.review={status:'pending'};
  await writeFile(join(pack,'manifest.pending.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});await rename(join(pack,'manifest.pending.json'),join(pack,'manifest.json'));
  console.log(JSON.stringify({sceneId,attached:true,review:'pending',sha256:receipt.sha256}));return;
 }
 if(action==='status'){console.log(JSON.stringify({sceneId,status:receipt.status,stage:receipt.stage,technical:receipt.technical}));return;}
 process.loadEnvFile(join(root,'.env'));
 const provider=new YouMindVideoProvider({endpoint:'https://youmind.com',requestTimeoutMs:45000});
 if(action==='start'){
  if(receipt.status!=='prepared')throw new Error('Submission already attempted. Poll only.');
  receipt.submittedAt=new Date().toISOString();
  await writeFile(join(dir,'submission-claim.json'),JSON.stringify({submittedAt:receipt.submittedAt,promptHash:receipt.promptHash}),{flag:'wx',mode:0o600});
  Object.assign(receipt,{status:'submission_uncertain',chatId:receipt.reference.chatId});await save(receipt);
  const response=await provider.call('sendMessage',{chatId:receipt.chatId,message:receipt.prompt,atReferences:[{type:'file',id:receipt.reference.mediaId,name:'Approved lifestyle first frame',instruction:'Use the exact approved CDN original as first_frame_image.url; do not generate a new still.'}]});
  await writeFile(join(dir,'submission-response.json'),JSON.stringify(response,null,2),{mode:0o600});
  receipt.status='submitted';await save(receipt);console.log(JSON.stringify({sceneId,status:receipt.status,chatId:receipt.chatId}));return;
 }
 if(action==='poll'||action==='confirm'){
  if(receipt.status==='downloaded'){console.log(JSON.stringify({sceneId,status:receipt.status,technical:receipt.technical}));return;}
  if(!receipt.chatId)throw new Error('No existing task.');
  const response=await provider.call('listMessages',{chatId:receipt.chatId});
  await writeFile(join(dir,'messages.json'),JSON.stringify(response,null,2),{mode:0o600});
  const index=(response.messages||[]).findLastIndex(m=>m.role==='user'&&m.content===receipt.prompt);
  const current=index>=0?response.messages.slice(index):(response.messages||[]).filter(m=>m.createdAt&&Date.parse(m.createdAt)>=Date.parse(receipt.submittedAt)-1000);
  const tools=videoTools(current);
  receipt.observation={checkedAt:new Date().toISOString(),toolCalls:tools.length,tools:tools.map(t=>({name:t.toolName,status:t.status})),assistantStatus:current.filter(m=>m.role==='assistant').at(-1)?.status};await save(receipt);
  if(tools.length>1)throw new Error('Unexpected multiple video tool calls; inspect existing receipt, no retry.');
  if(action==='confirm'){
   if(tools.length||receipt.confirmationClaimed)throw new Error('No confirmation after a video tool call or a prior confirmation.');
   const state=await provider.poll({chatId:receipt.chatId,prompt:receipt.prompt,submissionStartedAt:receipt.submittedAt,reference:receipt.reference,allowConfirmation:false});
   if(state.stage!=='awaiting_confirmation')throw new Error('Existing task is not requesting confirmation.');
   receipt.confirmationClaimed=true;await save(receipt);await provider.confirm({chatId:receipt.chatId,prompt:receipt.prompt});receipt.confirmationSent=true;await save(receipt);
   console.log(JSON.stringify({sceneId,status:'confirmation_sent'}));return;
  }
  let result;try{result=await provider.poll({chatId:receipt.chatId,prompt:receipt.prompt,submissionStartedAt:receipt.submittedAt,reference:receipt.reference,allowConfirmation:false});}catch(e){receipt.error={code:e.code,message:e.message};await save(receipt);throw e;}
  Object.assign(receipt,{status:result.status,stage:result.stage});
  if(result.status==='succeeded'){
   receipt.result=result;await save(receipt);
   if(result.controlEvidence?.status!=='first_frame_confirmed')throw new Error('Actual video-tool first-frame binding is unverified.');
   const video=await provider.download(result);await writeFile(join(dir,'generated.mp4'),video,{mode:0o600});
   receipt.technical=await new LocalVideoAssembler().probe(join(dir,'generated.mp4'),receipt.requested);
   await run('/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-xerror','-i',join(dir,'generated.mp4'),'-f','null','-'],{timeout:60000});
   await run('/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-i',join(dir,'generated.mp4'),'-vf',`fps=${8/scene.generationDuration},scale=225:-1,tile=4x2`,'-frames:v','1','-y',join(dir,'review-frames.jpg')],{timeout:60000});
   Object.assign(receipt,{status:'downloaded',sha256:digest(video),bytes:video.length,review:{status:'pending'}});
  }
  await save(receipt);console.log(JSON.stringify({sceneId,status:receipt.status,stage:receipt.stage,technical:receipt.technical,observation:receipt.observation}));return;
 }
 throw new Error('Use prepare/start/poll/confirm/status/attach and shot1/shot2.');
}
main().catch(e=>{console.error(JSON.stringify({code:e.code,message:e.message}));process.exitCode=1;});
