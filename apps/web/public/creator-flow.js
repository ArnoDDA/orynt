import { defaultScenePlan, sceneTiming } from '../../../packages/domain/src/scene-script.js';
import { creativePresentation } from './creative-visuals.js';
import { renderImportedProductReview } from './product-import-flow.js';
import { shotDirectionFields, shotDirectionFieldName, shotDirectionFromFields } from '../../../packages/domain/src/shot-direction.js';
import { renderShotDirectionEditor, renderShotDirectionSummary } from './shot-direction-view.js';
import { productionPlan } from '../../../packages/domain/src/production-plan.js';
import { reviewProductionPlan } from '../../../packages/domain/src/production-quality.js';
import { renderPlanChecks } from './production-quality-view.js';
import { renderAdvertisingPlan } from './product-plan-view.js';
import { renderWalkthroughProduct, renderWalkthroughCreative, renderWalkthroughStudio, renderWalkthroughResults } from './walkthrough-flow.js';
import { opportunityCards, advertisingDecision, renderDecisionPanel } from './opportunity-flow.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const link = (path, text, cls = '') => `<a href="#${path}" data-nav class="${cls}">${text}</a>`;
const find = (data, collection, id) => data[collection].find(item => item.id === id);
const field = (label, name, value, help = '', area = false) => `<label>${label}${area ? `<textarea name="${name}" rows="3" maxlength="${name.startsWith('scene') ? 600 : 2000}" required>${esc(value)}</textarea>` : `<input name="${name}" value="${esc(value)}" maxlength="2000" required>`}${help ? `<small>${help}</small>` : ''}</label>`;
const select = (label, name, value, options) => `<label>${label}<select name="${name}">${options.map(([key, title]) => `<option value="${key}" ${String(key) === String(value) ? 'selected' : ''}>${title}</option>`).join('')}</select></label>`;
export const sceneFieldNames = ['sceneOpening', 'sceneProof', 'sceneClosing'];
const sceneDirectionFieldNames = sceneFieldNames.slice(0, 2).flatMap(prefix => shotDirectionFields.map(({ key }) => shotDirectionFieldName(prefix, key)));

// Drafts contain only this workspace's editable creative fields, never credentials or file bytes.
export function createDraftStore(storage, namespace) {
  const memory = new Map();
  const allowed = new Set(['source', 'brandId', 'brandName', 'brandUrl', 'name', 'objective', 'product', 'audience', 'claim', 'channel', 'style', 'market', 'competitors', 'limitations', 'ratio', 'duration', 'language', 'notes', 'templateId', 'mode', 'selectedCardId', 'copyOpening', 'copyDetail', 'copyCta', 'music', 'productTreatment', ...sceneFieldNames, ...sceneDirectionFieldNames]);
  const key = name => `orynt:creator:v1:${namespace}:${name}`;
  return {
    read(name) { try { return JSON.parse(storage.getItem(key(name)) || 'null') || memory.get(name) || {}; } catch { return memory.get(name) || {}; } },
    write(name, fields) {
      const value = Object.fromEntries(Object.entries(fields).filter(([name, value]) => allowed.has(name) && typeof value === 'string').map(([name, value]) => [name, value.slice(0, sceneDirectionFieldNames.includes(name) ? 400 : name.startsWith('scene') ? 600 : 2000)]));
      if(Array.isArray(fields.brandAssetIds))value.brandAssetIds=fields.brandAssetIds.filter(id=>typeof id==='string'&&id.length<200).slice(0,50);
      if(Array.isArray(fields.importImageIds))value.importImageIds=fields.importImageIds.filter(id=>typeof id==='string'&&id.length<200).slice(0,12);
      memory.set(name, value); try { storage.setItem(key(name), JSON.stringify(value)); return true; } catch { return false; }
    },
    remove(name) { memory.delete(name); try { storage.removeItem(key(name)); } catch { /* Storage can be disabled. */ } }
  };
}

export function sceneFields(card, angle, config, draft = {}) {
  const scenes = config?.scenePlan || angle.scenePlan || defaultScenePlan({ hook: angle.hook, proof: angle.proof || card.creativeRoute.proof }, card.claim);
  const focus = card.advertisingPlan?.focus;
  const suggestedCopy = focus?.kind === 'confirmed_brand_statement' && focus.value.length <= 70 ? focus.value : '';
  const details = Object.fromEntries(sceneFieldNames.slice(0, 2).flatMap((prefix, index) => shotDirectionFields.map(({ key }) => [shotDirectionFieldName(prefix, key), scenes[index].direction?.[key] || ''])));
  return { ratio: config?.ratio || '9:16', duration: String(config?.duration || 15), language: config?.language || '中文', notes: config?.notes || '', copyOpening: config?.productionCopy?.opening ?? '', copyDetail: config?.productionCopy?.detail ?? suggestedCopy, copyCta: config?.productionCopy?.cta ?? '', music: config?.music || 'ambient', templateId: config?.templateId || '', ...Object.fromEntries(sceneFieldNames.map((key, index) => [key, scenes[index].text])), ...details, ...draft };
}

export function productImage(data, brandId, selectedIds) {
  const available = data.brandAssets.filter(asset => asset.brandId === brandId && asset.status === 'ready');
  const assets = selectedIds ? selectedIds.map(id => available.find(a=>a.id===id)).filter(Boolean) : available;
  return assets.find(asset => asset.type !== 'logo') || assets[0];
}
const image = (asset, cls = '') => asset ? `<img class="${cls}" src="/api/brand-assets/${asset.id}/preview" alt="${esc(asset.name)}">` : `<div class="maker-image-empty ${cls}">${icon('image')}<span>还没有产品图</span></div>`;
const head = (step, title, description) => `<div class="maker-heading"><span class="maker-kicker">${step}</span><h1>${title}</h1><p>${description}</p></div>`;
const coach = (title, text) => `<div class="maker-coach">${icon('sparkles')}<div><strong>${title}</strong><p>${text}</p></div></div>`;
export const stepFooter = (back, title, description, action) => `<div class="maker-step-footer"><div>${back || ''}<span><strong>${title}</strong><small>${description}</small></span></div>${action}</div>`;

