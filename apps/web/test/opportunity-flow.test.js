import test from 'node:test';
import assert from 'node:assert/strict';
import { advertisingDecision, opportunityCards, renderOpportunityBrief, renderDecisionPanel, renderStrategyAnchor, researchInventory, renderResearchWorkspace, referenceVisuals, renderReferenceMedia } from '../public/opportunity-flow.js';

function fixture() {
  const campaign = { id:'campaign', briefId:'brief', brandSnapshotId:'snapshot' };
  const card = { id:'card', campaignId:campaign.id, briefId:'brief', discoveryId:'discovery', status:'candidate', title:'通勤切入', claim:'轻便随身', audience:'城市通勤者', testHypothesis:'出门场景能否让通勤者更愿意点击？', advertisingPlan:{name:'出门前准备', audience:'城市通勤者', audienceBasis:'creative_hypothesis', focus:{value:'随身出行'}, hypothesis:'出门场景能否让通勤者更愿意点击？', marketBasis:{status:'public_copy_observation', explanation:'这条公开文案提到日常随身。', samples:[{sourceUrl:'https://example.com/ad/one', quote:'Take it with you.', advertiser:'公开品牌'}]}} };
  const data = { campaigns:[campaign], cards:[card], discoveries:[{id:'discovery',campaignId:'campaign',briefId:'brief'}], briefs:[{id:'brief',product:'随身杯',channel:'Meta'}], snapshots:[{id:'snapshot',confirmation:'confirmed',facts:{claim:'轻便随身',limitations:'不演示未经确认的功能'},assetIds:[]}], brandAssets:[] };
  return {campaign,card,data};
}

test('opportunities use the current discovery and exclude superseded or dismissed decisions', () => {
  const {data,campaign,card} = fixture();
  data.cards.push({...card,id:'old',discoveryId:'old-discovery'}, {...card,id:'dismissed',status:'dismissed'}, {...card,id:'superseded',status:'superseded'}, {...card,id:'foreign',campaignId:'other'});
  assert.deepEqual(opportunityCards(data,campaign).map(c=>c.id),['card']);
  const html=renderOpportunityBrief(data,campaign);
  assert.match(html,/Take it with you/);
  assert.match(html,/cards\?direction=card/);
  assert.match(html,/公开文案参考/);
});

