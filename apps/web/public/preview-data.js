// Fictional UI fixtures. No API, persistence, credentials or product execution.
const time = '2026-09-14T02:30:00Z';

const cardTemplates = [
  ['一杯咖啡，轻松出门','从早晨出门前的忙碌场景切入，让使用方式一眼可懂。','让随行咖啡成为轻松的日常','打开包、拿起杯子，进入一天的第一幕','用连续镜头展示装杯、携带和饮用','产品演示','场景开头是否比静态产品介绍更容易吸引目标受众？'],
  ['把细节交给镜头','放大用户拿起产品时最先感知的设计细节。','好设计，藏在每天触碰的细节里','杯盖、杯身与握持动作的三个特写','展示开合方式、表面质感与握持动作','产品实拍','细节特写能否提高用户对产品的理解和兴趣？'],
  ['跟着真实的一天走','以第一人称叙事表达使用场景，让受众判断是否适合自己。','从办公桌到城市街角，都有自己的节奏','一个通勤者的早晨自述','用连续日常片段展示产品的使用位置','真人 UGC','第一人称叙事是否比产品演示更容易引发共鸣？']
];

export function addDiscoveryExample(data,campaign,{ forceNew = false } = {}) {
  const existing=data.discoveries.filter(x=>x.campaignId===campaign.id).at(-1);
  if(existing&&!forceNew)return existing;
  const version=(existing?.version||0)+1,createdAt=forceNew?new Date().toISOString():time;
  const discovery={id:`${campaign.id}-discovery-${version}`,campaignId:campaign.id,briefId:campaign.briefId,version,status:'succeeded',createdAt,completedAt:createdAt};
  data.discoveries.push(discovery);campaign.status='discovering';campaign.updatedAt=createdAt;
  return discovery;
}

export function addCardExamples(data,campaign) {
  const existing=data.cards.filter(x=>x.campaignId===campaign.id);
  if(existing.length)return existing;
  const discovery=addDiscoveryExample(data,campaign);
  const cards=cardTemplates.map(([title,opportunity,claim,hook,proof,style,hypothesis],i)=>({
    id:`${campaign.id}-card-${i+1}`,campaignId:campaign.id,versionId:`${campaign.id}-card-version-${i+1}`,version:1,status:'candidate',
    snapshotId:campaign.brandSnapshotId,briefId:campaign.briefId,discoveryId:discovery.id,createdAt:time,title,opportunity,claim,
    audience:'城市通勤人群',creativeRoute:{hook,proof,style},testHypothesis:hypothesis,
    applicability:{channel:i===2?'TikTok':'Meta',market:'英语市场'},priority:i+1,evidenceStrength:i===1?'中等':'有限',
    facts:[],inferences:[{statement:'使用场景可能帮助受众理解产品价值。',basis:'虚构示例，仅用于审阅信息布局。'}],
    assumptionsToTest:['受众能否识别自己的使用场景','表达方式是否有助于理解产品'],
    risksAndBoundaries:['示例品牌与策略均为虚构，不代表市场事实。','正式内容需确认依据、产品主张与表达边界。']
  }));
  data.cards.push(...cards);campaign.status='cards_ready';campaign.updatedAt=time;
  return cards;
}

export function refreshCardExamples(data,campaign) {
  const discovery=data.discoveries.filter(item=>item.campaignId===campaign.id).at(-1);
  if(!discovery||discovery.briefId!==campaign.briefId)throw new Error('请先按当前本轮意图完成 Discovery。');
  const previousStatus=campaign.status;
  const source=data.cards.filter(card=>card.campaignId===campaign.id&&card.status!=='superseded').slice(-3);
  if(!source.length)return addCardExamples(data,campaign);
  const stamp=Date.now(),createdAt=new Date().toISOString();
  source.forEach(card=>{if(card.status!=='adopted')card.status='superseded';});
  const cards=source.map((card,index)=>({...card,id:`${campaign.id}-card-refresh-${stamp}-${index+1}`,versionId:`${campaign.id}-card-version-${stamp}-${index+1}`,snapshotId:campaign.brandSnapshotId,briefId:campaign.briefId,discoveryId:discovery.id,version:card.version+1,status:'candidate',saved:false,createdAt,title:index===0?`${card.title} · 新信号`:card.title}));
  data.cards.push(...cards);campaign.status=['draft','discovering','cards_ready'].includes(previousStatus)?'cards_ready':previousStatus;campaign.updatedAt=createdAt;
  return cards;
}

