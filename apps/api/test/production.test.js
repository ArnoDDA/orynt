import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../src/repository.js';
import { Core } from '../src/core.js';
import { LocalJobRunner } from '../src/job-runner.js';
import { createApplication } from '../src/server.js';
import { createHash } from 'node:crypto';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZkAAAAASUVORK5CYII=';
const bytes=Buffer.alloc(20); bytes.write('ftyp',4,'ascii');
function setup({path=':memory:', provider={}, assembler={}, configFields={},productionFields={}, publicOriginal=false}={}) {
  const repository=new Repository(path),core=new Core(repository);let n=0,creates=0,edits=0;
  const command=(action,id,data={})=>core.command(action,id,data,`production-${Date.now()}-${++n}`);
  const campaign=command('campaign.create',null,{brandUrl:'https://example.com',product:'Coffee',mode:'guided_demo'});
  command('snapshot.confirm',campaign.campaignId,{product:'Coffee',claim:'A warm morning'});
  command('discovery.start',campaign.campaignId);for(let i=0;i<3;i++)core.tick();
  command('cards.generate',campaign.campaignId);for(let i=0;i<3;i++)core.tick();
  const brandId=core.state().campaigns[0].brandId;
  const image=command('brandAsset.add',brandId,{name:'Original.png',type:'product',mime:'image/png',base64:png});
  if(publicOriginal)repository.transact(s=>Object.assign(s.brandAssets.find(a=>a.id===image.assetId),{source:'confirmed_website_import',sourceUrl:'https://example.com/original.png'}));
  const adopted=command('card.adopt',core.state().cardViews[0].id);
  const config=command('config.create',adopted.packageId,{angleId:adopted.angleIds[0],duration:15,ratio:'9:16',brandAssetIds:[image.assetId],productionCopy:{opening:'Your morning',detail:'Freshly brewed',cta:'Discover'},music:'ambient',...configFields});
  const started=command('production.start',config.configId,{productTreatment:'local_original_endcard',...productionFields});
  const videoProvider={available:true,create:async({prompt})=>{creates++;assert.match(prompt,/Photorealistic live-action/);assert.doesNotMatch(prompt,new RegExp(png.slice(0,20)));return {chatId:`chat-${creates}`};},poll:async()=>({status:'succeeded',mediaId:'media',url:'https://cdn.youmindassets.com/shot.mp4'}),download:async()=>bytes,...provider};
  const videoAssembler={check:async()=>{},inspect:async(_bytes,expected)=>({technical:{duration:expected.duration,width:1080,height:1920,issues:[]},thumbnailBase64:png}),assemble:async(r)=>{edits++;return {base64:bytes.toString('base64'),technical:{duration:15,width:720,height:1280,hasAudio:true,issues:[]},manifest:{copy:r.production.copy,shots:r.production.shots.map(s=>s.version)}};},...assembler};
  const runner=new LocalJobRunner({repository,core,videoProvider,videoAssembler,metaCrawler:null});runner.productionRunner.pollIntervalMs=0;
  const request=()=>repository.read().generationRequests.find(r=>r.id===started.generationRequestId);
  const run=async(n=10)=>{for(let i=0;i<n;i++)await runner.tick();};
  return {repository,core,command,started,config,image,run,runner,request,videoProvider,videoAssembler,counts:()=>({creates,edits})};
}
test('a pending video provider does not starve another product import',async()=>{
  let polls=0,imports=0;
  const h=setup({provider:{poll:async()=>{polls++;return {status:'pending'};}}});
  try {
    await h.run(4);
    const other=h.command('campaign.create',null,{brandUrl:'https://example.org/products/bottle',importFromUrl:true});
    h.runner.productImporter={collect:async()=>{imports++;return {fields:{product:{value:'Bottle'}},images:[]};}};
    await h.run(6);
    const state=h.repository.read(),job=state.jobs.find(j=>j.campaignId===other.campaignId&&j.type==='product_import');
    assert.ok(polls>0); assert.equal(imports,1); assert.equal(job.status,'succeeded');
    assert.equal(h.request().production.phase,'first_shot');
    assert.equal(h.counts().creates,1);
  } finally { h.repository.close(); }
});

