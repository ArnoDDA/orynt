// Isolated visual acceptance workspace. Reuses one existing paid coffee shot.
// Later shots are submitted only through the normal in-product approval command.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Repository } from '../apps/api/src/repository.js';
import { Core } from '../apps/api/src/core.js';
import { LocalProductImporter } from '../apps/api/src/product-importer.js';
import { LocalVideoAssembler } from '../apps/api/src/video-assembler.js';
import { createApplication } from '../apps/api/src/server.js';

const root=fileURLToPath(new URL('../.local/production-quality/',import.meta.url));
await mkdir(root,{recursive:true,mode:0o700});
const database=`${root}/demo.sqlite`, repository=new Repository(database), core=new Core(repository), assembler=new LocalVideoAssembler();
let n=0;
const command=(action,id,data={})=>core.command(action,id,data,`quality-${Date.now()}-${++n}`);
if(!repository.read().generationRequests.some(r=>r.workflow==='shot_pipeline')){
  const page=await new LocalProductImporter().collect({url:'https://www.stumptowncoffee.com/products/hair-bender'});
  const image=page.images.find(i=>['image/png','image/jpeg'].includes(i.mime));
  if(!image)throw new Error('No real product image available; nothing has been generated.');
  const created=command('campaign.create',null,{brandUrl:page.sourceUrl,product:page.fields.product.value,mode:'guided_demo'});
  const brandId=core.state().campaigns.find(c=>c.id===created.campaignId).brandId;
  command('brand.update',brandId,{name:page.fields.brandName.value});
  command('snapshot.confirm',created.campaignId,{brandName:page.fields.brandName.value,product:page.fields.product.value,claim:page.fields.claim.value});
  const asset=command('brandAsset.add',brandId,{name:'Hair Bender original product image',type:'product',mime:image.mime,base64:image.base64});
  command('discovery.start',created.campaignId);for(let i=0;i<3;i++)core.tick();
  command('cards.generate',created.campaignId);for(let i=0;i<3;i++)core.tick();
  const adopted=command('card.adopt',core.state().cardViews[0].id);
  const config=command('config.create',adopted.packageId,{angleId:adopted.angleIds[0],duration:15,ratio:'9:16',language:'English',brandAssetIds:[asset.assetId],productionCopy:{opening:'Make room for your morning.',detail:'Hair Bender. Your daily ritual.',cta:'Find your morning'},music:'ambient',scenePlan:[{text:'Close-up: black coffee pours into an ivory ceramic cup on a dark walnut counter. Warm window light from the left.'},{text:'The same ivory cup of freshly brewed coffee on a dark walnut counter. Delicate rising steam and a gentle sideways camera slide. No pouring, no people.'},{text:'Original Hair Bender product photo, brand name and invitation to discover the blend.'}]});
  const started=command('production.start',config.configId);
  const source=new URL('../.local/quality-shot/coffee-shot-01/coffee-shot-01.mp4',import.meta.url),bytes=await readFile(source);
  const inspected=await assembler.inspect(bytes,{duration:5,ratio:'9:16',audio:false});
  if(inspected.technical.issues.length)throw new Error('Existing source shot failed technical inspection.');
  const receipt=JSON.parse(await readFile(new URL('../.local/quality-shot/coffee-shot-01/request.json',import.meta.url),'utf8'));
  repository.transact(s=>{
    const request=s.generationRequests.find(r=>r.id===started.generationRequestId),job=s.jobs.find(j=>j.id===started.jobId);
    Object.assign(request.production.shots[0],inspected,{base64:bytes.toString('base64'),status:'ready',review:{status:'pending'},reusedFrom:'coffee-shot-01',providerState:{chatId:receipt.chatId,mediaId:receipt.result?.mediaId}});
    request.production.phase='awaiting_review';request.status='running';job.status='running';
    for(const step of job.steps.slice(0,2)){step.status='succeeded';step.finishedAt=new Date().toISOString();}
  });
  await writeFile(`${root}/product.png`,Buffer.from(image.base64,'base64'),{mode:0o600});
}
const request=repository.read().generationRequests.find(r=>r.workflow==='shot_pipeline'),config=repository.read().configs.find(c=>c.id===request.configId),pack=repository.read().packages.find(p=>p.id===config.packageId);
const route=`/#/campaigns/${request.campaignId}/create?cardId=${pack.cardId}&cardVersion=1&angleId=${config.angleId}&view=results`;
if(process.argv.includes('--export')){
  const asset=repository.read().assets.find(a=>a.id===request.assetId);
  if(!asset)throw new Error('No finished film yet.');
  await writeFile(`${root}/hair-bender-ad.mp4`,Buffer.from(asset.base64,'base64'),{mode:0o600});
  await writeFile(`${root}/manifest.json`,JSON.stringify(asset.productionManifest,null,2),{mode:0o600});
  console.log(JSON.stringify({path:`${root}/hair-bender-ad.mp4`,technical:asset.technical}));repository.close();
}else{
  const app=createApplication({repository,tickMs:1500});
  app.server.listen(4186,'127.0.0.1',()=>console.log(`Isolated quality demo: http://127.0.0.1:4186${route}`));
  const stop=()=>app.close().then(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
