// Product facts, creative hypotheses and available execution capabilities stay separate.
import { marketDirections } from './market-planning.js';
const text = (value, max = 600) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = (value, max = 12) => Array.isArray(value) ? value.slice(0, max) : [];
const publicUrl = value => {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
};

export function normalizeProductDetails(value = {}, sourceUrl = '') {
  value = value && typeof value === 'object' ? value : {};
  return {
    category: text(value.category, 160), model: text(value.model, 160), sku: text(value.sku, 160),
    attributes: list(value.attributes).filter(a => text(a?.name, 80) && text(a?.value, 300)).map(a => ({
      name: text(a.name, 80), value: text(a.value, 300), sourceUrl: publicUrl(sourceUrl),
      sourceType: 'schema_product_attribute', confirmation: 'pending'
    })),
    candidates: list(value.candidates, 8).filter(c => text(c?.name) && publicUrl(c?.url)).map(c => ({ name: text(c.name, 160), url: publicUrl(c.url) }))
  };
}

const categories = [
  ['hydration', '水杯与饮水用品', /水杯|水瓶|保温杯|freesip|water\s*bottle|tumbler|hydration/i],
  ['apparel', '服饰与穿戴', /服装|服饰|训练服|无缝|运动服|连衣裙|鞋|legging|seamless|activewear|shirt|jacket|dress|apparel|footwear/i],
  ['beauty', '护肤与个护', /护肤|面霜|精华|洗发|防晒|serum|skincare|moisturi[sz]er|sunscreen|cleanser|shampoo/i],
  ['electronics', '电子与设备', /耳机|键盘|摄像|充电|音箱|电子|headphone|earbud|keyboard|camera|charger|speaker|electronics/i],
  ['software', '软件与服务', /软件|应用程序|saas|software|dashboard|subscription app/i],
  ['food', '食品与饮品', /咖啡|茶叶|食品|饮品|巧克力|coffee|espresso|tea\b|chocolate|snack|beverage|food/i]
];

export function buildProductDossier({ snapshot, brief = {}, brand = {}, assets = [] }) {
  const imported = snapshot.productImport || {}, details = normalizeProductDetails(imported.details, imported.sourceUrl);
  const product = text(snapshot.confirmation === 'pending' ? imported.fields?.product?.value || brief.product : brief.product || snapshot.facts?.product, 300);
  const sameProduct = !imported.fields?.product?.value || imported.fields.product.value === product;
  const confirmed = snapshot.confirmation === 'confirmed';
  // A changed product name invalidates the old page's model/specification assumptions.
  const attributes = sameProduct ? details.attributes : [];
  const categoryMatch = categories.find(([, , regex]) => regex.test(`${product} ${sameProduct ? details.category : ''}`));
  const [category, categoryLabel] = categoryMatch || ['general', '通用产品'];
  const claim = text(snapshot.confirmation === 'pending' ? imported.fields?.claim?.value : snapshot.facts?.claim, 600);
  const facts = [
    ...(product ? [{ id: 'product', label: '产品', value: product, source: brief.product && brief.product !== snapshot.facts?.product ? 'campaign_brief' : snapshot.factMeta?.product?.sourceType || imported.fields?.product?.sourceType || 'user', sourceUrl: publicUrl(snapshot.factMeta?.product?.sourceUrl || (!confirmed ? imported.sourceUrl : '')), confirmation: confirmed ? 'confirmed' : 'pending' }] : []),
    ...(claim ? [{ id: 'claim', label: '本次表达', value: claim, source: snapshot.factMeta?.claim?.sourceType || imported.fields?.claim?.sourceType || 'user', sourceUrl: publicUrl(snapshot.factMeta?.claim?.sourceUrl || (!confirmed ? imported.sourceUrl : '')), confirmation: confirmed ? 'confirmed' : 'pending' }] : []),
    ...attributes.map((a, i) => ({ ...a, id: `attribute_${i}`, label: a.name, source: a.sourceType }))
  ];
  const imageIds = new Set(snapshot.assetIds || []);
  const selectedImports = new Set(imported.selectedImageIds || []);
  const selectedSources = new Set((imported.images || []).filter(im => selectedImports.has(im.id)).map(im => im.sourceUrl));
  const materials = assets.filter(a => a.brandId === snapshot.brandId && a.status === 'ready' && a.type !== 'logo' && imageIds.has(a.id) && (a.source === 'local_upload' || selectedSources.has(a.sourceUrl)))
    .slice(0, 12).map(a => ({ id: a.id, name: text(a.name, 120), mime: a.mime, sourceUrl: publicUrl(a.sourceUrl), role: 'product_original', variantName: text(a.variantName, 160), identityStatus: a.identityStatus || 'user_selected', alt: text(a.alt, 240), visualVerification: 'not_performed', usableForEndcard: ['image/png', 'image/jpeg', 'image/webp'].includes(a.mime) }));
  const missing = [];
  if (!product) missing.push('产品名称');
  if (!claim) missing.push('本条广告要表达的重点');
  if (!materials.some(m => m.usableForEndcard)) missing.push('用于成片收尾的 PNG、JPG 或 WebP 产品图');
  if (details.candidates.length > 1 && imported.pageKind !== 'product') missing.push('具体产品页面：当前页面包含多个候选商品');
  return {
    schemaVersion: 1, product, brandName: text(snapshot.brandName || brand.name, 120),
    sourceUrl: publicUrl(imported.sourceUrl), observedAt: imported.observedAt || null,
    category: { id: category, label: categoryLabel, source: 'local_inference', confirmed: false },
    identity: { model: sameProduct ? details.model : '', sku: sameProduct ? details.sku : '' },
    facts, audience: { value: text(brief.audience || snapshot.facts?.audience, 300), source: 'user', confirmed: Boolean(brief.audience || snapshot.facts?.audience) },
    materials, missing, boundaries: text(snapshot.facts?.limitations, 1000),
    materialCoverage: { availableImages: imported.images?.length || 0, selectedImages: materials.length, videos: (imported.videos || []).length, selectedVariantId: imported.selectedVariantId || '', variantCheckRequired: materials.some(m => ['needs_variant_check', 'other_variant'].includes(m.identityStatus)) },
    provenance: { snapshotId: snapshot.id, briefId: brief.id || null },
    limitations: ['网页属性未经逐项核对，不自动作为广告字幕或效果证明。', '产品原图保留在本地；当前场景生成不保证复刻商品外观。', ...(!sameProduct ? ['产品名称已修改，原网页的型号和属性不再作为本次产品依据。'] : [])]
  };
}

