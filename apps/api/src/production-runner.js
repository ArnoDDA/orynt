import { buildShotPrompt, buildKeyframePrompt } from '../../../packages/domain/src/production-plan.js';
import { createHash } from 'node:crypto';
import { reviewProductionPlan, reviewProductionDelivery } from '../../../packages/domain/src/production-quality.js';

const stamp = () => new Date().toISOString();
export class ProductionRunner {
  constructor({ core, repository, videoProvider, videoAssembler, pollIntervalMs = 3000 }) { Object.assign(this, {core, repository, videoProvider, videoAssembler, pollIntervalMs}); }
  current(job) { return this.repository.read().jobs.some(j=>j.id===job.id&&j.attemptId===job.attemptId&&['queued','running'].includes(j.status)); }
  change(job, callback) {
    if (!this.current(job)) return false;
    this.repository.transact(s=>{const j=s.jobs.find(j=>j.id===job.id),r=s.generationRequests.find(r=>r.id===j.input.generationRequestId);callback(r,j);j.updatedAt=stamp();});
    return true;
  }
  async tick(job) {
    const state=this.repository.read(), request=state.generationRequests.find(r=>r.id===job.input.generationRequestId), config=state.configs.find(c=>c.id===request.configId), step=job.steps.find(s=>s.status!=='succeeded');
    if (!step || !this.current(job)) return;
    let index;
    try {
      if(request.localEdit&&!['assemble_video','publish_asset'].includes(step.key))throw Object.assign(new Error('本地剪辑只能复用已保存镜头；没有提交新的生成任务。'),{code:'LOCAL_EDIT_ONLY'});
      if (step.key==='prepare_shots') {
        this.checkPlan(job, request, config);
        await this.videoAssembler.check();
        if(request.production.productTreatment==='local_product_overlay') {
          if(!this.videoAssembler.productPreview||!this.videoAssembler.productShot)throw Object.assign(new Error('本地产品合成环境尚未就绪，未提交生成。'),{code:'PRODUCT_COMPOSITION_UNAVAILABLE'});
          const prepared=await this.videoAssembler.productPreview(null,request.production.productImage,{ratio:config.ratio,index:0});
          if(!this.change(job,r=>{r.production.productPreparation=prepared.composition;}))return;
        }
        if (!this.videoProvider?.available) throw Object.assign(new Error('视频生成服务尚未配置。'),{code:'VIDEO_PROVIDER_UNAVAILABLE'});
        if(request.production.referenceMode==='generated_first_frame'&&(!this.videoProvider.supportsKeyframes||!this.videoAssembler.inspectKeyframe))throw Object.assign(new Error('当前生成服务或本地环境不支持关键帧，尚未提交生成。'),{code:'KEYFRAME_PROVIDER_UNAVAILABLE'});
        if(request.production.productTreatment==='product_reference'&&!(await this.prepareProductReference(job,request)))return;
        if(this.change(job,r=>{r.status='running';r.production.phase='first_shot';}))this.core.tick({jobId:job.id});
      } else if (step.key==='review_first_shot') {
        this.change(job,r=>{r.production.phase='awaiting_review';});
      } else if (['generate_first_shot','generate_remaining_shots'].includes(step.key)) {
        index=step.key==='generate_first_shot'?0:1;
        if (await this.shot(job,request,config,index)) {
          if(this.change(job,r=>{r.production.phase=index===0?'awaiting_review':'assembly';}))this.core.tick({jobId:job.id});
        }
      } else if (step.key==='assemble_video') {
        if (!job.providerResult) {
          const delivery = reviewProductionDelivery(request.production, config);
          request.production.qualityChecks = { plan: reviewProductionPlan(request.production, config), delivery };
          if (!this.change(job, r => { r.production.qualityChecks = request.production.qualityChecks; })) return;
          if (!delivery.valid) throw Object.assign(new Error(delivery.errors.map(e => e.message).join(' ')), { code: 'PRODUCTION_DELIVERY_ISSUES' });
          const result=await this.videoAssembler.assemble(request,config);
          if(this.current(job))this.core.tick({jobId:job.id,providerResult:result});
        } else this.core.tick({jobId:job.id});
      } else if (step.key==='publish_asset') this.core.tick({jobId:job.id});
    } catch (error) {
      if (!this.current(job)) return;
      const issue={code:error.code||'PRODUCTION_FAILED',message:error.message||'本轮制作未完成，已完成的镜头仍会保留。'};
      this.change(job,r=>{r.production.phase='failed';if(index!==undefined){const shot=r.production.shots[index];shot.status='failed';shot.error=issue;if(shot.keyframe&&shot.keyframe.review?.status!=='accepted'){shot.keyframe.status='failed';shot.keyframe.error=issue;}}});
      this.core.tick({jobId:job.id,error:issue});
    }
  }
  checkPlan(job, request, config) {
    const plan = reviewProductionPlan(request.production, config);
    this.change(job, r => { r.production.qualityChecks = { plan }; });
    if (!plan.valid) throw Object.assign(new Error(plan.errors.map(e => e.message).join(' ')), { code: 'PRODUCTION_PLAN_ISSUES' });
  }
  async prepareProductReference(job,request) {
    const reference=request.production.productReference;
    if(reference?.status==='ready')return true;
    if(!reference?.consent?.granted||!this.videoProvider.supportsProductReference)throw Object.assign(new Error('商品参考生成尚未获准或服务不支持，未提交生图。'),{code:'PRODUCT_REFERENCE_UNAVAILABLE'});
    if(!reference.fileId) {
      if(reference.submissionStartedAt)throw Object.assign(new Error('图片导入结果不确定，请先核查；没有重复导入或提交生图。'),{code:'PRODUCT_REFERENCE_IMPORT_UNCERTAIN'});
      const submissionStartedAt=stamp(),sha256=createHash('sha256').update(Buffer.from(request.production.productImage.base64,'base64')).digest('hex');
      if(!this.change(job,r=>Object.assign(r.production.productReference,{submissionStartedAt,sha256,status:'importing'})))return false;
      const result=await this.videoProvider.importProductReference({url:reference.sourceUrl});
      // Keep the non-paid import receipt even if the user cancelled meanwhile.
      this.repository.transact(s=>{
        const ref=s.generationRequests.find(r=>r.id===request.id)?.production.productReference;
        if(ref?.submissionStartedAt===submissionStartedAt&&!ref.fileId)Object.assign(ref,result);
      });
      return false;
    }
    if(Date.now()-Date.parse(reference.lastPolledAt||'1970-01-01')<this.pollIntervalMs)return false;
    const result=await this.videoProvider.readProductReference(reference);
    if(!this.change(job,r=>Object.assign(r.production.productReference,result,{lastPolledAt:stamp()})))return false;
    if(result.status==='pending'&&Date.now()-Date.parse(reference.submissionStartedAt)>120000)throw Object.assign(new Error('公开产品图准备超时，已有导入回执保留；可继续核查，无需重复生成。'),{code:'PRODUCT_REFERENCE_TIMEOUT'});
    return result.status==='ready';
  }
  async shot(job,request,config,index) {
    const shot=request.production.shots[index];
    if (shot.status==='ready') return true;
    if (!shot.submissionStartedAt && !shot.keyframe?.submissionStartedAt) this.checkPlan(job, request, config);
    if(shot.keyframe&&!(await this.keyframe(job,request,config,index)))return false;
    if(!this.current(job))return false;
    const reference=shot.keyframe?{chatId:shot.keyframe.providerState.chatId,url:shot.keyframe.providerState.url,...(shot.keyframe.providerState.mediaId?{mediaId:shot.keyframe.providerState.mediaId}:{})}:undefined;
    // Confirmation and recovery must retain the exact instructions submitted for this take.
    const prompt=shot.prompt||buildShotPrompt(request,config,shot);
    let providerState=shot.providerState||{};
    if (!providerState.chatId) {
      if(shot.submissionStartedAt)throw Object.assign(new Error('上次提交结果尚不确定，已停止重复提交，避免重复生成。请先核查服务端任务。'),{code:'VIDEO_SUBMISSION_UNCERTAIN'});
      const submissionStartedAt=stamp();
      if(!this.change(job,r=>{Object.assign(r.production.shots[index],{status:'submitting',submissionStartedAt,prompt});}))return false;
      const created=await this.videoProvider.create({prompt,...(reference?{reference}:{})});
      if(!created?.chatId)throw Object.assign(new Error('生成服务没有返回任务编号，已阻止自动重复提交。'),{code:'VIDEO_SUBMISSION_UNCERTAIN'});
      // A cancellation stops advancement, but must not lose an already-paid receipt.
      this.repository.transact(s=>{
        const r=s.generationRequests.find(r=>r.id===request.id),take=r?.production.shots[index];
        if(take?.version===shot.version&&take.submissionStartedAt===submissionStartedAt&&!take.providerState?.chatId){take.providerState={...created,submittedAt:stamp()};take.status='generating';}
      });
      return false;
    }
    if (!providerState.url) {
      if (Date.now()-Date.parse(providerState.lastPolledAt||'1970-01-01')<this.pollIntervalMs)return false;
      let result;
      try {
        result=await this.videoProvider.poll({chatId:providerState.chatId,confirmationSent:providerState.confirmationSent,prompt,submissionStartedAt:shot.submissionStartedAt,allowConfirmation:!shot.recovery,...(reference?{reference}:{})});
      } catch(error) {
        if(error.providerFailure)this.change(job,r=>{r.production.shots[index].providerState.failure=error.providerFailure;});
        if(shot.recovery?.mode==='resubmit'&&error.providerFailure?.confirmedNoVideo&&this.current(job)) {
          this.change(job,(r,j)=>{
            const take=r.production.shots[index];
            take.videoAttempts=[...(take.videoAttempts||[]),{providerState:structuredClone(take.providerState),submissionStartedAt:take.submissionStartedAt,prompt:take.prompt,failedAt:stamp()}];
            for(const key of ['providerState','submissionStartedAt','prompt','error','recovery'])delete take[key];
            take.status='pending';r.production.phase=index===0?'first_shot':'remaining_shots';
            const step=j.steps.find(s=>s.status!=='succeeded');step.attempts=0;
          });
          return false;
        }
        throw error;
      }
      providerState={...providerState,...result,lastPolledAt:stamp()};
      this.change(job,r=>{r.production.shots[index].providerState=providerState;r.production.shots[index].status=result.status==='succeeded'?'checking':'generating';if(result.status==='succeeded')delete r.production.shots[index].recovery;});
      if(result.status!=='succeeded'||!this.current(job))return false;
    }
    const localProduct=request.production.productTreatment==='local_product_overlay';
    const savedSource=localProduct?shot.backgroundBase64:shot.base64;
    const source=savedSource?Buffer.from(savedSource,'base64'):await this.videoProvider.download(providerState);
    if(!this.current(job))return false;
    let bytes=source,composition;
    if(localProduct) {
      this.change(job,r=>{r.production.shots[index].backgroundBase64=source.toString('base64');r.production.shots[index].status='checking';});
      const backgroundTechnical=(await this.videoAssembler.inspect(source,{duration:shot.requestedDuration,ratio:config.ratio,audio:false})).technical;
      if(!this.change(job,r=>{r.production.shots[index].backgroundTechnical=backgroundTechnical;}))return false;
      if(backgroundTechnical.issues.length)throw Object.assign(new Error(`背景视频文件检查未通过：${backgroundTechnical.issues.join('、')}。`),{code:'SHOT_TECHNICAL_ISSUES'});
      const composed=await this.videoAssembler.productShot(source,request.production.productImage,{ratio:config.ratio,index});
      bytes=composed.bytes;composition=composed.composition;
    }
    if(!this.current(job))return false;
    this.change(job,r=>{r.production.shots[index].base64=bytes.toString('base64');if(composition)r.production.shots[index].productComposition=composition;r.production.shots[index].status='checking';});
    const inspected=await this.videoAssembler.inspect(bytes,{duration:shot.requestedDuration,ratio:config.ratio,audio:false});
    this.change(job,r=>{Object.assign(r.production.shots[index],inspected,{status:inspected.technical.issues.length?'failed':'ready',review:{status:'pending'}});if(!inspected.technical.issues.length)delete r.production.shots[index].error;});
    if(inspected.technical.issues.length)throw Object.assign(new Error(`镜头文件检查未通过：${inspected.technical.issues.join('、')}。可以修改这个镜头后重新生成。`),{code:'SHOT_TECHNICAL_ISSUES'});
    return true;
  }