test('public product references require scoped consent and pause at a verifiable image before any video call',async()=>{
  let imports=0,images=0,videos=0;
  const h=setup({publicOriginal:true,configFields:{productTreatment:'product_reference',publicReferenceConsent:true},productionFields:{productTreatment:'product_reference',keyframes:true},provider:{
    supportsProductReference:true,supportsKeyframes:true,
    importProductReference:async({url})=>{imports++;assert.equal(url,'https://example.com/original.png');return {fileId:'file'};},
    readProductReference:async r=>{assert.equal(r.sha256,createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'));return {status:'ready',mediaId:'file',url:'https://cdn.youmindassets.com/user-files/hash',source:'product_original'};},
    createKeyframe:async({prompt,productReference})=>{images++;assert.equal(productReference.mediaId,'file');assert.match(prompt,/source_image_urls/);assert.doesNotMatch(prompt,/No original product image is attached/);return {chatId:'image-chat'};},
    pollKeyframe:async({productReference})=>{assert.equal(productReference.mediaId,'file');return {status:'succeeded',url:'https://cdn.youmindassets.com/frame.png',productReferenceEvidence:{status:'product_reference_confirmed'}};},
    downloadKeyframe:async()=>({bytes:Buffer.from(png,'base64'),mime:'image/png'}),
    create:async()=>{videos++;return {chatId:'video-chat'};}
  },assembler:{inspectKeyframe:async()=>({width:1080,height:1920,issues:[]})}});
  try{
    await h.run(15);assert.equal(h.request().production.phase,'awaiting_keyframe_review');
    assert.deepEqual({imports,images,videos},{imports:1,images:1,videos:0});
    h.command('production.approveKeyframe',h.request().id,{index:0,version:1,shotVersion:1});
    await h.run(10);assert.equal(videos,1);assert.equal(images,1);assert.equal(imports,1);
    assert.throws(()=>h.command('config.create',h.config.packageId||h.request().packageId,{angleId:h.request().angleId,ratio:'9:16',duration:15,brandAssetIds:[h.image.assetId],productTreatment:'product_reference'}),{code:'PRODUCT_REFERENCE_CONSENT_REQUIRED'});
  }finally{h.repository.close();}
});

test('uncertain reference imports and unverified image conditioning never silently fall back or generate again',async()=>{
  for(const uncertain of [true,false]) {
    let imports=0,images=0;
    const h=setup({publicOriginal:true,configFields:{productTreatment:'product_reference',publicReferenceConsent:true},productionFields:{productTreatment:'product_reference',keyframes:true},provider:{
      supportsProductReference:true,supportsKeyframes:true,
      importProductReference:async()=>{imports++;if(uncertain)throw new Error('lost reply');return {fileId:'file'};},
      readProductReference:async()=>({status:'ready',mediaId:'file',url:'https://cdn.youmindassets.com/user-files/hash'}),
      createKeyframe:async()=>{images++;return {chatId:'image-chat'};},
      pollKeyframe:async()=>({status:'succeeded',url:'https://cdn.youmindassets.com/frame.png',productReferenceEvidence:{status:'unverified'}})
    },assembler:{inspectKeyframe:async()=>({width:1080,height:1920,issues:[]})}});
    try{
      await h.run(12);assert.equal(h.request().production.phase,'failed');
      h.command('job.retry',h.started.jobId);await h.run(8);
      assert.equal(imports,1);assert.equal(images,uncertain?0:1);
      assert.equal(h.request().production.shots[0].keyframe.review.status,'pending');
    }finally{h.repository.close();}
  }
});
test('real shot workflow pauses before second submission, freezes originals and requires final human review',async()=>{
  const h=setup();try{
    await h.run();assert.equal(h.request().production.phase,'awaiting_review');assert.equal(h.counts().creates,1);
    assert.equal(h.request().production.productImage.base64,png);
    const publicRequest=h.core.state().generationRequests[0];
    assert.equal(publicRequest.production.productImage.base64,undefined);assert.equal(publicRequest.production.shots[0].base64,undefined);
    assert.throws(()=>h.command('generation.start',h.config.configId,{mode:'video'}),{code:'JOB_CONFLICT'});
    h.command('production.approveShot',h.request().id,{index:0,version:1});await h.run();
    assert.deepEqual(h.counts(),{creates:2,edits:1});assert.equal(h.request().production.phase,'completed');
    const id=h.request().assetId,asset=h.core.state().assets.find(a=>a.id===id);
    assert.equal(asset.source,'orynt_composed');assert.equal(h.request().provider,'youmind_local_edit');
    assert.throws(()=>h.command('asset.launch-ready',id,{reviewed:true}),{code:'REVIEW_REQUIRED'});
    assert.throws(()=>h.command('production.reviewFinal',id,{checks:{identity:true}}),{code:'REVIEW_REQUIRED'});
    h.command('production.reviewFinal',id,{checks:{identity:true,motion:true,copy:true,sound:true}});
    h.command('asset.launch-ready',id,{reviewed:true});assert.equal(h.core.state().assets.find(a=>a.id===id).status,'launch_ready');
  }finally{h.repository.close();}
});
test('single-shot revision preserves old takes and assets and does not regenerate the other accepted shot',async()=>{
  const h=setup();try{
    await h.run();h.command('production.approveShot',h.request().id,{index:0,version:1});await h.run();
    const oldAsset=h.request().assetId;
    h.command('production.reviseShot',h.request().id,{index:1,version:1,text:'Gentler camera slide'});await h.run();
    assert.deepEqual(h.counts(),{creates:3,edits:2});assert.equal(h.request().production.shots[1].history[0].base64,bytes.toString('base64'));
    assert.ok(h.repository.read().assets.find(a=>a.id===oldAsset));assert.notEqual(h.request().assetId,oldAsset);
    assert.equal(h.core.state().generationRequests[0].production.shots[1].history[0].base64,undefined);
    assert.throws(()=>h.command('production.reviseShot',h.request().id,{index:1,version:1,text:'Stale'}),{code:'STALE_SHOT'});
  }finally{h.repository.close();}
});
test('uncertain submissions cannot be retried or revised into duplicate paid tasks',async()=>{
  const h=setup({provider:{create:async()=>{throw new Error('Connection lost');}}});try{
    await h.run();assert.equal(h.request().production.phase,'failed');
    assert.throws(()=>h.command('job.retry',h.started.jobId),{code:'VIDEO_SUBMISSION_UNCERTAIN'});
    assert.throws(()=>h.command('production.reviseShot',h.request().id,{index:0,text:'Another shot'}),{code:'VIDEO_SUBMISSION_UNCERTAIN'});
  }finally{h.repository.close();}
});
test('local copy and music edits create a fresh reviewable asset without another provider call',async()=>{
  const h=setup();try{
    await h.run();h.command('production.approveShot',h.request().id,{index:0});await h.run();const old=h.request().assetId;
    h.command('production.reedit',h.request().id,{copy:{opening:'New opening',detail:'',cta:'Learn more'},music:'none'});await h.run();
    assert.deepEqual(h.counts(),{creates:2,edits:2});assert.notEqual(h.request().assetId,old);
    const state=h.core.state();assert.equal(state.assets.find(a=>a.id===old).productionManifest.copy.opening,'Your morning');
    assert.equal(state.assets.find(a=>a.id===h.request().assetId).productionManifest.copy.opening,'New opening');
    assert.equal(state.assets.find(a=>a.id===h.request().assetId).qualityReview.status,'pending');
  }finally{h.repository.close();}
});
test('cancelling a slow submission keeps its eventual receipt without advancing; retry resumes that receipt',async()=>{
  let release;const h=setup({provider:{create:()=>new Promise(resolve=>{release=resolve;})}});try{
    await h.run(1);const pending=h.runner.tick();await new Promise(resolve=>setImmediate(resolve));
    h.command('job.cancel',h.started.jobId);release({chatId:'paid-receipt'});await pending;
    assert.equal(h.request().production.phase,'cancelled');assert.equal(h.request().production.shots[0].providerState.chatId,'paid-receipt');
    h.command('job.retry',h.started.jobId);await h.run();assert.equal(h.request().production.phase,'awaiting_review');
  }finally{h.repository.close();}
});
test('technical failure blocks acceptance; assembly retry reuses both downloaded shots',async()=>{
  let failing=true;const h=setup({assembler:{assemble:async()=>{if(failing)throw new Error('Editor interrupted');return {base64:bytes.toString('base64'),technical:{issues:[]},manifest:{}};}}});try{
    await h.run();h.command('production.approveShot',h.request().id,{index:0});await h.run();
    assert.equal(h.request().production.phase,'failed');failing=false;h.command('job.retry',h.started.jobId);await h.run();
    assert.equal(h.counts().creates,2);assert.equal(h.request().production.phase,'completed');
  }finally{h.repository.close();}
  const bad=setup({assembler:{inspect:async()=>({technical:{issues:['画幅不符']}})}});try{
    await bad.run();assert.equal(bad.request().production.phase,'failed');
    assert.throws(()=>bad.command('production.approveShot',bad.request().id,{index:0}),{code:'SHOT_NOT_READY'});
  }finally{bad.repository.close();}
});
test('restart restores first-shot review and versioned media endpoints support seeking without exposing state bytes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orynt-production-test-')),h=setup({path:join(dir,'test.sqlite')});let app;
  try{
    await h.run();const id=h.request().id;h.repository.close();
    app=createApplication({repository:new Repository(join(dir,'test.sqlite')),tickMs:0,videoProvider:h.videoProvider,videoAssembler:h.videoAssembler});
    await app.jobRunner.tick();assert.equal(app.repository.read().generationRequests[0].production.phase,'awaiting_review');
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
    const response=await fetch(`${base}/api/productions/${id}/shots/0/preview?version=1`,{headers:{Range:'bytes=4-7'}});
    assert.equal(response.status,206);assert.equal(await response.text(),'ftyp');
    assert.equal((await fetch(`${base}/api/productions/${id}/shots/0/preview?version=99`)).status,404);
    assert.equal((await fetch(`${base}/production-flow.js`)).headers.get('content-type'),'text/javascript; charset=utf-8');
    for(const path of ['/shot-direction-view.js','/packages/domain/src/shot-direction.js','/production-quality-view.js','/packages/domain/src/production-plan.js','/packages/domain/src/production-quality.js','/packages/domain/src/vendor/openmontage/production-checks.js']) {
      const response=await fetch(`${base}${path}`);
      assert.equal(response.headers.get('content-type'),'text/javascript; charset=utf-8');
      assert.doesNotMatch(await response.text(),/<!doctype html>/i);
    }
  }finally{if(app)await app.close();else h.repository.close();rmSync(dir,{recursive:true,force:true});}
});

