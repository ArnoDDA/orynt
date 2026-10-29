import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../src/core.js';
import { Repository } from '../src/repository.js';
import { LocalJobRunner } from '../src/job-runner.js';
import { createApplication } from '../src/server.js';
import { LocalProductImporter } from '../src/product-importer.js';
import { mapApiState } from '../../web/public/api-client.js';
import { createDraftStore, renderProductReview } from '../../web/public/creator-flow.js';
import { productDraftEdits, importedProductValues } from '../../web/public/product-import-flow.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZkAAAAASUVORK5CYII=';
const url='https://example.com/products/coffee';
const result=()=>({sourceUrl:url,pageKind:'product',fields:{product:{value:'Daily Coffee',sourceType:'schema_product',confidence:.95},claim:{value:'Chocolate and caramel',sourceType:'schema_description',confidence:.8},brandName:{value:'Roaster',sourceType:'schema_brand',confidence:.95}},images:[{name:'coffee.png',mime:'image/png',sourceUrl:'https://example.com/bag.png',base64:png},{name:'other.png',mime:'image/png',sourceUrl:'https://example.com/other.png',base64:png}],limitations:['品牌自述']});
function setup(path=':memory:'){
  const repository=new Repository(path),core=new Core(repository);let seq=0;
  const command=(action,id,body={})=>core.command(action,id,body,`import-test-${++seq}`);
  const created=command('campaign.create',null,{brandUrl:url,importFromUrl:true});
  return {repository,core,command,created};
}

test('real importer distinguishes network, policy and website failures without exposing subprocess output', async () => {
  for (const [code, expected] of [['PUBLIC_DNS_UNAVAILABLE', /代理虚拟地址/], ['NETWORK_ADDRESS_BLOCKED', /内网/], ['ROBOTS_DENIED', /访问规则不允许/], ['PRODUCT_PAGE_NOT_FOUND', /404/], ['PRODUCT_PAGE_RATE_LIMITED', /请求频率/], ['PRODUCT_DNS_FAILED', /解析/]]) {
    const importer = new LocalProductImporter({ execute: async () => { throw { stderr: JSON.stringify({ code, error: 'private subprocess output' }) }; } });
    await assert.rejects(importer.collect({ url }), error => error.code === code && expected.test(error.message) && !error.message.includes('private subprocess'));
  }
  const timeout = new LocalProductImporter({ execute: async () => { throw { killed: true }; } });
  await assert.rejects(timeout.collect({ url }), { code: 'PRODUCT_IMPORT_TIMEOUT' });
  const unknown = new LocalProductImporter({ execute: async () => { throw { stderr: JSON.stringify({ code: '__proto__', error: 'secret' }) }; } });
  await assert.rejects(unknown.collect({ url }), { code: 'PRODUCT_IMPORT_UNAVAILABLE' });
});

test('unchanged failed-import defaults do not mask new website results, while real edits and deliberate clearing survive', async () => {
  const h=setup();
  try {
    const state=h.core.state(),campaign=state.campaigns[0],snapshot=state.snapshots[0],brief=state.briefs[0],brand=state.brands[0];
    const defaults=importedProductValues(snapshot,brief,brand);
    const untouched=productDraftEdits({...defaults,importImageIds:[]},snapshot,brief,brand);
    for(const key of ['claim','brandName','product'])assert.equal(Object.hasOwn(untouched,key),false);
    const runner=new LocalJobRunner({...h,productImporter:{collect:async()=>result()}});
    await runner.tick();await runner.tick();
    const ready=h.core.state().snapshots[0];
    assert.equal(importedProductValues(ready,brief,brand,untouched).claim,'Chocolate and caramel');
    const edited=productDraftEdits({...importedProductValues(ready,brief,brand),product:'My selected product',claim:'',audience:'Commuters'},ready,brief,brand);
    assert.equal(edited.claim,'');assert.equal(edited.product,'My selected product');
    assert.equal(importedProductValues(ready,brief,brand,edited).claim,'');
    assert.match(renderProductReview(mapApiState(h.core.state()),campaign,edited),/使用网页提取的资料/);
    assert.doesNotMatch(renderProductReview(mapApiState(h.core.state()),campaign,untouched),/使用网页提取的资料/);
  } finally {h.repository.close();}
});

