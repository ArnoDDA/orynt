// A view of the saved strategy, not a new prediction or generation step.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const link = (path, text, cls = 'text-button') => `<a href="#${path}" data-nav class="${cls}">${text}</a>`;
const get = (data, collection, id) => data[collection]?.find(item => item.id === id);
const publicUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };

export function opportunityCards(data, campaign) {
  const discovery = data.discoveries?.filter(d => d.campaignId === campaign.id && d.briefId === campaign.briefId).at(-1);
  return (data.cards || []).filter(card => card.campaignId === campaign.id && !['superseded', 'dismissed'].includes(card.status) && (!discovery || (card.discoveryId || get(data,'cardSets',card.cardSetId)?.discoveryId) === discovery.id));
}

export function advertisingDecision(data, campaign, card) {
  const brief = get(data, 'briefs', card?.briefId || get(data,'cardSets',card?.cardSetId)?.briefId) || get(data, 'briefs', campaign.briefId) || {};
  const plan = card?.advertisingPlan, basis = plan?.marketBasis;
  const sources = basis?.status === 'public_copy_observation' ? (basis.samples || []).flatMap(sample => {
    const url = publicUrl(sample.sourceUrl);
    const discoveryId = card?.discoveryId || get(data,'cardSets',card?.cardSetId)?.discoveryId;
    const evidence = (data.evidence || []).find(e => e.discoveryId === discoveryId && (e.id === sample.id || e.sourceUrl === url));
    const source = evidence && get(data,'discoverySources',evidence.discoverySourceId);
    const visualEvidence=evidence&&referenceVisuals(evidence).length?evidence:(data.evidence||[]).find(e=>e.sourceUrl===url&&referenceVisuals(e).length&&get(data,'discoverySources',e.discoverySourceId)?.status==='available');
    return url && sample.quote ? [{ ...sample, sourceUrl:url, ...(source?.status === 'available'&&visualEvidence ? {visualEvidence} : {}) }] : [];
  }) : [];
  const paired = !campaign.replay && card?.validationPlan?.mode !== 'single_creative' && !!card?.testPlan?.control && !!card?.testPlan?.variant;
  return {
    name: plan?.name || card?.title || '待确定的广告提案',
    product: brief.product || card?.productDossier?.product || '本次产品',
    audience: plan?.audience || card?.audience || brief.audience || '待确认；可在测试计划中补充',
    audienceSuggested: plan?.audienceBasis === 'creative_hypothesis',
    focus: plan?.focus?.value || card?.claim || '待确认产品表达',
    hypothesis: plan?.hypothesis || card?.testHypothesis || '先确定希望通过这条广告回答的问题。',
    rationale: sources.length ? basis.explanation || '参考以下公开样本，提出这个广告方向。' : '从已确认的产品资料出发，提出一个待验证的表达方向。',
    sources,
    basisLabel: sources.length ? '有公开文案参考 · 效果待验证' : '产品资料推导 · 待验证',
    metric: card?.validationPlan?.successSignal || card?.testPlan?.successSignal || '先观察点击率（CTR）；需要同条件对照，才能判断哪种表达更有效。',
    scope: campaign.replay ? '单条广告的模拟观察；未制作对照版，不构成 A/B 测试。' : paired ? 'A/B 测试提案；需要分别制作两版素材并保持测试条件一致，才能比较。' : '先制作一条广告用于观察；没有同条件对照时，不判断优劣或提升。',
    paired,
    shots: plan?.shots || [],
    channel: brief.channel || card?.applicability?.channel || 'Meta'
  };
}

export function renderDecisionSources(sources, limit = sources.length) {
  return sources.slice(0, limit).map(source => `<blockquote class="opportunity-source"><span>${icon('quote')}${esc(source.advertiser || '公开广告文案')}</span>${source.visualEvidence ? renderReferenceMedia(source.visualEvidence,{empty:false}) : ''}<p>“${esc(source.quote)}”</p><footer><a href="${esc(source.sourceUrl)}" target="_blank" rel="noreferrer">查看原始来源 ${icon('arrow-up-right')}</a>${source.observedAt ? `<time>${esc(source.observedAt.slice(0,10))}</time>` : ''}</footer></blockquote>`).join('');
}