test('duplicate scenes fail before queueing and invalid revisions keep the accepted take intact', async () => {
  const h = setup();
  try {
    await h.run();
    const saved = h.core.state().configs.find(c => c.id === h.config.configId);
    const duplicate = h.command('config.create', saved.packageId, { ...saved, scenePlan: [{ text: '同一个画面。' }, { text: ' 同一个画面！' }, { text: '收尾' }] });
    const before = structuredClone(h.request());
    assert.throws(() => h.command('production.reviseShot', before.id, { index: 0, version: 1, text: before.production.shots[1].text }), { code: 'PRODUCTION_PLAN_ISSUES' });
    assert.deepEqual(h.request(), before);
    assert.equal(h.counts().creates, 1);
    assert.equal(h.request().production.qualityChecks.plan.valid, true);
    h.command('job.cancel', h.started.jobId);
    const requestsBefore = h.core.state().generationRequests.length;
    assert.throws(() => h.command('production.start', duplicate.configId), { code: 'PRODUCTION_PLAN_ISSUES' });
    assert.equal(h.core.state().generationRequests.length, requestsBefore);
  } finally { h.repository.close(); }
});

test('delivery guard blocks assembly with missing media and retry reuses both existing provider receipts', async () => {
  const h = setup();
  try {
    await h.run();
    h.repository.transact(s => { s.generationRequests.find(r => r.id === h.request().id).production.shots[0].base64 = ''; });
    h.command('production.approveShot', h.request().id, { index: 0, version: 1 });
    await h.run();
    assert.equal(h.request().production.phase, 'failed');
    assert.equal(h.request().production.qualityChecks.delivery.valid, false);
    assert.deepEqual(h.counts(), { creates: 2, edits: 0 });
    assert.equal(h.core.state().jobs.find(j => j.id === h.started.jobId).error.code, 'PRODUCTION_DELIVERY_ISSUES');
    h.repository.transact(s => { s.generationRequests.find(r => r.id === h.request().id).production.shots[0].base64 = bytes.toString('base64'); });
    h.command('job.retry', h.started.jobId);
    await h.run();
    assert.equal(h.request().production.phase, 'completed');
    assert.equal(h.request().production.qualityChecks.delivery.valid, true);
    assert.equal(h.request().production.qualityChecks.delivery.motionSeconds, 11);
    assert.deepEqual(h.counts(), { creates: 2, edits: 1 });
  } finally { h.repository.close(); }
});

