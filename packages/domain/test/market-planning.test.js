import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketBrief } from '../src/market-planning.js';
import { buildProductDossier, buildAdvertisingPlans, validateModelPlans } from '../src/product-planning.js';
import { productionPlan, buildKeyframePrompt, buildShotPrompt } from '../src/production-plan.js';
import { renderAdvertisingPlan, renderMarketBrief } from '../../../apps/web/public/product-plan-view.js';

const dossier=buildProductDossier({snapshot:{id:'snapshot',confirmation:'confirmed',facts:{product:'Owala FreeSip Twist Water Bottle',claim:'My confirmed focus'},brandName:'Owala'}});
const discovery={id:'discovery'};
const bundle=(copy,extra={})=>({discoverySources:[{id:'source',status:'available'}],evidence:[{id:'evidence',discoveryId:'discovery',discoverySourceId:'source',sourceType:'meta_ad_library',sourceUrl:'https://www.facebook.com/ads/library/?id=1',attributes:{adId:'1',advertiserName:'Owala',bodyText:copy,displayFormat:'VIDEO'},...extra}]});

test('public copy changes the leading creative and actual generation directions, while source versions remain frozen',()=>{
  const carry=buildMarketBrief(bundle('Owala water bottle for your commute, carry it on the go.'),discovery,dossier);
  const detail=buildMarketBrief(bundle('Owala bottle design, color and beautiful details.'),discovery,dossier);
  const a=buildAdvertisingPlans(dossier,carry),b=buildAdvertisingPlans(dossier,detail);
  assert.equal(a[0].name,'随身与出行');assert.equal(b[0].name,'细节与选择理由');
  assert.deepEqual(a[0].marketBasis.evidenceIds,['evidence']);
  const config={scenePlan:a[0].shots.map(s=>({title:s.title,text:s.description,direction:s.direction})),duration:15,ratio:'9:16',advertisingPlan:a[0],productDossier:dossier,marketBrief:carry};
  const production=productionPlan({config,product:dossier.product});production.productTreatment='product_reference';
  a[0].visualBrief.setting='CHANGED AFTER SAVE';carry.samples[0].copy='CHANGED';
  const prompt=buildKeyframePrompt({production},config,production.shots[0]);
  assert.match(prompt,/玄关/);assert.match(prompt,/source_image_urls/);assert.doesNotMatch(prompt,/CHANGED|No original product image is attached/);
  assert.equal(production.marketBrief.samples[0].copy.includes('commute'),true);
  production.shots[0].keyframe={review:{status:'accepted'},providerState:{url:'https://cdn.youmindassets.com/frame.png'}};
  const video=buildShotPrompt({production},config,production.shots[0]);
  assert.match(video,/玄关/);assert.match(video,/preserve its product identity/);assert.doesNotMatch(video,/Do not render packaging/);
});

test('demo, failed, unrelated, duplicate and other-discovery ads cannot become market support',()=>{
  const state=bundle('Owala water bottle in your daily routine');
  const template=state.evidence[0];
  state.discoverySources.push({id:'failed',status:'failed'});
  state.evidence.push({...template,id:'duplicate'},{...template,id:'demo',attributes:{...template.attributes,demo:true}},{...template,id:'failed',discoverySourceId:'failed'},{...template,id:'old',discoveryId:'old'},{...template,id:'unrelated',attributes:{adId:'different',bodyText:'Fitness shoes for running',advertiserName:'Shoemaker'}},{...template,id:'placeholder',attributes:{bodyText:'{{product.name}}',advertiserName:'Owala'}});
  const brief=buildMarketBrief(state,discovery,dossier);
  assert.deepEqual(brief.samples.map(s=>s.id),['evidence']);
  assert.equal(brief.samples[0].mediaAnalysis,'copy_only');
  assert.equal(buildAdvertisingPlans(dossier,brief)[0].name,'日常习惯');
  const empty=buildMarketBrief({discoverySources:[],evidence:[]},discovery,dossier);
  assert.equal(empty.status,'insufficient');assert.ok(buildAdvertisingPlans(dossier,empty).every(p=>p.marketBasis.status==='product_hypothesis'));
});

test('model plans must cite real confirmed facts and actual supplied market samples',()=>{
  const brief=buildMarketBrief(bundle('Owala water bottle carry on the go.'),discovery,dossier);
  const value={plans:[1,2,3].map(n=>({name:`Direction ${n}`,hook:`Scene ${n}`,proof:`Detail ${n}`,hypothesis:'Test this?',factIds:['claim'],evidenceIds:['evidence']}))};
  assert.equal(validateModelPlans(value,dossier,brief)[0].marketBasis.samples.length,1);
  value.plans[0].evidenceIds=['invented'];assert.throws(()=>validateModelPlans(value,dossier,brief),/INVALID_MARKET_CITATION/);
  value.plans[0].evidenceIds=[];assert.throws(()=>validateModelPlans(value,dossier,brief),/INVALID_MARKET_CITATION/);
});

test('real travel and sports copy produce distinct visual directions; duplicated text across ad IDs counts once',()=>{
  const state=bundle('From spontaneous getaways to everyday city adventures. Discover them now at owalalife.sg');
  const base=state.evidence[0];
  state.evidence.push({...base,id:'sport',attributes:{...base.attributes,adId:'sport',bodyText:'Game, set, hydrate. 16oz FreeSip, made for days on the move.'}},{...base,id:'duplicate-text',attributes:{...base.attributes,adId:'another-id'}});
  const brief=buildMarketBrief(state,discovery,dossier),plans=buildAdvertisingPlans(dossier,brief);
  assert.equal(brief.samples.length,2);
  assert.equal(brief.observations.length,3);
  assert.deepEqual(plans.map(p=>p.name),['随身与出行','日常习惯','运动与户外时刻']);
  assert.equal(new Set(plans.map(p=>p.visualBrief.setting)).size,3);
  assert.match(plans[2].shots[0].description,/网球场/);
});

test('the user sees an attributed quote, creative interpretation and hypothesis without markup injection',()=>{
  const brief=buildMarketBrief(bundle('Owala daily routine <img src=x onerror=bad()>'),discovery,dossier);
  const plan=buildAdvertisingPlans(dossier,brief)[0];
  const html=renderMarketBrief(brief)+renderAdvertisingPlan({advertisingPlan:plan,productDossier:dossier});
  assert.match(html,/这次要验证什么/);assert.match(html,/查看样本/);assert.match(html,/未分析视频画面/);
  assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img/);
});
