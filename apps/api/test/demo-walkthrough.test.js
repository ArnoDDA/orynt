import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../src/repository.js';
import { createApplication } from '../src/server.js';
import { DemoLibrary, digest } from '../src/demo-library.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=','base64');
async function setup(overrides={}) {
  const root=await mkdtemp(join(tmpdir(),'orynt-walkthrough-')),dir=join(root,'owala-commute/v1');await mkdir(dir,{recursive:true});
  const manifest=JSON.parse(await readFile(new URL('../../../demo-cases/owala-commute.json',import.meta.url)));
  manifest.evidence=[{url:'https://www.facebook.com/ads/library/?id=123',copy:'From everyday city adventures.',advertiser:'Owala',observedAt:'2026-10-28T00:00:00Z'}];manifest.assets={};
  for(const name of ['productPhoto','fidelityStill','shot1Frame','shot2Frame','shot1Video','shot2Video','finalVideo']) {
    const video=name.endsWith('Video'),bytes=video?Buffer.from(`0000ftyp-video-fixture-${name}`):png,file=`${name}.${video?'mp4':'png'}`;
    manifest.assets[name]={file,mime:video?'video/mp4':'image/png',bytes:bytes.length,sha256:digest(bytes)};await writeFile(join(dir,file),bytes);
  }
  manifest.technical={status:'passed',duration:15,width:1080,height:1920,hasAudio:true,finalSha256:manifest.assets.finalVideo.sha256};manifest.qualityReview={status:'candidate',finalSha256:manifest.assets.finalVideo.sha256};await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  let external=0;
  const forbidden=new Proxy({available:true},{get(target,key){if(key==='available')return true;return async()=>{external++;throw new Error('Unexpected external call');};}});
  const options={tickMs:0,demoLibrary:new DemoLibrary(root),crawler:forbidden,metaCrawler:forbidden,productImporter:forbidden,strategyPlanner:forbidden,videoProvider:forbidden,videoAssembler:forbidden,...overrides};
  let app=createApplication({...options,repository:new Repository(join(root,'test.sqlite'))});
  const command=(action,id,data={})=>app.core.command(action,id,data,`test_${crypto.randomUUID()}`);
  const drain=async()=>{for(let i=0;i<12;i++)await app.jobRunner.tick();};
  return {root,dir,manifest,command,drain,get app(){return app;},get external(){return external;},async restart(){await app.close();app=createApplication({...options,repository:new Repository(join(root,'test.sqlite'))});},async close(){await app.close();await rm(root,{recursive:true,force:true});}};
}
test('a replay forks a real local edit, preserves its source, retries assembly only, and versions another re-edit without provider calls',async()=>{
  let edits=0,fail=true;
  const h=await setup({videoAssembler:{async assemble(request){edits++;assert.ok(request.localEdit);assert.equal(request.replay,undefined);assert.ok(request.production.shots.slice(0,2).every(s=>s.base64));if(fail){fail=false;throw Object.assign(new Error('Temporary editor failure'),{code:'EDITOR_BUSY'});}return {base64:Buffer.from('0000ftyp-local-edit-'+edits).toString('base64'),filename:'edit.mp4',technical:{duration:15,width:1080,height:1920,hasAudio:true,issues:[]},manifest:{localEdit:request.localEdit,copy:request.production.copy,editVersion:request.production.editVersion}};}}});
  try {
    const {c,config}=await prepared(h),started=h.command('production.start',config.configId,{keyframes:true});
    assert.throws(()=>h.command('production.forkEdit',started.generationRequestId,{copy:{opening:'Go',detail:'Daily',cta:'Explore'},music:'ambient'}),{code:'EDIT_SOURCE_NOT_READY'});
    await h.drain();h.command('production.approveKeyframe',started.generationRequestId,{index:0,version:1,shotVersion:1});await h.drain();h.command('production.approveShot',started.generationRequestId,{index:0,version:1});await h.drain();h.command('production.approveKeyframe',started.generationRequestId,{index:1,version:1,shotVersion:1});await h.drain();
    const before=h.app.repository.read(),original=before.generationRequests.find(r=>r.id===started.generationRequestId),originalAsset=before.assets.find(a=>a.id===original.assetId),body={copy:{opening:'Ready for your day.',detail:'Take your everyday further.',cta:'Explore Owala'},music:'ambient'};
    assert.throws(()=>h.command('production.forkEdit',original.id,{...body,copy:{...body.copy,cta:'x'.repeat(25)}}),{code:'INVALID_COPY'});
    const fork=h.command('production.forkEdit',original.id,body);
    assert.throws(()=>h.command('production.forkEdit',original.id,body),{code:'JOB_CONFLICT'});
    await h.drain();let s=h.app.repository.read();assert.equal(s.jobs.find(j=>j.id===fork.jobId).status,'failed');assert.equal(edits,1);
    h.command('job.retry',fork.jobId);await h.drain();s=h.app.repository.read();
    const derived=s.generationRequests.find(r=>r.id===fork.generationRequestId),asset=s.assets.find(a=>a.id===derived.assetId);
    assert.equal(derived.production.phase,'completed');assert.equal(edits,2);assert.equal(asset.qualityReview.status,'pending');assert.equal(asset.productionManifest.copy.cta,'Explore Owala');assert.equal(asset.provider,'local_editorial');
    assert.deepEqual(s.generationRequests.find(r=>r.id===original.id),original);assert.deepEqual(s.assets.find(a=>a.id===originalAsset.id),originalAsset);
    assert.throws(()=>h.command('production.reviseShot',derived.id,{index:0,version:1,text:'new'}),{code:'DEMO_INPUT_LOCKED'});
    h.command('production.reedit',derived.id,{...body,copy:{...body.copy,cta:'Meet your everyday'}});await h.drain();s=h.app.repository.read();
    const newer=s.assets.find(a=>a.id===s.generationRequests.find(r=>r.id===derived.id).assetId);
    assert.notEqual(newer.id,asset.id);assert.equal(newer.productionManifest.copy.cta,'Meet your everyday');assert.deepEqual(s.assets.find(a=>a.id===asset.id),asset);assert.equal(edits,3);assert.equal(h.external,0);
    h.app.repository.transact(s=>{const j=s.jobs.find(j=>j.id===fork.jobId);j.status='queued';delete j.resultId;j.steps[0].status='queued';});await h.drain();
    assert.equal(h.app.repository.read().jobs.find(j=>j.id===fork.jobId).error.code,'LOCAL_EDIT_ONLY');assert.equal(h.external,0);assert.equal(edits,3);
    h.command('campaign.archive',c.id);assert.throws(()=>h.command('production.forkEdit',original.id,body));
  } finally {await h.close();}
});
async function prepared(h) {
  await h.app.core.walkthrough.prepare();
  const created=h.command('campaign.create',null,{brandUrl:h.manifest.product.url,mode:'demo_replay',importFromUrl:true});await h.drain();
  let s=h.app.repository.read(),c=s.campaigns.find(c=>c.id===created.campaignId),snap=s.snapshots.find(x=>x.id===c.brandSnapshotId);
  h.command('snapshot.confirm',c.id,{...c.replay.facts,brandName:'Owala',importImageIds:snap.productImport.selectedImageIds});
  h.command('discovery.start',c.id);await h.drain();h.command('cards.generate',c.id);await h.drain();
  s=h.app.repository.read();const card=s.cards.find(x=>x.campaignId===c.id),adopted=h.command('card.adopt',card.id);
  const config=h.command('config.create',adopted.packageId,{angleId:adopted.angleIds[0],ratio:'9:16',duration:15,language:'English',music:'ambient',productTreatment:'local_product_overlay',brandAssetIds:h.app.repository.read().snapshots.find(x=>x.id===c.brandSnapshotId).assetIds,scenePlan:c.replay.scenes.map(x=>({text:x.text})),productionCopy:c.replay.copy});
  h.command('generation.start',config.configId,{mode:'storyboard'});await h.drain();
  return {c,config,created};
}
test('ordinary entities run product → evidence → card → storyboard → human shot gates → real saved film → simulated learning, with no external calls',async()=>{
  const h=await setup();try{
    const {c,config}=await prepared(h),started=h.command('production.start',config.configId,{keyframes:true});await h.drain();
    const request=()=>h.app.repository.read().generationRequests.find(x=>x.id===started.generationRequestId);
    const stateBefore=h.app.repository.read(),saved=stateBefore.configs.find(x=>x.id===config.configId),card=stateBefore.cards.find(x=>x.campaignId===c.id),content=stateBefore.cardVersions.find(x=>x.id===card.adoptedVersionId).content;
    assert.equal(content.testPlan,null);assert.equal(content.validationPlan.mode,'single_creative');
    assert.doesNotMatch(content.advertisingPlan.route.reason,/真实产品图明确/);
    assert.deepEqual(saved.scenePlan.map(x=>x.title),h.manifest.scenes.map(x=>x.title));
    assert.deepEqual(request().production.shots.map(x=>[x.title,x.text,x.start,x.end]),content.advertisingPlan.shots.map(x=>[x.title,x.description,x.start,x.end]));
    assert.deepEqual(request().production.copy,content.advertisingPlan.productionCopy);
    assert.equal(saved.advertisingPlan.shots[2].source,'continuing_video');
    assert.deepEqual(saved.advertisingPlan.shots[2].materialIds,[]);
    assert.equal(request().production.phase,'awaiting_keyframe_review');assert.equal(request().production.shots[0].base64,undefined);
    assert.throws(()=>h.command('production.approveShot',request().id,{index:0,version:1}),{code:'SHOT_NOT_READY'});
    await h.restart();await h.drain();assert.equal(request().production.phase,'awaiting_keyframe_review');
    h.command('production.approveKeyframe',request().id,{index:0,version:1,shotVersion:1});await h.drain();assert.equal(request().production.phase,'awaiting_review');
    assert.throws(()=>h.command('production.approveShot',request().id,{index:0,version:2}),{code:'STALE_SHOT'});
    h.command('production.approveShot',request().id,{index:0,version:1});await h.drain();assert.equal(request().production.phase,'awaiting_keyframe_review');
    h.command('production.approveKeyframe',request().id,{index:1,version:1,shotVersion:1});await h.drain();assert.equal(request().production.phase,'completed');
    const asset=h.app.repository.read().assets.find(x=>x.id===request().assetId);assert.equal(digest(Buffer.from(asset.base64,'base64')),h.manifest.assets.finalVideo.sha256);assert.equal(asset.qualityReview.status,'pending');
    assert.throws(()=>h.command('asset.launch-ready',asset.id,{reviewed:true}),{code:'REVIEW_REQUIRED'});
    h.command('production.reviewFinal',asset.id,{checks:{identity:true,motion:true,copy:true,sound:true}});h.command('asset.launch-ready',asset.id,{reviewed:true});
    const plan=h.command('plan.save',c.id,{assetIds:[asset.id],channel:'Meta',audience:c.replay.facts.audience,hypothesis:h.manifest.creative.question});h.command('plan.simulate-launch',plan.planId);h.command('metrics.simulate',plan.planId,{confirmSimulation:true});
    const state=h.app.core.state();assert.ok(state.metricSnapshots.length);assert.ok(state.metricSnapshots.every(x=>x.simulation));assert.equal(h.external,0);
    assert.equal(state.generationRequests.find(x=>x.id===request().id).production.shots[0].base64,undefined);
    assert.equal(state.cards.filter(x=>x.campaignId===c.id).length,1);assert.ok(state.cardEvidence.length);
    await new Promise(resolve=>h.app.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${h.app.server.address().port}`;
    const response=await fetch(`${url}/api/assets/${asset.id}/preview`,{headers:{Range:'bytes=4-7'}});assert.equal(response.status,206);assert.equal(await response.text(),'ftyp');
    assert.equal((await fetch(`${url}/api/productions/${request().id}/shots/0/keyframe?version=99`)).status,404);
    const second=await prepared(h);assert.notEqual(second.c.id,c.id);assert.notEqual(second.c.brandId,c.brandId);assert.equal(h.external,0);
  }finally{await h.close();}
});

test('a fresh demo reuses locally saved original posters only for the exact same public ad',async()=>{
  const h=await setup();try{
    const first=await prepared(h);
    h.app.repository.transact(s=>{
      const discovery=s.discoveries.find(x=>x.campaignId===first.c.id);
      const e=s.evidence.find(x=>x.discoveryId===discovery.id);
      e.attributes.media=[{status:'available',kind:'video_poster',sourceUrl:'https://cdn.example/original.png',mime:'image/png',base64:png.toString('base64'),sha256:digest(png)}];
    });
    const second=await prepared(h),s=h.app.repository.read();
    const discovery=s.discoveries.find(x=>x.campaignId===second.c.id);
    const e=s.evidence.find(x=>x.discoveryId===discovery.id);
    assert.equal(e.attributes.media[0].sha256,digest(png));
    assert.equal(e.attributes.media[0].kind,'video_poster');
    assert.equal(h.external,0);
  }finally{await h.close();}
});
test('existing replay metadata is repaired with an audit snapshot, preserving the film, confirmations and unrelated work',async()=>{
  const h=await setup();try{
    const {c,config}=await prepared(h);
    h.app.repository.transact(s=>{
      const card=s.cards.find(x=>x.campaignId===c.id),v=s.cardVersions.find(x=>x.id===card.adoptedVersionId);
      v.content.testPlan={control:'Old A',variant:'Old B'};v.content.advertisingPlan.route.reason='Old photo closing';
      const saved=s.configs.find(x=>x.id===config.configId);saved.scenePlan[2].title='Old closing';
    });
    const before=h.app.repository.read(),result=h.command('demo.alignPlan',c.id);
    const after=h.app.repository.read(),card=after.cards.find(x=>x.campaignId===c.id),v=after.cardVersions.find(x=>x.id===card.adoptedVersionId);
    assert.equal(result.aligned,true);assert.equal(v.content.testPlan,null);
    assert.equal(after.configs.find(x=>x.id===config.configId).scenePlan[2].title,h.manifest.scenes[2].title);
    assert.deepEqual(after.jobs,before.jobs);assert.equal(h.external,0);
    const event=after.audit.find(x=>x.action==='demo_plan_metadata_aligned');
    assert.equal(event.before.find(x=>x.collection==='cardVersions').values.content.testPlan.control,'Old A');
    assert.equal(h.command('demo.alignPlan',c.id).aligned,false);
    h.app.repository.transact(s=>{s.configs.find(x=>x.id===config.configId).scenePlan[0].text='A different scene';});
    assert.throws(()=>h.command('production.start',config.configId),{code:'DEMO_INPUT_LOCKED'});
  }finally{await h.close();}
});
test('different product, edited script and missing saved media cannot silently reuse a film or fall through to paid generation',async()=>{
  const h=await setup();try{
    await h.app.core.walkthrough.prepare();assert.throws(()=>h.command('campaign.create',null,{brandUrl:'https://example.org/product',mode:'demo_replay'}),{code:'DEMO_PRODUCT_MISMATCH'});
    const {c,config}=await prepared(h);
    assert.throws(()=>h.command('production.reedit',config.configId,{}),{code:'DEMO_INPUT_LOCKED'});
    const saved=h.app.repository.read().configs.find(x=>x.id===config.configId);
    assert.throws(()=>h.command('config.create',saved.packageId,{...saved,scenePlan:[{text:'A different product'}]}),{code:'DEMO_INPUT_LOCKED'});
    const started=h.command('production.start',config.configId);await writeFile(join(h.dir,h.manifest.assets.shot1Video.file),'corrupt');await h.drain();
    assert.equal(h.app.repository.read().jobs.find(x=>x.id===started.jobId).status,'failed');assert.equal(h.external,0);assert.equal(h.app.repository.read().assets.some(x=>x.type==='video'),false);
  }finally{await h.close();}
});
