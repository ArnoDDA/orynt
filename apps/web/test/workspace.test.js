import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPresentation, renderStudio } from '../public/creator-flow.js';
import { productionFocus, renderProduction } from '../public/production-flow.js';

function fixture() {
  const request={id:'production',packageId:'pack',campaignId:'campaign',angleId:'angle',jobId:'job',workflow:'shot_pipeline',production:{product:'Coffee',phase:'awaiting_keyframe_review',shots:[
    {index:0,kind:'generated_shot',title:'开场',text:'第一镜头',version:1,status:'ready',start:0,end:3,technical:{width:720,height:1280,duration:5,issues:[]},keyframe:{version:1,status:'ready',sha256:'first',review:{status:'accepted'}}},
    {index:1,kind:'generated_shot',title:'展示',text:'第二镜头',version:2,status:'awaiting_keyframe_review',start:3,end:11,keyframe:{version:3,status:'ready',sha256:'second',technical:{width:720,height:1280,issues:[]},review:{status:'pending'}}},
    {index:2,kind:'product_endcard',title:'收尾',text:'原图',version:1,status:'local',start:11,end:15}
  ]}};
  const job={id:'job',status:'running',steps:[]};
  const data={generationRequests:[request],jobs:[job],assets:[],packages:[{id:'pack',cardId:'card',cardVersion:4}]};
  return {request,job,data,c:{id:'campaign',status:'creating'}};
}

test('project resume targets the production awaiting review and keeps its frozen creative version',()=>{
  const f=fixture(),view=projectPresentation(f.data,f.c);
  assert.match(view.label,/镜头 2/);
  assert.match(view.path,/cardVersion=4/);
  assert.match(view.path,/productionId=production/);
  assert.equal(view.shot.index,1);
  f.job.status='failed';
  assert.equal(projectPresentation(f.data,f.c).label,'制作需要处理');
});

test('opening a production focuses the pending second image while other shots remain browsable',()=>{
  const f=fixture();
  assert.equal(productionFocus(f.request),1);
  assert.equal(productionFocus(f.request,0),0);
  assert.equal(productionFocus(f.request,99),1);
  const pending=renderProduction({...f,path:'/create?',jobRow:()=>''});
  assert.match(pending,/data-action="approve-production-keyframe"[^>]*data-index="1"[^>]*data-version="3"[^>]*data-shot-version="2"/);
  const previous=renderProduction({...f,path:'/create?',jobRow:()=>'',selectedShot:0});
  assert.match(previous,/shots\/0\/preview\?version=1/);
  assert.match(previous,/镜头 2 的图片需要你确认/);
  assert.doesNotMatch(previous,/data-action="approve-production-keyframe"|data-action="approve-production-shot"/);
});

test('archived projects permit viewing but expose no generation or final-review mutation',()=>{
  const f=fixture();f.c.archived=true;
  const pending=renderProduction({...f,path:'/create?',jobRow:()=>''});
  assert.doesNotMatch(pending,/data-action="approve-production-keyframe"|production-keyframe-form/);
  f.request.production.phase='completed';f.request.production.copy={};f.request.assetId='video';
  f.data.assets=[{id:'video',technical:{duration:15}}];
  const final=renderProduction({...f,path:'/create?',jobRow:()=>''});
  assert.match(final,/fieldset disabled/);
  assert.doesNotMatch(final,/id="production-edit-form"|data-action="launch-ready"/);
  assert.equal(productionFocus(f.request),'final');
  assert.equal(productionFocus(f.request,0),0);
});

test('script editing can inspect the existing production but never shows a different config as its output',()=>{
  const f=fixture();f.request.configId='config';
  f.data.brands=[{id:'brand',name:'Coffee'}];f.data.briefs=[{id:'brief',product:'Coffee'}];f.data.brandAssets=[];
  const card={id:'card',version:4,claim:'Morning',creativeRoute:{hook:'Coffee',proof:'Brew'}};
  const angle={id:'angle',name:'场景先行',hook:'Coffee',proof:'Brew'};
  const options={data:f.data,c:{...f.c,brandId:'brand',briefId:'brief'},card,pack:{id:'pack'},angle,angles:[angle],config:{id:'config',scenePlan:[{text:'Opening'},{text:'Proof'},{text:'Closing'}]},draft:{},selectedAssets:new Set(),templates:[],selectedTemplateId:''};
  const html=renderStudio(options);
  assert.match(html,/已有视频 · 修改脚本不会改变已生成的画面/);
  assert.match(html,/shots\/0\/preview\?version=1/);
  const newVersion=renderStudio({...options,config:{...options.config,id:'new-config'}});
  assert.doesNotMatch(newVersion,/shots\/0\/preview/);
});

test('uncertain submissions and failed image states do not offer duplicate submission shortcuts',()=>{
  const f=fixture();f.job.status='failed';f.job.error={code:'KEYFRAME_SUBMISSION_UNCERTAIN',message:'请核查任务'};f.request.production.phase='failed';
  const html=renderProduction({...f,path:'/create?',jobRow:()=>'<button data-action="retry">retry</button>'});
  assert.doesNotMatch(html,/data-action="retry"|data-action="approve-production-keyframe"|production-keyframe-form/);
});

test('a failed download is explained as an existing image awaiting receipt, never a review or a completed video',()=>{
  const f=fixture();f.request.production.phase='failed';f.job.status='failed';
  delete f.request.production.shots[0].technical;
  f.request.production.shots[0].status='failed';
  f.request.production.shots[0].keyframe={version:1,status:'failed',review:{status:'pending'},providerState:{status:'succeeded',url:'https://cdn.youmindassets.com/existing.png'}};
  const html=renderProduction({...f,path:'/create?',jobRow:()=>''});
  assert.match(html,/图片已生成，尚未接收完成/);
  assert.match(html,/视频镜头尚未开始生成/);
  assert.match(html,/继续接收已有图片/);
  assert.doesNotMatch(html,/先确认这张画面|已完成的镜头仍保留|data-action="approve-production-keyframe"/);
  f.job.status='queued';f.request.production.phase='resuming';f.request.production.shots[0].status='planning';
  const recovering=renderProduction({...f,path:'/create?',jobRow:()=>''});
  assert.match(recovering,/正在恢复图片接收/);assert.doesNotMatch(recovering,/需要处理|data-action="approve-production-keyframe"/);
});
test('a failed video with an approved frame offers checked video recovery rather than a blind retry',()=>{
  const f=fixture();f.job.status='failed';f.request.production.phase='failed';
  const shot=f.request.production.shots[0];shot.status='failed';delete shot.technical;shot.providerState={chatId:'existing'};
  const html=renderProduction({...f,path:'/create?',jobRow:()=>''});
  assert.match(html,/data-action="recover-production-video"[^>]*data-index="0"[^>]*data-version="1"/);
  assert.match(html,/仅在确认失败且没有视频时重新提交/);
  assert.doesNotMatch(html,/data-action="retry"|data-action="approve-production-keyframe"/);
});
test('legacy films offer a preserved local fork while composite films disclose static product layering',()=>{
  const f=fixture();f.request.production.phase='awaiting_review';f.request.production.referenceMode='generated_first_frame';
  assert.match(renderProduction({...f,path:'/create?',jobRow:()=>''}),/data-action="local-product-version"/);
  f.request.production.productTreatment='local_product_overlay';
  const html=renderProduction({...f,path:'/create?',jobRow:()=>''});
  assert.match(html,/真实产品原图 \+ AI 背景/);assert.match(html,/产品主体保持静态/);
  assert.doesNotMatch(html,/data-action="local-product-version"/);
});