export function renderDecisionPanel(data, campaign, card) {
  const d = advertisingDecision(data, campaign, card);
  return `<div class="decision-panel"><span class="opportunity-label">CAMPAIGN CARD / 广告提案</span><h2>${esc(d.name)}</h2><span class="opportunity-basis ${d.sources.length ? 'has-source' : ''}">${icon(d.sources.length ? 'scan-search' : 'flask-conical')}${esc(d.basisLabel)}</span><dl class="decision-fields"><div><dt>给谁看${d.audienceSuggested ? ' · 建议人群' : ''}</dt><dd>${esc(d.audience)}</dd></div><div><dt>这条广告讲什么</dt><dd>${esc(d.focus)}</dd></div><div class="decision-question"><dt>${icon('flask-conical')}这次要验证</dt><dd>${esc(d.hypothesis)}</dd></div><div><dt>看什么结果</dt><dd>${esc(d.metric)}</dd></div></dl><p class="decision-scope">${icon('info')}${esc(d.scope)}</p>${d.sources.length ? `<details class="decision-sources"><summary>查看这个提案的 ${d.sources.length} 条文案依据</summary><p>${esc(d.rationale)}</p>${renderDecisionSources(d.sources)}</details>` : `<p class="decision-scope">当前缺少相关公开文案参考，创意依据来自产品资料。</p>`}</div>`;
}

export function renderStrategyAnchor(data, campaign, card, { validation = false } = {}) {
  if (!card) return '';
  const d = advertisingDecision(data, campaign, card);
  return `<section class="strategy-anchor" aria-label="本次广告的策略目标"><div class="strategy-anchor-mark">${icon('crosshair')}</div><div><span>${validation ? '回到这次要验证的问题' : '这条广告始终围绕'}</span><h2>${esc(d.hypothesis)}</h2><p><strong>给谁看</strong>${esc(d.audience)}<b>·</b><strong>表达重点</strong>${esc(d.focus)}</p></div>${link(`/campaigns/${campaign.id}/cards/${card.id}`, '查看提案 '+icon('arrow-up-right'))}</section>`;
}

export function renderCreativeLineage(data,campaign,card) {
  const d=advertisingDecision(data,campaign,card),replay=!!campaign.replay?.revision;
  const sources=d.sources.slice(0,2),shot=d.shots[0];
  if(!card)return '';
  return `<section class="creative-lineage" aria-label="从参考到广告拍法"><header><span class="opportunity-label" lang="en">THE REASON BEHIND THE CREATIVE</span><h2>看到了什么，决定怎么拍。</h2><p>参考提供线索，提案决定表达；成片完成后，再用测试检验判断。</p></header><div class="lineage-columns"><article class="lineage-evidence"><span class="lineage-step">01 / WHAT WE FOUND</span><div class="lineage-sources">${sources.length?sources.map(source=>`<a href="${esc(source.sourceUrl)}" target="_blank" rel="noreferrer">${source.visualEvidence&&referenceVisuals(source.visualEvidence).length?`<img loading="lazy" src="${esc(referenceVisuals(source.visualEvidence)[0].url)}" alt="${esc(source.advertiser||'公开广告')}原广告封面">`:`<span class="lineage-source-icon">${icon('quote')}</span>`}<blockquote>“${esc(source.quote)}”</blockquote><small>${esc(source.advertiser||'公开广告')} · 核对来源 ↗</small></a>`).join(''):`<div class="lineage-no-evidence">${icon('package')}<h3>从已确认的产品资料出发</h3><p>尚无可引用的公开广告参考；这个拍法是待验证建议。</p></div>`}</div><p class="lineage-boundary">${sources.length?'封面用于核对原广告；方向推导基于已保存文案，尚无效果数据。':'补充公开参考后，可以进一步核对这个方向。'}</p></article><article class="lineage-decision"><span class="lineage-step">02 / OUR CREATIVE CHOICE</span><div>${icon('git-branch')}<h3>${esc(d.name)}</h3><p>${esc(d.focus)}</p></div><dl><div><dt>给谁看</dt><dd>${esc(d.audience)}</dd></div><div><dt>想验证</dt><dd>${esc(d.hypothesis)}</dd></div></dl><span class="lineage-hypothesis">创意假设 · 待测试</span></article><article class="lineage-shot"><span class="lineage-step">03 / HOW IT SHOWS UP</span>${replay?`<figure><img src="/api/demo/owala-commute/media/shot1Frame?revision=${encodeURIComponent(campaign.replay.revision)}&size=preview" alt="${esc(shot?.title||'广告开场')} · 已保存真实生成静帧" loading="lazy"><figcaption>已保存的真实生成画面</figcaption></figure>`:`<div class="lineage-shot-draft">${icon('clapperboard')}<strong>镜头草案</strong><p>${esc(shot?.description||shot?.text||d.focus)}</p><small>画面尚未生成</small></div>`}<h3>${esc(shot?.title||'计划中的广告开场')}</h3><p>${esc(shot?.purpose||d.focus)}</p>${link(`/campaigns/${campaign.id}/cards?direction=${encodeURIComponent(card.id)}`,'查看完整提案 '+icon('arrow-right'))}</article></div></section>`;
}

