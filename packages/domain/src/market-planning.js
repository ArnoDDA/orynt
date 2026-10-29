const text = (v, max = 600) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const url = v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
const terms = v => [...new Set(text(v, 3000).toLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}/g) || [])].filter(t => !['the','and','for','with','product','daily','everyday','this','that'].includes(t));
const categoryTerms = {
  hydration: /bottle|freesip|tumbler|hydration|水瓶|水杯|保温杯/i,
  food: /coffee|espresso|chocolate|snack|beverage|tea\b|咖啡|茶叶|零食/i,
  apparel: /shirt|legging|apparel|activewear|jacket|dress|服装|运动服|穿搭/i,
  beauty: /serum|skin|cleanser|shampoo|护肤|精华|面霜/i,
  electronics: /headphone|earbud|charger|keyboard|camera|耳机|充电|键盘/i,
  software: /software|saas|dashboard|软件|应用/i
};
const motifs = [
  { id: 'carry', label: '随身与出行', match: /on[\s_-]*the[\s_-]*go|on[\s_-]*the[\s_-]*move|commut|carry|travel|backpack|getaway|city adventure|wherever the day|便携|通勤|随身|出行/i, question: '把产品放在出门准备的场景，能否比单独产品照更快建立使用联想？', setting: '明亮玄关的浅色置物台，柔和晨光和远处虚化的门框', palette: '温暖晨光、浅木色与低饱和背景，商品自身颜色不变', motion: '远景光线轻微变化，保持产品所在平面稳定', audience: '有随身携带需求的人（建议测试人群）' },
  { id: 'routine', label: '日常习惯', match: /routine|every[\s_-]*day|daily|morning|ritual|日常|每天|晨间|习惯/i, question: '把产品融入一个日常时刻，能否比抽象卖点更容易让观众代入？', setting: '靠窗的日常桌面，清晨自然光与安静的室内纵深', palette: '柔和自然光、暖白与浅灰，真实生活质感', motion: '窗外光影缓慢变化，主体保持稳定', audience: '希望简化日常习惯的人（建议测试人群）' },
  { id: 'detail', label: '细节与选择理由', match: /design|detail|material|texture|color|colour|style|设计|细节|材质|质感|颜色/i, question: '先让观众看清商品外观和细节，能否提升对这款产品的兴趣？', setting: '有细微材质纹理的简洁展示台，背景呈现克制的几何光影', palette: '克制的中性色、明确的侧光与轮廓光', motion: '展示台侧光轻微流动，不改变商品结构', audience: '重视外观与使用细节的人（建议测试人群）' },
  { id: 'active', label: '运动与户外时刻', match: /tennis|gym\b|workout|sport|game,? set|trail|hiking|健身|运动|户外|网球/i, question: '把产品放在运动间歇或户外准备的时刻，能否比通用桌面展示更容易引起目标人群兴趣？', setting: '自然日光下的网球场边长凳，远处虚化的球场色块与树影，商品完整立于稳定平面', palette: '清透日光、草木绿与暖灰，商品保持原有颜色，不添加品牌道具', motion: '背景树影微动，缓慢靠近稳定的商品，不生成饮用或开盖动作', audience: '关注运动与户外生活的人（建议测试人群）' },
  { id: 'problem', label: '需求与解决思路', match: /tired|mess|struggle|problem|easy|simple|方便|麻烦|轻松|简单|困扰/i, question: '先呈现需求发生的环境，再说明已确认的产品重点，是否比直接报卖点更清楚？', setting: '真实工作与生活交界的桌面空间，以清晰留白突出商品', palette: '清晰自然光、干净中性色，避免夸张效果对比', motion: '保持稳定构图，只使用自然光的轻微变化', audience: '面临相关日常需求的人（建议测试人群）' }
];