export function adoptCardExample(data,card) {
  card.status='adopted';
  let pack=data.packages.find(x=>x.cardId===card.id&&x.cardVersion===card.version);
  if(pack)return pack;
  pack={id:`${card.id}-package`,campaignId:card.campaignId,cardId:card.id,cardVersionId:card.versionId,cardVersion:card.version,createdAt:time};
  data.packages.push(pack);
  const angleSpecs=[
    ['场景先行',card.creativeRoute.hook,card.creativeRoute.proof,card.creativeRoute.style],
    ['证明先行','第一秒直接展示产品动作','用近景连续呈现关键使用步骤','产品实拍'],
    ['人物先行','由真实使用者提出日常问题','用第一人称体验完成产品证明','真人 UGC']
  ];
  angleSpecs.forEach(([name,hook,proof,visualLanguage],i)=>data.angles.push({id:`${pack.id}-angle-${i+1}`,packageId:pack.id,position:i+1,name,hook,proof,visualLanguage}));
  data.configs.push({id:`${pack.id}-config-1`,packageId:pack.id,version:1,ratio:'9:16',duration:15,language:'English',notes:''});
  const campaign=data.campaigns.find(x=>x.id===card.campaignId);campaign.status='creating';campaign.updatedAt=time;
  return pack;
}

function addStoryboardFixture(data,pack) {
  const angle=data.angles.find(x=>x.packageId===pack.id);
  data.assets.push({id:`${pack.id}-storyboard-1`,campaignId:pack.campaignId,packageId:pack.id,angleId:angle.id,cardId:pack.cardId,cardVersion:pack.cardVersion,configVersion:1,version:1,type:'storyboard',status:'ready',source:'ui_fixture',createdAt:time});
}

function addLaunchFixture(data,pack) {
  const angle=data.angles.find(x=>x.packageId===pack.id);
  const asset={id:`${pack.id}-video-1`,campaignId:pack.campaignId,packageId:pack.id,angleId:angle.id,cardId:pack.cardId,cardVersion:pack.cardVersion,configVersion:1,version:1,type:'video',status:'launch_ready',source:'ui_fixture',createdAt:time};
  data.assets.push(asset);
  const plan={id:`${pack.campaignId}-plan-1`,campaignId:pack.campaignId,cardId:pack.cardId,cardVersion:pack.cardVersion,assetIds:[asset.id],channel:'Meta',audience:'注重日常便利与设计的城市通勤者',goal:'验证产品证明表达',budget:'USD 300–500',period:'7 天',metric:'CTR',version:1,status:'prepared',hypothesis:data.cards.find(x=>x.id===pack.cardId).testHypothesis,createdAt:time};
  data.plans.push(plan);
  return {asset,plan};
}

function addLearningFixture(data,pack) {
  const {asset,plan}=addLaunchFixture(data,pack);
  const mapping={id:`${pack.campaignId}-mapping-1`,campaignId:pack.campaignId,planId:plan.id,assetId:asset.id,externalCampaign:'DF Autumn Test',externalAdSet:'Urban Commuters',externalAdId:'2385900142',confidence:'high',status:'confirmed',createdAt:time};
  data.mappings.push(mapping);plan.status='completed';
  data.metrics.push({id:`${pack.campaignId}-metrics-1`,campaignId:pack.campaignId,mappingId:mapping.id,assetId:asset.id,dateRange:'2026-09-01 — 2026-09-14',impressions:18420,clicks:412,ctr:2.24,cpc:0.86,videoCompletion:31.8,observedAt:time,quality:'sufficient'});
  data.conclusions.push({id:`${pack.campaignId}-conclusion-1`,campaignId:pack.campaignId,planId:plan.id,cardId:pack.cardId,cardVersion:pack.cardVersion,assetIds:[asset.id],state:'continue',title:'保留场景开头',body:'日常通勤场景能较快建立产品与受众的关联，下一轮应保留这一变量。',basis:'虚构的完整数据示例：映射完整，观察期 14 天。',confidence:'中等',applicability:'英语市场 · Meta · 城市通勤人群',status:'candidate',createdAt:time});
}

