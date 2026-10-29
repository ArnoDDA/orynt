import test from 'node:test';
import assert from 'node:assert/strict';
import {renderProductionProcess,renderEditingWorkspace} from '../public/production-flow.js';
import {renderTemplateBreakdown} from '../public/creator-flow.js';

const request=()=>({id:'request',production:{phase:'completed',editVersion:2,referenceMode:'generated_first_frame',productImage:{assetId:'product'},music:'ambient',copy:{opening:'Start',detail:'Detail',cta:'Explore'},shots:[{index:0,kind:'generated_shot',title:'Opening',version:1,start:0,end:3,keyframe:{sha256:'one',version:1},technical:{issues:[]}},{index:1,kind:'generated_shot',title:'Detail',version:2,start:3,end:11,keyframe:{sha256:'two',version:1},technical:{issues:[]}},{index:2,kind:'continuing_video',title:'Close',version:1,start:11,end:15}]}});

test('edit desk uses exact current shot versions and saved captions while keeping replay immutable',()=>{
  const r=request(),asset={id:'film',manifest:{copy:{opening:'Pinned title',detail:'Pinned detail',cta:'Pinned CTA'}}};
  let html=renderEditingWorkspace(r,{asset});
  assert.match(html,/shots\/1\/poster\?version=2/);
  assert.match(html,/Pinned title/);assert.match(html,/name="opening"[^>]+value="Pinned title"/);
  assert.match(html,/id="production-edit-form"/);
  assert.doesNotMatch(html,/>Start</);
  r.replay={revision:'fixed'};
  html=renderEditingWorkspace(r,{asset});
  assert.match(html,/真实|已保存广告/);
  assert.doesNotMatch(html,/production-edit-form|保存并重新剪辑/);
  assert.match(html,/id="production-fork-edit-form"/);
  assert.match(html,/原版保留，不消耗生成额度/);
  assert.doesNotMatch(renderEditingWorkspace(r,{asset,editable:false}),/production-fork-edit-form/);
  const derived={...r,replay:undefined,localEdit:{sourceRequestId:'original'}};
  const changed=renderEditingWorkspace(derived,{asset:{id:'new',productionManifest:{copy:{opening:'New caption',detail:'',cta:'New CTA'}}}});
  assert.match(changed,/name="opening"[^>]+value="New caption"/);
  assert.match(changed,/本地重剪版本/);
  delete r.replay;
  assert.doesNotMatch(renderEditingWorkspace(r,{asset,editable:false}),/production-edit-form/);
  r.production.phase='assembly';
  assert.doesNotMatch(renderEditingWorkspace(r),/production-edit-form|已包含在成片中/);
});

test('workflow reflects received media and never treats a failed task as completed editing',()=>{
  const r=request();
  delete r.production.shots[1].technical;
  const html=renderProductionProcess(r,{status:'failed'});
  assert.match(html,/1 \/ 2 段视频已接收/);
  assert.doesNotMatch(html,/已保存成片/);
  r.replay={};r.production.phase='assembly';
  assert.match(renderProductionProcess(r,{status:'running'}),/正在载入已保存剪辑/);
});

test('template results expose real keyframes and times and escape filenames',()=>{
  assert.equal(renderTemplateBreakdown({status:'analyzing'}),'');
  const html=renderTemplateBreakdown({id:'template',status:'ready',filename:'<script>bad</script>',duration:8,scenes:[{index:0,start:0,end:3},{index:1,start:3,end:8}]});
  assert.match(html,/video-templates\/template\/keyframes\/1/);
  assert.match(html,/3\.0–8\.0 秒/);
  assert.doesNotMatch(html,/<script>/);
});
