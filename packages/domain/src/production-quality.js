import { scoreSlideshowRisk, validateMotionDelivery } from './vendor/openmontage/production-checks.js';

export const productionQualityVersion = 'openmontage-adapter-v1';
export const motionDeliveryPolicy = Object.freeze({ minMotionRatio: .7, stillFallbackAllowed: false });
const text = value => String(value || '').trim();
const identity = value => text(value).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const issue = (code, message, shotIndex) => ({ code, message, ...(shotIndex === undefined ? {} : { shotIndex }) });

export function reviewProductionPlan(production, config) {
  const errors = [], warnings = [], shots = production.shots || [];
  const generated = shots.filter(s => s.kind === 'generated_shot');
  const continuingClose=production.editStyle==='editorial_continuing_video'&&shots[2]?.kind==='continuing_video';
  if (shots.length !== 3 || generated.length !== 2 || (!continuingClose&&shots[2]?.kind !== 'product_endcard')) {
    errors.push(issue('SHOT_LAYOUT', '需要两个场景镜头和一个产品图收尾，请返回脚本重新保存。'));
  }
  let cursor = 0;
  for (const [index, shot] of shots.entries()) {
    if (shot.index !== index || !Number.isFinite(shot.start) || !Number.isFinite(shot.end) || shot.end <= shot.start || Math.abs(shot.start - cursor) > .01 || Math.abs(shot.targetDuration - (shot.end - shot.start)) > .01 || !Number.isFinite(shot.targetDuration)) {
      errors.push(issue('SHOT_TIMING', `镜头 ${index + 1} 的时间安排不完整，请返回脚本重新保存。`, index));
    }
    cursor = shot.end;
  }
  if (!Number.isFinite(config?.duration) || !shots.length || Math.abs(cursor - config.duration) > .01) {
    errors.push(issue('TOTAL_DURATION', '镜头总时长与成片设置不一致，请返回脚本重新保存。'));
  }
  for (const shot of generated) {
    if (!text(shot.text)) errors.push(issue('EMPTY_SCENE', `镜头 ${shot.index + 1} 还没有画面描述。`, shot.index));
    const d = shot.direction || {}, missing = [];
    if(production.productTreatment==='local_product_overlay') {
      if(!text(d.lighting))missing.push('背景光线与色调');
    } else {
      if (!text(d.shotIntent)) missing.push('这一镜要让观众看懂什么');
      if (!text(d.firstFrame)) missing.push('开始时的主体与构图');
      if (!text(d.subjectMotion)) missing.push('主体动作（也可以明确静止）');
      if (!text(d.cameraMotion)) missing.push('镜头移动方式（也可以固定机位）');
    }
    if (missing.length) warnings.push(issue('SHOT_DESIGN', `镜头 ${shot.index + 1} 建议补充：${missing.join('、')}。`, shot.index));
  }
  if (generated.length === 2 && identity(generated[0].text) && identity(generated[0].text) === identity(generated[1].text)) {
    errors.push(issue('DUPLICATE_SCENES', '前两个镜头的画面描述相同，请让第二镜展示不同的细节或动作。', 1));
  }
  if (production.productTreatment!=='local_product_overlay'&&generated.length > 1 && !text(generated[1].direction?.continuity)) {
    warnings.push(issue('CONTINUITY', '镜头 2 建议写明需要延续的主体、材质与光线，减少两镜之间的跳变。', 1));
  }
  const scenes = generated.map(s => ({
    description: s.text, type: 'video', shot_intent: text(s.direction?.shotIntent),
    shot_language: { camera_movement: text(s.direction?.cameraMotion) || 'unspecified', lighting_key: text(s.direction?.lighting) }
  }));
  return { engine: productionQualityVersion, valid: !errors.length, errors, warnings, risk: scoreSlideshowRisk(scenes) };
}