function contextScenes(dossier) {
  const coffee = /咖啡|coffee|espresso/i.test(dossier.product);
  const scenes = {
    hydration: ['晨光下的随身物品准备空间，为真实水杯素材留出清晰位置，突出出门前的使用联想，不虚构饮水动作或防漏效果。', '同一光线下的桌面近景，为真实水杯细节素材留出位置，说明已确认的产品重点，不虚构开盖结构。'],
    food: coffee ? ['近景记录黑咖啡注入一只素色杯子的单一动作，固定机位，柔和侧光。', '从桌面侧方缓慢靠近，一只手端起刚完成的咖啡；保持杯型、桌面和光线一致，不再重复注入动作。']
      : ['桌面近景，一只手把盛有食物的素色碟子放下，动作自然，侧光突出食物轮廓。', '同一桌面，从另一角度记录使用者拿起餐具准备享用的动作；不生成具体包装或未经证实的配料。'],
    apparel: ['更衣空间的中景，一位穿中性无标识服装的人拿起随身包准备出门；这是使用情境，不是该款服装的实物演示。', '同一人物走到自然光下，镜头跟随一个简单转身动作；保持人物和光线一致，不声称展示该商品的版型或面料。'],
    beauty: ['洗漱台的近景，一只手展开干净毛巾，为日常护理做准备；不生成商品瓶身或皮肤效果对比。', '同一空间，一只手把毛巾放到托盘旁，柔和光线与缓慢运镜呈现护理仪式；不把生成画面作为成分、质地或功效证明。'],
    electronics: ['工作台中景，一只手整理桌面并坐下准备开始使用设备；不生成该商品的型号、接口或功能演示。', '同一工作空间，一只手收起桌上配件，镜头缓慢移动；不展示未经实物验证的屏幕内容或性能结果。'],
    software: ['整洁工作空间，一位使用者坐到桌前准备处理日常任务；屏幕不出现虚构界面或可读文字。', '同一空间，使用者完成一个简单整理动作并合上笔记本；具体软件功能需真实录屏支持，不以此场景证明。'],
    general: ['中景展示整洁的日常使用空间，一只手整理桌面，为使用产品做准备；不虚构具体商品外形或功能。', '同一空间用缓慢的侧向运镜呈现不同构图，保持光线和物体关系一致；具体商品使用真实素材展示。']
  };
  return scenes[dossier.category.id];
}

