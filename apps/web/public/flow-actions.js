import { shotDirectionFields, shotDirectionFieldName, shotDirectionFromFields, normalizeShotDirection, hasShotDirection } from '../../../packages/domain/src/shot-direction.js';

const sameIds = (left = [], right = []) => left.length === right.length && left.every(id => right.includes(id));

export async function saveGenerationConfig({ command, packageId, angleId, fields, brandAssetIds = [], config }) {
  const scenePlan = ['sceneOpening', 'sceneProof', 'sceneClosing'].every(key => fields[key] !== undefined)
    ? ['sceneOpening', 'sceneProof', 'sceneClosing'].map((key, index) => {
      const text = String(fields[key]).trim(), previous = config?.scenePlan?.[index];
      const explicit = shotDirectionFields.some(({ key: detail }) => fields[shotDirectionFieldName(key, detail)] !== undefined);
      const direction = index < 2 ? (explicit ? shotDirectionFromFields(fields, key) : normalizeShotDirection(previous?.text === text ? previous.direction : null)) : {};
      return { title: previous?.title || ['开场吸引', '展示产品', '收尾引导'][index], text, ...(hasShotDirection(direction) ? { direction } : {}) };
    })
    : config?.scenePlan || null;
  const productionCopy = { opening: fields.copyOpening ?? config?.productionCopy?.opening ?? '', detail: fields.copyDetail ?? config?.productionCopy?.detail ?? '', cta: fields.copyCta ?? config?.productionCopy?.cta ?? '' };
  const productTreatment = fields.productTreatment || config?.productTreatment || 'local_product_overlay';
  const publicReferenceConsent = fields.publicReferenceConsent === 'on' || fields.publicReferenceConsent === true;
  const values = { ...fields, duration: Number(fields.duration), angleId, brandAssetIds, scenePlan, productionCopy, productTreatment, publicReferenceConsent, music: fields.music || config?.music || 'ambient' };
  const unchanged = config && config.angleId === angleId &&
    ['ratio', 'language'].every(key => config[key] === values[key]) && config.duration === values.duration &&
    (config.notes || '') === (values.notes || '') && (config.templateId || '') === (values.templateId || '') &&
    (config.music || 'ambient') === values.music && ['opening','detail','cta'].every(key => (config.productionCopy?.[key] || '') === productionCopy[key]) &&
    (config.productTreatment || 'local_product_overlay') === productTreatment && (productTreatment !== 'product_reference' || publicReferenceConsent) &&
    sameIds(config.brandAssetIds, brandAssetIds) && JSON.stringify(config.scenePlan || null) === JSON.stringify(scenePlan);
  if (unchanged) return config.id;
  return (await command('config.create', packageId, values)).configId;
}

export async function prepareCreativeOptions({ campaignId, command, state, wait, onJob = () => {} }) {
  const run = async (type, action) => {
    const active = state().jobs.find(job => job.campaignId === campaignId && job.type === type && ['queued', 'running'].includes(job.status));
    const jobId = active?.id || (await command(action, campaignId)).jobId;
    onJob(jobId);
    await wait(jobId);
  };
  let campaign = state().campaigns.find(item => item.id === campaignId);
  let discovery = state().discoveries.filter(item => item.campaignId === campaignId && item.briefId === campaign.briefId).at(-1);
  if (!discovery) await run('discovery', 'discovery.start');
  campaign = state().campaigns.find(item => item.id === campaignId);
  discovery = state().discoveries.filter(item => item.campaignId === campaignId && item.briefId === campaign.briefId).at(-1);
  if (!discovery) throw new Error('市场资料尚未整理完成，请重试。');
  const cards = state().cards.filter(item => item.campaignId === campaignId && item.discoveryId === discovery.id && item.status !== 'superseded');
  if (!cards.length) await run('cards', 'cards.generate');
}

export async function simulatePlan({ command, campaignId, fields }) {
  const plan = await command('plan.save', campaignId, fields);
  await command('plan.simulate-launch', plan.planId);
  await command('metrics.simulate', plan.planId, { confirmSimulation: true });
  return plan.planId;
}