  async keyframe(job,request,config,index) {
    const shot=request.production.shots[index],frame=shot.keyframe;
    if(frame.review?.status==='accepted')return true;
    const localProduct=request.production.productTreatment==='local_product_overlay';
    if(frame.status==='ready'&&(!localProduct||frame.productPreview)) {this.change(job,r=>{r.production.phase='awaiting_keyframe_review';r.production.shots[index].status='awaiting_keyframe_review';delete r.production.shots[index].error;});return false;}
    this.change(job,r=>{r.production.shots[index].status='planning';delete r.production.shots[index].error;delete r.production.shots[index].keyframe.error;});
    const prompt=frame.prompt||buildKeyframePrompt(request,config,shot);
    const previous=index>0?request.production.shots[index-1]:null, priorFrame=previous?.keyframe;
    const reference=priorFrame?.review?.status==='accepted'?{...priorFrame.providerState,sha256:priorFrame.sha256,shotIndex:previous.index,shotVersion:previous.version,version:priorFrame.version}:undefined;
    let providerState=frame.providerState||{};
    if(!providerState.chatId) {
      if(frame.submissionStartedAt)throw Object.assign(new Error('上次关键帧提交结果不确定，已停止重复提交，请先核查任务。'),{code:'KEYFRAME_SUBMISSION_UNCERTAIN'});
      const submissionStartedAt=stamp();
      if(!this.change(job,r=>{Object.assign(r.production.shots[index].keyframe,{status:'submitting',submissionStartedAt,prompt,...(reference?{reference:{source:'youmind_generated',purpose:'continuity',sha256:reference.sha256,shotIndex:reference.shotIndex,shotVersion:reference.shotVersion,version:reference.version}}:{})});r.production.shots[index].status='planning';}))return false;
      const productReference=request.production.productTreatment==='product_reference'?request.production.productReference:undefined;
      const created=await this.videoProvider.createKeyframe({prompt,...(reference?{reference}:{}),...(productReference?{productReference}:{})});
      if(!created?.chatId)throw Object.assign(new Error('服务未返回关键帧任务标识，已停止重复提交。'),{code:'KEYFRAME_SUBMISSION_UNCERTAIN'});
      this.repository.transact(s=>{
        const take=s.generationRequests.find(r=>r.id===request.id)?.production.shots[index],current=take?.keyframe;
        if(take?.version===shot.version&&current?.version===frame.version&&current.submissionStartedAt===submissionStartedAt&&!current.providerState?.chatId){current.providerState={...created,submittedAt:stamp()};current.status='generating';}
      });
      return false;
    }
    if(!providerState.url) {
      if(Date.now()-Date.parse(providerState.lastPolledAt||'1970-01-01')<this.pollIntervalMs)return false;
      const productReference=request.production.productTreatment==='product_reference'?request.production.productReference:undefined;
      const result=await this.videoProvider.pollKeyframe({chatId:providerState.chatId,confirmationSent:providerState.confirmationSent,prompt,...(productReference?{productReference}:{})});
      providerState={...providerState,...result,lastPolledAt:stamp()};
      this.change(job,r=>{r.production.shots[index].keyframe.providerState=providerState;});
      if(result.status!=='succeeded'||!this.current(job))return false;
    }
    if(request.production.productTreatment==='product_reference'&&providerState.productReferenceEvidence?.status!=='product_reference_confirmed')throw Object.assign(new Error('已有图片结果已保留，但工具回执未证实使用了产品参考图，不能作为合格关键帧继续。'),{code:'PRODUCT_REFERENCE_UNVERIFIED'});
    let base64=frame.base64,mime=frame.mime;
    if(!base64){const downloaded=await this.videoProvider.downloadKeyframe(providerState);base64=downloaded.bytes.toString('base64');mime=downloaded.mime;}
    if(!this.current(job))return false;
    const technical=await this.videoAssembler.inspectKeyframe(Buffer.from(base64,'base64'),{ratio:config.ratio});
    // Save the paid background before local compositing, so a local failure can
    // be retried without another provider request.
    if(!this.change(job,r=>Object.assign(r.production.shots[index].keyframe,{base64,mime,technical})))return false;
    const productPreview=localProduct&&!technical.issues.length?await this.videoAssembler.productPreview(Buffer.from(base64,'base64'),request.production.productImage,{ratio:config.ratio,index}):undefined;
    this.change(job,r=>{
      Object.assign(r.production.shots[index].keyframe,{base64,mime,technical,...(productPreview?{productPreview}:{}),sha256:createHash('sha256').update(Buffer.from(base64,'base64')).digest('hex'),status:technical.issues.length?'failed':'ready',review:{status:'pending'}});
      if(!technical.issues.length){r.production.phase='awaiting_keyframe_review';r.production.shots[index].status='awaiting_keyframe_review';delete r.production.shots[index].error;}
    });
    if(technical.issues.length)throw Object.assign(new Error(`关键帧文件检查未通过：${technical.issues.join('、')}。请调整后重做图片。`),{code:'KEYFRAME_TECHNICAL_ISSUES'});
    return false;
  }
}