function processScenes(dossier) {
  const recipes = {
    hydration: ['靠窗桌面的晨间准备场景，为真实水杯素材留出位置，不用虚构商品证明便携性。', '同一空间的细节构图，突出商品真实照片与已确认表达，保持瓶盖与提环形态。'],
    food: ['厨房中景，使用者把素色杯碟摆到桌上，固定机位，只记录摆放这一个动作。', '同一空间的手部近景，使用者拿起已准备好的杯子或餐具，保持光线与器皿一致；不展示虚构包装。'],
    apparel: ['门边中景，穿中性无标识服装的使用者拿起随身包，镜头随动作轻微移动；不冒充该商品试穿。', '同一人物的侧后方中景，使用者走向门口；不展示或证明该商品的材质、弹性或版型。'],
    beauty: ['浴室中景，使用者打开台面灯准备日常护理，不出现商品瓶身或皮肤前后对比。', '同一洗漱空间近景，一只手将干净毛巾折好，固定机位；不生成质地演示或功效变化。'],
    electronics: ['出门准备场景的中景，使用者把中性收纳袋放进背包；不展示具体设备或暗示设备尺寸。', '同一背包的近景，一只手拉上拉链，镜头保持稳定；商品外形和规格使用真实素材说明。'],
    software: ['办公场景中景，使用者在纸上整理当天的任务，不出现软件界面或虚构数据。', '同一桌面的近景，使用者把纸质清单收好，完成一个简单动作；软件功能需要真实录屏。'],
    general: ['日常空间中景，使用者将桌面整理好，构图为真实商品素材留出位置。', '同一空间近景，一只手把素色收纳盒放好；不把辅助动作当作具体商品功能演示。']
  };
  return recipes[dossier.category.id];
}

export function buildAdvertisingPlans(dossier, marketBrief = null) {
  const claim = dossier.facts.find(f => f.id === 'claim' && f.confirmation === 'confirmed');
  const focus = claim?.value || dossier.product || '当前产品';
  const scenes = contextScenes(dossier);
  const process = processScenes(dossier);
  const appearanceSensitive = ['apparel', 'beauty', 'electronics', 'software'].includes(dossier.category.id);
  const route = appearanceSensitive ? 'original_material_first' : 'usage_context';
  const formats = [
    { name: '情境开场', question: `把“${focus}”放进具体使用情境，是否比直接展示产品更容易引起兴趣？`, hook: scenes[0], proof: scenes[1] },
    { name: '细节情境开场', question: `用不同的场景细节引出“${focus}”，是否比完整情境开场更容易引起兴趣？`, hook: scenes[1], proof: scenes[0] },
    { name: '日常过程', question: `把准备与使用情境串起来，是否更容易让受众记住“${focus}”？`, hook: process[0], proof: process[1] }
  ];
  const directions = marketDirections(marketBrief, dossier);
  const marketFormats = marketBrief?.observations?.length ? directions.map(d => ({ name: d.name, question: d.question, hook: `${d.visualBrief.setting}。围绕${dossier.product}安排一个清晰的使用联想，商品外观使用真实素材，不虚构功能演示。`, proof: `同一场景的近景构图，以已确认产品素材和“${focus.slice(0, 220)}”补充选择理由，不将场景作为功效证据。` })) : formats;
  return marketFormats.map((format, i) => ({
    id: `product_plan_${i + 1}`, name: format.name, title: `${format.name} · ${focus.slice(0, 65)}`,
    source: 'local_product_plan', status: 'draft', recommended: i === 0,
    focus: { value: focus, factIds: claim ? ['claim'] : ['product'], kind: claim ? 'confirmed_brand_statement' : 'product_identity' },
    audience: directions[i].audience, audienceBasis: directions[i].audienceBasis,
    marketBasis: marketBrief?.observations?.length ? directions[i].marketBasis : { ...directions[i].marketBasis, status: 'product_hypothesis', observationIds: [], evidenceIds: [], samples: [], explanation: '当前缺少匹配市场表达，先依据商品资料提出方向，效果待验证。' },
    visualBrief: directions[i].visualBrief,
    route: { id: route, label: appearanceSensitive ? '真实商品素材优先' : '使用情境与产品素材结合', reason: appearanceSensitive ? '外观或实际功能决定商品识别，生成情境不能代替实物证明。' : '用简单使用情境吸引注意，再以真实产品图明确品牌与商品。' },
    execution: { mode: 'generated_context_and_local_endcard', label: '两个生成情境镜头 + 本地产品图收尾', exactProductInGeneratedScenes: false },
    hook: format.hook, proof: format.proof, style: '真实摄影感；商品身份以原始素材为准', hypothesis: format.question,
    control: 'A 基准版：真实产品图与已确认表达。', variant: `B 测试版：${format.name}，保持产品和表达重点相同。`,
    constant: '同一产品、表达重点、受众、时长和行动引导。', successSignal: '先比较前 3 秒留存，再看点击率；当前没有真实投放效果数据。',
    shots: [format.hook, format.proof].map((description, index) => ({ index, title: index ? '补充选择理由' : '引起注意', source: 'generated_context', description, factIds: [], materialIds: [], purpose: '创意情境，不是商品实物或效果证据', direction: { shotIntent: index ? `让观众理解已确认表达：${focus.slice(0, 200)}` : format.question.slice(0, 400), firstFrame: index ? '同一空间近景，保持商品完整，留出字幕区域。' : `${directions[i].visualBrief.setting}，为商品留出完整主体位置。`, lastFrame: '保持相同主体与空间，结束在便于承接下一镜的稳定构图。', subjectMotion: '主体保持稳定；没有真实动作素材时不虚构功能演示。', cameraMotion: '缓慢微推近；若采用本地静态原图合成则保持机位固定。', lighting: directions[i].visualBrief.palette, continuity: '保持同一款式、颜色、空间光线与背景色调。' } })).concat({ index: 2, title: '真实产品与行动引导', source: 'local_product_image', description: `使用原始产品图展示${dossier.product}，以本地字幕表达已确认的广告重点并引导了解产品。`, factIds: claim ? ['product', 'claim'] : ['product'], materialIds: dossier.materials.filter(m => m.usableForEndcard).map(m => m.id), purpose: '明确商品身份与广告表达' }),
    missing: [...dossier.missing],
    limitations: [...dossier.limitations, ...(appearanceSensitive ? ['完整实物演示需补充真实视频或获准的图像参考能力；当前只执行辅助情境与真实图片收尾。'] : [])],
    modelStatus: 'not_used'
  }));
}