export function researchInventory(data, campaign) {
  const discovery = (data.discoveries || []).filter(d => d.campaignId === campaign.id && d.briefId === campaign.briefId).at(-1);
  const sources = (data.discoverySources || []).filter(s => discovery && s.discoveryId === discovery.id);
  const sourceById = new Map(sources.map(s => [s.id, s]));
  const decisions = opportunityCards(data, campaign).map(card => ({ card, decision:advertisingDecision(data, campaign, card) }));
  const evidence = (data.evidence || []).filter(e => discovery && e.discoveryId === discovery.id).map(e => {
    const source = sourceById.get(e.discoverySourceId);
    const demo = e.attributes?.demo || String(e.sourceType || source?.sourceType).includes('_demo');
    const url = publicUrl(e.sourceUrl);
    const available = source?.status === 'available' && !demo && !!url;
    const quote = e.attributes?.bodyText || e.contentSummary || '';
    const proposals = available ? decisions.filter(({decision}) => decision.sources.some(s => s.id === e.id || (s.sourceUrl === url && quote.includes(s.quote)))).map(({card,decision}) => ({id:card.id,name:decision.name})) : [];
    return { ...e, url, quote, available, demo, source, proposals, category:String(e.sourceType || source?.sourceType).startsWith('meta_') ? 'meta' : 'website' };
  });
  return { discovery, sources, evidence, usable:evidence.filter(e => e.available), cited:evidence.filter(e => e.proposals.length) };
}

export function referenceVisuals(evidence) {
  if (evidence.sourceType !== 'meta_ad_library' || evidence.attributes?.demo || evidence.available === false) return [];
  return (evidence.attributes?.media || []).flatMap((media,index) => media.status === 'available' && ['image/png','image/jpeg','image/webp'].includes(media.mime) && /^[a-f0-9]{64}$/.test(media.sha256 || '') ? [{...media,url:`/api/evidence/${encodeURIComponent(evidence.id)}/media/${index}?sha256=${media.sha256}`}] : []);
}

export function renderReferenceMedia(evidence, {empty = true} = {}) {
  const visuals = referenceVisuals(evidence);
  const blocked = evidence.attributes?.media?.some(m => m.reason === 'ROBOTS_DENIED');
  return visuals.length ? `<div class="reference-visuals">${visuals.map(media=>`<a href="${esc(media.url)}" target="_blank" rel="noreferrer" aria-label="放大查看${media.kind === 'video_poster' ? '原广告视频封面' : '原广告图片'}"><img loading="lazy" src="${esc(media.url)}" alt="${esc(evidence.attributes?.advertiserName || '公开广告')} · ${media.kind === 'video_poster' ? '原广告视频封面' : '原广告图片'}"><span>${icon(media.kind === 'video_poster' ? 'film' : 'image')}${media.kind === 'video_poster' ? '原广告视频封面 · 非完整视频' : '原广告图片'}${icon('expand')}</span></a>`).join('')}</div>` : empty ? `<div class="reference-visual-missing">${icon('image-off')}<span>${blocked ? '来源限制了自动图片采集' : '尚未取得广告原图'}</span><small>${blocked ? '可通过下方「查看原广告」核对画面，当前仅保存文案。' : evidence.attributes?.mediaMissingReason === 'RAW_RECORD_MISSING' ? '这条历史记录只保存了文案，原始素材记录已缺失。' : evidence.attributes?.mediaStatus === 'unavailable' ? '图片链接暂不可读，已保留文案与原始来源。' : '当前只保存了文案，不能据此判断原广告画面。'}</small></div>` : '';
}