export function addExample(data,id,name,status='cards_ready') {
  const campaign={id,name,status:'draft',brandId:'brand-demo',brandSnapshotId:`${id}-snapshot`,briefId:`${id}-brief`,createdAt:time,updatedAt:time,archived:false};
  data.campaigns.push(campaign);
  data.snapshots.push({id:campaign.brandSnapshotId,brandId:'brand-demo',version:1,confirmation:'confirmed',facts:{...data.brands[0].facts}});
  data.briefs.push({id:campaign.briefId,campaignId:id,version:1,objective:'找到让通勤人群愿意了解产品的表达方式',product:'日常随行杯',audience:'注重日常便利与设计的城市通勤者',channel:'Meta',style:'产品演示',focusSignals:['竞品动作','用户语言'],limitations:'不使用未经证明的效果承诺'});
  if(status!=='draft'&&status!=='discovering')addCardExamples(data,campaign);
  if(['creating','launch_ready','learning','closed'].includes(status)){
    const pack=adoptCardExample(data,data.cards.find(x=>x.campaignId===id));
    if(status==='creating')addStoryboardFixture(data,pack);
    if(status==='launch_ready')addLaunchFixture(data,pack);
    if(['learning','closed'].includes(status))addLearningFixture(data,pack);
  }
  campaign.status=status;
  return campaign;
}

export function createExamples() {
  const data={brands:[{id:'brand-demo',name:'DAYFORM · 示例品牌',websiteUrl:'https://dayform.example',version:1,facts:{product:'日常随行杯（虚构示例）',claim:'让随行咖啡成为轻松的日常',audience:'城市通勤人群',limitations:'不使用未经验证的保温时长或防漏承诺',competitors:'同类设计型随行杯品牌',market:'北美英语市场'},memory:[]}],campaigns:[],snapshots:[],briefs:[],discoveries:[],cards:[],packages:[],angles:[],configs:[],assets:[],plans:[],mappings:[],metrics:[],conclusions:[],brandAssets:[
    {id:'brand-asset-1',brandId:'brand-demo',name:'随行杯正面产品图',type:'image',format:'PNG',status:'ready',source:'brand_library',updatedAt:time},
    {id:'brand-asset-2',brandId:'brand-demo',name:'通勤场景图',type:'image',format:'JPG',status:'ready',source:'brand_library',updatedAt:time},
    {id:'brand-asset-3',brandId:'brand-demo',name:'DAYFORM 深色 Logo',type:'logo',format:'SVG',status:'ready',source:'brand_library',updatedAt:time}
  ],connections:[{id:'meta-demo',brandId:'brand-demo',provider:'Meta',status:'disconnected',scopes:['ads_read'],lastSyncedAt:'2026-09-14T01:20:00Z'}],audit:[],jobs:[]};
  addExample(data,'morning','通勤系列 · 找到第一条创意','cards_ready');
  addExample(data,'details','设计细节 · 首批创意探索','creating');
  addExample(data,'weekend','周末场景 · 准备下一次测试','launch_ready');
  addExample(data,'learning','秋季表达 · 复盘场景开头','learning');
  data.jobs=[
    {id:'job-preview',campaignId:'details',type:'storyboard',status:'succeeded',createdAt:time,resumePath:'/campaigns/details/create',steps:[{status:'succeeded'},{status:'succeeded'},{status:'succeeded'}]},
    {id:'job-example-failed',campaignId:'weekend',type:'video',status:'failed',createdAt:time,resumePath:'/campaigns/weekend/create',steps:[{status:'succeeded'},{status:'failed'}],error:{message:'失败状态示例：此处展示原因说明与重试入口。'}}
  ];
  return data;
}