export function renderCreatorHome(data, resume, demoEntry = '', demo = null) {
  const current = data.campaigns.filter(c => !c.archived).toSorted((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const demoBrand = data.brands.find(b => productImage(data, b.id)) || data.brands.find(b => b.name === 'Gymshark') || data.brands[0];
  const demoImage = demoBrand && productImage(data, demoBrand.id);
  const showcase=renderCreativeShowcase(data,demo);
  return `<header class="workspace-heading"><div><h1 lang="en">Workspace</h1><p>把产品资料和市场线索，变成有明确验证目标的广告。</p></div>${link('/library?type=videos', icon('film')+'查看广告素材', 'button secondary')}</header>
  ${showcase}
  <section class="workspace-start ${showcase?'workspace-quickstart':''}"><div><span class="maker-kicker" lang="en">${showcase?'TRY YOUR PRODUCT':'FROM INSIGHT TO IMPACT'}</span><h2 class="brand-headline" lang="en">${showcase?'Your next campaign starts here.':'Turn market signals<br>into better ads.'}</h2><form id="home-start-form"><label class="sr-only" for="home-product-url">产品链接</label><div class="workspace-url">${icon('link')}<input id="home-product-url" type="url" name="brandUrl" required placeholder="粘贴你想推广的产品链接" maxlength="2000"><button class="button" type="submit">从产品开始 ${icon('arrow-right')}</button></div></form><p>先核对产品事实，再看公开参考与广告机会，确定提案后进入制作。</p></div>${showcase?'':`<aside>${demoBrand ? `<button class="maker-demo" type="button" data-action="start-demo" data-id="${demoBrand.id}">${image(demoImage)}<span><strong>用已有产品开始</strong><small>${esc(demoBrand.name)} · 示例资料</small></span>${icon('arrow-up-right')}</button>` : link('/campaigns/new', '选择产品来源', 'button secondary')}</aside>`}</section>
  ${showcase?'':demoEntry}
  <div class="opportunity-home-route" aria-label="从机会到验证">${[['scan-search','Discover','看见参考：产品图、公开广告与来源'],['crosshair','Campaign Card','确定拍法：给谁看、讲什么、拍哪一幕'],['clapperboard','Studio & Testing','检查成片，改文案出新版，再模拟测试']].map(([symbol,title,copy])=>`<div>${icon(symbol)}<span><strong>${title}</strong><small>${copy}</small></span></div>`).join('')}</div>
  <div class="section-title section-gap"><div><h2 lang="en">Recent Campaigns <span class="workspace-count">${current.length}</span></h2><p class="muted">画面和修改记录会随项目保留。先显示最近 4 个项目。</p></div>${current.length>4?'<button type="button" class="text-button" data-action="show-all-campaigns">查看全部项目 ↓</button>':''}</div><div class="workspace-projects">${current.map((c,index) => {
    const brand = find(data, 'brands', c.brandId), state = projectPresentation(data, c);
    const thumbnail = state.video ? `<video controls playsinline preload="metadata" src="/api/assets/${state.video.id}/preview" aria-label="${esc(c.name)}成片"></video>` : state.shot?.technical ? `<img src="/api/productions/${state.request.id}/shots/${state.shot.index}/poster?version=${state.shot.version}" alt="最近生成的镜头">` : state.shot?.keyframe?.sha256 ? `<img src="/api/productions/${state.request.id}/shots/${state.shot.index}/keyframe?shotVersion=${state.shot.version}&version=${state.shot.keyframe.version}" alt="已生成的镜头画面">` : image(productImage(data, c.brandId));
    return `<article class="workspace-project" ${index>=4?'hidden data-extra-campaign':''}><div class="workspace-project-media">${thumbnail}<span>${state.video?'成片':state.shot?.technical?'视频镜头':state.shot?.keyframe?.sha256?'生成图片':'产品素材'}</span></div><div class="workspace-project-body"><small>${esc(brand?.name)}</small><h3>${link(state.path || resume(c), esc(c.name))}</h3><p class="workspace-status" role="status">${icon(state.symbol)}${state.label}</p><p>${state.hint}</p>${link(state.path || resume(c), state.action+' '+icon('arrow-right'), 'button secondary wide')}</div></article>`;
  }).join('') || '<div class="maker-empty-project"><h3>开始你的第一条广告</h3><p>粘贴产品链接，或使用已有产品资料开始。</p></div>'}</div>`;
}

export function renderCreativeShowcase(data,demo) {
  const film=demo?.media?.finalVideo||demo?.reviewMedia?.finalVideo;
  if(!demo?.integrity||!film||!demo.media?.productPhoto||!demo.media?.shot1Frame||!demo.media?.shot2Frame)return '';
  const media=name=>esc(demo.media[name].url+(demo.media[name].url.includes('?')?'&':'?')+'size=preview');
  const references=(data.evidence||[]).filter(e=>e.sourceType?.startsWith('meta_')&&!e.sourceType.includes('_demo')&&demo.evidence?.some(s=>s.url===e.sourceUrl)&&(data.discoverySources||[]).some(s=>s.id===e.discoverySourceId&&s.status==='available')).flatMap(e=>(e.attributes?.media||[]).flatMap((m,index)=>m.status==='available'&&/^[a-f0-9]{64}$/.test(m.sha256||'')?[{id:e.id,index,sha256:m.sha256,quote:e.attributes?.bodyText||e.contentSummary,url:e.sourceUrl}]:[])).filter((m,i,all)=>all.findIndex(n=>n.sha256===m.sha256)===i).slice(0,2);
  return `<section class="creative-showcase" aria-label="从产品到广告的真实创作过程"><header><div><span class="maker-kicker" lang="en">ONE PRODUCT. A CLEAR CREATIVE DIRECTION.</span><h2 lang="en">An ad with a reason<br>behind every frame.</h2><p>不止生成画面。把看到的市场参考，变成拍得出来的广告提案。</p></div><div>${link('/campaigns/demo','体验完整创作流程 '+icon('arrow-up-right'),'button')}<small>真实资料与生成结果回放 · 可现场另存剪辑</small></div></header><div class="showcase-stages"><article class="showcase-product"><span class="showcase-label">01 / PRODUCT</span><div><img src="${media('productPhoto')}" alt="Owala 黑色 FreeSip Twist 官网产品原图" loading="lazy"></div><h3>从真实产品开始</h3><p>官网资料与产品外观，作为创作边界。</p></article><article class="showcase-market"><span class="showcase-label">02 / MARKET SIGNALS</span><div class="showcase-reference-pair">${references.length?references.map(m=>`<a href="${esc(m.url)}" target="_blank" rel="noreferrer"><img src="/api/evidence/${esc(m.id)}/media/${m.index}?sha256=${m.sha256}" alt="Owala 已保存的公开广告封面" loading="lazy"><span>Meta · 公开封面 ↗</span></a>`).join(''):`<a href="${esc(demo.evidence?.[0]?.url||demo.product.url)}" target="_blank" rel="noreferrer" class="showcase-reference-quote">“${esc(demo.evidence?.[0]?.copy||'公开广告参考')}”<small>核对公开文案 ↗</small></a>`}</div><h3>找到日常出行的切入点</h3><p>已保存文案提到城市出行；图片可核对，效果仍待测试。</p></article><article class="showcase-plan"><span class="showcase-label">03 / CAMPAIGN CARD</span><div class="showcase-story-pair"><figure><img src="${media('shot1Frame')}" alt="出门前的准备 · 已保存真实生成静帧" loading="lazy"><figcaption>Hook / 出门前</figcaption></figure><figure><img src="${media('shot2Frame')}" alt="城市窗边 · 已保存真实生成静帧" loading="lazy"><figcaption>Story / 抵达后</figcaption></figure></div><h3>把方向变成镜头</h3><p>同一产品、两个生活场景，讲清随身出行的用途。</p></article><article class="showcase-film"><span class="showcase-label">04 / FINAL CUT</span><video controls playsinline preload="none" poster="${media('shot2Frame')}" src="${esc(film.url)}" aria-label="Owala 已保存的 15 秒真实广告成片"></video><div><h3>看得见的广告成片</h3><p>15s · 9:16 · ${demo.ready?'已验收回放':'真实成片 · 待确认'}</p></div></article></div><footer><span>${icon('git-branch')}产品 → 参考 → 提案 → 镜头 → 成片 → 模拟复盘</span><span>来源可核对，原始镜头与版本可回看。</span></footer></section>`;
}

export function projectPresentation(data, c) {
  const requests=(data.generationRequests||[]).filter(r=>r.campaignId===c.id&&r.workflow==='shot_pipeline'),request=requests.at(-1);
  const asset=request?data.assets.find(a=>a.id===request.assetId):data.assets.filter(a=>a.campaignId===c.id&&a.type==='video').at(-1);
  const job=request&&(data.jobs||[]).find(j=>j.id===request.jobId),p=request?.production;
  const frame=p?.shots.find(s=>s.keyframe&&s.keyframe.review?.status!=='accepted'&&['ready','failed'].includes(s.keyframe.status));
  const shot=frame||p?.shots.filter(s=>s.technical||s.keyframe?.sha256).at(-1);
  const pack=request&&(data.packages||[]).find(p=>p.id===request.packageId);
  const path=pack?`/campaigns/${c.id}/create?cardId=${pack.cardId}&cardVersion=${pack.cardVersion}&angleId=${request.angleId}&view=results&productionId=${request.id}`:null;
  const base={request,shot,path,video:asset};
  if(job?.status==='failed')return {...base,symbol:'circle-alert',label:'制作需要处理',hint:'已完成的画面仍然保留，可以继续未完成的步骤。',action:'处理并继续'};
  if(job?.status==='cancelled')return {...base,symbol:'pause',label:'制作已暂停',hint:'脚本与已完成的镜头已保留。',action:'继续制作'};
  if(p?.phase==='awaiting_keyframe_review')return {...base,symbol:'image',label:`镜头 ${frame?.index+1||1} · 等待确认画面`,hint:'检查构图与主体，满意后再生成视频。',action:'查看并确认画面'};
  if(p?.phase==='awaiting_review')return {...base,symbol:'play',label:'首镜头 · 等待检查视频',hint:'检查动作与画面质感，再继续后续制作。',action:'检查视频镜头'};
  if(p?.phase==='completed')return {...base,symbol:'circle-check',label:asset?.qualityReview?.status==='accepted'?'成片已确认':'成片已完成 · 等待检查',hint:'预览完整视频，或修改文案后重新剪辑。',action:'查看成片'};
  if(job&&['running','queued'].includes(job.status))return {...base,symbol:'loader-circle',label:p.phase==='assembly'?'正在剪辑成片':'镜头制作中',hint:'可以离开页面，稍后从这里继续。',action:'查看制作进度'};
  const defaults={draft:['确认产品','核对产品、卖点与图片。'],discovering:['正在寻找广告机会','正在整理产品事实、市场参考与待验证方向。'],cards_ready:['发现广告机会','先看来源与切入点，再确定一份广告提案。'],creating:['把提案变成镜头','围绕选定的人群与假设，安排每个画面。'],launch_ready:['查看广告成片','检查广告是否执行了提案，再进入模拟验证。'],learning:['查看模拟测试','测试数据为模拟数据，不代表真实投放效果。']};
  const [label,hint]=defaults[c.status]||['继续项目','从上次停下的位置继续。'];
  return {...base,symbol:'arrow-right',label,hint,action:label};
}

export function renderProductStart({ data, source, url, brandId, draft, context }) {
  const brand = find(data, 'brands', brandId) || data.brands[0];
  const example = data.brands.find(b => productImage(data, b.id)) || data.brands[0];
  return `${head('CREATE / 01', 'Start with your product.', '粘贴要推广的产品链接，或复用已经保存的品牌资料。')}${context ? `<div class="notice">已带入参考：${esc(context.label)}</div>` : ''}<div class="maker-two-panel"><form class="panel maker-product-form" id="new-form"><div class="maker-source-tabs" role="group" aria-label="产品来源"><button type="button" data-action="new-source" data-value="website" aria-pressed="${source === 'website'}" class="${source === 'website' ? 'selected' : ''}">${icon('link')}产品链接</button><button type="button" data-action="new-source" data-value="existing" aria-pressed="${source === 'existing'}" class="${source === 'existing' ? 'selected' : ''}" ${data.brands.length ? '' : 'disabled'}>${icon('briefcase-business')}已有品牌</button></div>${source === 'website' ? `<label>产品页或品牌官网<input type="url" name="brandUrl" id="brand-url" required value="${esc(url)}" placeholder="https://your-brand.com/product" maxlength="2000"><small>自动提取产品名称、官网描述和候选图；下一步核对即可。</small></label>${example ? `<button type="button" class="text-button" data-action="new-example" data-id="${example.id}">使用 ${esc(example.name)} 示例资料</button>` : ''}` : `${select('选择品牌', 'brandId', brand?.id, data.brands.map(b => [b.id, esc(b.name)]))}<div class="maker-brand-preview">${image(productImage(data, brand.id))}<div><strong>${esc(brand.name)}</strong><p>${esc(brand.websiteUrl)}</p><small>已保存的资料会预填到下一步。</small></div></div>`}<label>产品名称<input name="product" value="${esc(draft.product || (source === 'existing' ? brand?.facts?.product : ''))}" placeholder="例如：Trail Blend 咖啡" maxlength="2000"><small>可留空，下一步会尝试从网页自动提取。</small></label><input type="hidden" name="objective" value="${esc(draft.objective || '让用户更快理解产品卖点')}"><input type="hidden" name="name" value="${esc(draft.name || '')}"><input type="hidden" name="mode" value="${esc(draft.mode || 'standard')}">${stepFooter(link('/home', '返回', 'text-button'), '接下来：确认产品与素材', '产品名称、卖点和受众会带入后续脚本。', '<button type="submit" class="button">继续 '+icon('arrow-right')+'</button>')}</form><aside class="maker-guidance"><span>第一次使用</span><h2>先准备产品，<br>不用准备提示词。</h2><ol><li><strong>一个产品链接</strong><p>也可以直接选择已有品牌。</p></li><li><strong>一句你想表达的卖点</strong><p>接下来核对，再进入创意选择。</p></li><li><strong>产品图或参考视频</strong><p>可选；用于规划画面，随后可以添加。</p></li></ol></aside></div>`;
}

export function renderProductReview(data, c, draft = {}) {
  if(c.replay)return renderWalkthroughProduct(data,c);
  const snapshot = find(data, 'snapshots', c.brandSnapshotId), brief = find(data, 'briefs', c.briefId), brand = find(data, 'brands', c.brandId);
  if(snapshot.productImport)return renderImportedProductReview(data,c,draft);
  const values = { ...snapshot.facts, ...brief, product: brief.product || snapshot.facts.product, audience: brief.audience || snapshot.facts.audience, claim: snapshot.facts.claim, ...(!snapshot.frozenAt ? draft : {}) };
  const locked = snapshot.frozenAt || c.archived;
  const assets = data.brandAssets.filter(a => a.brandId === brand.id && a.status === 'ready');
  return `${head('01 / PRODUCT', locked ? 'Product Profile' : 'Know your product.', locked ? '本轮已确认的资料保留在这里。需要改变产品或受众时，可以调整本轮目标。' : '核对三个信息就可以继续。我们会把产品、卖点和受众带入下一步。')}<div class="maker-two-panel"><form id="setup-form" class="panel maker-product-form" data-campaign="${c.id}"><div class="maker-brand-line"><span class="brand-monogram">${esc(brand.name.slice(0, 1))}</span><div><strong>${esc(brand.name)}</strong><small>${esc(brand.websiteUrl)}</small></div><span>${locked ? '已确认' : '请核对'}</span></div><fieldset ${locked ? 'disabled' : ''}>${field('产品名称', 'product', values.product, '具体到这次要推广的产品。')}${field('最想表达的卖点', 'claim', values.claim, '例如：适合每日饮用的均衡风味。', true)}${field('想吸引谁？', 'audience', values.audience, '例如：想在家轻松冲一杯咖啡的日常饮用者。')}<details class="maker-advanced"><summary>渠道与其他要求</summary><div class="two-col">${select('渠道', 'channel', values.channel, [['Meta', 'Meta'], ['TikTok', 'TikTok']])}${select('内容风格', 'style', values.style, [['产品演示', '产品演示'], ['产品实拍', '产品实拍'], ['真人 UGC', '真人体验'], ['CGI', 'CGI'], ['动效', '动效']])}</div>${field('创作目标', 'objective', values.objective)}<label>不希望出现什么？<textarea name="limitations" maxlength="2000">${esc(values.limitations)}</textarea></label><input type="hidden" name="market" value="${esc(values.market)}"><input type="hidden" name="competitors" value="${esc(values.competitors)}"></details></fieldset>${stepFooter('', locked ? '产品资料已确认' : '下一步：选择一种广告表达', locked ? '更新品牌资料用于以后的新创作。' : '系统整理参考资料后，会给出三个可选方向。', locked ? link(`/campaigns/${c.id}/cards`, '继续选创意 '+icon('arrow-right'), 'button') : `<button type="submit" class="button" ${c.archived ? 'disabled' : ''}>继续选创意 ${icon('arrow-right')}</button>`)}</form><aside class="maker-product-assets"><div class="section-title"><div><h2>产品素材</h2><p class="muted">规划画面时会看到这些图片。</p></div><span>可选</span></div><div class="maker-image-grid">${assets.map(a => `<figure>${image(a)}<figcaption>${esc(a.name)}</figcaption></figure>`).join('') || '<div class="maker-image-empty">'+icon('image')+'<strong>还没有产品图</strong><p>上传包装、产品细节或使用场景图，画面规划会更直观。</p></div>'}</div>${!c.archived ? `<label class="maker-upload">${icon('upload')}添加产品图<input class="settings-asset-import" data-brand="${brand.id}" type="file" accept="image/png,image/jpeg,image/webp" aria-label="添加产品图"><small>PNG / JPG / WebP，单张最多 5 MB</small></label>` : ''}${coach('没有图片也可以先看脚本', '图片保存在本机，制作时作为静态产品层加入每个镜头。AI 仅生成背景，不重画商品，也不支持实物交互动作。')}</aside></div>`;
}

export function creativeName(card) {
  const hook = card.creativeRoute.hook || '';
  if (/特写|纹理|细节|结构/.test(hook)) return '产品细节展示';
  if (/穿上|用户|人物|体验|过程|准备/.test(hook)) return '使用过程展示';
  return '场景演示';
}
export function renderCreativeChoices(data, c, selectedId) {
  const cards = opportunityCards(data,c);
  const selected = cards.find(card => card.id === selectedId) || cards.find(card => card.status === 'adopted') || cards[0];
  if(c.replay)return renderWalkthroughCreative(c,selected,data);
  const brief = find(data, 'briefs', c.briefId), brand = find(data, 'brands', c.brandId), product = brief.product;
  const photo = productImage(data, c.brandId, selected?.productDossier ? find(data, 'snapshots', c.brandSnapshotId)?.assetIds : undefined), plan = selected && creativePresentation(selected, product);
  const times = sceneTiming(15);
  const nextAction = selected ? selected.status === 'adopted'
    ? link(`/campaigns/${c.id}/create?cardId=${selected.id}&cardVersion=${selected.version}`, '按这份提案安排镜头 '+icon('arrow-right'), 'button')
    : `<button class="button" data-action="adopt" data-id="${selected.id}" ${c.archived ? 'disabled' : ''}>确认提案，安排镜头 ${icon('arrow-right')}</button>`
    : '';
  return `<section class="direction-page">
    <div class="direction-product">
      <div class="direction-brand-mark">${esc(brand.name.slice(0,1))}</div>
      <div><small>${esc(brand.name)} · 本次推广</small><strong>${esc(product)}</strong></div>
      ${photo ? `<span class="direction-product-ready">${icon('image')}已带入产品图</span>` : link(`/campaigns/${c.id}/discover?view=setup`, icon('plus')+'添加产品图', 'text-button')}
    </div>
    <header class="direction-heading"><div><span class="direction-eyebrow">03 / CREATIVE DIRECTION</span><h1 lang="en">Choose your Campaign Card.</h1><p>Campaign Card 是这次广告的创意提案：给谁看、讲什么、验证什么。选中后会带入脚本与模拟测试。</p></div><span class="direction-count">${cards.length} 个可选提案</span></header>
    <div class="direction-section-label">${link(`/campaigns/${c.id}/discover?view=opportunities`,icon('arrow-left')+'回看产品与市场机会','text-button')}<small>这是脚本提案，尚未生成画面</small></div>
    <div class="direction-workbench">
      <div class="direction-options">
        <div class="direction-grid" role="group" aria-label="选择广告提案">
          ${cards.map((card, index) => {
            const item = creativePresentation(card, product), chosen = selected?.id === card.id, decision=advertisingDecision(data,c,card);
            return `<article class="direction-card ${chosen ? 'selected' : ''}">
              <button type="button" class="direction-pick" aria-pressed="${chosen}" aria-label="选择提案：${esc(decision.name)}" data-action="pick-creative" data-id="${card.id}" ${c.archived ? 'disabled' : ''}>
                <div class="direction-proposal"><span>提案 0${index+1} · ${esc(decision.sources.length?'有公开文案参考':'产品资料推导')}</span><span class="direction-indicator">${icon(chosen ? 'check' : 'plus')}</span></div>
                <div class="direction-card-body"><h2>${esc(decision.name)}</h2><p>${esc(item.description)}</p><dl class="proposal-decision"><div><dt>给谁看${decision.audienceSuggested?' · 建议人群':''}</dt><dd>${esc(decision.audience)}</dd></div><div><dt>这次要验证</dt><dd>${esc(decision.hypothesis)}</dd></div></dl>
                  <div class="direction-shot-strip">${item.shots.map((title, i) => `<span><b>0${i+1}</b>${esc(title)}</span>`).join('')}</div>
                  <span class="direction-select-label">${chosen ? icon('circle-check')+'当前选择' : '选择这个方向 '+icon('arrow-up-right')}</span>
                </div>
              </button>
              <details class="direction-rationale"><summary>为什么值得尝试？</summary><p>${esc(decision.rationale)}</p><p>观众先看到：${esc(item.scenes[0])}</p><small>${esc(decision.scope)}</small>${link(`/campaigns/${c.id}/cards/${card.id}`, '查看完整方案与依据', 'text-button')}</details>
            </article>`;
          }).join('')}
        </div>
        <div class="direction-materials">
          ${photo ? `<img src="/api/brand-assets/${photo.id}/preview" alt="${esc(photo.name)}"><div><strong>你的产品素材</strong><p>${esc(photo.name)}</p><small>下一步可选原图合成，或用官网公开产品图参考生成完整场景。</small></div>` : `<span class="direction-material-icon">${icon('image')}</span><div><strong>产品图片可以在下一步补充</strong><p>先选表达方向。制作前需要一张真实产品图。</p></div>`}
          ${link(`/campaigns/${c.id}/discover?view=setup`, photo ? '管理产品素材' : '添加产品图', 'text-button')}
        </div>
      </div>
      ${plan ? `<aside class="direction-preview" aria-label="当前广告提案与验证目标">
        ${renderDecisionPanel(data,c,selected)}<details class="decision-scenes"><summary>这个提案怎样落实到镜头？</summary>
        <ol class="proposal-scenes">${plan.scenes.map((text,i)=>`<li><span>0${i+1}</span><div><strong>${esc(plan.shots[i])}</strong><small>${times[i].start}–${times[i].end} 秒</small><p>${esc(text)}</p></div></li>`).join('')}</ol>
        </details>${selected.advertisingPlan?`<details class="decision-scenes"><summary>本条广告的制作方案与素材分工</summary>${renderAdvertisingPlan(selected)}</details>`:''}<p class="direction-preview-note">${icon('clapperboard')}确定提案后，围绕同一个目标安排镜头、验收成片。</p>
      </aside>` : '<div class="direction-no-options"><h2>还没有可选方向</h2><p>先确认产品资料，再整理创意。</p></div>'}
    </div>
    <div class="direction-next">
      <div>${link(`/campaigns/${c.id}/discover?view=opportunities`, icon('arrow-left')+'返回机会', 'text-button')}<span><strong>${selected ? `已选提案：${esc(advertisingDecision(data,c,selected).name)}` : '先选择一个提案'}</strong><small>接下来：把提案落实到三个镜头。参考视频可选。</small></span></div>
      ${nextAction}
    </div>
    <details class="direction-more"><summary>参考来源与其他操作</summary><p>${c.mode === 'guided_demo' ? '演示创作使用示例品牌资料，没有真实市场广告证据。' : '创意依据与公开参考保留在这里，真实广告效果需要后续验证。'}</p><div class="actions">${link(`/campaigns/${c.id}/discover?view=signals&section=samples`, '查看参考来源', 'text-button')}${!c.replay?`<button class="button secondary" data-action="refresh-cards" data-id="${c.id}" ${c.archived ? 'disabled' : ''}>重新整理创意</button>${link(`/campaigns/${c.id}/discover?view=intent`, '调整本轮目标', 'text-button')}`:''}</div></details>
  </section>`;
}

export function renderTemplateBreakdown(template) {
  if(!template || template.status!=='ready')return '';
  return `<div class="template-breakdown" aria-label="参考视频拆镜结果"><strong>${esc(template.filename)} · ${Number(template.duration).toFixed(1)} 秒 / ${template.scenes.length} 个镜头</strong><div>${template.scenes.map(s=>`<figure><img loading="lazy" src="/api/video-templates/${template.id}/keyframes/${s.index}" alt="参考视频第 ${s.index+1} 镜关键帧"><figcaption><b>镜头 ${s.index+1}</b><span>${Number(s.start).toFixed(1)}–${Number(s.end).toFixed(1)} 秒</span></figcaption></figure>`).join('')}</div></div>`;
}

export function renderStudio({ data, c, card, pack, angle, angles, config, draft, selectedAssets, selectedTemplateId, templates, activeJob, selectedScene = 0 }) {
  if(c.replay)return renderWalkthroughStudio({c,card,pack,angle,activeJob});
  const fields = sceneFields(card, angle, config, draft), times = sceneTiming(fields.duration);
  const referenceMode = (draft?.productTreatment || config?.productTreatment) === 'product_reference';
  const sceneLabels = card.advertisingPlan ? ['引起注意', '补充情境', '真实产品收尾'] : ['开场吸引', '展示产品', '品牌收尾'];
  const assets = data.brandAssets.filter(a => a.brandId === c.brandId && a.status === 'ready');
  const photo = productImage(data, c.brandId, [...selectedAssets]);
  const path = `/campaigns/${c.id}/create?cardId=${card.id}&cardVersion=${card.version}&angleId=${angle.id}`;
  const ready = templates.filter(t => t.status === 'ready'), latest = templates[0];
  const previousRequest=(data.generationRequests||[]).filter(r=>r.workflow==='shot_pipeline'&&r.configId===config?.id).at(-1);
  const sceneMedia=index=>{
    const shot=previousRequest?.production.shots[index];
    if(shot?.technical||shot?.keyframe?.sha256)return `<div class="script-existing-media">${shot.technical?`<video controls playsinline preload="metadata" src="/api/productions/${previousRequest.id}/shots/${index}/preview?version=${shot.version}"></video>`:`<img src="/api/productions/${previousRequest.id}/shots/${index}/keyframe?shotVersion=${shot.version}&version=${shot.keyframe.version}" alt="已有镜头图片">`}<p>已有${shot.technical?'视频':'图片'} · 修改脚本不会改变已生成的画面</p>${link(`${path}&view=results&productionId=${previousRequest.id}`,'回到这轮制作','text-button')}</div>`;
    return `<div class="script-placeholder">${icon('image')}<div><strong>这个镜头还没有生成画面</strong><p>先确认下面的场景描述，制作时会生成图片供你检查。</p></div></div>`;
  };
  return `${head('04 / CREATIVE STUDIO', 'Storyboard', '选择左侧镜头，调整画面内容。确认脚本后，再生成第一张画面。')}
    ${card.advertisingPlan ? `<details class="maker-advanced"><summary>查看本条广告的制作方案与素材分工</summary>${renderAdvertisingPlan(card)}</details>` : ''}
  <form id="config-form" class="script-workspace" data-package="${pack.id}" data-angle="${angle.id}">
    <nav class="script-rail" aria-label="选择要编辑的镜头"><h2 lang="en">Shot List</h2>${sceneFieldNames.map((name,i)=>`<button type="button" data-action="edit-scene" data-index="${i}" aria-pressed="${selectedScene===i}"><span>0${i+1}</span><div><strong>${sceneLabels[i]}</strong><small data-scene-time="${i}">${times[i].start}–${times[i].end} 秒</small><small>${i===2?'原始产品图 + 文案':referenceMode?'商品参考 + 场景生成':'产品原图 + AI 背景'}</small></div></button>`).join('')}<p>先确认第一张画面<br>再检查视频<br>最后合成整条广告</p></nav>
    <div class="script-main"><div class="maker-editor-toolbar"><span>${icon('clapperboard')}镜头脚本</span><label>开场方式<select name="angleChoice" data-angle-choice>${angles.map(a=>`<option value="${a.id}" ${a.id===angle.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select></label></div>
    ${sceneFieldNames.map((name,i)=>`<section class="script-scene" data-script-scene="${i}" ${selectedScene===i?'':'hidden'}><header><span class="maker-kicker" lang="en">SHOT 0${i+1}</span><h2>${['Hook · 吸引注意','Product Proof · 展示产品','CTA · 行动引导'][i]}</h2></header>${i===2?`<div class="script-endcard">${image(photo)}<div><strong>使用原始产品图收尾</strong><p>品牌文字和行动引导会在本地排版。请在右侧确认产品图片。</p></div></div><input type="hidden" name="${name}" value="${esc(fields[name])}">`:`${sceneMedia(i)}${field('这幕要表达什么？',name,fields[name],referenceMode?'根据所选官网产品图生成商品与场景。描述构图、环境与光线，先避免手持、开盖等复杂动作。':'当前采用静态产品原图 + AI 背景。描述环境、光线和氛围，不支持手持、开盖等实物动作。',true)}${renderShotDirectionEditor(shotDirectionFromFields(fields,name),name,{localProduct:!referenceMode})}`}</section>`).join('')}
    <details class="maker-advanced"><summary>这条广告的创意依据</summary><p>${esc(card.testHypothesis)}</p>${link(`/campaigns/${c.id}/cards/${card.id}`,'查看完整方案','text-button')}</details></div>
    <aside class="script-settings"><h2 lang="en">Output Settings</h2><div class="two-col">${select('尺寸','ratio',fields.ratio,[['9:16','竖屏 · 9:16'],['1:1','方形 · 1:1'],['16:9','横屏 · 16:9']])}${select('时长','duration',fields.duration,[['15','15 秒'],['30','30 秒']])}</div>
    ${select('描述语言','language',fields.language,[['中文','中文'],['English','English']])}
    <section class="product-generation-mode"><h3>怎样呈现商品</h3>${select('商品画面','productTreatment',referenceMode?'product_reference':'local_product_overlay',[['local_product_overlay','本地原图 + 生成背景'],['product_reference','官网产品图参考生成 · 试验']])}<p class="help">参考生成会把商品与场景一起生成，需检查外形细节；本地合成保持原图，商品不动。</p><label class="production-check"><input type="checkbox" name="publicReferenceConsent" ${config?.publicReferenceConsent?.granted?'checked':''}>使用参考生成时，允许将所选官网公开产品图及必要场景描述发送给 YouMind。</label><small>仅点击开始生成后发送。不会发送项目文档或本地上传图片；生成可能消耗额度。</small></section>
    <details class="maker-advanced" open><summary>产品图片 <span>${photo?'已选择':'生成前需补充'}</span></summary><div class="maker-asset-picks">${assets.map(a=>`<button type="button" aria-pressed="${selectedAssets.has(a.id)}" class="${selectedAssets.has(a.id)?'selected':''}" data-action="toggle-brand-asset" data-package="${pack.id}" data-id="${a.id}">${image(a)}<span>${esc(a.name)}</span>${selectedAssets.has(a.id)?icon('check'):''}</button>`).join('')||'<p class="help">先添加一张真实产品图，用于每个镜头的本地合成。</p>'}<label class="maker-upload">${icon('plus')}添加产品图<input id="brand-asset-import" data-brand="${c.brandId}" data-package="${pack.id}" type="file" accept="image/png,image/jpeg,image/webp" aria-label="添加本次产品图片" ${c.archived?'disabled':''}></label></div></details>
    <details class="maker-advanced"><summary>字幕与声音</summary><label>开场标题<input name="copyOpening" maxlength="70" value="${esc(fields.copyOpening)}" placeholder="${esc(find(data,'briefs',c.briefId).product)}"><small>留空使用产品名称。</small></label><label>第二幕标题 · 可选<input name="copyDetail" maxlength="70" value="${esc(fields.copyDetail)}"></label><label>收尾引导<input name="copyCta" maxlength="24" value="${esc(fields.copyCta)}" placeholder="了解产品"></label>${select('声音','music',fields.music,[['ambient','轻配乐 · 无旁白'],['none','无声']])}</details>
    <section class="template-workspace"><span class="opportunity-label">REFERENCE VIDEO / 可选</span><h3>拆开参考视频，看清镜头节奏。</h3><p class="help">上传后在本机识别切镜位置、时长和代表画面。当前不会自动理解或复制原片的美术风格。</p><label class="maker-upload">${icon('video')}上传参考视频<input id="template-video-import" data-package="${pack.id}" data-angle="${angle.id}" type="file" accept="video/mp4,video/webm" aria-label="上传参考视频" ${latest?.status==='analyzing'||c.archived?'disabled':''}></label>${latest?.status==='analyzing'?'<p role="status">正在拆分镜头、提取关键帧…</p>':latest?.status==='failed'?'<p role="alert">分析未完成，可更换视频重试。</p>':''}${ready.length?select('参考视频','templateId',draft?.templateId??selectedTemplateId,[['','不使用参考视频'],...ready.map(t=>[t.id,`${esc(t.filename)} · ${t.sceneCount} 个镜头`])]):'<input type="hidden" name="templateId" value="">'}${renderTemplateBreakdown(ready.find(t=>t.id===(draft?.templateId??selectedTemplateId)) || ready[0])}<p class="help">不上传也可以继续。拆镜结果供你核对节奏，镜头脚本仍由上方内容决定。</p></section><details class="maker-advanced"><summary>其他要求</summary><label>补充要求<textarea name="notes" maxlength="2000" rows="3">${esc(fields.notes)}</textarea></label></details></aside>
    ${stepFooter(link(`/campaigns/${c.id}/cards`,'返回创意','text-button'),'确认脚本，进入制作','此步仅保存脚本。下一页由你开始生成画面。',`<button class="button" type="submit" data-mode="storyboard" ${c.archived||activeJob?'disabled':''}>${activeJob?'制作进行中':'保存并继续'} ${icon('arrow-right')}</button>`)}
  </form><p class="maker-footnote">${link(`${path}&view=results`,'查看已有制作','text-button')}草稿自动保存在当前浏览器。</p>`;
}

export function renderResults({ data, c, card, pack, angle, config, assets, activeJob, blockedJob, jobs, jobRow }) {
  if(c.replay)return renderWalkthroughResults({c,card,angle,config,assets,activeJob});
  const path = `/campaigns/${c.id}/create?cardId=${card.id}&cardVersion=${card.version}&angleId=${angle.id}`;
  const currentAssets = config ? assets.filter(a => a.configId === config.id) : assets;
  const latestVideo=currentAssets.find(a=>a.type==='video'),story=currentAssets.find(a=>a.type==='storyboard');
  const storyConfig=story&&find(data,'configs',story.configId),photo=productImage(data,c.brandId,storyConfig?.brandAssetIds);
  const times=sceneTiming(storyConfig?.duration||config?.duration||15),failed=!activeJob&&jobs[0]?.status==='failed'?jobs[0]:null;
  const referenceMode=storyConfig?.productTreatment==='product_reference';
  const planChecks=story&&storyConfig?reviewProductionPlan({...productionPlan({config:{...storyConfig,scenePlan:story.scenes}}),productTreatment:storyConfig.productTreatment||'local_product_overlay'},storyConfig):null;
  const unavailable=activeJob||blockedJob||c.archived||!photo||planChecks?.valid===false;
  const plan=story?`<section class="plan-ready"><header><div><span class="maker-kicker">脚本已保存</span><h2>${referenceMode?'先确认商品在场景中的第一张画面':'从第一张产品合成图开始制作'}</h2><p>${referenceMode?'将已授权的官网产品图与本条广告的场景要求一起提交。先检查外形、颜色、细节与创意是否相符，再生成视频。':'AI 先生成背景，本机加入真实产品原图。确认排版后再制作背景视频；产品保持静态，不演示手持、开盖等动作。'}已完成的画面保留。</p></div><button class="button" data-action="video" data-id="${story.configId}" data-angle="${angle.id}" ${unavailable?'disabled':''}>${icon('image-plus')}生成第一张画面</button></header>
    ${!photo?`<div class="maker-recovery"><p>还需要一张真实产品图，用于每个镜头的本地合成。</p>${link(`${path}&view=setup`,'添加产品图','button secondary')}</div>`:''}
    ${renderPlanChecks(planChecks,`${path}&view=setup`)}
    <div class="plan-scenes">${story.scenes.map((scene,i)=>`<article><header><span>镜头 0${i+1}</span><small>${times[i].start}–${times[i].end} 秒</small></header><h3>${esc(scene.title)}</h3><span class="plan-kind">${i===2?'原始产品图收尾':referenceMode?'待制作 · 商品参考场景':'待制作 · 产品原图 + AI 背景'}</span><p>${esc(scene.text)}</p>${renderShotDirectionSummary(scene.direction)}</article>`).join('')}</div>
    <div class="plan-product">${photo?image(photo):''}<div><strong>成片设置</strong><p>${esc(storyConfig?.ratio||'9:16')} · ${storyConfig?.duration||15} 秒 · ${storyConfig?.music==='none'?'无声':'轻配乐，无旁白'}</p><small>${referenceMode?'官网公开产品图经授权作为生成参考；画面须经你确认后才进入视频制作。':'真实产品原图只在本机合成，AI 不重画商品；背景视频在外部服务生成。'}</small></div>${link(`${path}&view=setup`,icon('pencil')+'修改脚本与设置','text-button')}</div></section>`:'';
  return `${head('04 / CREATIVE STUDIO',latestVideo?'Your creative is ready.':story?'Production Studio':'Preparing your studio…',latestVideo?'视频已准备好。检查完整视频，再决定导出或继续模拟测试。':story?'脚本已就绪，开始制作画面。先图片，后视频；每一步都可以检查和修改。':'先保存镜头脚本，再开始制作画面；每一步都可以检查和修改。')}
    ${activeJob?`<section class="maker-processing" role="status"><span>${icon('loader-circle')}</span><div><h2>${activeJob.type==='video'?'正在制作视频':'正在保存镜头脚本'}</h2><p>完成后自动更新，可以稍后继续。</p>${jobRow(activeJob)}</div></section>`:''}
    ${failed?`<div class="maker-recovery" role="alert"><div><strong>这一步未完成，脚本仍然保留</strong><p>${esc(failed.error?.message||'可以重试，或返回调整脚本。')}</p></div><button class="button secondary" data-action="retry" data-id="${failed.id}">重试这一步</button></div>`:''}
    ${latestVideo?`<div class="maker-video-result"><div><video controls playsinline preload="metadata" src="/api/assets/${latestVideo.id}/preview"></video></div><aside><span class="maker-kicker">已保存的视频</span><h2>${esc(creativeName(card))}</h2><p>${latestVideo.source==='user_import'?'导入的视频已保存在本机。':'视频已保存在本机。'}</p><a class="button wide" href="/api/assets/${latestVideo.id}/download" download>${icon('download')}下载视频</a>${latestVideo.status==='launch_ready'?link(`/campaigns/${c.id}/launch`,'继续模拟测试','button secondary wide'):`<button class="button secondary wide" data-action="launch-ready" data-id="${latestVideo.id}" ${c.archived?'disabled':''}>检查并进入模拟测试</button>`}<p class="help">模拟测试不会发布真实广告。</p>${link(`${path}&view=setup`,'修改脚本，再做一版','text-button')}</aside></div>`:plan}
    ${story&&!latestVideo?`<details class="maker-advanced"><summary>已有成片？直接导入</summary><p class="help">导入已完成的视频，继续预览和模拟测试。</p><label class="maker-upload">${icon('upload')}选择视频<input id="video-import" type="file" accept="video/mp4,video/webm" data-package="${pack.id}" data-angle="${angle.id}" data-config="${story.configId}" aria-label="导入已有视频" ${activeJob||blockedJob||c.archived?'disabled':''}></label><p class="help">MP4 / WebM · 最多 20 MB</p></details>`:''}
    ${!story&&!activeJob&&!latestVideo?`<div class="maker-recovery"><p>还没有已保存的脚本。</p>${link(`${path}&view=setup`,'返回编辑脚本','button')}</div>`:''}
    <details class="maker-advanced"><summary>历史结果与任务记录</summary><div class="maker-history">${assets.map(a=>`<a href="/api/assets/${a.id}/download" download>${a.type==='video'?'视频':'脚本'} v${a.version} · 下载</a>`).join('')}</div>${jobs.slice(0,5).map(jobRow).join('')}</details>`;
}