export function renderMarketReferences(data,campaign) {
  const inventory = researchInventory(data,campaign);
  const ads = inventory.usable.filter(e => e.category === 'meta');
  if (!ads.length) return '';
  const shown = ads.toSorted((a,b) => Number(!!b.proposals.length)-Number(!!a.proposals.length) || Number(!!referenceVisuals(b).length)-Number(!!referenceVisuals(a).length)).slice(0,4);
  const withImages = ads.filter(e => referenceVisuals(e).length).length;
  const pending = (data.jobs || []).some(j => j.campaignId === campaign.id && j.type === 'reference_media' && ['queued','running'].includes(j.status));
  return `<section class="market-reference-board" aria-label="真实广告图片参考"><header><div><span class="opportunity-label" lang="en">PUBLIC AD REFERENCES</span><h2 lang="en">Market Signals</h2><p>${campaign.replay ? '以下为公开广告的历史采集资料，与你自己的生成画面分开展示。' : '原图和封面保存在本地，可以放大核对，不必只读文案猜画面。'}</p></div><div><span>${withImages} / ${ads.length} 条参考有图片</span>${!campaign.archived ? `<button type="button" class="button secondary" data-action="collect-reference-images" data-id="${esc(campaign.id)}" ${pending ? 'disabled aria-busy="true"' : ''}>${icon(pending ? 'loader-circle' : 'images')}${pending ? '正在补齐图片…' : withImages < ads.length ? '补齐参考图片' : '重新读取参考图片'}</button>` : ''}</div></header><div class="market-reference-grid">${shown.map(e=>`<article><div class="market-reference-byline"><strong>${esc(e.attributes?.advertiserName || '公开广告')}</strong><span>Meta 广告库</span></div>${renderReferenceMedia(e)}<div class="market-reference-caption"><span>${e.proposals.length ? '本次方向引用的参考' : '采集到的其他参考'}${e.observedAt ? ' · '+esc(e.observedAt.slice(0,10)) : ''}</span><p>${esc(e.attributes?.bodyText || e.contentSummary)}</p><a href="${esc(e.url)}" target="_blank" rel="noreferrer">查看原广告 ${icon('arrow-up-right')}</a></div></article>`).join('')}</div><p class="market-reference-boundary">${icon('info')}图片用于核对视觉参考；视频封面不能代表完整分镜。当前广告建议仍基于产品资料和公开文案，未自动分析原广告镜头。</p></section>`;
}