// Public copy provides observations about expression, never proof of performance
// or evidence that we have watched the ad's footage.
export function buildMarketBrief(state, discovery, dossier) {
  const sources = new Map((state.discoverySources || []).map(s => [s.id, s]));
  const keywords = terms(`${dossier.product} ${dossier.brandName}`);
  const category = categoryTerms[dossier.category.id];
  const seen = new Set(), seenCopy = new Set();
  let considered = 0;
  const samples = (state.evidence || []).filter(e => e.discoveryId === discovery?.id && String(e.sourceType).startsWith('meta_')).flatMap(e => {
    considered++;
    const source = sources.get(e.discoverySourceId);
    if (source?.status !== 'available' || e.attributes?.demo || !url(e.sourceUrl)) return [];
    const copy = text(e.attributes?.bodyText, 1200);
    if (!copy || /\{\{[^}]+\}\}/.test(copy)) return [];
    const body = `${e.attributes?.advertiserName || ''} ${e.attributes?.title || ''} ${copy}`;
    const matches = keywords.filter(t => body.toLowerCase().includes(t));
    const categoryMatch = Boolean(category?.test(body));
    if (!matches.length && !categoryMatch) return [];
    const key = text(e.attributes?.adId) || copy.toLowerCase();
    const copyKey = copy.toLowerCase().replace(/[\s\u200b-\u200d\ufeff]+/g, ' ').trim();
    if (seen.has(key) || seenCopy.has(copyKey)) return [];
    seen.add(key);
    seenCopy.add(copyKey);
    return [{ id: e.id, sourceUrl: url(e.sourceUrl), observedAt: e.observedAt || null, advertiser: text(e.attributes?.advertiserName, 120), copy, format: text(e.attributes?.displayFormat, 40) || 'UNKNOWN', relevance: matches.length ? 'product_or_brand_terms' : 'category_terms', score: matches.length * 10 + Number(categoryMatch), mediaAnalysis: 'copy_only', motifIds: motifs.filter(m => m.match.test(copy)).map(m => m.id) }];
  }).sort((a, b) => b.score - a.score).slice(0, 6);
  const observations = motifs.flatMap(m => {
    const supporting = samples.filter(s => s.motifIds.includes(m.id));
    return supporting.length ? [{ id: `observation_${m.id}`, motifId: m.id, label: m.label, statement: `${supporting.length} 条相关公开广告文案出现${m.label}的表达。`, sampleIds: supporting.map(s => s.id), scope: 'public_ad_copy', limitation: '只说明样本出现此表达，不代表热门、有效或已经分析视频画面。' }] : [];
  });
  return { schemaVersion: 1, discoveryId: discovery?.id || null, status: observations.length ? 'observations_available' : 'insufficient', channel: 'Meta', considered, samples, observations, limitations: ['相关性是文字初筛；样本可能来自同品牌其他型号或同品类，仍需核对具体商品与目标市场。', '未取得投放效果、转化或受众数据；不能据此判断广告有效。', '本轮只分析已采集文案和格式标记，未分析视频动作、构图或剪辑节奏。', ...(observations.length ? [] : ['尚无足够的相关市场观察；下方方向为产品资料推导的创意假设。'])] };
}

export function marketDirections(brief, dossier) {
  const observed = (brief?.observations || []).map(o => motifs.find(m => m.id === o.motifId)).filter(Boolean);
  const candidates = [...observed, ...motifs].filter((m, i, all) => all.findIndex(n => n.id === m.id) === i).slice(0, 3);
  return candidates.map(m => {
    const observation = brief?.observations?.find(o => o.motifId === m.id);
    const samples = (brief?.samples || []).filter(s => observation?.sampleIds.includes(s.id));
    return {
      id: m.id, name: m.label, question: m.question,
      audience: dossier.audience.value || m.audience,
      audienceBasis: dossier.audience.value ? 'user' : 'creative_hypothesis',
      visualBrief: { setting: m.setting, palette: m.palette, motion: m.motion, rationale: observation ? `将文案中观察到的“${m.label}”转成场景创意；画面设计是本次建议，不是对样本画面的复刻。` : `根据商品资料提出“${m.label}”方向，尚无匹配市场样本支持。` },
      marketBasis: { status: observation ? 'public_copy_observation' : 'product_hypothesis', discoveryId: brief?.discoveryId || null, observationIds: observation ? [observation.id] : [], evidenceIds: samples.map(s => s.id), samples: samples.map(({ id, sourceUrl, advertiser, copy, observedAt }) => ({ id, sourceUrl, advertiser, quote: copy.slice(0, 400), observedAt })), explanation: observation?.statement || '没有匹配的公开表达，仅为待验证创意方向。', limitation: '公开样本不证明效果；新场景与视觉设计是创意建议。' }
    };
  });
}
