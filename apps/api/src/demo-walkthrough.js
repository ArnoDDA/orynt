import { randomUUID } from 'node:crypto';
import { digest } from './demo-library.js';
import { productionPlan } from '../../../packages/domain/src/production-plan.js';

const timestamp = () => new Date().toISOString();
const fieldsFor = view => ({ product: `${view.product.name} · ${view.product.variant}`, claim: '日常随身出行，让水杯成为出门装备的一部分。', audience: view.creative.audience, competitors: '', market: 'Singapore', limitations: view.product.boundary });
const copyFor = view => ({ opening: view.creative.copy[0], detail: view.creative.copy[1], cta: view.creative.copy[2].replace(`${view.product.name} · `, '') });
const scenesFor = view => {
  let start = 0;
  return view.scenes.map((scene, index) => {
    const end = start + scene.duration;
    const result = { title: scene.title, text: scene.description, timing: scene.timing, start, end, screenCopy: Object.values(copyFor(view))[index], source: index === 2 ? 'continuing_video' : 'recorded_product_reference' };
    start = end;
    return result;
  });
};
// The pinned film's plan supplies every downstream description, not the generic
// card template that initially created these ordinary domain entities.
function alignContent(content, view) {
  const scenes = scenesFor(view), plan = content.advertisingPlan;
  Object.assign(content, { title: view.title, audience: view.creative.audience, opportunity: view.market.decision, testHypothesis: view.creative.question, creativeRoute: { hook: scenes[0].text, proof: scenes[1].text, style: view.creative.look }, testPlan: null,
    validationPlan: { mode: 'single_creative', scope: view.simulation.comparison, successSignal: view.simulation.metric },
    planningNotice: '本轮只有一条生活场景广告；两个生成镜头与动态收尾对应下方脚本。未制作对照版，不构成 A/B 测试。' });
  Object.assign(plan, { name: '日常随身出行', title: view.title, source: 'recorded_creative_plan', audience: view.creative.audience, audienceBasis: 'creative_hypothesis', hook: scenes[0].text, proof: scenes[1].text, style: view.creative.look, hypothesis: view.creative.question,
    focus: { value: view.creative.concept, factIds: [], kind: 'creative_hypothesis' },
    route: { id: 'everyday_carry', label: '日常出行情境', reason: '门边准备 → 城市窗边停留 → 延续城市镜头的动态品牌收尾。产品保持静置，用环境与运镜表达日常陪伴，不演示手持、开盖或饮水。' },
    execution: { mode: 'recorded_product_reference', label: '官网图参考静帧 → 两段真实生成视频 → 本地动态字幕收尾', exactProductInGeneratedScenes: true },
    productionCopy: copyFor(view),
    shots: scenes.map((scene, index) => ({ index, title: scene.title, description: scene.text, timing: scene.timing, start: scene.start, end: scene.end, screenCopy: scene.screenCopy, source: scene.source, purpose: view.scenes[index].purpose, factIds: [], materialIds: [] })),
    visualBrief: { setting: view.creative.concept, palette: view.creative.look, rationale: view.market.decision }, limitations: [view.product.boundary, view.market.boundary] });
  for (const key of ['control', 'variant', 'constant', 'successSignal']) delete plan[key];
}
const record = (s, prefix, data) => ({ id: `${prefix}_${randomUUID()}`, workspaceId: s.workspace.id, createdAt: timestamp(), ...data });