export function renderResearchWorkspace(data, campaign, filter = 'all') {
  const inventory = researchInventory(data,campaign), {sources,usable,cited} = inventory;
  const selected = ['all','meta','website'].includes(filter) ? filter : 'all';
  const shown = usable.filter(e => selected === 'all' || e.category === selected);
  const snapshot = get(data,'snapshots',campaign.brandSnapshotId), images = (snapshot?.productImport?.images || []).filter(i => i.id);
  const sourceLabel = type => String(type).startsWith('meta_') ? 'Meta 广告库' : '品牌官网';
  const originGroups = [...new Set(sources.map(s => sourceLabel(s.sourceType)))].map(name => {
    const entries=sources.filter(s=>sourceLabel(s.sourceType)===name);
    return {name,entries,available:entries.filter(s=>s.status==='available'&&!String(s.sourceType).includes('_demo')).length,demo:entries.filter(s=>String(s.sourceType).includes('_demo')).length};
  });
  const root = `/campaigns/${campaign.id}/discover?view=opportunities`;
  return `<section class="research-workspace" aria-label="采集与参考工作区"><header class="capability-heading"><div><span class="opportunity-label">RESEARCH WORKSPACE</span><h2 lang="en">Research Workspace</h2><p>${campaign.replay ? '展示已保存的采集结果与引用关系，本轮不重新请求外部网站。' : '核对来源、浏览公开内容，查看哪些参考进入了广告提案。'}</p></div>${link(`/campaigns/${campaign.id}/discover?view=signals&section=samples`,'查看采集详情 '+icon('arrow-up-right'))}</header>
    <div class="research-summary"><div><strong>${images.length}</strong><span>读取到的产品候选图</span></div><div><strong>${usable.length}</strong><span>可查看的公开内容</span></div><div><strong>${cited.length}</strong><span>被提案引用的内容</span></div><div><strong>${sources.filter(s=>s.status!=='available').length}</strong><span>未取得可用结果的来源</span></div></div>
    <div class="research-origins">${originGroups.length ? originGroups.map(g=>`<article><span>${icon(g.name==='Meta 广告库'?'scan-search':'globe')}${esc(g.name)}</span><strong>${g.available?`${g.available} 个来源已保存`:g.demo?'仅有演示记录':'未取得可用内容'}</strong><small>${campaign.replay?'历史采集结果':g.entries.length-g.available-g.demo?`${g.entries.length-g.available-g.demo} 个来源未取得结果`:'可在下方逐条核对'}</small></article>`).join('') : '<p class="help">本轮没有外部采集来源记录，产品资料仍可用于提出创意假设。</p>'}</div>
    ${images.length?`<details class="research-product-images"><summary>查看导入的 ${images.length} 张产品候选图</summary><div>${images.slice(0,8).map(i=>`<figure><img loading="lazy" src="/api/product-imports/${snapshot.id}/images/${i.id}" alt="${esc(i.name || '官网候选产品图')}"><figcaption>${snapshot.productImport.selectedImageIds?.includes(i.id)?'已选用':'候选图片'}</figcaption></figure>`).join('')}</div>${link(`/campaigns/${campaign.id}/discover?view=setup`,'核对并选择产品素材 '+icon('arrow-right'))}</details>`:''}
    <nav class="research-filters" aria-label="筛选采集内容">${[['all','全部内容'],['meta','Meta 广告'],['website','官网资料']].map(([key,label])=>`<a data-nav href="#${root}&research=${key}" ${selected===key?'aria-current="page"':''}>${label}<span>${usable.filter(e=>key==='all'||e.category===key).length}</span></a>`).join('')}</nav>
    <div class="research-evidence-grid">${shown.map(e=>`<article class="research-evidence"><header><span>${esc(e.attributes?.advertiserName || sourceLabel(e.sourceType))}</span><small>${e.category==='meta'?'公开广告参考':'官网内容'}${e.observedAt?' · '+esc(e.observedAt.slice(0,10)):''}</small></header>${e.category==='meta' ? renderReferenceMedia(e) : ''}<h3>${esc(e.title || '公开来源内容')}</h3><p>${esc(e.quote)}</p><div class="research-lineage"><span>${icon(e.proposals.length?'git-branch':'file-search')}${e.proposals.length?'已进入以下提案':'尚未被当前提案引用'}</span>${e.proposals.map(p=>link(`/campaigns/${campaign.id}/cards?direction=${encodeURIComponent(p.id)}`,esc(p.name)+' '+icon('arrow-right'))).join('')}</div><a class="research-original" href="${esc(e.url)}" target="_blank" rel="noreferrer">核对原始来源 ${icon('arrow-up-right')}</a></article>`).join('') || `<div class="research-empty">${icon('search')}<h3>这个范围还没有可查看的公开内容</h3><p>采集未完成、不可用来源及模拟记录不会当作真实参考。可以切换范围，或到采集详情查看原因。</p></div>`}</div><p class="opportunity-fact-note">${icon('info')}公开文案用于观察表达方式；被引用不代表效果已验证。产品候选图数量也不代表已确认可用于生成的素材数量。</p></section>`;
}

function opportunityProductImage(data, campaign, snapshot) {
  if (campaign.replay?.revision) return `/api/demo/owala-commute/media/productPhoto?revision=${encodeURIComponent(campaign.replay.revision)}&size=preview`;
  const imported = snapshot?.productImport;
  const selected = imported?.images?.find(image => imported.selectedImageIds?.includes(image.id));
  if (selected) return `/api/product-imports/${snapshot.id}/images/${selected.id}`;
  const assets = (snapshot?.assetIds || []).map(id => get(data,'brandAssets',id)).filter(Boolean);
  const asset = assets.find(a => !/logo|标志|徽标/i.test(`${a.role || ''} ${a.name || ''}`)) || assets[0];
  return asset ? `/api/brand-assets/${asset.id}/preview` : '';
}