test('production requires an actual selected product photo and checks local editing before spending',async()=>{
  const h=setup({assembler:{check:async()=>{throw Object.assign(new Error('Editor missing'),{code:'VIDEO_EDITOR_UNAVAILABLE'});}}});try{
    await h.run();assert.equal(h.counts().creates,0);
    const saved=h.core.state().configs.find(c=>c.id===h.config.configId);
    const empty=h.command('config.create',saved.packageId,{...saved,brandAssetIds:[]});
    assert.throws(()=>h.command('production.start',empty.configId),{code:'PRODUCT_PHOTO_REQUIRED'});
    assert.throws(()=>h.command('config.create',saved.packageId,{...saved,productionCopy:{cta:'a'.repeat(25)}}),{code:'INVALID_COPY'});
  }finally{h.repository.close();}
});
test('structured shot design reaches submission and revision without rewriting the previous take',async()=>{
  const scenePlan=[{text:'磨豆机正面特写',direction:{firstFrame:'磨豆机位于右侧',subjectMotion:'磨盘保持静止',cameraMotion:'固定机位'}},{text:'按钮近景'},{text:'产品收尾'}];
  const h=setup({configFields:{scenePlan}});try{
    await h.run();
    const before=h.request().production.shots[0];
    assert.match(before.prompt,/Subject action: 磨盘保持静止/);
    h.command('production.reviseShot',h.request().id,{index:0,version:1,text:'磨豆机启动',direction:{firstFrame:'磨豆机位于右侧',subjectMotion:'手指按下启动按钮',cameraMotion:'固定机位'}});
    await h.run();
    const after=h.request().production.shots[0];
    assert.equal(after.history[0].direction.subjectMotion,'磨盘保持静止');
    assert.match(after.history[0].prompt,/Subject action: 磨盘保持静止/);
    assert.match(after.prompt,/Subject action: 手指按下启动按钮/);
    assert.doesNotMatch(after.prompt,/磨盘保持静止|ivory ceramic cup/);
    assert.equal(h.counts().creates,2);
    assert.equal(h.request().production.phase,'awaiting_review');
  }finally{h.repository.close();}
});

test('legacy text-only shot revisions discard obsolete detailed motion',async()=>{
  const h=setup({configFields:{scenePlan:[{text:'磨豆机静止',direction:{subjectMotion:'保持静止'}},{text:'细节'},{text:'收尾'}]}});try{
    await h.run();
    h.command('production.reviseShot',h.request().id,{index:0,version:1,text:'手指按下开关'});
    await h.run();
    assert.deepEqual(h.request().production.shots[0].direction,{});
    assert.doesNotMatch(h.request().production.shots[0].prompt,/Subject action: 保持静止/);
  }finally{h.repository.close();}
});

test('polling uses the frozen submitted prompt even if a newer builder would produce different instructions',async()=>{
  let polledPrompt;
  const h=setup({provider:{poll:async({prompt})=>{polledPrompt=prompt;return {status:'succeeded',mediaId:'existing',url:'https://cdn.youmindassets.com/shot.mp4'};}}});try{
    await h.run(2);
    const originalPrompt=h.request().production.shots[0].prompt;
    assert.ok(originalPrompt);
    h.repository.transact(s=>{s.generationRequests.find(r=>r.id===h.request().id).production.shots[0].text='Changed after submission';});
    await h.run();
    assert.equal(polledPrompt,originalPrompt);
    assert.equal(h.counts().creates,1);
  }finally{h.repository.close();}
});