test('product hypotheses and unsafe or empty citations cannot become public market evidence', () => {
  const {data,campaign,card} = fixture();
  card.advertisingPlan.marketBasis.status='product_hypothesis';
  let html=renderOpportunityBrief(data,campaign);
  assert.doesNotMatch(html,/Take it with you/);
  assert.match(html,/当前还没有足够的公开参考/);
  assert.match(html,/产品资料推导/);
  card.advertisingPlan.marketBasis.status='public_copy_observation';
  card.advertisingPlan.marketBasis.samples=[{sourceUrl:'javascript:alert(1)',quote:'untrusted'}, {sourceUrl:'https://example.com',quote:''}];
  assert.equal(advertisingDecision(data,campaign,card).sources.length,0);
  assert.doesNotMatch(renderDecisionPanel(data,campaign,card),/href="javascript:/);
});

test('selecting a proposal changes its audience, question and exact supporting references together', () => {
  const {data,campaign,card} = fixture();
  const other={...card,id:'other',advertisingPlan:{...card.advertisingPlan,audience:'户外爱好者',hypothesis:'户外场景是否更容易引发兴趣？',marketBasis:{status:'public_copy_observation',samples:[{sourceUrl:'https://example.com/ad/two',quote:'For the trail.'}]}}};
  const html=renderDecisionPanel(data,campaign,other);
  assert.match(html,/户外爱好者/);assert.match(html,/户外场景是否/);assert.match(html,/For the trail/);
  assert.doesNotMatch(html,/Take it with you|城市通勤者/);
  assert.match(renderStrategyAnchor(data,campaign,other),/cards\/other/);
});

test('a recorded single film never becomes a completed A/B experiment and original brief stays pinned', () => {
  const {data,campaign,card} = fixture();
  campaign.replay={};
  card.testPlan={control:'纯产品',variant:'场景广告',successSignal:'观察点击率'};
  data.briefs.push({id:'updated',product:'另一个产品'});campaign.briefId='updated';
  const decision=advertisingDecision(data,campaign,card);
  assert.equal(decision.product,'随身杯');assert.equal(decision.paired,false);
  assert.match(decision.scope,/未制作对照版，不构成 A\/B 测试/);
  delete campaign.replay;
  assert.equal(advertisingDecision(data,campaign,card).paired,true);
  assert.match(advertisingDecision(data,campaign,card).scope,/需要分别制作两版/);
});

test('untrusted copy is escaped and a skipped snapshot is not presented as confirmed', () => {
  const {data,campaign,card} = fixture();
  data.snapshots[0].confirmation='skipped';
  card.advertisingPlan.hypothesis='<img src=x onerror=alert(1)>';
  card.advertisingPlan.marketBasis.samples[0].quote='<script>untrusted()</script>';
  const html=renderOpportunityBrief(data,campaign)+renderDecisionPanel(data,campaign,card);
  assert.doesNotMatch(html,/<script>|<img src=x|本轮已确认资料/);
  assert.match(html,/&lt;script&gt;untrusted/);assert.match(html,/产品资料 · 待核对/);
});

test('research inventory keeps real current sources separate from unavailable, demo and old records', () => {
  const {data,campaign}=fixture();
  data.discoverySources=[{id:'source',discoveryId:'discovery',status:'available',sourceType:'meta_ad_library'}, {id:'blocked',discoveryId:'discovery',status:'unavailable'}];
  const evidence={id:'evidence',discoveryId:'discovery',discoverySourceId:'source',sourceType:'meta_ad_library',sourceUrl:'https://example.com/ad/one',attributes:{bodyText:'Take it with you.'}};
  data.evidence=[evidence,{...evidence,id:'demo',attributes:{demo:true}},{...evidence,id:'blocked',discoverySourceId:'blocked'},{...evidence,id:'stale',discoveryId:'old'},{...evidence,id:'unsafe',sourceUrl:'javascript:alert(1)'}];
  const inventory=researchInventory(data,campaign);
  assert.deepEqual(inventory.usable.map(e=>e.id),['evidence']);
  assert.deepEqual(inventory.cited[0].proposals,[{id:'card',name:'出门前准备'}]);
  const html=renderResearchWorkspace(data,campaign,'meta');
  assert.match(html,/已进入以下提案/);
  assert.doesNotMatch(html,/javascript:|href="#\/campaigns\/other/);
  assert.doesNotMatch(renderResearchWorkspace(data,campaign,'website'),/核对原始来源/);
});

test('saved demo imagery is labelled and never leaks into a different product proposal', () => {
  const {data,campaign,card}=fixture();
  card.advertisingPlan.shots=[{title:'展示随身杯',description:'本产品放在通勤包旁边'}];
  campaign.replay={revision:'saved-v1',scenes:[{title:'出门前的准备',text:'水杯放在门边置物台',timing:'0–3s'}]};
  const replay=renderOpportunityBrief(data,campaign);
  assert.match(replay,/真实生成画面 · 已保存/);
  assert.match(replay,/shot1Frame\?revision=saved-v1/);
  assert.match(replay,/productPhoto\?revision=saved-v1/);
  delete campaign.replay;
  data.snapshots[0].assetIds=['logo','product'];
  data.brandAssets=[{id:'logo',name:'brand logo'},{id:'product',name:'产品正面'}];
  const normal=renderOpportunityBrief(data,campaign);
  assert.doesNotMatch(normal,/owala-commute|Owala|Before you head out|真实生成画面/);
  assert.match(normal,/场景画面尚未生成/);
  assert.match(normal,/本产品放在通勤包旁边/);
  assert.match(normal,/src="\/api\/brand-assets\/product\/preview"/);
  assert.doesNotMatch(normal,/src="\/api\/brand-assets\/logo\/preview"/);
  assert.match(normal,/<details class="creative-research-details" >/);
  assert.match(renderOpportunityBrief(data,campaign,'website'),/<details class="creative-research-details" open>/);
});

test('advertising references display locally saved originals and never use generated or remote substitutes',()=>{
  const evidence={id:'ref',sourceType:'meta_ad_library',attributes:{advertiserName:'Public brand',media:[{status:'available',kind:'video_poster',mime:'image/jpeg',sha256:'a'.repeat(64),sourceUrl:'https://cdn.example/expiring.jpg'}]}};
  const html=renderReferenceMedia(evidence);
  assert.match(html,/原广告视频封面 · 非完整视频/);
  assert.match(html,/src="\/api\/evidence\/ref\/media\/0\?sha256=/);
  assert.doesNotMatch(html,/src="https:|owala-commute|shot1Frame/);
  assert.equal(referenceVisuals({...evidence,available:false}).length,0);
  assert.equal(referenceVisuals({...evidence,attributes:{...evidence.attributes,demo:true}}).length,0);
  assert.match(renderReferenceMedia({...evidence,attributes:{mediaStatus:'unavailable'}}),/图片链接暂不可读/);
});