export function renderOpportunityBrief(data, campaign, researchFilter = null) {
  const cards = opportunityCards(data, campaign), snapshot = get(data, 'snapshots', campaign.brandSnapshotId), brief = get(data, 'briefs', campaign.briefId) || {};
  if (!cards.length) return `<section class="opportunity-empty"><span class="maker-kicker" lang="en">02 / DISCOVER</span><h1>先把产品和参考资料整理好</h1><p>资料准备完成后，这里会展示来源、切入方向和待验证的问题。</p>${link(`/campaigns/${campaign.id}/discover?view=preparing`, '继续整理资料', 'button')}</section>`;
  const decisions = cards.map(card => advertisingDecision(data, campaign, card));
  const sources = [...new Map(decisions.flatMap(d => d.sources).map(source => [source.sourceUrl+'\n'+source.quote,source])).values()];
  const productImage = opportunityProductImage(data,campaign,snapshot);
  const facts = snapshot?.facts || {};
  const confirmed = snapshot?.confirmation === 'confirmed';
  const d = decisions[0], card = cards[0];
  const replay = !!campaign.replay?.revision;
  const frame = index => `/api/demo/owala-commute/media/${index === 0 ? 'shot1Frame' : 'shot2Frame'}?revision=${encodeURIComponent(campaign.replay.revision)}&size=preview`;
  const scenes = (replay ? campaign.replay.scenes || [] : d.shots).slice(0,3);
  const proposalLink = `/campaigns/${campaign.id}/cards?direction=${encodeURIComponent(card.id)}`;
  const sceneText = scene => scene.description || scene.text || scene.direction?.firstFrame || scene.direction?.shotIntent || '';
  return `<section class="opportunity-page"><header class="opportunity-heading"><div><span class="opportunity-label" lang="en">02 / DISCOVER</span><h1 lang="en">Find your creative edge.</h1><p>从公开广告与产品事实中找切入点。先看参考和拍法，选好方向后再制作。</p></div><span class="opportunity-mode">${replay ? '固定演示 · 重放已保存结果' : '本轮创意建议'}</span></header>
    ${renderCreativeLineage(data,campaign,card)}
    <section class="creative-recommendation" aria-label="建议制作的广告"><div class="creative-transformation"><figure class="creative-original">${productImage ? `<img src="${esc(productImage)}" alt="${esc(brief.product || facts.product || d.product)} · 导入的产品图">` : `<div class="creative-missing">${icon('image')}<span>尚未选择产品图</span></div>`}<figcaption><span>你的产品图</span><strong>${esc(brief.product || facts.product || d.product)}</strong></figcaption></figure><span class="creative-transform-arrow">${icon('arrow-right')}</span><figure class="creative-outcome ${replay ? 'has-preview' : ''}">${replay ? `<img src="${frame(0)}" alt="出门前的准备 · 已保存的真实生成画面"><span class="creative-preview-label">真实生成画面 · 已保存</span><figcaption><small>Before you head out.</small><strong>出门之前，<br>带上 Owala。</strong></figcaption>` : `<div class="creative-scene-draft">${icon('clapperboard')}<span>计划拍摄的开场</span><strong>${esc(scenes[0]?.title || d.name)}</strong><p>${esc(sceneText(scenes[0] || {}) || card.advertisingPlan?.visualBrief?.setting || d.focus)}</p></div><figcaption><span>拍法建议 · 场景画面尚未生成</span></figcaption>`}</figure></div>
    <div class="creative-recommendation-copy"><span class="opportunity-label">${cards.length > 1 ? '先看方向 01' : '本次广告建议'}</span><h2>${esc(replay ? '把水杯放进「出门前」的生活场景。' : d.name)}</h2><p class="creative-value">${esc(replay ? '让顾客一眼看懂：这只水杯，可以成为每天出门时带上的东西。' : d.focus)}</p><dl><div><dt>${icon('users')}希望谁停下来看</dt><dd>${esc(d.audience)}</dd></div><div><dt>${icon('crosshair')}做完后要回答</dt><dd>${esc(d.hypothesis)}</dd></div></dl>${link(proposalLink,'看脚本，确定这个方向 '+icon('arrow-right'),'button')}<small>下一步可查看镜头和文案；这里不会开始付费生成。</small></div></section>
    ${scenes.length ? `<section class="creative-storyboard" aria-label="广告的画面顺序"><header><h2 lang="en">Storyboard Preview</h2><span>${replay ? '已保存的成片画面' : '镜头草案 · 确认后再生成'}</span></header><ol>${scenes.map((scene,index)=>`<li>${replay ? `<div class="creative-shot-image"><img src="${frame(index)}" alt="${esc(scene.title)} · 已保存的生成静帧" loading="lazy"><span>${esc(scene.timing || `${scene.start}–${scene.end}s`)}</span></div>` : `<div class="creative-shot-placeholder">${icon(['clapperboard','focus','flag'][index])}<span>待生成画面</span></div>`}<div><span class="creative-shot-step">0${index+1} / ${['让人停下来','给出选择理由','留下品牌和入口'][index]}</span><h3>${esc(scene.title)}</h3><p>${esc(sceneText(scene))}</p></div></li>`).join('')}</ol></section>` : ''}
    <section class="creative-why" aria-label="为什么建议这样拍"><div class="creative-why-icon">${icon(sources.length ? 'scan-search' : 'lightbulb')}</div><div><h2>${replay && d.sources.length ? '为什么拍日常场景？官网广告也在讲「随时带着走」。' : d.sources.length ? '这个拍法，参考了公开广告里怎样介绍产品。' : '这个拍法，先从产品本身能表达的特点出发。'}</h2><p>${esc(replay && d.sources.length ? '已保存的两条 Owala 广告文案，都把水杯与出行、日常生活联系起来。我们据此选择「出门前准备」作为开场；它是否更能吸引顾客，还需要测试。' : d.rationale)}</p><details class="creative-references"><summary>${d.sources.length ? `核对这条建议的 ${d.sources.length} 条公开文案参考` : '当前还没有足够的公开参考 · 产品资料推导'}</summary>${d.sources.length ? renderDecisionSources(d.sources) : '<p>可以先制作并观察，也可以补充公开参考。当前没有依据声称这种拍法表现更好。</p>'}<p class="opportunity-fact-note">公开文案只提供表达线索，不代表我们分析了原广告画面，也不代表其投放效果已验证。</p></details></div></section>
    ${cards.length > 1 ? `<section class="creative-alternatives"><header><h2 lang="en">More Creative Directions</h2><p>每个方向都能展开成脚本，先选最适合这次推广的一个。</p></header><div class="opportunity-directions">${cards.slice(1).map((item,index)=>{const other=decisions[index+1];return `<article><span class="opportunity-index">0${index+2}</span><div><span class="opportunity-basis">${esc(other.sources.length?'有公开文案参考':'产品资料推导')}</span><h3>${esc(other.name)}</h3><p>${esc(other.focus)}</p><p><strong>想吸引</strong>${esc(other.audience)}</p></div>${link(`/campaigns/${campaign.id}/cards?direction=${encodeURIComponent(item.id)}`,'看这个方向 '+icon('arrow-right'),'button secondary')}</article>`;}).join('')}</div></section>` : ''}
    <details class="creative-product-details"><summary>${icon('shield-check')}制作时，会遵守哪些产品信息？<span>${confirmed ? '本轮已确认资料' : '产品资料 · 待核对'}</span></summary><dl><div><dt>能讲什么</dt><dd>${esc(facts.claim || '尚未明确；可返回产品页补充')}</dd></div><div><dt>不应擅自承诺什么</dt><dd>${esc(facts.limitations || '只使用已确认的产品信息，避免未经证实的功能与效果承诺。')}</dd></div></dl>${link(`/campaigns/${campaign.id}/discover?view=setup`,'核对产品资料 '+icon('arrow-up-right'))}</details>
    <details class="creative-research-details" ${['all','meta','website'].includes(researchFilter) ? 'open' : ''}><summary><span>${icon('folders')}查看采集素材与完整来源</span><small>${sources.length} 条被当前提案引用的公开文案</small>${icon('chevron-down')}</summary>${renderResearchWorkspace(data,campaign,researchFilter)}</details></section>`;
}