// Requires downloaded, inspected video for every generated shot; no still fallback.
// This checks source/timing evidence, not whether pixels contain natural motion.
export function reviewProductionDelivery(production, config) {
  const plan = reviewProductionPlan(production, config), errors = [...plan.errors];
  for (const shot of production.shots || []) {
    if (shot.kind !== 'generated_shot') continue;
    const t = shot.technical;
    if (shot.status !== 'ready' || !shot.base64 || !t || !Array.isArray(t.issues) || t.issues.length || !Number.isFinite(t.duration) || t.duration + .1 < shot.targetDuration || !Number.isFinite(t.width) || !Number.isFinite(t.height) || Math.min(t.width, t.height) < 720) {
      errors.push(issue('SHOT_MEDIA', `镜头 ${shot.index + 1} 缺少检查通过且时长足够的视频，不能用图片替代。`, shot.index));
    }
    if (shot.keyframe && (shot.keyframe.review?.status !== 'accepted' || shot.keyframe.review.version !== shot.keyframe.version)) {
      errors.push(issue('KEYFRAME_APPROVAL', `镜头 ${shot.index + 1} 的当前图片版本还没有确认。`, shot.index));
    }
    if(production.productTreatment==='product_reference'&&shot.keyframe?.providerState?.productReferenceEvidence?.status!=='product_reference_confirmed')errors.push(issue('PRODUCT_REFERENCE',`镜头 ${shot.index+1} 缺少真实产品图输入证据。`,shot.index));
    if(production.productTreatment==='local_product_overlay') {
      const c=shot.productComposition,k=shot.keyframe?.productPreview?.composition,source=production.productPreparation?.sourceSha256;
      if(!source||!c||c.sourceSha256!==source||k?.sourceSha256!==source||c.productImageId!==production.productImage?.assetId||k.productImageId!==c.productImageId||c.layoutVersion!==k.layoutVersion||!shot.keyframe?.productPreview?.base64||!shot.backgroundBase64||!shot.backgroundTechnical||shot.backgroundTechnical.issues?.length) {
        errors.push(issue('PRODUCT_COMPOSITION',`镜头 ${shot.index+1} 缺少与已确认预览一致的真实产品图合成记录。`,shot.index));
      }
    }
  }
  const first = production.shots?.[0];
  if (first?.review?.status !== 'accepted' || first.review.version !== first.version) {
    errors.push(issue('FIRST_SHOT_APPROVAL', '首镜头的当前视频版本还没有确认，不能继续合成。', 0));
  }
  if (!production.productImage?.base64) errors.push(issue('PRODUCT_IMAGE', '缺少已保存的产品原图，无法制作品牌收尾。'));
  const cuts = (production.shots || []).map(shot => ({
    duration: shot.end - shot.start,
    motion: (shot.kind === 'generated_shot' && shot.status === 'ready' && !!shot.base64 && !!shot.technical && Array.isArray(shot.technical.issues) && !shot.technical.issues.length && !errors.some(e => e.shotIndex === shot.index)) || (production.editStyle==='editorial_continuing_video'&&shot.index===2&&shot.kind==='continuing_video'&&!errors.some(e=>e.shotIndex===1)&&production.shots[1]?.status==='ready'&&!!production.shots[1]?.base64)
  }));
  // Always enforce Orynt's supported policy; persisted labels cannot lower it.
  const delivery = validateMotionDelivery(cuts, motionDeliveryPolicy);
  if (!delivery.valid) errors.push(issue('MOTION_DELIVERY', '已检查的视频素材时长不足整片的 70%，已停止合成，避免把图片轮播当作成片。'));
  return { engine: productionQualityVersion, ...delivery, valid: !errors.length, errors, note: production.productTreatment==='local_product_overlay'?'视频时长来自背景视频，产品主体为静态原图本地合成，不是实物使用演示；排版和画面效果仍需人工确认。':'按检查通过的视频素材在剪辑中占用的时长计算；动作自然度与产品一致性仍需人工确认。' };
}
