import test from 'node:test';
import assert from 'node:assert/strict';
import {renderKeyframeReview,renderReferenceStatus} from '../public/keyframe-view.js';
test('keyframe review shows a real local image, versioned approval, rejection and honest reference status',()=>{
  const shot={index:0,version:2,text:'<img onerror=evil()>',keyframe:{version:3,status:'ready',sha256:'abc',technical:{width:720,height:1280,issues:[]},history:[{version:1,sha256:'old'}]}};
  const html=renderKeyframeReview({id:'request'},shot);
  assert.match(html,/shotVersion=2&version=3/);assert.match(html,/data-shot-version="2"/);
  assert.match(html,/不采用这张，重新出图/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img onerror/);
  assert.match(html,/是否实际绑定为视频首帧/);
  assert.match(renderReferenceStatus(shot),/关键帧待确认/);
  shot.submissionStartedAt=new Date().toISOString();
  assert.match(renderReferenceStatus(shot),/尚未核验/);
  shot.providerState={controlEvidence:{status:'first_frame_confirmed'}};
  assert.match(renderReferenceStatus(shot),/回执已确认/);
  assert.doesNotMatch(renderKeyframeReview({id:'request'},shot,{canAct:false}),/data-action="approve-production-keyframe"|<form/);
});
test('local composite review distinguishes product plate from background conditioning and gates missing previews',()=>{
  const request={id:'request',production:{productTreatment:'local_product_overlay'}};
  const shot={index:0,version:1,text:'Scene',reusedFrom:{generationRequestId:'old'},keyframe:{version:1,sha256:'hash',status:'ready',technical:{width:720,height:1280,issues:[]}}};
  assert.doesNotMatch(renderKeyframeReview(request,shot),/data-action="approve-production-keyframe"/);
  shot.keyframe.productPreview={composition:{sourceSha256:'original'}};
  const html=renderKeyframeReview(request,shot);assert.match(html,/产品合成预览/);assert.match(html,/合成已有镜头/);assert.match(html,/产品主体保持静态/);
  assert.match(html,/未叠加产品的背景首帧/);assert.doesNotMatch(html,/产品原图仍仅用于本地收尾/);
});
