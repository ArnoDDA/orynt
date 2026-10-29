// Exercise the actual saved media through ordinary product entities, offline.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';

// Send an explicit Host header when checking reverse-proxy deployments.
const fetch=(url,{headers={},method='GET',body}={})=>new Promise((resolve,reject)=>{
  const req=httpRequest(url,{headers,method},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{
    const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,ok:res.statusCode>=200&&res.statusCode<300,json:async()=>JSON.parse(bytes),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)});
  });});req.on('error',reject);req.end(body);
});

const project=new URL('../',import.meta.url);
const { Repository }=await import(new URL('apps/api/src/repository.js',project));
const { createApplication }=await import(new URL('apps/api/src/server.js',project));
const { DemoLibrary, digest }=await import(new URL('apps/api/src/demo-library.js',project));
const { onlineDeployment }=await import(new URL('apps/api/src/deployment-policy.js',project));
const hosted=process.env.ORYNT_VERIFY_PUBLIC==='1';
const password=randomUUID()+randomUUID();
const deployment=hosted?onlineDeployment({ORYNT_PUBLIC_ORIGIN:'https://preview.orynt.test',ORYNT_ACCESS_PASSWORD:password}):null;
const auth=deployment?{Host:deployment.host,Authorization:'Basic '+Buffer.from('demo:'+password).toString('base64')}:{};
let inventory;
try{inventory=JSON.parse(await readFile(new URL('INTEGRITY.json',project)));}catch(error){if(error.code!=='ENOENT')throw error;}
if(inventory)for(const item of inventory.files){
  const bytes=await readFile(new URL(item.path,project));assert.equal(bytes.length,item.bytes,item.path);assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,item.path);
}
const library=new DemoLibrary(fileURLToPath(new URL('.local/demo-baselines/',project)));
const loaded=await library.load(),view=loaded.view;
assert.equal(view.integrity,true,JSON.stringify(view.issues));assert.equal(view.technical.status,'passed');
const film=loaded.files.get('finalVideo')||loaded.reviewFiles.get('finalVideo');assert.ok(film);assert.equal(film.bytes.toString('ascii',4,8),'ftyp');
const dir=await mkdtemp(join(tmpdir(),'orynt-experience-'));
let app,external=0;
const forbidden=new Proxy({},{get:(_,key)=>key==='available'?true:async()=>{external++;throw new Error('Unexpected external operation');}});
const options={tickMs:0,demoLibrary:library,crawler:forbidden,metaCrawler:forbidden,productImporter:forbidden,strategyPlanner:forbidden,videoProvider:forbidden,videoAssembler:forbidden,deployment};
try{
  const db=join(dir,'verification.sqlite');
  app=createApplication({...options,repository:new Repository(db)});
  await new Promise((ok,fail)=>{app.server.once('error',fail);app.server.listen(0,'127.0.0.1',ok);});
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const get=async path=>{const res=await fetch(origin+path,{headers:auth});assert.equal(res.status,200,path);return res;};
  if(deployment){
    assert.equal((await fetch(origin+'/',{headers:{Host:deployment.host}})).status,303);
    assert.equal((await fetch(origin+'/api/state',{headers:{...auth,Origin:'https://untrusted.test'}})).status,403);
    assert.equal((await fetch(origin+'/api/state',{headers:{...auth,Host:'untrusted.test'}})).status,403);
    assert.equal((await fetch(origin+'/healthz')).status,200);
  }
  for(const path of ['/','/brand.css','/orynt-logo.svg','/app.js','/walkthrough-flow.js','/opportunity-flow.js','/opportunity.css','/api/health']){
    const response=await get(path);
    if(path.endsWith('.js'))assert.match(response.headers['content-type'],/javascript/,path);
    if(path.endsWith('.css'))assert.match(response.headers['content-type'],/text\/css/,path);
  }
  const session=await(await get('/api/session')).json();
  const command=async(action,resourceId,data={})=>{
    const res=await fetch(origin+'/api/commands',{method:'POST',headers:{...auth,...(deployment?{Origin:deployment.publicOrigin}:{}),'Content-Type':'application/json','X-Local-Session':session.token,'Idempotency-Key':randomUUID()},body:JSON.stringify({action,resourceId,data})});
    const body=await res.json();assert.ok(res.ok,`${action}: ${JSON.stringify(body.error)}`);return body.result;
  };
  const drain=async()=>{for(let i=0;i<12;i++)await app.jobRunner.tick();const failed=app.repository.read().jobs.find(j=>j.status==='failed');assert.ok(!failed,JSON.stringify(failed?.error));};
  const created=await command('campaign.create',null,{mode:'demo_replay',brandUrl:view.product.url,importFromUrl:true});await drain();
  let state=app.repository.read(),c=state.campaigns.find(x=>x.id===created.campaignId),snap=state.snapshots.find(x=>x.id===c.brandSnapshotId);
  await command('snapshot.confirm',c.id,{...c.replay.facts,brandName:'Owala',importImageIds:snap.productImport.selectedImageIds});
  await command('discovery.start',c.id);await drain();await command('cards.generate',c.id);await drain();
  state=app.repository.read();const card=state.cards.find(x=>x.campaignId===c.id),adopted=await command('card.adopt',card.id);
  const config=await command('config.create',adopted.packageId,{angleId:adopted.angleIds[0],ratio:'9:16',duration:15,language:'English',music:'ambient',productTreatment:'local_product_overlay',brandAssetIds:app.repository.read().snapshots.find(x=>x.id===c.brandSnapshotId).assetIds,scenePlan:c.replay.scenes.map(x=>({title:x.title,text:x.text})),productionCopy:c.replay.copy});
  await command('generation.start',config.configId,{mode:'storyboard'});await drain();
  const started=await command('production.start',config.configId,{keyframes:true});await drain();
  const request=()=>app.repository.read().generationRequests.find(x=>x.id===started.generationRequestId);
  assert.equal(request().production.phase,'awaiting_keyframe_review');
  await get(`/api/productions/${request().id}/shots/0/keyframe?version=1`);
  await command('production.approveKeyframe',request().id,{index:0,version:1,shotVersion:1});await drain();
  assert.equal(request().production.phase,'awaiting_review');await get(`/api/productions/${request().id}/shots/0/preview?version=1`);
  await command('production.approveShot',request().id,{index:0,version:1});await drain();
  await command('production.approveKeyframe',request().id,{index:1,version:1,shotVersion:1});await drain();
  assert.equal(request().production.phase,'completed');
  const asset=app.repository.read().assets.find(x=>x.id===request().assetId);
  assert.equal(digest(Buffer.from(await(await get(`/api/assets/${asset.id}/download`)).arrayBuffer())),digest(film.bytes));
  const seek=await fetch(`${origin}/api/assets/${asset.id}/preview`,{headers:{...auth,Range:'bytes=0-99'}});assert.equal(seek.status,206);assert.equal((await seek.arrayBuffer()).byteLength,100);
  await command('production.reviewFinal',asset.id,{checks:{identity:true,motion:true,copy:true,sound:true}});
  await command('asset.launch-ready',asset.id,{reviewed:true});
  const plan=await command('plan.save',c.id,{assetIds:[asset.id],channel:'Meta',audience:c.replay.facts.audience,hypothesis:view.creative.question});
  await command('plan.simulate-launch',plan.planId);await command('metrics.simulate',plan.planId,{confirmSimulation:true});
  state=app.repository.read();assert.equal(state.campaigns.find(x=>x.id===c.id).stage,'learning');assert.ok(state.metricSnapshots.length);assert.ok(state.metricSnapshots.every(x=>x.simulation));
  await app.close();app=null;
  const reopened=new Repository(db);try{assert.equal(reopened.read().campaigns.find(x=>x.id===c.id).stage,'learning');assert.equal(digest(Buffer.from(reopened.read().assets.find(x=>x.id===asset.id).base64,'base64')),digest(film.bytes));}finally{reopened.close();}
  assert.equal(external,0);
  console.log(JSON.stringify({result:'PASS',hosted,checks:['file integrity','real media fingerprints','HTTP startup and branding',...(hosted?['access password','host and origin rejection','public health check']:[]),'product import replay','market evidence','Card and script','keyframe and shot approvals','exact final MP4 download and seek','simulated launch and learning','SQLite restart persistence'],externalCalls:external,filmSha256:digest(film.bytes),inventoryFiles:inventory?.files.length||null},null,2));
}finally{if(app)await app.close();await rm(dir,{recursive:true,force:true});}
