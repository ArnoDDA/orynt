import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Repository} from '../src/repository.js';
import {Core} from '../src/core.js';
import {LocalJobRunner} from '../src/job-runner.js';
import {createApplication} from '../src/server.js';

const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=';
const image={status:'available',sourceUrl:'https://cdn.example/ad.png',kind:'video_poster',mime:'image/png',base64,sha256:createHash('sha256').update(Buffer.from(base64,'base64')).digest('hex')};
function fixture(){
  const repository=new Repository(),core=new Core(repository);let n=0;
  const command=(action,id,data={})=>core.command(action,id,data,`reference-media-${++n}`);
  const {campaignId}=command('campaign.create',null,{brandUrl:'https://example.com',product:'Bottle'});
  command('snapshot.confirm',campaignId,{skip:true});
  const job=command('discovery.start',campaignId);
  const sourceUrl='https://www.facebook.com/ads/library/?id=12345';
  const bundle={sources:[{sourceType:'meta_ad_library',sourceUrl,status:'available'}],evidence:[{sourceType:'meta_ad_library',sourceUrl,contentSummary:'Real copy',contentHash:'original-copy-hash',attributes:{bodyText:'Real copy',media:[image]}}],coverage:{}};
  for(let i=0;i<3;i++)core.tick({jobId:job.jobId,discovery:bundle});
  return {repository,core,command,campaignId};
}

test('public images survive discovery, stay out of JSON state, and are served from local bytes',async()=>{
  const {repository,core}=fixture();const app=createApplication({repository,tickMs:0});
  try{
    const evidence=repository.read().evidence[0];
    assert.equal(evidence.attributes.media[0].base64,base64);
    assert.equal(core.state().evidence[0].attributes.media[0].base64,undefined);
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const root=`http://127.0.0.1:${app.server.address().port}/api/evidence/${evidence.id}/media/0`;
    const res=await fetch(root+`?sha256=${image.sha256}`);
    assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from(base64,'base64'));
    assert.equal((await fetch(root+'?sha256=stale')).status,404);
    repository.transact(s=>{s.evidence[0].attributes.demo=true;});
    assert.equal((await fetch(root)).status,404);
  }finally{await app.close();}
});

test('image enrichment preserves evidence lineage and original images if retry fails',async()=>{
  const {repository,core,command,campaignId}=fixture();
  try{
    const before=repository.read().evidence[0];
    const {jobId}=command('references.collectImages',campaignId);
    assert.equal(command('references.collectImages',campaignId).jobId,jobId);
    const runner=new LocalJobRunner({core,repository,metaCrawler:{hydrate:async()=>({evidence:[{id:before.id,media:[{...image,status:'unavailable',base64:undefined}]}]})}});
    await runner.tick();
    const after=repository.read().evidence[0];
    assert.equal(after.contentHash,before.contentHash);assert.equal(after.contentSummary,before.contentSummary);
    assert.equal(after.attributes.media[0].base64,base64);
    assert.equal(repository.read().discoveries.length,1);
    assert.equal(repository.read().jobs.find(j=>j.id===jobId).status,'succeeded');
    const next=command('references.collectImages',campaignId);
    command('job.cancel',next.jobId);
    core.tick({jobId:next.jobId,providerResult:{evidence:[{id:before.id,media:[]}]}});
    assert.equal(repository.read().evidence[0].attributes.media[0].base64,base64);
  }finally{repository.close();}
});

test('explicit direct poster permission is source-scoped and consumed before the first attempt',async()=>{
  const {repository,core,command,campaignId}=fixture();
  try {
    assert.throws(()=>command('references.collectImages',campaignId,{directAdIds:['99999']}),{code:'INVALID_MEDIA_AUTHORIZATION'});
    const {jobId}=command('references.collectImages',campaignId,{directAdIds:['12345']});
    const calls=[];
    const runner=new LocalJobRunner({core,repository,metaCrawler:{hydrate:async input=>{
      calls.push(input.directAdIds);
      assert.ok(repository.read().jobs.find(j=>j.id===jobId).directMediaStartedAt);
      if(calls.length===1)throw new Error('interrupted');
      return {evidence:[]};
    }}});
    await runner.tick();
    assert.equal(repository.read().jobs.find(j=>j.id===jobId).status,'failed');
    command('job.retry',jobId);
    await runner.tick();
    assert.deepEqual(calls,[['12345'],[]]);
  }finally{repository.close();}
});
