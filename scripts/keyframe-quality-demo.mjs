// Isolated first-frame integration check. No original photo is uploaded.
// A video is submitted only after the normal in-product keyframe approval.
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Repository } from '../apps/api/src/repository.js';
import { Core } from '../apps/api/src/core.js';
import { createApplication } from '../apps/api/src/server.js';

const root=fileURLToPath(new URL('../.local/keyframe-quality/',import.meta.url));
await mkdir(root,{recursive:true,mode:0o700});
const repository=new Repository(`${root}/demo.sqlite`),core=new Core(repository);
let n=0;
const command=(action,id,data={})=>core.command(action,id,data,`keyframe-demo-${Date.now()}-${++n}`);
if(!repository.read().generationRequests.some(r=>r.production?.referenceMode==='generated_first_frame')){
  const original=await readFile(new URL('../.local/production-quality/product.png',import.meta.url));
  const created=command('campaign.create',null,{brandUrl:'https://www.stumptowncoffee.com/products/hair-bender',product:'Hair Bender',mode:'guided_demo'});
  const brandId=core.state().campaigns.find(c=>c.id===created.campaignId).brandId;
  command('brand.update',brandId,{name:'Stumptown Coffee'});
  command('snapshot.confirm',created.campaignId,{brandName:'Stumptown Coffee',product:'Hair Bender',claim:'A daily coffee ritual'});
  const asset=command('brandAsset.add',brandId,{name:'Hair Bender original product image',type:'product',mime:'image/png',base64:original.toString('base64')});
  command('discovery.start',created.campaignId);for(let i=0;i<3;i++)core.tick();
  command('cards.generate',created.campaignId);for(let i=0;i<3;i++)core.tick();
  const adopted=command('card.adopt',core.state().cardViews[0].id);
  const config=command('config.create',adopted.packageId,{angleId:adopted.angleIds[0],duration:15,ratio:'9:16',language:'English',brandAssetIds:[asset.assetId],productionCopy:{opening:'Make room for your morning.',detail:'Your daily ritual.',cta:'Discover Hair Bender'},music:'ambient',scenePlan:[
    {text:'Macro commercial shot of freshly brewed black coffee in one ivory ceramic cup on a dark wooden counter. Soft morning window light; the cup stays motionless and only a thin wisp of steam moves.',direction:{firstFrame:'Single ivory ceramic cup at lower right, filled with dark coffee. Dark walnut counter. Clean softly blurred background. Top third left empty for a title.',lastFrame:'Same cup in the exact same position; unchanged shape, handle and coffee level.',subjectMotion:'Only a thin natural wisp of steam rises. The cup and coffee remain still. No pouring.',cameraMotion:'Locked camera, no zoom, no slide.',lighting:'Warm soft side light from the left, dark calm background, detailed ceramic texture.',continuity:'One cup, a single handle on the right, no changing shape or objects. No people or hands.'}},
    {text:'A closer view of the same calm coffee ritual, no pouring and no new objects.'},
    {text:'Original Hair Bender product photo and invitation to discover the coffee.'}
  ]});
  command('production.start',config.configId,{keyframes:true});
}
const request=repository.read().generationRequests.find(r=>r.production?.referenceMode==='generated_first_frame'),config=repository.read().configs.find(c=>c.id===request.configId),pack=repository.read().packages.find(p=>p.id===config.packageId);
const route=`/#/campaigns/${request.campaignId}/create?cardId=${pack.cardId}&cardVersion=1&angleId=${config.angleId}&view=results&productionId=${request.id}`;
if(process.argv.includes('--export')){
  const shot=request.production.shots[0],frame=shot.keyframe;
  if(frame.base64)await writeFile(`${root}/first-frame.${frame.mime==='image/png'?'png':frame.mime==='image/webp'?'webp':'jpg'}`,Buffer.from(frame.base64,'base64'),{mode:0o600});
  if(shot.base64)await writeFile(`${root}/first-shot.mp4`,Buffer.from(shot.base64,'base64'),{mode:0o600});
  console.log(JSON.stringify({phase:request.production.phase,keyframe:{version:frame.version,sha256:frame.sha256,technical:frame.technical},shot:{status:shot.status,technical:shot.technical,controlEvidence:shot.providerState?.controlEvidence},directory:root}));
  repository.close();
}else{
const offline=process.argv.includes('--offline');
const app=createApplication({repository,tickMs:1500,metaCrawler:null,...(offline?{videoProvider:{available:false}}:{})});
app.server.listen(4187,'127.0.0.1',()=>console.log(`Isolated keyframe check: http://127.0.0.1:4187${route}`));
const stop=()=>app.close().then(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