test('product import survives restart, previews locally and saves only explicitly confirmed fields and images',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orynt-product-import-'));let h=setup(join(dir,'test.sqlite')),calls=0,app;
  const importer={collect:async()=>{calls++;return result();}};
  try{
    let runner=new LocalJobRunner({...h,productImporter:importer});
    await runner.tick();
    assert.ok(h.repository.read().jobs[0].providerResult);
    assert.equal(h.core.state().jobs[0].providerResult.images[0].base64,undefined);
    const {created}=h;h.repository.close();
    const repository=new Repository(join(dir,'test.sqlite')),core=new Core(repository);
    h={...h,repository,core};runner=new LocalJobRunner({...h,productImporter:importer});
    await runner.tick();assert.equal(calls,1);
    const snapshot=core.state().snapshots[0];
    assert.equal(snapshot.productImport.status,'ready');
    assert.deepEqual(core.state().brands[0].facts,{});
    assert.equal(core.state().brandAssets.length,0);
    assert.equal(snapshot.productImport.images[0].base64,undefined);
    app=createApplication({repository,tickMs:0,metaCrawler:null,productImporter:importer});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/product-imports/${snapshot.id}/images/${snapshot.productImport.images[0].id}`);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.ok((await response.arrayBuffer()).byteLength);
    const command=(action,id,body)=>core.command(action,id,body,`after-restart-${Math.random()}`);
    assert.throws(()=>command('snapshot.confirm',created.campaignId,{importImageIds:['other-snapshot']}),{code:'INVALID_IMPORT_IMAGE'});
    command('snapshot.confirm',created.campaignId,{brandName:'Roaster',product:'Daily Coffee',claim:'My edited claim',importImageIds:[snapshot.productImport.images[0].id]});
    const confirmed=core.state().snapshots[0];
    assert.equal(confirmed.factMeta.product.sourceType,'schema_product');
    assert.equal(confirmed.factMeta.claim.sourceType,'user');
    assert.equal(confirmed.brandName,'Roaster');
    assert.equal(core.state().brandAssets.length,1);
    assert.equal(core.state().brandAssets[0].source,'confirmed_website_import');
    command('snapshot.confirm',created.campaignId,{brandName:'Roaster',product:'Daily Coffee',claim:'My edited claim',importImageIds:[snapshot.productImport.images[0].id]});
    assert.equal(core.state().brandAssets.length,1);
    command('discovery.start',created.campaignId,{});
    assert.throws(()=>command('productImport.start',created.campaignId,{}),{code:'SNAPSHOT_FROZEN'});
  }finally{if(app)await new Promise(resolve=>app.server.close(resolve));h.repository.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed reads can retry or fall back manually; cancelled and late results cannot overwrite a confirmed snapshot',async()=>{
  const h=setup();
  try{
    let runner=new LocalJobRunner({...h,productImporter:{collect:async()=>{throw new Error('Page unavailable');}}});
    await runner.tick();assert.equal(h.core.state().snapshots[0].productImport.status,'failed');
    h.command('job.retry',h.created.jobId);assert.equal(h.core.state().snapshots[0].productImport.status,'reading');
    h.command('job.cancel',h.created.jobId);assert.equal(h.core.state().snapshots[0].productImport.status,'skipped');
    const queued=h.command('productImport.start',h.created.campaignId);
    assert.throws(()=>h.command('job.retry',h.created.jobId),{code:'SNAPSHOT_FROZEN'});
    let release;
    runner=new LocalJobRunner({...h,productImporter:{collect:()=>new Promise(resolve=>{release=resolve;})}});
    const pending=runner.tick();
    h.command('snapshot.confirm',h.created.campaignId,{product:'Manual product',claim:'Manual claim'});
    release(result());await pending;
    assert.equal(h.core.state().jobs.find(j=>j.id===queued.jobId).status,'cancelled');
    assert.equal(h.core.state().snapshots[0].facts.product,'Manual product');
    assert.equal(h.core.state().snapshots[0].productImport.fields.product,undefined);
    assert.throws(()=>h.command('job.retry',queued.jobId),{code:'SNAPSHOT_FROZEN'});
  }finally{h.repository.close();}
});

test('imported review prefills real fields, preserves draft choices and makes missing audience optional',async()=>{
  const h=setup();
  try{
    const runner=new LocalJobRunner({...h,productImporter:{collect:async()=>result()}});await runner.tick();await runner.tick();
    const data=mapApiState(h.core.state()),campaign=data.campaigns[0];
    const html=renderProductReview(data,campaign);
    assert.match(html,/value="Daily Coffee"/);assert.match(html,/Chocolate and caramel/);
    assert.doesNotMatch(html,/name="audience"[^>]*required/);
    assert.match(html,/来自商品描述/);assert.doesNotMatch(html,/name="importImageIds"[^>]*checked/);
    const store=createDraftStore(undefined,'test'),selected=data.snapshots[0].productImport.images[0].id;
    store.write('product',{brandName:'Mine',product:'Edited product',importImageIds:[selected],secret:'not stored'});
    const draft=store.read('product');assert.equal(draft.secret,undefined);
    const edited=renderProductReview(data,campaign,draft);
    assert.match(edited,/value="Edited product"/);assert.match(edited,new RegExp(`value="${selected}" checked`));
  }finally{h.repository.close();}
});

test('ordinary existing-brand and demo campaigns do not silently enqueue product reads',()=>{
  const h=setup();
  try{
    const a=h.command('campaign.create',null,{brandUrl:url});
    const b=h.command('campaign.create',null,{brandUrl:url,mode:'guided_demo',importFromUrl:true});
    assert.equal(a.jobId,undefined);assert.equal(b.jobId,undefined);
    assert.equal(h.core.state().jobs.length,1);
  }finally{h.repository.close();}
});

test('a complete gallery persists past four images; wrong and mixed variants cannot be confirmed',async()=>{
  const h=setup();
  try{
    const gallery={...result(),selectedVariantId:'black',variants:[{id:'black',name:'Black',selected:true},{id:'red',name:'Red'}],images:Array.from({length:10},(_,i)=>({name:`view-${i}.png`,mime:'image/png',sourceUrl:`https://example.com/view-${i}.png`,base64:png,variantId:i===9?'red':'black',variantName:i===9?'Red':'Black',identityStatus:i===9?'other_variant':'selected_variant'}))};
    const runner=new LocalJobRunner({...h,productImporter:{collect:async()=>gallery}});await runner.tick();await runner.tick();
    const images=h.core.state().snapshots[0].productImport.images;
    assert.equal(images.length,10);
    for(const ids of [[images[9].id],[images[0].id,images[9].id]])assert.throws(()=>h.command('snapshot.confirm',h.created.campaignId,{product:'Bottle',claim:'Daily',importImageIds:ids}),{code:'PRODUCT_VARIANT_MISMATCH'});
    h.command('snapshot.confirm',h.created.campaignId,{product:'Bottle',claim:'Daily',importImageIds:images.slice(0,9).map(i=>i.id)});
    assert.equal(h.core.state().brandAssets.length,9);
    assert.equal(h.core.state().brandAssets[0].variantName,'Black');
    const data=mapApiState(h.core.state()),html=renderProductReview(data,data.campaigns[0]);
    assert.match(html,new RegExp(`name="importImageIds" value="${images[0].id}" checked\\s*>`));
    assert.match(html,new RegExp(`name="importImageIds" value="${images[9].id}"[^>]*disabled`));
  }finally{h.repository.close();}
});