function keyframeSetup(options={}) {
  let images=0;const references=[];
  const h=setup({...options,productionFields:{keyframes:true,...options.productionFields},provider:{supportsKeyframes:true,
    createKeyframe:async({prompt})=>{images++;assert.match(prompt,/image only/);assert.doesNotMatch(prompt,new RegExp(png.slice(0,20)));return {chatId:`frame-chat-${images}`};},
    pollKeyframe:async({chatId})=>({status:'succeeded',url:`https://cdn.youmindassets.com/${chatId}.png`}),
    downloadKeyframe:async()=>({bytes:Buffer.from(png,'base64'),mime:'image/png'}),
    create:async({prompt,reference})=>{assert.ok(reference.url);assert.ok(prompt.includes(reference.url));references.push(reference);return {chatId:reference.chatId};},
    ...options.provider
  },assembler:{inspectKeyframe:async()=>({width:720,height:1280,issues:[]}),...options.assembler}});
  return {...h,imageCount:()=>images,references};
}
const approveFrame=(h,index=0)=>{const shot=h.request().production.shots[index];return h.command('production.approveKeyframe',h.request().id,{index,version:shot.keyframe.version,shotVersion:shot.version});};

function localAssembler(overrides={}) {
  const composition=image=>({layoutVersion:'original-photo-plate-v1',sourceSha256:createHash('sha256').update(Buffer.from(image.base64,'base64')).digest('hex'),productImageId:image.assetId,productMotion:'static_local_layer',network:false});
  return {
    productPreview:async(_background,image)=>({base64:Buffer.from('local-preview').toString('base64'),mime:'image/jpeg',composition:composition(image)}),
    productShot:async(_background,image)=>({bytes:Buffer.from('composite-video'),composition:composition(image)}),
    ...overrides
  };
}
test('new keyframe productions default to local originals and gate both composite previews before delivery',async()=>{
  const h=keyframeSetup({productionFields:{productTreatment:undefined},assembler:localAssembler()});try{
    await h.run();assert.equal(h.request().production.productTreatment,'local_product_overlay');
    assert.equal(h.request().production.phase,'awaiting_keyframe_review');assert.equal(h.references.length,0);
    assert.ok(h.request().production.shots[0].keyframe.productPreview.base64);
    const publicShot=h.core.state().generationRequests[0].production.shots[0];
    assert.equal(publicShot.keyframe.productPreview.base64,undefined);
    approveFrame(h);await h.run();assert.equal(h.request().production.phase,'awaiting_review');
    assert.equal(h.request().production.shots[0].backgroundBase64,bytes.toString('base64'));
    assert.equal(h.request().production.shots[0].base64,Buffer.from('composite-video').toString('base64'));
    assert.equal(h.core.state().generationRequests[0].production.shots[0].backgroundBase64,undefined);
    h.command('production.approveShot',h.request().id,{index:0,version:1});await h.run();
    assert.equal(h.request().production.phase,'awaiting_keyframe_review');assert.equal(h.references.length,1);
    approveFrame(h,1);await h.run();assert.equal(h.request().production.phase,'completed');
    assert.equal(h.request().production.qualityChecks.delivery.valid,true);assert.equal(h.references.length,2);
    assert.ok(h.references.every(ref=>!JSON.stringify(ref).includes(png)));
  }finally{h.repository.close();}
});
test('local preparation fails before spending; a missing composite preview cannot be approved',async()=>{
  const h=keyframeSetup({productionFields:{productTreatment:'local_product_overlay'}});try{
    await h.run();assert.equal(h.imageCount(),0);assert.equal(h.references.length,0);
    assert.equal(h.core.state().jobs.find(j=>j.id===h.started.jobId).error.code,'PRODUCT_COMPOSITION_UNAVAILABLE');
  }finally{h.repository.close();}
  const ready=keyframeSetup({productionFields:{productTreatment:'local_product_overlay'},assembler:localAssembler()});try{
    await ready.run();ready.repository.transact(s=>{delete s.generationRequests[0].production.shots[0].keyframe.productPreview;});
    assert.throws(()=>approveFrame(ready),{code:'PRODUCT_PREVIEW_REQUIRED'});
  }finally{ready.repository.close();}
});
test('local composition failures preserve paid image/video bytes and retry without provider resubmission',async()=>{
  let failPreview=true,failVideo=true,downloads=0;
  const impl=localAssembler();
  const h=keyframeSetup({productionFields:{productTreatment:'local_product_overlay'},provider:{download:async()=>{downloads++;return bytes;}},assembler:localAssembler({
    productPreview:async(background,image)=>{if(background&&failPreview){failPreview=false;throw new Error('Local preview interrupted');}return impl.productPreview(background,image);},
    productShot:async(background,image)=>{if(failVideo){failVideo=false;throw new Error('Local encoding interrupted');}return impl.productShot(background,image);}
  })});try{
    await h.run();assert.equal(h.request().production.phase,'failed');assert.ok(h.request().production.shots[0].keyframe.base64);
    h.command('job.retry',h.started.jobId);await h.run();assert.equal(h.imageCount(),1);
    approveFrame(h);await h.run();assert.equal(h.request().production.phase,'failed');assert.ok(h.request().production.shots[0].backgroundBase64);
    h.command('job.retry',h.started.jobId);await h.run();assert.equal(h.request().production.phase,'awaiting_review');
    assert.equal(h.references.length,1);assert.equal(downloads,1);
  }finally{h.repository.close();}
});
test('forking a legacy film preserves originals and reuses first media without any new generation',async()=>{
  const h=keyframeSetup({assembler:localAssembler()});try{
    await h.run();approveFrame(h);await h.run();const before=structuredClone(h.request());
    const fork=h.command('production.localProductVersion',before.id);
    const current=()=>h.repository.read().generationRequests.find(r=>r.id===fork.generationRequestId);
    await h.run();assert.equal(current().production.phase,'awaiting_keyframe_review');
    assert.equal(current().derivedFrom,before.id);assert.equal(h.request().production.phase,'cancelled');
    assert.equal(h.request().production.shots[0].base64,before.production.shots[0].base64);
    assert.equal(h.request().production.shots[0].keyframe.base64,before.production.shots[0].keyframe.base64);
    h.command('production.approveKeyframe',current().id,{index:0,version:1,shotVersion:1});await h.run();
    assert.equal(current().production.phase,'awaiting_review');assert.equal(h.references.length,1);assert.equal(h.imageCount(),1);
    assert.equal(current().production.shots[0].providerState.chatId,before.production.shots[0].providerState.chatId);
    assert.ok(current().production.shots[0].productComposition);
    assert.throws(()=>h.command('production.localProductVersion',current().id),{code:'INVALID_PRODUCTION'});
  }finally{h.repository.close();}
});
test('revising a reused background discards its video; local media endpoint never silently serves raw background',async()=>{
  const h=keyframeSetup({assembler:localAssembler()});let app;
  try{
    await h.run();approveFrame(h);await h.run();const fork=h.command('production.localProductVersion',h.request().id);await h.run();
    app=createApplication({repository:h.repository,tickMs:0,videoProvider:h.videoProvider,videoAssembler:h.videoAssembler});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}/api/productions/${fork.generationRequestId}/shots/0/keyframe?version=1&shotVersion=1`;
    assert.equal(await(await fetch(base)).text(),'local-preview');
    assert.equal(Buffer.from(await(await fetch(base+'&layer=background')).arrayBuffer()).toString('base64'),png);
    h.command('production.reviseKeyframe',fork.generationRequestId,{index:0,version:1,shotVersion:1,text:'A different soft studio environment'});
    const shot=h.repository.read().generationRequests.find(r=>r.id===fork.generationRequestId).production.shots[0];
    assert.equal(shot.backgroundBase64,undefined);assert.equal(shot.providerState,undefined);assert.equal(shot.reusedFrom,undefined);
    const state=h.core.state().generationRequests.find(r=>r.id===fork.generationRequestId).production.shots[0];
    assert.equal(state.keyframe.history[0].productPreview.base64,undefined);
    assert.equal((await fetch(base.replace('version=1&','version=2&'))).status,404);
  }finally{if(app)await app.close();else h.repository.close();}
});
test('video recovery rechecks a terminal failure, archives its receipt, and resubmits only video with the same approved frame',async()=>{
  let creates=0,polls=0;
  const h=keyframeSetup({provider:{create:async()=>({chatId:`video-${++creates}`}),poll:async args=>{
    polls++;
    if(creates===1){if(polls===2)assert.equal(args.allowConfirmation,false);throw Object.assign(new Error('Bad reference URL'),{code:'VIDEO_REFERENCE_MISMATCH',providerFailure:{confirmedNoVideo:true,actualReference:'https://cdn.youmindassets.com/frame.png.'}});}
    return {status:'succeeded',url:'https://cdn.youmindassets.com/recovered.mp4',mediaId:'video-2'};
  }}});
  try{
    await h.run();approveFrame(h);await h.run();assert.equal(h.request().production.phase,'failed');
    const frame=structuredClone(h.request().production.shots[0].keyframe);
    h.repository.transact(s=>{const j=s.jobs.find(j=>j.id===h.started.jobId);j.steps.find(s=>s.key==='generate_first_shot').attempts=3;});
    h.command('production.recoverVideo',h.request().id,{index:0,version:1,resubmit:true});
    await h.run(1);assert.equal(creates,1);assert.equal(h.request().production.shots[0].videoAttempts.length,1);
    await h.run();const shot=h.request().production.shots[0];
    assert.equal(h.request().production.phase,'awaiting_review');assert.equal(creates,2);assert.equal(h.imageCount(),1);
    assert.deepEqual(shot.keyframe,frame);assert.equal(shot.videoAttempts[0].providerState.chatId,'video-1');
    assert.equal(shot.providerState.chatId,'video-2');assert.ok(shot.prompt.includes(`\n${JSON.stringify(frame.providerState.url)}\n`));
    assert.throws(()=>h.command('production.recoverVideo',h.request().id,{index:0,version:1,resubmit:true}),{code:'VIDEO_NOT_RECOVERABLE'});
  }finally{h.repository.close();}
});
test('unknown video outcomes cannot trigger resubmission and late successes reuse the original receipt',async()=>{
  let creates=0,outcome='unknown';
  const h=keyframeSetup({provider:{create:async()=>({chatId:`video-${++creates}`}),poll:async()=>{
    if(outcome==='unknown')throw Object.assign(new Error('No verifiable result'),{code:'REFERENCE_VIDEO_RESULT_MISSING'});
    return {status:'succeeded',url:'https://cdn.youmindassets.com/late.mp4',mediaId:'late'};
  }}});
  try{
    await h.run();approveFrame(h);await h.run();
    h.command('production.recoverVideo',h.request().id,{index:0,version:1,resubmit:true});await h.run();
    assert.equal(h.request().production.phase,'failed');assert.equal(creates,1);assert.equal(h.request().production.shots[0].videoAttempts,undefined);
    outcome='succeeded';h.command('production.recoverVideo',h.request().id,{index:0,version:1,resubmit:true});await h.run();
    assert.equal(h.request().production.phase,'awaiting_review');assert.equal(creates,1);assert.equal(h.imageCount(),1);
    assert.equal(h.request().production.shots[0].providerState.chatId,'video-1');
  }finally{h.repository.close();}
});
test('read-only video checks and still-running provider tasks cannot spend a second submission',async()=>{
  let creates=0,outcome='failed';
  const h=keyframeSetup({provider:{create:async()=>({chatId:`video-${++creates}`}),poll:async args=>{
    if(outcome==='pending'){assert.equal(args.allowConfirmation,false);return {status:'pending'};}
    throw Object.assign(new Error('Failed'),{code:'VIDEO_PROVIDER_FAILED',providerFailure:{confirmedNoVideo:true}});
  }}});
  try{
    await h.run();approveFrame(h);await h.run();
    h.command('production.recoverVideo',h.request().id,{index:0,version:1});await h.run();
    assert.equal(creates,1);assert.equal(h.request().production.phase,'failed');
    outcome='pending';h.command('production.recoverVideo',h.request().id,{index:0,version:1,resubmit:true});await h.run();
    assert.equal(creates,1);assert.equal(h.request().production.shots[0].videoAttempts,undefined);
    h.command('job.cancel',h.started.jobId);await h.run();assert.equal(h.request().production.phase,'cancelled');assert.equal(creates,1);
  }finally{h.repository.close();}
});
test('image receipt failures resume the paid image without resubmitting or bypassing review, even after restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orynt-frame-recovery-'));let downloads=0,app;
  const h=keyframeSetup({path:join(dir,'test.sqlite'),provider:{downloadKeyframe:async()=>{
    if(++downloads===1)throw Object.assign(new Error('Old 5 MB limit'),{code:'ASSET_TOO_LARGE'});
    return {bytes:Buffer.from(png,'base64'),mime:'image/png'};
  }}});
  try{
    await h.run();const failed=h.request(),receipt=failed.production.shots[0].keyframe.providerState;
    assert.equal(failed.production.phase,'failed');assert.ok(receipt.url);assert.equal(h.imageCount(),1);assert.equal(h.references.length,0);
    h.repository.close();
    app=createApplication({repository:new Repository(join(dir,'test.sqlite')),tickMs:0,videoProvider:h.videoProvider,videoAssembler:h.videoAssembler});
    app.jobRunner.productionRunner.pollIntervalMs=0;
    app.core.command('job.retry',h.started.jobId,{},'resume-existing-image');
    assert.equal(app.repository.read().generationRequests.find(r=>r.id===failed.id).production.shots[0].status,'planning');
    for(let i=0;i<5;i++)await app.jobRunner.tick();
    const request=app.repository.read().generationRequests.find(r=>r.id===failed.id),frame=request.production.shots[0].keyframe;
    assert.equal(request.production.phase,'awaiting_keyframe_review');assert.equal(frame.base64,png);
    assert.equal(frame.providerState.chatId,receipt.chatId);assert.equal(frame.providerState.url,receipt.url);
    assert.equal(h.imageCount(),1);assert.equal(h.references.length,0);assert.equal(downloads,2);
  }finally{if(app)await app.close();else h.repository.close();rmSync(dir,{recursive:true,force:true});}
});
test('a corrupt download is not cached as a reviewable frame and retry can fetch the existing image again',async()=>{
  let inspections=0,downloads=0;
  const h=keyframeSetup({provider:{downloadKeyframe:async()=>{downloads++;return {bytes:Buffer.from(png,'base64'),mime:'image/png'};}},assembler:{inspectKeyframe:async()=>{
    if(++inspections===1)throw Object.assign(new Error('Truncated image'),{code:'INVALID_KEYFRAME'});
    return {width:720,height:1280,issues:[]};
  }}});
  try{
    await h.run();assert.equal(h.request().production.phase,'failed');
    assert.equal(h.request().production.shots[0].keyframe.base64,undefined);
    h.command('job.retry',h.started.jobId);await h.run();
    assert.equal(h.request().production.phase,'awaiting_keyframe_review');
    assert.equal(h.imageCount(),1);assert.equal(downloads,2);assert.equal(h.references.length,0);
  }finally{h.repository.close();}
});
test('keyframe production gates each video on its approved real image and never uploads the local product photo',async()=>{
  const h=keyframeSetup();try{
    await h.run();assert.equal(h.request().production.phase,'awaiting_keyframe_review');assert.equal(h.imageCount(),1);assert.equal(h.references.length,0);
    const frame=h.request().production.shots[0].keyframe;
    assert.equal(frame.base64,png);assert.ok(frame.sha256);
    assert.equal(h.core.state().generationRequests[0].production.shots[0].keyframe.base64,undefined);
    assert.throws(()=>h.command('production.approveShot',h.request().id,{index:0}),{code:'SHOT_NOT_READY'});
    approveFrame(h);await h.run();assert.equal(h.request().production.phase,'awaiting_review');assert.equal(h.references.length,1);
    assert.equal(h.references[0].chatId,frame.providerState.chatId);
    h.command('production.approveShot',h.request().id,{index:0});await h.run();
    assert.equal(h.request().production.phase,'awaiting_keyframe_review');assert.equal(h.references.length,1);assert.equal(h.imageCount(),2);
    approveFrame(h,1);await h.run();assert.equal(h.request().production.phase,'completed');assert.equal(h.references.length,2);
    const before=h.request().production.shots[1].keyframe;
    h.command('production.reviseShot',h.request().id,{index:1,version:1,text:'A simpler shot'});await h.run();
    assert.equal(h.request().production.phase,'awaiting_keyframe_review');assert.equal(h.references.length,2);
    assert.equal(h.request().production.shots[1].history[0].keyframe.sha256,before.sha256);
  }finally{h.repository.close();}
});
test('rejecting every candidate retains image history, clears old instructions and rejects stale acceptance',async()=>{
  const h=keyframeSetup();try{
    await h.run();
    h.command('production.reviseKeyframe',h.request().id,{index:0,version:1,shotVersion:1,text:'Static grinder on a dark table',direction:{firstFrame:'Grinder at right'}});
    await h.run();const shot=h.request().production.shots[0];
    assert.equal(shot.keyframe.version,2);assert.equal(shot.keyframe.history[0].base64,png);assert.equal(shot.keyframe.history[0].review.status,'rejected');
    assert.match(shot.keyframe.prompt,/Grinder at right/);assert.equal(h.references.length,0);
    assert.equal(h.core.state().generationRequests[0].production.shots[0].keyframe.history[0].base64,undefined);
    assert.throws(()=>h.command('production.approveKeyframe',h.request().id,{index:0,version:1,shotVersion:1}),{code:'STALE_SHOT'});
    approveFrame(h);await h.run();assert.equal(h.references[0].chatId,'frame-chat-2');
  }finally{h.repository.close();}
});
test('uncertain image submissions cannot be retried or bypassed by revising a shot',async()=>{
  const h=keyframeSetup({provider:{createKeyframe:async()=>{throw new Error('Receipt lost');}}});try{
    await h.run();assert.equal(h.request().production.phase,'failed');
    assert.throws(()=>h.command('job.retry',h.started.jobId),{code:'KEYFRAME_SUBMISSION_UNCERTAIN'});
    assert.throws(()=>h.command('production.reviseShot',h.request().id,{index:0,text:'New scene'}),{code:'KEYFRAME_SUBMISSION_UNCERTAIN'});
    assert.throws(()=>h.command('production.reviseKeyframe',h.request().id,{index:0,version:1,shotVersion:1,text:'New scene'}),{code:'KEYFRAME_SUBMISSION_UNCERTAIN'});
  }finally{h.repository.close();}
});
test('image cancellation retains the eventual receipt and resumes without a second image submission',async()=>{
  let release,submitted=0;
  const h=keyframeSetup({provider:{createKeyframe:async()=>{submitted++;return new Promise(r=>release=r);}}});try{
    await h.run(1);const pending=h.runner.tick();await new Promise(r=>setImmediate(r));
    h.command('job.cancel',h.started.jobId);release({chatId:'paid-image'});await pending;
    assert.equal(h.request().production.shots[0].keyframe.providerState.chatId,'paid-image');
    h.command('job.retry',h.started.jobId);await h.run();
    assert.equal(h.request().production.phase,'awaiting_keyframe_review');assert.equal(submitted,1);assert.equal(h.references.length,0);
  }finally{h.repository.close();}
});
test('keyframe review and image bytes survive restart behind versioned local media routes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orynt-keyframe-test-')),h=keyframeSetup({path:join(dir,'test.sqlite')});let app;
  try{
    await h.run();const id=h.request().id;h.repository.close();
    app=createApplication({repository:new Repository(join(dir,'test.sqlite')),tickMs:0,videoProvider:{available:false}});
    await app.jobRunner.tick();assert.equal(app.repository.read().generationRequests[0].production.phase,'awaiting_keyframe_review');
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
    const r=await fetch(`${base}/api/productions/${id}/shots/0/keyframe?shotVersion=1&version=1`);
    assert.equal(r.headers.get('content-type'),'image/png');assert.equal(Buffer.from(await r.arrayBuffer()).toString('base64'),png);
    assert.equal((await fetch(`${base}/api/productions/${id}/shots/0/keyframe?shotVersion=2&version=1`)).status,404);
    assert.equal((await fetch(`${base}/keyframe-view.js`)).headers.get('content-type'),'text/javascript; charset=utf-8');
  }finally{if(app)await app.close();else h.repository.close();rmSync(dir,{recursive:true,force:true});}
});
