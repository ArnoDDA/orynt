import { sceneTiming } from '../../../packages/domain/src/scene-script.js';
import { formatShotDirection } from '../../../packages/domain/src/shot-direction.js';

export function buildVideoPrompt(state, job) {
  const request = state.generationRequests.find(item => item.id === job.input.generationRequestId);
  const config = state.configs.find(item => item.id === request?.configId);
  const version = state.cardVersions.find(item => item.id === request?.cardVersionId);
  const content = version?.content || {};
  const angle = state.angles.find(item => item.id === request?.angleId);
  const route = angle ? { hook: angle.hook, proof: angle.proof, style: angle.visualLanguage } : (content.creativeRoute || {});
  const brandAssets = (config?.brandAssetIds || [])
    .map(assetId => state.brandAssets.find(item => item.id === assetId && item.status === 'ready'))
    .filter(Boolean);
  const brand = state.brands.find(item => item.id === state.campaigns.find(campaign => campaign.id === request?.campaignId)?.brandId);
  const template = config?.templateId
    ? state.videoTemplates.find(item => item.id === config.templateId && item.status === 'ready')
    : null;
  const duration = Math.min(30, Math.max(4, Number(config?.duration || 15)));
  const ratio = ['9:16', '1:1', '16:9'].includes(config?.ratio) ? config.ratio : '9:16';
  const templateStructure = template?.scenes?.length
    ? `参考模板结构（仅使用本地提取的时间信息，未上传原视频，也未识别画面语义）：总时长 ${template.duration} 秒，${template.scenes.map((scene, index) => `镜头 ${index + 1} 为 ${scene.start}-${scene.end} 秒`).join('；')}。借鉴其节奏和镜头长度，不复制具体画面。`
    : '';
  return [
    '请生成一段用于内部创意验证的短视频，不要询问积分或再次请求确认。',
    `画幅：${ratio}；时长：约 ${duration} 秒；关闭音频；Seedance 2.0。`,
    '使用正式生成画质，不使用低画质预览。严格遵守指定画幅与时长；如服务不支持这些设置，请明确返回限制，不要自行缩短时长或降级画质。',
    `Hook：${String(route.hook || '').slice(0, 350)}`,
    `Proof：${String(route.proof || '').slice(0, 350)}`,
    `Style：${String(route.style || '').slice(0, 200)}`,
    `产品主张：${String(content.claim || '').slice(0, 350)}`,
    `目标受众：${String(content.audience || '').slice(0, 250)}`,
    config?.scenePlan?.length ? `用户确认的画面脚本（优先于默认 Hook / Proof，按顺序执行）：\n${config.scenePlan.map((scene, index) => { const time = sceneTiming(duration)[index]; return `${time.start}-${time.end} 秒 · ${scene.title}：${scene.text}`; }).join('\n')}` : '',
    ...(config?.scenePlan || []).slice(0, 2).map((scene, index) => formatShotDirection(scene.direction) ? `镜头 ${index + 1} 的已确认设计（文字要求，未附参考图）：\n${formatShotDirection(scene.direction)}` : ''),
    brand ? `品牌：${String(brand.name || '').slice(0, 120)}` : '',
    brandAssets.length
      ? `已选本地品牌视觉参考（仅使用以下文字描述，不上传原图）：${brandAssets.map(asset => `${asset.type === 'logo' ? 'Logo' : '产品图'}「${String(asset.name).slice(0, 120)}」— ${String(asset.promptHint || '保持其品牌视觉特征').slice(0, 300)}`).join('；')}`
      : '未选择品牌视觉参考；避免自行生成或模仿任何第三方 Logo。',
    templateStructure,
    `语言：${String(config?.language || 'English')}`,
    config?.notes ? `执行备注：${String(config.notes).slice(0, 350)}` : '',
    '只使用以上创意信息，不读取或引用任何外部文档、内部指标、账号信息或未确认的市场证据。不要出现未经确认的效果承诺、第三方品牌素材、可读文字或字幕。'
  ].filter(Boolean).join('\n');
}
