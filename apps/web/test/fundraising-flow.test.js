import test from 'node:test';
import assert from 'node:assert/strict';
import {renderCreativeShowcase} from '../public/creator-flow.js';
import {renderCreativeLineage} from '../public/opportunity-flow.js';

test('the visual workspace uses saved media and marks an unaccepted film as a candidate',()=>{
  const demo={integrity:true,ready:false,product:{url:'https://product.example/item'},evidence:[{url:'https://example.com/ad',copy:'Carry it daily.'}],media:Object.fromEntries(['productPhoto','shot1Frame','shot2Frame'].map(k=>[k,{url:'/api/demo/media/'+k}])),reviewMedia:{finalVideo:{url:'/api/demo/media/candidate'}}};
  let html=renderCreativeShowcase({},demo);
  assert.match(html,/src="\/api\/demo\/media\/candidate"/);assert.match(html,/真实成片 · 待确认/);assert.doesNotMatch(html,/已验收/);
  assert.match(html,/preload="none"/);assert.match(html,/href="#\/campaigns\/demo"/);
  demo.ready=true;demo.media.finalVideo={url:'/api/demo/media/accepted'};
  html=renderCreativeShowcase({},demo);assert.match(html,/已验收回放/);assert.match(html,/src="\/api\/demo\/media\/accepted"/);
  demo.integrity=false;assert.equal(renderCreativeShowcase({},demo),'');
});

test('market to shot linkage keeps each product and hypothesis isolated and never invents a generated frame',()=>{
  const campaign={id:'shoes',briefId:'brief'},card={id:'proposal',briefId:'brief',advertisingPlan:{name:'Running comfort',audience:'Runners',focus:{value:'A comfortable run'},hypothesis:'Does a running setting improve understanding?',shots:[{title:'Morning run',description:'Shoes on a city path.',purpose:'Show the use case.'}],marketBasis:{status:'public_copy_observation',samples:[{sourceUrl:'https://example.com/ad',quote:'<script>Every day.</script>',advertiser:'Public brand'},{sourceUrl:'javascript:alert(1)',quote:'Unsafe'}]}}};
  const html=renderCreativeLineage({briefs:[{id:'brief',product:'Running shoes'}]},campaign,card);
  assert.match(html,/Running comfort/);assert.match(html,/Morning run/);assert.match(html,/画面尚未生成/);assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/Owala|owala-commute|<script>|javascript:|Unsafe/);
});