export function planningContext(state, snapshot, brief) {
  const brand = state.brands.find(b => b.id === snapshot.brandId);
  return buildProductDossier({ snapshot, brief, brand, assets: state.brandAssets });
}

export function validateModelPlans(value, dossier, marketBrief = null) {
  if (!Array.isArray(value?.plans) || value.plans.length !== 3) throw new Error('INVALID_STRATEGY_RESULT');
  if (new Set(value.plans.map(p => text(p?.hook).replace(/\s+/g, '').toLowerCase())).size !== 3) throw new Error('DUPLICATE_STRATEGY_RESULT');
  const base = buildAdvertisingPlans(dossier, marketBrief), allowed = new Set(dossier.facts.filter(f => f.confirmation === 'confirmed').map(f => f.id));
  return value.plans.map((plan, i) => {
    if (!['name', 'hook', 'proof', 'hypothesis'].every(k => typeof plan[k] === 'string' && plan[k].trim() && plan[k].length <= (k === 'name' ? 80 : 450)) || !Array.isArray(plan.factIds) || !plan.factIds.length || plan.factIds.some(id => !allowed.has(id))) throw new Error('INVALID_STRATEGY_RESULT');
    const evidenceIds = Array.isArray(plan.evidenceIds) ? [...new Set(plan.evidenceIds)] : [];
    if (evidenceIds.some(id => !marketBrief?.samples?.some(s => s.id === id)) || (marketBrief?.observations?.length && !evidenceIds.length)) throw new Error('INVALID_MARKET_CITATION');
    const cited = (marketBrief?.samples || []).filter(s => evidenceIds.includes(s.id));
    return { ...base[i], name: text(plan.name, 80), title: `${text(plan.name, 80)} · ${base[i].focus.value.slice(0, 65)}`, hook: plan.hook.trim(), proof: plan.proof.trim(), hypothesis: plan.hypothesis.trim(), source: 'model_product_plan', modelStatus: 'draft_requires_review',
      marketBasis: { ...base[i].marketBasis, status: cited.length ? 'public_copy_observation' : 'product_hypothesis', evidenceIds, observationIds: (marketBrief?.observations || []).filter(o => o.sampleIds.some(id => evidenceIds.includes(id))).map(o => o.id), samples: cited.map(({ id, sourceUrl, advertiser, copy, observedAt }) => ({ id, sourceUrl, advertiser, quote: copy.slice(0, 400), observedAt })), explanation: cited.length ? '模型参考了所列公开文案；广告方向仍为待核对创意，不代表效果。' : '仅依据商品资料提出的创意假设。' },
      visualBrief: { ...base[i].visualBrief, setting: plan.hook.trim(), rationale: '模型基于所列资料提出的新场景，仍需核对，不是对参考广告画面的复刻。' },
      shots: base[i].shots.map((s, n) => n < 2 ? { ...s, description: n ? plan.proof.trim() : plan.hook.trim(), direction: { ...s.direction, firstFrame: (n ? plan.proof : plan.hook).trim().slice(0,400), shotIntent: plan.hypothesis.trim().slice(0,400) } } : s),
      limitations: [...base[i].limitations, '模型提供的是待核对的创意，不新增商品事实；具体动作和表达仍需人工确认。'] };
  });
}
