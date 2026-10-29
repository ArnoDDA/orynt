import { productionPlan } from '../../../packages/domain/src/production-plan.js';
import { isValidShotDirection, normalizeShotDirection } from '../../../packages/domain/src/shot-direction.js';
import { reviewProductionPlan } from '../../../packages/domain/src/production-quality.js';

function checkedPlan(production, config, requireValue) {
  const report = reviewProductionPlan(production, config);
  requireValue(report.valid, 'PRODUCTION_PLAN_ISSUES', report.errors.map(e => e.message).join(' '));
  return report;
}

export function executeProduction({ s, action, resourceId, b, get, requireValue, requireWritableCampaign, object, queue, audit }) {
  if (action === 'production.forkEdit') {
    const original=get(s,'generationRequests',resourceId),campaign=get(s,'campaigns',original.campaignId);
    requireWritableCampaign(campaign);
    requireValue(original.replay && original.production?.phase==='completed' && original.assetId,'EDIT_SOURCE_NOT_READY','先完成并保存演示成片，再另存剪辑版本。',409);
    const config=get(s,'configs',original.configId);
    requireValue(config.ratio==='9:16'&&Number(config.duration)===15&&original.production.shots[2]?.kind==='continuing_video','INVALID_EDITORIAL_SOURCE','请选择完整的竖屏动态收尾演示片。',409);
    requireValue(original.production.shots.slice(0,2).every(shot=>shot.base64&&shot.status==='ready'&&shot.technical&&!shot.technical.issues.length),'SHOTS_NOT_READY','已保存的原始镜头不完整，未开始剪辑。',409);
    requireValue(!s.jobs.some(j=>j.campaignId===campaign.id&&['production','video','storyboard'].includes(j.type)&&['queued','running'].includes(j.status)),'JOB_CONFLICT','当前已有制作任务，请完成后再另存剪辑。',409);
    const copy=b.copy;
    requireValue(copy&&['opening','detail','cta'].every(key=>typeof copy[key]==='string'&&copy[key].length<=(key==='cta'?24:70))&&copy.opening.trim()&&copy.cta.trim(),'INVALID_COPY','请填写开场标题与收尾引导，标题最多 70 字，引导最多 24 字。');
    requireValue(['ambient','none'].includes(b.music),'INVALID_CONFIG','请选择轻配乐或无声。');
    const production=structuredClone(original.production);
    production.copy=Object.fromEntries(['opening','detail','cta'].map(key=>[key,copy[key].trim()]));
    production.music=b.music;production.phase='assembly';production.editVersion=1;
    production.editStyle='editorial_continuing_video';delete production.qualityChecks;
    const request=object(s,'generation_request',{campaignId:campaign.id,packageId:original.packageId,angleId:original.angleId,configId:original.configId,cardVersionId:original.cardVersionId,mode:'video',workflow:'shot_pipeline',provider:'local_editorial',status:'queued',safetyStatus:'pending',derivedFrom:original.id,localEdit:{sourceRequestId:original.id,sourceAssetId:original.assetId,revision:original.replay.revision,source:'recorded_youmind',label:'复用真实镜头 · 本地重新剪辑'},production});
    s.generationRequests.push(request);
    const job=queue(s,campaign.id,'production',{generationRequestId:request.id,configId:request.configId},{type:'generation_request',id:request.id});
    request.jobId=job.id;
    for(const step of job.steps.slice(0,4)){step.status='succeeded';step.finishedAt=new Date().toISOString();}
    audit(s,'production_edit_forked',request.id);
    return {jobId:job.id,generationRequestId:request.id};
  }
  if(action==='production.localProductVersion') {
    const original=get(s,'generationRequests',resourceId),campaign=get(s,'campaigns',original.campaignId),oldJob=get(s,'jobs',original.jobId);
    requireWritableCampaign(campaign);
    requireValue(original.workflow==='shot_pipeline'&&original.production.referenceMode==='generated_first_frame'&&original.production.productTreatment!=='local_product_overlay','INVALID_PRODUCTION','请选择尚未采用原图合成的关键帧制作。',409);
    requireValue(['awaiting_review','completed','failed'].includes(original.production.phase),'PRODUCTION_BUSY','请先等待当前镜头制作结束。',409);
    requireValue(original.production.shots[0].technical&&!original.production.shots[0].technical.issues.length&&original.production.shots[0].base64&&original.production.shots[0].keyframe?.base64,'SHOT_NOT_READY','需要已有背景镜头及图片，才能不消耗额度制作本地新版。',409);
    requireValue(!s.jobs.some(j=>j.id!==oldJob.id&&j.campaignId===campaign.id&&['production','video','storyboard'].includes(j.type)&&['queued','running'].includes(j.status)),'JOB_CONFLICT','其他制作正在进行。',409);
    const production=structuredClone(original.production);
    production.productTreatment='local_product_overlay';production.phase='preparing';delete production.qualityChecks;
    for(const shot of production.shots.slice(0,2)) {
      if(shot.base64&&shot.technical&&!shot.technical.issues.length) {
        shot.backgroundBase64=shot.base64;shot.backgroundTechnical=shot.technical;
        shot.reusedFrom={generationRequestId:original.id,shotIndex:shot.index,shotVersion:shot.version};
      }
      for(const key of ['base64','technical','thumbnailBase64','review','error','prompt','submissionStartedAt','recovery','productComposition'])delete shot[key];
      shot.status='pending';shot.history=[];
      if(shot.keyframe) { shot.keyframe.review={status:'pending'};delete shot.keyframe.error;delete shot.keyframe.productPreview; }
    }
    if(['queued','running'].includes(oldJob.status)) {
      oldJob.status='cancelled';oldJob.cancelledAt=new Date().toISOString();oldJob.updatedAt=oldJob.cancelledAt;
      for(const step of oldJob.steps)if(step.status!=='succeeded')step.status='cancelled';
      original.status='cancelled';original.production.phase='cancelled';
    }
    const request=object(s,'generation_request',{campaignId:original.campaignId,packageId:original.packageId,angleId:original.angleId,configId:original.configId,cardVersionId:original.cardVersionId,mode:'video',workflow:'shot_pipeline',provider:'youmind_local_edit',status:'queued',safetyStatus:'pending',derivedFrom:original.id,production});
    s.generationRequests.push(request);
    const job=queue(s,campaign.id,'production',{generationRequestId:request.id,configId:request.configId},{type:'generation_request',id:request.id});request.jobId=job.id;
    audit(s,'production_local_product_version',request.id);
    return {jobId:job.id,generationRequestId:request.id};
  }
  if(action==='production.recoverVideo') {
    const request=get(s,'generationRequests',resourceId),campaign=get(s,'campaigns',request.campaignId),job=get(s,'jobs',request.jobId);
    requireWritableCampaign(campaign);
    requireValue(request.workflow==='shot_pipeline'&&job.status==='failed','VIDEO_NOT_RECOVERABLE','当前视频不需要恢复。',409);
    const index=Number(b.index),shot=request.production.shots[index];
    requireValue(Number.isInteger(index)&&index>=0&&index<2&&shot&&Number(b.version)===shot.version,'STALE_SHOT','镜头已有新版本，请刷新后操作。',409);
    requireValue(shot.providerState?.chatId&&!shot.providerState.url&&!shot.base64&&shot.status==='failed','VIDEO_NOT_RECOVERABLE','请保留已有视频，或先核查尚未取得回执的提交。',409);
    requireValue(shot.keyframe?.review?.status==='accepted','KEYFRAME_NOT_READY','请先确认镜头图片。',409);
    requireValue(b.resubmit===undefined||typeof b.resubmit==='boolean','INVALID_INPUT','恢复选项无效。');
    requireValue(!b.resubmit||(shot.videoAttempts||[]).length<3,'VIDEO_RETRY_LIMIT','本镜头已重试多次，请先检查生成服务。',409);
    requireValue(!s.jobs.some(j=>j.id!==job.id&&j.campaignId===campaign.id&&['production','video','storyboard'].includes(j.type)&&['queued','running'].includes(j.status)),'JOB_CONFLICT','其他创作正在进行。',409);
    // Re-query the existing receipt first. Only the runner can establish a
    // terminal tool failure; a browser flag cannot authorize blind submission.
    shot.recovery={mode:b.resubmit?'resubmit':'check',requestedAt:new Date().toISOString()};
    shot.status='generating';delete shot.error;
    for(const step of job.steps)if(step.status!=='succeeded'){step.status='queued';delete step.error;delete step.finishedAt;}
    job.status='queued';job.attemptId=`video_recovery_${request.id}_${index}_${shot.recovery.requestedAt}`;
    delete job.error;delete job.completedAt;request.status='queued';delete request.error;request.production.phase='resuming';
    audit(s,b.resubmit?'production_video_recovery_requested':'production_video_checked',request.id);
    return {jobId:job.id,generationRequestId:request.id};
  }
  if (action === 'production.start') {
    const config = get(s, 'configs', resourceId), campaign = get(s, 'campaigns', config.campaignId);
    requireWritableCampaign(campaign);
    requireValue(!s.jobs.some(j => j.campaignId === campaign.id && ['video', 'storyboard', 'production'].includes(j.type) && ['queued', 'running'].includes(j.status)), 'JOB_CONFLICT', '当前创作仍在进行，请完成或取消后继续。', 409);
    const image = config.brandAssetIds.map(id => s.brandAssets.find(a => a.id === id && a.brandId === campaign.brandId && a.status === 'ready' && a.type !== 'logo' && ['image/png','image/jpeg','image/webp'].includes(a.mime))).find(Boolean);
    requireValue(image, 'PRODUCT_PHOTO_REQUIRED', '请先选择一张真实产品图（PNG、JPG 或 WebP），用于成片收尾，保留产品原貌。');
    const snapshot = get(s, 'snapshots', campaign.brandSnapshotId), brief = get(s, 'briefs', campaign.briefId), brand = get(s, 'brands', campaign.brandId), angle = get(s, 'angles', config.angleId);
    const production = productionPlan({ config, product: brief.product || snapshot.facts.product, claim: snapshot.facts.claim, brandName: snapshot.brandName || brand.name, route: { hook: angle.hook, proof: angle.proof } });
    production.qualityChecks = { plan: checkedPlan(production, config, requireValue) };
    requireValue(b.keyframes===undefined||typeof b.keyframes==='boolean','INVALID_PRODUCTION','关键帧选项无效。');
    if(b.keyframes){
      production.referenceMode='generated_first_frame';
      for(const shot of production.shots.slice(0,2))shot.keyframe={version:1,status:'pending',source:'youmind_generated',purpose:'first_frame',history:[],review:{status:'pending'}};
    }
    const treatment=b.productTreatment||config.productTreatment||(b.keyframes?'local_product_overlay':'local_original_endcard');
    requireValue(['local_product_overlay','local_original_endcard','product_reference'].includes(treatment),'INVALID_PRODUCTION','产品图呈现方式无效。');
    requireValue(treatment!=='local_product_overlay'||b.keyframes,'INVALID_PRODUCTION','原图合成需要先确认关键帧。');
    requireValue(treatment!=='product_reference'||(b.keyframes&&config.publicReferenceConsent?.granted&&config.publicReferenceConsent.assetId===image.id&&config.publicReferenceConsent.sourceUrl===image.sourceUrl&&image.source==='confirmed_website_import'),'PRODUCT_REFERENCE_CONSENT_REQUIRED','请在脚本设置中确认官网公开图片参考范围，再开始制作。');
    production.productTreatment=treatment;
    if(treatment==='product_reference')production.productReference={assetId:image.id,sourceUrl:image.sourceUrl,consent:structuredClone(config.publicReferenceConsent),status:'pending'};
    production.qualityChecks={plan:checkedPlan(production,config,requireValue)};
    // Freeze the selected original as well as its ID; later brand edits cannot change this film.
    production.productImage = { assetId: image.id, base64: image.base64, mime: image.mime, name: image.name };
    const request = object(s, 'generation_request', { campaignId: campaign.id, packageId: config.packageId, angleId: config.angleId, configId: config.id, cardVersionId: config.cardVersionId, mode: 'video', workflow: 'shot_pipeline', provider: 'youmind_local_edit', status: 'queued', safetyStatus: 'pending', production });
    s.generationRequests.push(request);
    const job = queue(s, campaign.id, 'production', { generationRequestId: request.id, configId: config.id }, { type: 'generation_request', id: request.id });
    request.jobId = job.id;
    audit(s, 'production_started', request.id);
    return { jobId: job.id, generationRequestId: request.id };
  }

  if (action==='production.approveKeyframe'||action==='production.reviseKeyframe') {
    const request=get(s,'generationRequests',resourceId),campaign=get(s,'campaigns',request.campaignId),job=get(s,'jobs',request.jobId);
    requireWritableCampaign(campaign);
    requireValue(request.workflow==='shot_pipeline'&&request.production.referenceMode==='generated_first_frame','INVALID_PRODUCTION','这轮制作没有启用关键帧。');
    const index=Number(b.index),shot=request.production.shots[index],frame=shot?.keyframe;
    requireValue(Number.isInteger(index)&&index>=0&&index<2&&frame,'INVALID_SHOT','请选择生成镜头。');
    requireValue(Number(b.version)===frame.version&&Number(b.shotVersion)===shot.version,'STALE_SHOT','关键帧已有新版本，请刷新后操作。',409);
    requireValue(['awaiting_keyframe_review','failed'].includes(request.production.phase)&&!shot.submissionStartedAt,'KEYFRAME_LOCKED','视频正在制作或已提交，不能替换它的关键帧。',409);
    requireValue(!s.jobs.some(j=>j.id!==job.id&&j.campaignId===campaign.id&&['production','video','storyboard'].includes(j.type)&&['queued','running'].includes(j.status)),'JOB_CONFLICT','其他创作正在进行。',409);
    if(action==='production.approveKeyframe') {
      requireValue(request.production.phase==='awaiting_keyframe_review'&&frame.status==='ready'&&frame.base64&&frame.providerState?.chatId&&frame.providerState?.url&&frame.technical&&!frame.technical.issues.length,'KEYFRAME_NOT_READY','关键帧尚未通过文件检查。',409);
      requireValue(request.production.productTreatment!=='local_product_overlay'||frame.productPreview?.base64,'PRODUCT_PREVIEW_REQUIRED','真实产品合成预览尚未就绪。',409);
      requireValue(request.production.productTreatment!=='product_reference'||frame.providerState?.productReferenceEvidence?.status==='product_reference_confirmed','PRODUCT_REFERENCE_UNVERIFIED','工具回执尚未证实使用真实产品图，不能继续视频制作。',409);
      frame.review={status:'accepted',version:frame.version,reviewedAt:new Date().toISOString()};
      audit(s,'production_keyframe_approved',request.id);
    } else {
      requireValue(!frame.submissionStartedAt||frame.providerState?.chatId,'KEYFRAME_SUBMISSION_UNCERTAIN','上次图片提交结果不确定，已阻止重复提交，请先核查任务。',409);
      requireValue(['ready','failed'].includes(frame.status),'KEYFRAME_NOT_READY','关键帧仍在制作。',409);
      requireValue(frame.version<6,'KEYFRAME_VERSION_LIMIT','请回到脚本重新规划这个镜头。');
      requireValue(typeof b.text==='string'&&b.text.trim()&&b.text.length<=600&&isValidShotDirection(b.direction),'INVALID_SCENE_PLAN','请填写有效画面描述和镜头设计。');
      const plan = checkedPlan({ ...request.production, shots: request.production.shots.map(s => s.index === index ? { ...s, text: b.text.trim(), direction: normalizeShotDirection(b.direction) } : s) }, get(s, 'configs', request.configId), requireValue);
      const history=[...frame.history,{...frame,history:undefined,review:{status:'rejected',reviewedAt:new Date().toISOString()}}];
      shot.text=b.text.trim();shot.direction=normalizeShotDirection(b.direction);delete shot.prompt;
      if(shot.reusedFrom) {
        for(const key of ['backgroundBase64','backgroundTechnical','providerState','base64','technical','thumbnailBase64','productComposition','reusedFrom','submissionStartedAt'])delete shot[key];
      }
      shot.keyframe={version:frame.version+1,status:'pending',source:'youmind_generated',purpose:'first_frame',history,review:{status:'pending'}};
      request.production.qualityChecks = { plan };
      audit(s,'production_keyframe_rejected',request.id);
    }
    for(const step of job.steps)if(step.status!=='succeeded'){step.status='queued';delete step.error;delete step.finishedAt;}
    for(const key of ['error','completedAt'])delete job[key];
    job.status='queued';job.attemptId=`keyframe_${request.id}_${index}_${shot.keyframe.version}_${action}`;
    shot.status='pending';delete shot.error;delete shot.keyframe.error;request.status='queued';request.production.phase=index===0?'first_shot':'remaining_shots';
    return {jobId:job.id,generationRequestId:request.id};
  }

  if (action === 'production.approveShot' || action === 'production.reviseShot') {
    const request = get(s, 'generationRequests', resourceId), campaign = get(s, 'campaigns', request.campaignId), job = get(s, 'jobs', request.jobId);
    requireWritableCampaign(campaign);
    requireValue(request.workflow === 'shot_pipeline', 'INVALID_PRODUCTION', '这不是逐镜头制作任务。');
    const index = Number(b.index), shot = request.production.shots[index];
    requireValue(Number.isInteger(index) && index >= 0 && index < 2 && shot, 'INVALID_SHOT', '请选择一个生成镜头。');
    requireValue(!b.version || Number(b.version) === shot.version, 'STALE_SHOT', '这个镜头已有新版本，请刷新后检查。', 409);
    if (action === 'production.approveShot') {
      requireValue(index === 0 && request.production.phase === 'awaiting_review' && shot.status === 'ready' && !shot.technical?.issues?.length, 'SHOT_NOT_READY', '首个镜头尚未通过文件检查，请先查看或重做。', 409);
      shot.review = { status: 'accepted', reviewedAt: new Date().toISOString(), version: shot.version };
      const step = job.steps.find(s => s.key === 'review_first_shot');
      step.status = 'succeeded'; step.finishedAt = new Date().toISOString();
      request.production.phase = 'remaining_shots'; job.status = 'queued';
      audit(s, 'production_shot_approved', request.id);
    } else {
      requireValue(!shot.submissionStartedAt || shot.providerState?.chatId, 'VIDEO_SUBMISSION_UNCERTAIN', '上次提交结果不确定，已阻止重复付费提交，请先核查任务。', 409);
      requireValue(!shot.keyframe?.submissionStartedAt || shot.keyframe.providerState?.chatId,'KEYFRAME_SUBMISSION_UNCERTAIN','上次图片提交结果不确定，请先核查任务。',409);
      requireValue(['ready','failed'].includes(shot.status), 'SHOT_NOT_REVISABLE', '当前镜头仍在制作，请等待后再调整。', 409);
      requireValue(!s.jobs.some(j => j.id !== job.id && j.campaignId === campaign.id && ['production','video','storyboard'].includes(j.type) && ['queued','running'].includes(j.status)), 'JOB_CONFLICT', '其他创作正在进行。', 409);
      requireValue(['awaiting_review','completed','failed'].includes(request.production.phase), 'PRODUCTION_BUSY', '请等本轮制作结束后再修改镜头。', 409);
      requireValue(typeof b.text === 'string' && b.text.trim() && b.text.length <= 600, 'INVALID_SCENE_PLAN', '请填写 600 字以内的画面描述。');
      requireValue(isValidShotDirection(b.direction), 'INVALID_SHOT_DIRECTION', '镜头设计每项最多 400 字。');
      requireValue(shot.version < 8, 'SHOT_VERSION_LIMIT', '这个镜头已有多次尝试，请回到脚本重新规划。');
      const history = [...shot.history, { ...shot, history: undefined }];
      // Legacy text-only revisions must not carry an obsolete detailed action.
      const direction = normalizeShotDirection(b.direction === undefined && b.text.trim() === shot.text ? shot.direction : b.direction);
      const plan = checkedPlan({ ...request.production, shots: request.production.shots.map(s => s.index === index ? { ...s, text: b.text.trim(), direction } : s) }, get(s, 'configs', request.configId), requireValue);
      Object.assign(shot, { text: b.text.trim(), direction, version: shot.version + 1, status: 'pending', history });
      request.production.qualityChecks = { plan };
      for (const key of ['providerState','technical','base64','thumbnailBase64','error','review','submissionStartedAt','prompt','backgroundBase64','backgroundTechnical','productComposition','reusedFrom']) delete shot[key];
      if(request.production.referenceMode==='generated_first_frame')shot.keyframe={version:1,status:'pending',source:'youmind_generated',purpose:'first_frame',history:[],review:{status:'pending'}};
      const first = index === 0 ? 1 : 3;
      for (const step of job.steps.slice(first)) { step.status = 'queued'; step.attempts = 0; for (const key of ['error','startedAt','finishedAt']) delete step[key]; }
      for (const key of ['resultId','providerResult','error','completedAt']) delete job[key];
      job.status = 'queued'; job.attemptId = `revision_${request.id}_${index}_${shot.version}`;
      request.status = 'queued'; request.safetyStatus = 'pending'; delete request.completedAt;
      request.production.phase = index === 0 ? 'first_shot' : 'remaining_shots';
      audit(s, 'production_shot_revised', request.id);
    }
    return { jobId: job.id, generationRequestId: request.id };
  }

  if (action === 'production.reedit') {
    const request=get(s,'generationRequests',resourceId),job=get(s,'jobs',request.jobId);
    requireWritableCampaign(get(s,'campaigns',request.campaignId));
    requireValue(request.workflow==='shot_pipeline'&&['completed','failed'].includes(request.production.phase)&&request.production.shots.slice(0,2).every(shot=>shot.status==='ready'&&!shot.technical.issues.length), 'SHOTS_NOT_READY', '请先完成两个可用镜头。',409);
    requireValue(!s.jobs.some(j=>j.campaignId===request.campaignId&&['production','video','storyboard'].includes(j.type)&&['queued','running'].includes(j.status)), 'JOB_CONFLICT', '本轮已有制作任务，请完成后再重剪。',409);
    const copy=b.copy;
    requireValue(copy&&['opening','detail','cta'].every(key=>typeof copy[key]==='string'&&copy[key].length<=(key==='cta'?24:70))&&copy.opening.trim()&&copy.cta.trim(),'INVALID_COPY','请填写开场标题与收尾引导，标题最多 70 字，引导最多 24 字。');
    requireValue(['ambient','none'].includes(b.music),'INVALID_CONFIG','请选择轻配乐或无声。');
    request.production.copy=Object.fromEntries(['opening','detail','cta'].map(key=>[key,copy[key].trim()]));request.production.music=b.music;
    request.production.editVersion=(request.production.editVersion||1)+1;request.production.phase='assembly';request.status='queued';delete request.completedAt;
    for(const step of job.steps.slice(4)){step.status='queued';step.attempts=0;for(const key of ['error','startedAt','finishedAt'])delete step[key];}
    for(const key of ['error','providerResult','resultId','completedAt'])delete job[key];job.status='queued';job.attemptId=`edit_${request.id}_${request.production.editVersion}`;
    audit(s,'production_reedited',request.id);return {jobId:job.id};
  }
  if (action === 'production.reviewFinal') {
    const asset = get(s, 'assets', resourceId);
    requireWritableCampaign(get(s, 'campaigns', asset.campaignId));
    requireValue(asset.source === 'orynt_composed' && asset.status === 'ready', 'INVALID_PRODUCTION', '请选择待检查的制作成片。');
    requireValue(!asset.technical?.issues?.length, 'VIDEO_TECHNICAL_ISSUES', '文件检查未通过，请重新制作。');
    requireValue(['identity','motion','copy','sound'].every(key => b.checks?.[key] === true), 'REVIEW_REQUIRED', '请检查产品、镜头、文案和声音后再确认。');
    asset.qualityReview = { status: 'accepted', checks: b.checks, reviewedAt: new Date().toISOString() };
    asset.safety = 'user_reviewed';
    audit(s, 'production_final_reviewed', asset.id);
    return { assetId: asset.id };
  }
  requireValue(false, 'UNKNOWN_COMMAND', '未支持的制作操作。', 404);
}