test('variant changes must be exact known URLs while the import remains pending',async()=>{
  const h=setup();
  try{
    const runner=new LocalJobRunner({...h,productImporter:{collect:async()=>({...result(),variants:[{id:'2',name:'Black'}]})}});await runner.tick();await runner.tick();
    for(const productUrl of [url+'?variant=unknown',url+'?variant=2&redirect=elsewhere','https://unrelated.example/products/coffee?variant=2'])assert.throws(()=>h.command('productImport.start',h.created.campaignId,{productUrl}),{code:'INVALID_PRODUCT_CANDIDATE'});
    const next=h.command('productImport.start',h.created.campaignId,{productUrl:url+'?variant=2'});
    assert.ok(next.jobId);assert.equal(h.core.state().campaigns[0].productUrl,url+'?variant=2');
  }finally{h.repository.close();}
});

test('skipping a slow read aborts it so the next local task can run',async()=>{
  const h=setup();let aborted=false;
  try{
    const runner=new LocalJobRunner({...h,productImporter:{collect:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}))}});
    const pending=runner.tick();h.command('productImport.skip',h.created.campaignId);
    await runner.tick();await pending;assert.equal(aborted,true);
    h.command('snapshot.confirm',h.created.campaignId,{product:'Manual coffee',claim:'Balanced taste'});
    const job=h.command('discovery.start',h.created.campaignId);
    await runner.tick();assert.equal(h.core.state().jobs.find(j=>j.id===job.jobId).steps[0].status,'succeeded');
  }finally{h.repository.close();}
});

test('a result from a cancelled attempt cannot publish into the retried attempt',async()=>{
  const h=setup();let release;
  try{
    const runner=new LocalJobRunner({...h,productImporter:{collect:()=>new Promise(resolve=>{release=resolve;})}});
    const pending=runner.tick();h.command('job.cancel',h.created.jobId);h.command('job.retry',h.created.jobId);
    release(result());await pending;
    const job=h.core.state().jobs[0];assert.equal(job.status,'queued');assert.equal(job.providerResult,undefined);
    assert.deepEqual(h.core.state().snapshots[0].productImport.fields,{});
  }finally{h.repository.close();}
});