// Recorded results drive the ordinary domain entities and human review gates.
// This adapter never calls a crawler, image model, video model or editor.
export class DemoWalkthrough {
  constructor(library) { this.library = library; }
  async prepare() {
    this.bundle = await this.library.load();
    const v = this.bundle.view;
    this.available = v.integrity && v.technical?.status === 'passed' && !!(v.media.finalVideo || v.reviewMedia?.finalVideo) && v.evidence?.length > 0;
    return this.available;
  }
  binding(requireValue) {
    requireValue(this.available, 'DEMO_UNAVAILABLE', '演示素材缺失或校验失败，请先检查本地素材。', 409);
    const v = this.bundle.view;
    return { id: v.id, revision: v.contentHash, label: '演示模式 · 复用已保存的真实结果', product: v.product, facts: fieldsFor(v), copy: copyFor(v), scenes: scenesFor(v) };
  }
  attach(campaign, snapshot, brief, requireValue) {
    campaign.replay = this.binding(requireValue);
    campaign.name = 'Owala · 随身出行广告 · 全流程演示';
    snapshot.facts = fieldsFor(this.bundle.view); snapshot.assetIds = [];
    Object.assign(brief, fieldsFor(this.bundle.view), { objective: this.bundle.view.creative.question, channel: 'Meta', style: '产品实拍' });
  }
  execute(ctx) {
    const { s, action, resourceId, b, requireValue, get, requireWritableCampaign, queue, audit } = ctx;
    if (action === 'campaign.create' && b.mode === 'demo_replay') {
      const binding = this.binding(requireValue);
      requireValue(b.brandUrl === binding.product.url && !b.brandId, 'DEMO_PRODUCT_MISMATCH', '完整流程演示固定使用这个 Owala 款式。其他产品请使用普通创作。', 409);
      requireValue(b.importFromUrl === true, 'DEMO_IMPORT_REQUIRED', '请从产品链接开始完整演示。', 409);
      return;
    }
    let campaign = s.campaigns.find(c => c.id === resourceId);
    for (const collection of ['snapshots','packages','configs','generationRequests','assets','jobs','plans','cards']) {
      const entity = s[collection].find(e => e.id === resourceId);
      if (entity?.campaignId) campaign = s.campaigns.find(c => c.id === entity.campaignId);
    }
    if (!campaign?.replay) return;
    requireWritableCampaign(campaign);
    const fixed = campaign.replay, snapshot = get(s, 'snapshots', campaign.brandSnapshotId);
    // A separate local edit keeps the accepted replay and its confirmations intact.
    if (action === 'production.forkEdit') return;
    if (action === 'production.reedit' && s.generationRequests.some(r=>r.id===resourceId&&r.localEdit)) return;
    const unchanged = (condition) => requireValue(condition, 'DEMO_INPUT_LOCKED', '本轮演示使用固定产品与脚本，修改后不能复用这条成片。请从工作台新建普通创作。', 409);
    if (action === 'demo.alignPlan') {
      unchanged(this.available && fixed.revision === this.bundle.view.contentHash);
      if (fixed.alignmentVersion === 1) return { aligned: false };
      const view = this.bundle.view, scenes = scenesFor(view), before = [];
      const remember = (collection, entity, keys) => before.push({ collection, id: entity.id, values: Object.fromEntries(keys.map(key => [key, structuredClone(entity[key] ?? null)])) });
      const cards = s.cards.filter(x => x.campaignId === campaign.id), versions = s.cardVersions.filter(v => cards.some(c => c.id === v.cardId));
      for (const config of s.configs.filter(x => x.campaignId === campaign.id)) {
        unchanged(config.scenePlan?.length === 3 && config.scenePlan.every((scene, i) => scene.text === scenes[i].text) && Object.entries(copyFor(view)).every(([key, value]) => config.productionCopy?.[key] === value));
      }
      for (const version of versions) { remember('cardVersions', version, ['content']); alignContent(version.content, view); }
      for (const pack of s.packages.filter(x => x.campaignId === campaign.id)) {
        const content = get(s, 'cardVersions', pack.cardVersionId).content;
        for (const angle of s.angles.filter(x => x.packageId === pack.id)) {
          remember('angles', angle, ['name', 'hook', 'proof', 'visualLanguage', 'scenePlan', 'advertisingPlan']);
          Object.assign(angle, { name: content.advertisingPlan.name, hook: scenes[0].text, proof: scenes[1].text, visualLanguage: view.creative.look, advertisingPlan: structuredClone(content.advertisingPlan), scenePlan: scenes.map(({ title, text }) => ({ title, text })) });
        }
      }
      for (const config of s.configs.filter(x => x.campaignId === campaign.id)) {
        remember('configs', config, ['scenePlan', 'advertisingPlan']);
        config.scenePlan = scenes.map(({ title, text }) => ({ title, text }));
        config.advertisingPlan = structuredClone(get(s, 'angles', config.angleId).advertisingPlan);
      }
      for (const request of s.generationRequests.filter(x => x.campaignId === campaign.id && x.production)) {
        unchanged(request.replay?.revision === fixed.revision && request.production.shots.every((shot, i) => shot.text === scenes[i].text));
        remember('generationRequests', request, []);
        before.at(-1).values.productionMetadata = { advertisingPlan: structuredClone(request.production.advertisingPlan), shots: request.production.shots.map(({ title, start, end, kind }) => ({ title, start, end, kind })) };
        request.production.advertisingPlan = structuredClone(get(s, 'configs', request.configId).advertisingPlan);
        request.production.shots.forEach((shot, i) => Object.assign(shot, { title: scenes[i].title, start: scenes[i].start, end: scenes[i].end, kind: i === 2 ? 'continuing_video' : 'generated_shot' }));
      }
      for (const asset of s.assets.filter(x => x.campaignId === campaign.id && x.type === 'storyboard')) {
        remember('assets', asset, ['scenes']); asset.scenes = structuredClone(get(s, 'configs', asset.configId).scenePlan);
      }
      remember('campaigns', campaign, ['replay']);
      campaign.replay = { ...fixed, scenes, copy: copyFor(view), alignmentVersion: 1 };
      audit(s, 'demo_plan_metadata_aligned', campaign.id, before, { revision: fixed.revision, mediaUnchanged: true });
      return { aligned: true, records: before.length };
    }
    if (action === 'snapshot.confirm') {
      unchanged(!b.skip && b.brandName === 'Owala' && Object.entries(fixed.facts).every(([k,v]) => String(b[k] || '') === v));
      unchanged(b.importImageIds?.length === 1 && b.importImageIds[0] === snapshot.productImport?.images[0]?.id);
    }
    if (action === 'brief.update') unchanged(['product','audience','limitations'].every(k => b[k] === fixed.facts[k]) && b.channel === 'Meta' && b.objective === get(s,'briefs',campaign.briefId).objective);
    if (action === 'discovery.start') unchanged(snapshot.confirmation === 'confirmed');
    if (action === 'config.create') {
      unchanged(b.ratio === '9:16' && Number(b.duration) === 15 && b.language === 'English' && b.music === 'ambient' && !b.notes && !b.templateId);
      unchanged(b.scenePlan?.length === 3 && b.scenePlan.every((scene,i) => scene.text === fixed.scenes[i].text && !scene.direction));
      unchanged(Object.entries(fixed.copy).every(([k,v]) => b.productionCopy?.[k] === v));
      unchanged(b.brandAssetIds?.length === 1 && snapshot.assetIds.includes(b.brandAssetIds[0]));
      // Historical reference use is recorded; this command does not grant or use
      // permission to send anything externally in the walkthrough.
      unchanged(b.productTreatment === 'local_product_overlay');
    }
    if (['productImport.start','productImport.skip','template.import','asset.import','cards.refresh','production.reviseKeyframe','production.reviseShot','production.reedit','production.recoverVideo','production.localProductVersion'].includes(action)) unchanged(false);
    if (action === 'generation.start') unchanged(b.mode === 'storyboard');
    if (action === 'production.start') {
      const config = get(s,'configs',resourceId);
      unchanged(config.scenePlan?.length === 3 && config.scenePlan.every((scene, i) => scene.text === fixed.scenes[i].text) && Object.entries(fixed.copy).every(([key, value]) => config.productionCopy[key] === value));
      requireValue(!s.jobs.some(j => j.campaignId === campaign.id && ['production','video','storyboard'].includes(j.type) && ['queued','running'].includes(j.status)), 'JOB_CONFLICT','当前制作尚未结束。',409);
      const image = get(s,'brandAssets',config.brandAssetIds[0]);
      unchanged(image.sourceUrl === fixed.product.imageUrl);
      const production = productionPlan({ config, product: fixed.facts.product, brandName: 'Owala', claim: fixed.facts.claim });
      production.referenceMode = 'generated_first_frame'; production.productTreatment = 'recorded_product_reference';
      production.productImage = { assetId: image.id, base64: image.base64, mime: image.mime, name: image.name };
      const scenes = scenesFor(this.bundle.view);
      production.shots.forEach((shot,i) => Object.assign(shot, { title: scenes[i].title, start: scenes[i].start, end: scenes[i].end, targetDuration: scenes[i].end - scenes[i].start, kind: i === 2 ? 'continuing_video' : 'generated_shot' }));
      const request = record(s,'generation_request',{ campaignId: campaign.id, packageId: config.packageId, angleId: config.angleId, configId: config.id, cardVersionId: config.cardVersionId, mode:'video', workflow:'shot_pipeline', provider:'recorded_youmind', replay: { id: fixed.id, revision: fixed.revision }, status:'queued', safetyStatus:'pending', production });
      s.generationRequests.push(request);
      const job = queue(s,campaign.id,'production',{ generationRequestId: request.id, configId: config.id },{ type:'generation_request',id:request.id }); request.jobId = job.id;
      audit(s,'demo_production_started',request.id);
      return { jobId:job.id,generationRequestId:request.id };
    }
    if (action === 'production.approveKeyframe' || action === 'production.approveShot') {
      const request = get(s,'generationRequests',resourceId), p = request.production, job = get(s,'jobs',request.jobId), index = Number(b.index), shot = p.shots[index];
      requireValue(request.replay?.revision === fixed.revision && shot && index < 2 && index >= 0 && Number.isInteger(index),'INVALID_PRODUCTION','请选择本轮演示镜头。',409);
      requireValue(job.status !== 'cancelled','PRODUCTION_PAUSED','请先继续已暂停的制作。',409);
      if (action === 'production.approveKeyframe') {
        requireValue(Number(b.version) === shot.keyframe?.version && Number(b.shotVersion) === shot.version,'STALE_SHOT','画面版本已变更，请刷新。',409);
        requireValue(p.phase === 'awaiting_keyframe_review' && shot.keyframe?.status === 'ready' && shot.keyframe.review.status === 'pending','KEYFRAME_NOT_READY','当前没有待确认的图片。',409);
        shot.keyframe.review = { status:'accepted', version:shot.keyframe.version, reviewedAt:timestamp() }; p.phase = index === 0 ? 'first_shot' : 'remaining_shots';
      } else {
        requireValue(Number(b.version) === shot.version,'STALE_SHOT','镜头版本已变更，请刷新。',409);
        requireValue(index === 0 && p.phase === 'awaiting_review' && shot.status === 'ready','SHOT_NOT_READY','当前没有待确认的首镜头。',409);
        shot.review = { status:'accepted',version:shot.version,reviewedAt:timestamp() }; p.phase = 'remaining_shots';
      }
      job.status = 'queued'; audit(s,action,request.id);
      return { jobId:job.id,generationRequestId:request.id };
    }
  }
  async tick(core, repository, original) {
    await this.prepare();
    repository.transact(s => {
      const job = s.jobs.find(j => j.id === original.id), c = s.campaigns.find(c => c.id === job?.campaignId);
      if (!job || !c?.replay || !['queued','running'].includes(job.status) || job.attemptId !== original.attemptId) return;
      const fail = message => { job.status='failed'; job.error={code:'DEMO_SNAPSHOT_UNAVAILABLE',message}; const r=s.generationRequests.find(r=>r.id===job.input.generationRequestId); if(r){r.status='failed';r.production && (r.production.phase='failed');} };
      if (!this.available || this.bundle.view.contentHash !== c.replay.revision) return fail('本轮演示绑定的素材版本缺失或已更换；请恢复原版本或新建演示，不会转为付费生成。');
      const { view, files, reviewFiles } = this.bundle, media = name => files.get(name) || reviewFiles.get(name), encoded = name => media(name).bytes.toString('base64');
      const milestone = count => { for(const step of job.steps.slice(0,count)){step.status='succeeded';step.finishedAt ||= timestamp();}job.updatedAt=timestamp(); };
      const finish = bundle => { core.complete(s,job,bundle); for(const step of job.steps){step.status='succeeded';step.finishedAt=timestamp();} job.status='succeeded';job.completedAt=timestamp();delete job.providerResult; };
      const image = { name:'Owala · 黑色 18oz 官网产品图', mime:media('productPhoto').mime,base64:encoded('productPhoto'),sourceUrl:view.product.imageUrl,variantId:view.product.variantId,variantName:view.product.variant,identityStatus:'selected_variant' };
      if (job.type === 'product_import') {
        job.providerResult = { sourceUrl:view.product.url, observedAt:view.frozenAt, pageKind:'product', fields:Object.fromEntries(Object.entries({brandName:'Owala',product:c.replay.facts.product,claim:c.replay.facts.claim}).map(([k,value])=>[k,{value,sourceType:'saved_website_snapshot',confidence:1}])), images:[image], selectedVariantId:view.product.variantId, details:{}, limitations:['演示使用已保存的官网资料；不会重新读取网页。'] };
        finish(); const snap=s.snapshots.find(x=>x.id===job.input.snapshotId);snap.productImport.selectedImageIds=[snap.productImport.images[0].id];return;
      }
      if (job.type === 'discovery') {
        const evidence=view.evidence.map(e=>{
          // Reuse only saved originals for this exact public ad, never generated media.
          const cached=s.evidence.find(saved=>saved.sourceType==='meta_ad_library' && saved.sourceUrl===e.url && !saved.attributes?.demo && s.discoverySources.some(source=>source.id===saved.discoverySourceId && source.status==='available') && saved.attributes?.media?.some(m=>m.status==='available' && m.base64));
          return {sourceType:'meta_ad_library',sourceUrl:e.url,observedAt:e.observedAt,title:'Owala · 日常出行公开文案',contentSummary:e.copy,contentHash:digest(e.copy),rawEvidenceRef:cached?.rawEvidenceRef,attributes:{bodyText:e.copy,advertiserName:e.advertiser||'Owala',available:true,...(cached?{media:structuredClone(cached.attributes.media),mediaCheckedAt:cached.attributes.mediaCheckedAt}:{})}};
        });
        finish({provider:'saved_public_evidence',sources:evidence.map(e=>({...e,status:'available'})),evidence,coverage:{externalSignals:evidence.length,visualAds:evidence.filter(e=>e.attributes.media?.length).length},limitations:[view.market.boundary,'演示使用历史公开样本，不代表实时采集或已验证效果。']});return;
      }
      if (job.type === 'cards') {
        finish();
        const set=s.cardSets.find(x=>x.id===job.resultId), [first,...others]=set.cardIds, removed=new Set(others), card=s.cards.find(x=>x.id===first), version=s.cardVersions.find(v=>v.id===card.currentVersionId), content=version.content, plan=content.advertisingPlan;
        s.cards=s.cards.filter(x=>!removed.has(x.id));s.cardVersions=s.cardVersions.filter(x=>!removed.has(x.cardId));s.cardEvidence=s.cardEvidence.filter(x=>!removed.has(x.cardId));set.cardIds=[first];
        alignContent(content, view);
        content.evidenceBasis='public_sample';version.quality={status:'partial',evidenceStatus:'traceable_small_sample',source:'recorded_evidence_plan',supportingEvidenceCount:view.evidence.length};
        plan.visualBrief={setting:view.creative.concept,palette:view.creative.look,rationale:view.market.decision};
        const evidence=s.evidence.filter(e=>e.discoveryId===job.input.discoveryId);
        plan.marketBasis={status:'public_copy_observation',evidenceIds:evidence.map(e=>e.id),samples:evidence.map(e=>({id:e.id,quote:e.contentSummary,sourceUrl:e.sourceUrl,observedAt:e.observedAt,advertiser:'Owala'})),explanation:view.market.observation,limitation:view.market.boundary};
        plan.limitations=[view.product.boundary,view.market.boundary];
        content.facts=evidence.map(e=>({statement:e.contentSummary,evidenceIds:[e.id],sourceUrl:e.sourceUrl,observedAt:e.observedAt}));
        s.cardEvidence=s.cardEvidence.filter(e=>e.cardId!==card.id);for(const e of evidence)s.cardEvidence.push(record(s,'card_evidence',{cardId:card.id,cardVersionId:version.id,evidenceId:e.id,discoveryId:job.input.discoveryId,relation:'supports'}));
        return;
      }
      if (job.type === 'storyboard') { finish();return; }
      if (job.type !== 'production') return fail('演示中不支持此类外部任务。');
      const request=s.generationRequests.find(r=>r.id===job.input.generationRequestId),p=request.production;
      milestone(1);
      const frame = index => { const shot=p.shots[index];shot.keyframe={version:1,status:'ready',source:'recorded_youmind',purpose:'first_frame',history:[],review:{status:'pending'},base64:encoded(`shot${index+1}Frame`),mime:'image/png',sha256:digest(media(`shot${index+1}Frame`).bytes),technical:{width:1440,height:2560,issues:[]},replay:{revision:c.replay.revision,asset:`shot${index+1}Frame`}};shot.status='awaiting_keyframe_review';p.phase='awaiting_keyframe_review'; };
      const video = index => { const shot=p.shots[index];Object.assign(shot,{status:'ready',base64:encoded(`shot${index+1}Video`),thumbnailBase64:encoded(`shot${index+1}Frame`),thumbnailMime:media(`shot${index+1}Frame`).mime,technical:{width:1080,height:1920,duration:index===0?5.041667:10.041667,issues:[]},replay:{revision:c.replay.revision,asset:`shot${index+1}Video`}}); };
      if(!p.shots[0].keyframe){frame(0);return;}
      if(p.shots[0].keyframe.review.status!=='accepted'){p.phase='awaiting_keyframe_review';return;}
      if(p.shots[0].status!=='ready'){video(0);milestone(2);p.phase='awaiting_review';return;}
      if(p.shots[0].review?.status!=='accepted'){p.phase='awaiting_review';return;}
      milestone(3);
      if(!p.shots[1].keyframe){frame(1);return;}
      if(p.shots[1].keyframe.review.status!=='accepted'){p.phase='awaiting_keyframe_review';return;}
      if(p.shots[1].status!=='ready'){video(1);milestone(4);p.phase='assembly';return;}
      job.providerResult={base64:encoded('finalVideo'),filename:'owala-everyday-v2.mp4',technical:{width:1080,height:1920,duration:15,hasAudio:true,issues:[]},manifest:{replay:{id:view.id,revision:c.replay.revision,sha256:digest(media('finalVideo').bytes)},copy:p.copy,timeline:view.scenes.map(scene=>({title:scene.title,timing:scene.timing}))}};
      finish();const asset=s.assets.find(a=>a.id===request.assetId);asset.replay=request.replay;asset.provider='recorded_youmind';request.provider='recorded_youmind';
    });
  }
}
