import { initializeApi, readApiState, sendApiCommand, waitForJob, readDemoCase } from './api-client.js';
import { renderDemoEntry, renderDemoCase } from './demo-flow.js';
import { renderWalkthroughStart, walkthroughNotice } from './walkthrough-flow.js';
import { distinctValues, isBrandRelevantMetaSample, recoverCampaignRoute } from './preview-logic.js';
import { prepareCreativeOptions, saveGenerationConfig, simulatePlan } from './flow-actions.js';
import { createDraftStore, renderCreatorHome, renderProductStart, renderProductReview, renderCreativeChoices, renderStudio, renderResults, sceneFields, sceneFieldNames } from './creator-flow.js';
import { sceneTiming } from '../../../packages/domain/src/scene-script.js';
import { renderProduction, videoRecoveryButton } from './production-flow.js';
import { productDraftEdits } from './product-import-flow.js';
import { shotDirectionFromFields } from '../../../packages/domain/src/shot-direction.js';
import { renderOpportunityBrief, renderStrategyAnchor, renderReferenceMedia } from './opportunity-flow.js';
let creatorDrafts;
const creatorChoices = new Map();
const scriptScenes = new Map(), productionScenes = new Map();
let data = null, drawer = false, busy = false, dirty = false;
let demoCase = null;
let renderedRoute = null;
let newCampaignSource = 'website', newCampaignUrl = '', selectedBrandId = null;
let newCampaignDraft = { name: '', objective: '让用户更快理解产品卖点', product: '' };
const preparingCampaigns = new Set();
const watchedJobs = new Set();
let newCampaignContext = null;
let focusSignals = new Set(['竞品动作','用户语言']);
const discoveryRunning = new Set(), compareByCampaign = new Map(), routeStates = new Map(), brandAssetSelections = new Map(), templateSelections = new Map();
let routeRecoveryMessage = '';
const currentRoute = () => (location.hash.slice(1) || '/home');
const currentPath = () => currentRoute().split('?')[0];
let activeRoute = currentRoute();
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const primaryNav = [['home','/home','house','Workspace'],['new','/campaigns/new','plus','Create'],['library','/library','film','Library'],['settings','/settings','briefcase-business','Brand Hub']];
const date = value => new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const labels = { draft: '草稿', discovering: '发现中', cards_ready: '待选策略', creating: '创作中', launch_ready: '待投放', learning: '学习中', closed: '已归档', candidate: '待审阅', reviewed: '已审阅', adopted: '已采纳', dismissed: '已略过', superseded: '历史版本', ready: '可预览', generating: '生成中', queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', prepared: '已准备', mapped: '已映射', observing: '观察中', completed: '已完成', disconnected: '已断开', connected: '已连接' };
const auditLabels = { product_import_completed:'读取了产品页资料',product_import_skipped:'切换为手动填写产品资料', campaign_created:'创建了 Campaign',brand_confirmed:'确认了品牌背景',brand_confirmation_skipped:'暂时跳过品牌确认',brand_updated:'更新了品牌信息',brand_asset_added:'添加了品牌素材',brand_asset_record_removed:'删除了品牌素材',brand_memory_reset:'重置了长期品牌记忆',brand_memory_removed:'删除了一条品牌记忆',brand_data_removed:'清理了品牌及关联数据',brief_updated:'更新了本轮意图',discovery_started:'开始市场发现',cards_generated:'生成了 Campaign Cards',card_adopted:'采纳了 Campaign Card',card_feedback:'更新了 Card 反馈',video_template_imported:'导入了参考模板',video_template_analyzed:'完成了模板镜头分析',generation_config_created:'保存了生成配置',job_created:'创建了后台任务',storyboard_created:'生成了分镜',video_asset_created:'生成了视频素材',asset_downloaded:'下载了素材',asset_launch_ready:'确认素材可用于投放',campaign_archived:'归档了 Campaign',workspace_cleared:'清理了本地工作空间' };
const evidenceLabels = { brand_context: '品牌自述 · 非市场验证', public_sample: '公开样本 · 效果未验证', unverified: '无匹配证据 · 待验证' };
const pill = (status, text) => `<span class="pill ${['ready','succeeded','adopted','launch_ready','prepared','mapped'].includes(status) ? 'green' : status==='failed' ? 'red' : ''}">${esc(text || labels[status] || status)}</span>`;
const link = (href, text, cls = '') => `<a href="#${href}" data-nav class="${cls}">${text}</a>`;
const creativeFormats = {
  VIDEO: { label:'短视频', mark:'▶', purpose:'用动作或使用过程快速解释产品', variable:'开场 3 秒、动作顺序与证明节奏' },
  IMAGE: { label:'单图', mark:'▧', purpose:'用一个画面集中表达单一卖点', variable:'主视觉、标题与行动按钮的组合' },
  CAROUSEL: { label:'轮播', mark:'▥', purpose:'用连续卡片展开步骤、对比或变化', variable:'卡片顺序与每一屏的信息密度' },
  DPA: { label:'商品组', mark:'▦', purpose:'用多个具体商品承接兴趣并缩短选择路径', variable:'首个商品、价格信息与产品组合顺序' },
  DCO: { label:'动态组合', mark:'◫', purpose:'让平台组合产品信息、标题与行动按钮', variable:'可用文案组件与商品信息完整度' },
  UNKNOWN: { label:'其他形式', mark:'◇', purpose:'观察卖点、证明和行动引导如何组合', variable:'开场表达、证明方式与行动按钮' }
};
const signalLead = value => {
  const text=String(value||'').trim(),match=text.match(/^.*?[。！？!?](?:\s|$)/);
  return (match?.[0]||text||'暂未提取到可展示的广告文案').slice(0,96);
};
const readableDiscoveryLimit = value => {
  const text=String(value||'');
  if(text.includes('品牌官网采集未完成'))return '品牌官网暂未采集到可用内容，本轮不会把官网信息当作市场证据。';
  if(text.includes('Meta 当前使用结构化演示样本'))return '以下为演示样本，只用于验证分析流程，不能作为真实市场结论。';
  if(text.includes('公开页面采集未启用或未成功'))return 'Meta 公开页面暂未采集成功，当前先用演示样本展示产品流程。';
  return text.replace(/：?[A-Z_]+(?::[^\s]+)?$/,'。');
};
const explainCreative = (body,format) => {
  if(/还在|日常问题/.test(body))return '先说出用户遇到的麻烦，再展示产品如何解决。';
  if(/先看产品|如何工作/.test(body))return '先演示产品怎么用，再邀请用户判断是否适合。';
  if(/一个细节|更顺手/.test(body))return '放大一个产品细节，把抽象卖点变成具体体验。';
  if(/抽象卖点|三秒/.test(body))return '直接展示关键产品动作，让卖点更快被理解。';
  if(/真实用户|形成习惯/.test(body))return '用用户从尝试到形成习惯的过程讲完整故事。';
  if(/同样的场景|不同的处理/.test(body))return '通过场景对比，让用户看见不同处理方式的差别。';
  return creativeFormats[format]?.purpose||creativeFormats.UNKNOWN.purpose;
};
function creativeSignalCard(signal,index,product='当前产品') {
  const attributes=signal.attributes||{},formatKey=creativeFormats[attributes.displayFormat]?attributes.displayFormat:'UNKNOWN',format=creativeFormats[formatKey];
  const advertiser=attributes.advertiserName||(signal.type==='品牌事实'?'品牌官网':'公开来源');
  const body=signalLead(attributes.bodyText||signal.summary),headline=attributes.title||signal.title||`${format.label}样本`;
  const period=attributes.startDate?`${attributes.startDate} — ${attributes.endDate||'仍在观察'}`:'未记录投放时间',explanation=explainCreative(body,formatKey);
  const visual=renderReferenceMedia({id:signal.evidenceId,sourceType:signal.sourceType,available:signal.status==='available',attributes});
  return `<article class="creative-sample-card format-${formatKey.toLowerCase()}"><div class="sample-heading"><span>样本 ${String(index+1).padStart(2,'0')} · ${esc(format.label)}</span>${pill(signal.status,signal.status==='available'?'公开样本':signal.status==='demo'?'演示样本':'覆盖有限')}</div>${visual}<blockquote><small>采集到的广告文案</small><strong>${esc(body)}</strong></blockquote><div class="sample-takeaway"><div><span>可参考的表达方式 · 非画面分析</span><strong>${esc(explanation)}</strong></div><div><span>放到本轮可以怎么试</span><strong>保留这种表达顺序，换成「${esc(product)}」的真实使用场景。</strong><small>是否有效仍需用素材和投放验证。</small></div></div><details><summary>查看来源与原始字段</summary><dl><div><dt>原始标题</dt><dd>${esc(headline)}</dd></div><div><dt>广告主</dt><dd>${esc(advertiser)}</dd></div><div><dt>投放时间</dt><dd>${esc(period)}</dd></div><div><dt>行动按钮</dt><dd>${esc(attributes.cta||'未提取')}</dd></div><div><dt>落地页</dt><dd>${esc(attributes.landingDomain||'未提取')}</dd></div><div><dt>观察时间</dt><dd>${esc(signal.time)}</dd></div><div><dt>证据边界</dt><dd>${esc(signal.relevance)}</dd></div></dl>${signal.url&&signal.url.startsWith('http')?`<a href="${esc(signal.url)}" target="_blank" rel="noreferrer">打开公开来源 ↗</a>`:''}</details></article>`;
}
function opportunityTestCard(op,index,displaySignals) {
  const sampleRefs=(op.signalIds||[]).map(id=>displaySignals.findIndex(signal=>signal.id===id)).filter(position=>position>=0).map(position=>`样本 #${position+1}`);
  const evidence=op.basis==='brand_context'?'已确认品牌背景':sampleRefs.length?sampleRefs.join('、'):'暂无直接样本';
  return `<article class="opportunity-item"><div class="test-card-heading"><span>${String(index+1).padStart(2,'0')}</span>${pill(op.basis==='unverified'?'draft':'ready',evidence)}</div><h3>${esc(op.title)}</h3><div class="test-question"><span>要回答的问题</span><strong>${esc(op.testQuestion||op.hypothesis)}</strong></div><div class="test-versions"><div><small>A · 基准版</small><p>${esc((op.control||'保持当前通用产品介绍。').replace(/^A\s*基准版[：:]\s*/,''))}</p></div><div class="test-variant"><small>B · 测试版</small><p>${esc((op.variant||op.hook).replace(/^B\s*测试版[：:]\s*/,''))}</p></div></div><dl><div><dt>其他条件保持不变</dt><dd>${esc(op.constant||'受众、产品、优惠与行动按钮保持一致。')}</dd></div><div><dt>看什么结果</dt><dd>${esc(op.successSignal||'在投放计划中确认主要观察指标。')}</dd></div></dl><details class="test-rationale"><summary>为什么建议这个测试</summary><p>${esc(op.summary)}</p></details></article>`;
}
const byId = (collection, id) => data[collection].find(x => x.id === id);
const forCampaign = (collection, c) => data[collection].filter(x => x.campaignId === c.id);
const comparedCards = campaignId => compareByCampaign.get(campaignId) || [];
function toast(message, error = false) { const t = $('#toast'); t.textContent = message; t.className = error ? 'visible error' : 'visible'; clearTimeout(toast.timer); toast.timer = setTimeout(() => t.className = '', 5000); }
function confirmAction(message, title = '确认操作') {
  $('#confirm-title').textContent = title; $('#confirm-message').textContent = message;
  const dialog = $('#confirm-dialog'); dialog.showModal();
  return new Promise(resolve => { $('#confirm-yes').onclick = () => { dialog.close(); resolve(true); }; $('#confirm-no').onclick = () => { dialog.close(); resolve(false); }; dialog.oncancel = () => resolve(false); });
}
async function refreshState({ preserveScroll = true } = {}) {
  const y = window.scrollY;
  data = await readApiState();
  if (preserveScroll) requestAnimationFrame(() => window.scrollTo(0, y));
  return data;
}
async function command(action, resourceId, fields = {}) {
  const result = await sendApiCommand(action, resourceId, fields);
  await refreshState();
  return result || {};
}
async function navigate(path) {
  if (dirty && !await confirmAction('当前编辑尚未保存，确定离开吗？', '保留当前编辑？')) return;
  const target=path.replace(/^#/,'');
  routeStates.set(activeRoute,{scrollY:window.scrollY});
  dirty = false; drawer=false; routeRecoveryMessage=''; history.pushState({}, '', '#'+target); activeRoute=target; render();
  const saved=routeStates.get(target);requestAnimationFrame(()=>window.scrollTo(0,saved?.scrollY||0));
}
function resume(c) {
  if(c.status==='discovering'||forCampaign('jobs',c).some(j=>['discovery','cards'].includes(j.type)&&['queued','running'].includes(j.status)))return `/campaigns/${c.id}/discover?view=preparing`;
  if(c.status==='creating'){
    const request=forCampaign('generationRequests',c).at(-1),asset=forCampaign('assets',c).at(-1),config=byId('configs',asset?.configId||request?.configId),pack=byId('packages',config?.packageId);
    if(pack&&config)return `/campaigns/${c.id}/create?cardId=${pack.cardId}&cardVersion=${pack.cardVersion}&angleId=${config.angleId}&view=results`;
  }
  return c.status==='cards_ready'?`/campaigns/${c.id}/discover?view=opportunities`:`/campaigns/${c.id}/${({ draft:'discover',creating:'create',launch_ready:'launch',learning:'learn',closed:'learn' })[c.status]||'discover'}`;
}
function heading(kicker, title, subtitle, action = '') { return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`; }
function empty(title, text, action = '') { return `<div class="empty-state"><span class="empty-icon">◇</span><h3>${title}</h3><p>${text}</p>${action}</div>`; }
function normalizeRoute() {
  const result=recoverCampaignRoute(currentRoute(),data.campaigns);
  if(!result.recovered)return currentPath();
  history.replaceState({},'',`#${result.route}`);activeRoute=result.route;
  routeRecoveryMessage=result.target?`原链接中的 Campaign 已不存在，已恢复到当前唯一的 Campaign「${result.target.name}」。`:'原链接中的 Campaign 已不存在，已返回 Campaign 中心。';
  return result.route.split('?')[0];
}
function field(label, name, value = '', options = {}) {
  if (options.select) return `<label>${label}<select name="${name}">${options.select.map(v => `<option${v===value?' selected':''}>${esc(v)}</option>`).join('')}</select></label>`;
  return `<label>${label}${options.area ? `<textarea name="${name}" rows="3" maxlength="2000">${esc(value)}</textarea>` : `<input name="${name}" value="${esc(value)}" type="${options.type||'text'}" ${options.required?'required':''} maxlength="2000" placeholder="${esc(options.placeholder||'')}">`}</label>`;
}
function filterOptions(allLabel, values, selected) {
  return `<option value="all">${allLabel}</option>${values.map(value=>`<option value="${esc(value)}" ${selected===value?'selected':''}>${esc(value)}</option>`).join('')}`;
}
function render({preserveEdits=false}={}) {
  const editableSelector='#content input:not([type=file]),#content textarea,#content select';
  const editKey=el=>{const f=el.closest('form');return JSON.stringify([f?.id,f?.className,f?.dataset.request,f?.dataset.index,f?.dataset.version,f?.dataset.angle,f?.dataset.campaign,el.name,el.type]);};
  const edits=new Map(preserveEdits?[...document.querySelectorAll(editableSelector)].filter(el=>el.name).map(el=>[editKey(el),{value:el.value,checked:el.checked}]):[]);
  const disclosures=preserveEdits?[...document.querySelectorAll('#content details')].map(el=>el.open):[];
  const scrollY=window.scrollY;
  const path = normalizeRoute(), active = ['/campaigns/new','/campaigns/demo'].includes(path)?'new':path.startsWith('/library')?'library':path.startsWith('/settings')?'settings':'home';
  const entering = renderedRoute !== currentRoute();
  renderedRoute = currentRoute();
  const running = data.jobs.filter(j=>['queued','running'].includes(j.status)).length;
  const campaign=data.campaigns.find(c=>path.startsWith(`/campaigns/${c.id}/`));
  const nav=primaryNav.map(([name,url,symbol,title])=>`<a href="#${url}" data-nav class="nav-link ${active===name?'active':''}" ${active===name?'aria-current="page"':''} title="${title}">${icon(symbol)}<span>${title}</span></a>`).join('');
  document.body.classList.toggle('online-demo',!!data.deployment?.demoOnly);
  const markup = `<div class="shell">
    <aside class="sidebar"><a class="logo" href="#/home" data-nav aria-label="Orynt 工作台"><img class="logo-symbol" src="/orynt-logo.svg" alt=""><span class="logo-word">orynt<span class="logo-dot">.ai</span></span></a>
      <div class="workspace-selector"><span class="workspace-avatar">${icon('briefcase-business')}</span><div>${esc(data.workspace?.name||'我的工作空间')}<small>私有工作空间</small></div></div>
      <div class="nav-caption">WORKSPACE</div><nav aria-label="主导航">${nav}</nav>
      <div class="sidebar-bottom"><div class="local-indicator"><i></i>本机数据已连接</div><div class="profile"><span class="avatar">我</span><div>我的工作空间<small>内部测试版</small></div></div></div>
    </aside>
    <div class="main-shell"><header class="topbar"><nav class="breadcrumb" aria-label="当前位置">${link('/home','Workspace')}${icon('chevron-right')}<span class="breadcrumb-current">${campaign?esc(byId('brands',campaign.brandId)?.name||'创作项目'):path==='/campaigns/demo'?'Creative Walkthrough':primaryNav.find(item=>item[0]===active)[3]}</span></nav><div class="actions"><button class="task-button" data-action="drawer" aria-label="任务" title="任务中心" aria-haspopup="dialog" aria-expanded="${drawer}">${icon('activity')}<span>任务</span>${running?`<span class="count">${running}</span>`:''}</button>${path==='/campaigns/new'?'':`<a href="#/campaigns/new" data-nav class="button small" aria-label="开始创作">${icon('plus')}<span>开始创作</span></a>`}</div></header>
    <nav class="mobile-nav" aria-label="移动端主导航">${nav}</nav>
    <main id="content" class="${entering?'studio-entering':''}" data-page="${campaign?path.split('/')[3]:path.slice(1)||'home'}">${routeRecoveryMessage?`<div class="notice route-recovery">${esc(routeRecoveryMessage)}</div>`:''}${page(path)}</main>
    <footer><span>Orynt</span><span>内部测试 · 数据保存在本机</span></footer></div></div>${drawer?taskDrawer():''}`;
  $('#app').innerHTML = data.deployment ? markup.replaceAll('本机','服务器').replaceAll('私有工作空间','共享演示工作空间') : markup;
  // Assign the individual CSS property after rendering; HTML style attributes
  // are blocked by the app's CSP. Both tracks share the saved cut durations.
  document.querySelectorAll('[data-edit-duration]').forEach(segment=>{
    const duration=Number(segment.dataset.editDuration);
    segment.style.flex=`${Number.isFinite(duration)&&duration>0?duration:1} 1 0%`;
  });
  window.lucide?.createIcons({attrs:{'stroke-width':1.7}});
  bind();
  document.querySelectorAll('[data-action="toggle-brand-asset"]').forEach(button=>button.setAttribute('aria-pressed',String(button.classList.contains('selected'))));
  if(preserveEdits)document.querySelectorAll(editableSelector).forEach(el=>{const saved=edits.get(editKey(el));if(saved){el.value=saved.value;if(el.type==='checkbox'||el.type==='radio')el.checked=saved.checked;}});
  if(preserveEdits)document.querySelectorAll('#content details').forEach((el,index)=>{if(disclosures[index]!==undefined)el.open=disclosures[index];});
  document.body.classList.toggle('drawer-open',drawer);
  $('.shell').inert=drawer;
  if(drawer)requestAnimationFrame(()=>$('.task-drawer [data-action="drawer"]')?.focus());
  if(preserveEdits)requestAnimationFrame(()=>window.scrollTo(0,scrollY));
  updateSaveState();
  const stages=$('.stage-nav'),currentStage=stages?.querySelector('.current');
  if(currentStage&&stages.scrollWidth>stages.clientWidth)requestAnimationFrame(()=>{
    stages.scrollLeft=currentStage.getBoundingClientRect().left-stages.getBoundingClientRect().left+stages.scrollLeft-(stages.clientWidth-currentStage.clientWidth)/2;
  });
}
function updateSaveState() {
  document.querySelectorAll('#brand-form,#brief-form,#setup-form,#config-form,.brand-settings').forEach(form=>{
    let state=form.querySelector('.save-state');
    if(!state){state=document.createElement('div');state.className='save-state';state.setAttribute('role','status');state.setAttribute('aria-live','polite');form.append(state);}
    state.classList.toggle('unsaved',dirty);
    const replayCampaign=byId('campaigns',form.dataset.campaign)||data.campaigns.find(c=>currentPath().startsWith(`/campaigns/${c.id}/`));
    if(replayCampaign?.replay){state.textContent=form.id==='setup-form'?'固定演示资料 · 确认后发现广告机会':'固定演示脚本 · 确认后进入镜头制作';return;}
    if(form.id==='setup-form'&&byId('snapshots',byId('campaigns',form.dataset.campaign)?.brandSnapshotId)?.productImport?.status==='reading'){state.textContent='正在读取产品页，完成后可核对资料。';return;}
    state.textContent=dirty?'有未保存的修改':form.id==='config-form'?'点击「保存并继续」后，脚本会写入项目':form.id==='setup-form'?form.querySelector('fieldset:disabled')?'本次品牌资料已固定':'确认后开始整理创意':'已保存';
  });
  document.querySelectorAll('.generation-actions [data-action="storyboard"],.generation-actions [data-action="video"]').forEach(button=>{
    button.dataset.baseDisabled ??= String(button.disabled);
    button.disabled=dirty||button.dataset.baseDisabled==='true';
  });
  const gate=$('.config-gate');
  if(gate){gate.dataset.originalText ??= gate.textContent;gate.textContent=dirty?'先保存当前修改，生成时会使用最新设置。':gate.dataset.originalText;}
}
function toggleTaskDrawer() {
  drawer=!drawer;
  render({preserveEdits:true});
  if(!drawer)requestAnimationFrame(()=>document.querySelector('.task-button')?.focus());
}
function page(path) {
  if(path==='/'||path==='/home')return home();
  if(path==='/demo/owala-commute')return renderDemoCase(demoCase, new URLSearchParams(currentRoute().split('?')[1]).get('step'));
  if(path==='/campaigns/new')return data.deployment?.demoOnly ? renderWalkthroughStart(demoCase) : newCampaign();
  if(path==='/campaigns/demo')return renderWalkthroughStart(demoCase);
  if(path==='/library')return library();
  if(path==='/settings')return settings();
  const m=/^\/campaigns\/([^/]+)\/(discover|cards|create|launch|learn)(?:\/([^/]+))?$/.exec(path);
  if(m){const c=byId('campaigns',m[1]);if(!c)return empty('未找到 Campaign','请回到中心选择已有 Campaign。',link('/home','返回中心','button'));
  const access=stageAccess(c),stage=m[2];
    const content=stage==='cards'&&!access.cards?stageLocked('Campaign Card 尚未解锁','先完成本轮市场发现，再生成可选择的策略方向。',`/campaigns/${c.id}/discover`,'返回市场发现'):
      stage==='create'&&!access.create?stageLocked('素材创作尚未解锁','先选择并采纳一张 Campaign Card（广告提案）。',`/campaigns/${c.id}/cards`,'查看 Campaign Cards'):
      stage==='launch'&&!access.launch?stageLocked('投放准备尚未解锁','先完成一条视频，并确认它可以用于模拟投放。',`/campaigns/${c.id}/create`,'返回素材创作'):
      stage==='learn'&&!access.learn?stageLocked('学习结果尚未解锁','先保存模拟投放计划。',`/campaigns/${c.id}/launch`,'返回投放准备'):
      stage==='discover'?discover(c):stage==='cards'?m[3]?cardDetail(c,m[3]):cards(c):stage==='create'?create(c):stage==='launch'?launch(c):learn(c);
    const plan=['launch','learn'].includes(stage)?forCampaign('plans',c).at(-1):null;
    const strategy=plan?renderStrategyAnchor(data,c,byId('cards',plan.cardId),{validation:true}):'';
    return campaignBar(c,m[2])+walkthroughNotice(c)+(c.archived?'<div class="notice">该 Campaign 已归档。历史策略、素材和来源继续保留。</div>':'')+strategy+content;
  }
  return empty('页面不存在','从 Campaign 中心继续你的工作。',link('/home','返回中心','button'));
}
function stageLocked(title,text,path,label){return empty(title,text,link(path,label,'button'));}
function stageAccess(c){
  const hasDiscovery=forCampaign('discoveries',c).some(x=>['succeeded','partial_ready','ready'].includes(x.status));
  const hasPackage=forCampaign('packages',c).some(p=>byId('cards',p.cardId)?.status==='adopted');
  const hasLaunchAsset=forCampaign('assets',c).some(a=>a.type==='video'&&a.status==='launch_ready');
  const hasPlan=forCampaign('plans',c).length>0;
  return {discover:true,cards:hasDiscovery&&forCampaign('cards',c).some(card=>card.status!=='superseded'),create:hasPackage,launch:hasLaunchAsset,learn:hasPlan||['learning','closed'].includes(c.status)};
}
function creativeSketch(product,title,tone=0,compact=false) {
  const symbol=/咖啡|coffee|blend/i.test(product)?'coffee':/服|训练|wear|seamless|运动|gymshark/i.test(product)?'shirt':'package';
  return `<div class="creative-sketch sketch-${tone%3} ${compact?'compact':''}" aria-label="画面示意，尚非生成素材"><span class="sketch-label">画面示意</span><div class="sketch-orbit"></div><div class="sketch-product">${icon(symbol)}</div><div class="sketch-caption"><small>${esc(product||'你的产品')}</small><strong>${esc(title||'让卖点被看见')}</strong></div><span class="sketch-play">${icon('play')}</span></div>`;
}
function home() {
  return renderCreatorHome(data,resume,renderDemoEntry(demoCase),demoCase);
}
function campaignTile(c) {
  const brand=byId('brands',c.brandId);
  return `<article class="campaign-tile"><div class="tile-top"><span class="brand-monogram">${esc((brand?.name||'O').slice(0,1).toUpperCase())}</span>${pill(c.status)}</div><h3>${link(resume(c),esc(c.name))}</h3><p>${esc(byId('briefs',c.briefId)?.objective||'')}</p><div class="tile-meta"><span>${forCampaign('cards',c).length} 张 Campaign Cards</span><span>${forCampaign('assets',c).length} 份素材</span></div><div class="tile-bottom"><span>${date(c.createdAt)}</span>${link(resume(c),'继续工作 ↗')}</div></article>`;
}
function newCampaign() {
  return renderProductStart({data,source:newCampaignSource,url:newCampaignUrl,brandId:selectedBrandId,draft:newCampaignDraft,context:newCampaignContext});
}
function campaignBar(c,stage) {
  const access=stageAccess(c),params=new URLSearchParams(currentRoute().split('?')[1]||''),isResults=stage==='create'&&params.get('view')==='results',post=stage==='launch'||stage==='learn';
  const opportunityView=stage==='discover'&&['opportunities','signals','intent','preparing'].includes(params.get('view'));
  const step=stage==='discover'?(opportunityView?1:0):stage==='cards'?2:post?4:3;
  const pack=forCampaign('packages',c).find(p=>p.cardId===params.get('cardId'))||forCampaign('packages',c).at(-1);
  const createParams=new URLSearchParams();if(pack){createParams.set('cardId',pack.cardId);createParams.set('cardVersion',pack.cardVersion);}if(params.get('angleId'))createParams.set('angleId',params.get('angleId'));
  const createPath=`/campaigns/${c.id}/create?${createParams}&`;
  const steps=[['Product',`/campaigns/${c.id}/discover?view=setup`,true],['Discover',`/campaigns/${c.id}/discover?view=opportunities`,access.cards],['Campaign Card',`/campaigns/${c.id}/cards`,access.cards],['Studio',`${createPath}view=${isResults?'results':'setup'}`,access.create],['Test & Learn',`/campaigns/${c.id}/${stage==='learn'?'learn':'launch'}`,access.launch||access.learn]];
  return `<div class="maker-project-line"><div>${'<a href="#/home" data-nav class="maker-back" aria-label="返回工作台">'+icon('arrow-left')+'</a>'}<span>${esc(byId('brands',c.brandId)?.name)} <small>/ ${esc(c.name)}</small></span></div><span>${post?'广告实验 · 模拟验证':'从市场机会到广告实验'}</span></div><nav class="maker-progress" aria-label="广告实验步骤">${steps.map(([title,url,enabled],index)=>enabled?`<a href="#${url}" data-nav class="${index===step?'current':index<step?'completed':''}" ${index===step?'aria-current="step"':''}><span>${index<step?icon('check'):index+1}</span><div>${title}<small>${['事实与素材','来源与切入点','受众与假设',isResults?'镜头验收与成片':'脚本与镜头','模拟测试与下一步'][index]}</small></div></a>`:`<span class="locked" aria-disabled="true"><span>${index+1}</span><div>${title}<small>完成前一步后继续</small></div></span>`).join('')}</nav>`;
}
function brandSetup(c) {
  return renderProductReview(data,c,creatorDrafts?.read(`product:${c.id}`));
}
function preparation(c) {
  const jobs=forCampaign('jobs',c).filter(j=>['discovery','cards'].includes(j.type)),active=jobs.find(j=>['running','queued'].includes(j.status)),last=jobs.at(-1),discovery=forCampaign('discoveries',c).find(d=>d.briefId===c.briefId),ready=forCampaign('cards',c).some(card=>card.discoveryId===discovery?.id&&card.status!=='superseded'),failed=!active&&['failed','cancelled'].includes(last?.status),waiting=preparingCampaigns.has(c.id)||Boolean(active);
  return `<section class="preparation-page"><div class="preparation-symbol ${failed?'failed':''}">${icon(failed?'circle-alert':ready?'check':'scan-search')}</div>
    <span class="eyebrow">${esc(byId('brands',c.brandId).name)} · 寻找广告机会</span><h1>${ready?'产品与市场线索已整理好':failed?'这一步还没有完成':waiting?'正在寻找值得尝试的广告方向':'继续整理广告机会'}</h1>
    <p>${failed?esc(last.error?.message||'任务已停止，你可以重新开始。'):ready?'先看看来源与切入点，再确定一份广告提案。':c.mode==='guided_demo'?'根据已保存的示例产品资料提出创意假设，不代表真实市场结论。':'整理产品事实和公开广告表达，把依据与待验证的判断分开呈现。'}</p>
    <div class="preparation-steps"><div class="done">${icon('check')}<span><strong>确认产品事实</strong><small>${esc(byId('briefs',c.briefId).product)}</small></span></div><div class="${discovery?'done':waiting?'working':''}">${icon(discovery?'check':'scan-search')}<span><strong>${c.mode==='guided_demo'?'整理示例资料':'整理官网与公开文案'}</strong><small>${discovery?'已整理；下一页可检查来源与资料边界':c.mode==='guided_demo'?'使用本机保存的产品资料':'来源响应较慢时，可能需要一两分钟'}</small></span></div><div class="${ready?'done':discovery&&waiting?'working':''}">${icon(ready?'check':'crosshair')}<span><strong>形成广告提案</strong><small>把受众、表达重点和验证问题放在一起</small></span></div></div>
    ${active?`<div class="preparation-job">${jobRow(active)}</div>`:''}<div class="actions">${ready?link(`/campaigns/${c.id}/discover?view=opportunities`,'查看广告机会','button'):!waiting?`<button class="button" data-action="continue-preparation" data-id="${c.id}">${failed?'重新整理机会':'继续整理'}</button>`:''}${link('/home','返回工作台，稍后继续','text-button')}</div><p class="help">任务保存在本机，离开页面不会取消。</p></section>`;
}
async function beginPreparation(campaignId) {
  if(preparingCampaigns.has(campaignId))return;
  preparingCampaigns.add(campaignId);render({preserveEdits:true});
  try {
    await prepareCreativeOptions({campaignId,command,state:()=>data,wait:async jobId=>{
      const completed=await waitForJob(jobId,{timeoutMs:150_000,onState:state=>{data=state;if(currentPath()===`/campaigns/${campaignId}/discover`&&currentRoute().includes('view=preparing'))render();}});data=completed.state;
    }});
    if(currentPath()===`/campaigns/${campaignId}/discover`&&currentRoute().includes('view=preparing'))await navigate(`/campaigns/${campaignId}/discover?view=opportunities`);
    else toast('广告机会已整理好，可以从工作台继续。');
  } catch(error) {await refreshState();render({preserveEdits:true});toast(error.message,true);}
  finally {preparingCampaigns.delete(campaignId);if(currentPath()===`/campaigns/${campaignId}/discover`&&currentRoute().includes('view=preparing'))render();}
}
function discover(c) {
  const snap=byId('snapshots',c.brandSnapshotId), brief=byId('briefs',c.briefId), latest=forCampaign('discoveries',c).at(-1),analysisRunning=discoveryRunning.has(c.id);
  const params=new URLSearchParams(currentRoute().split('?')[1]||''),confirmed=['confirmed','skipped'].includes(snap.confirmation),view=params.get('view')||(!confirmed?'brand':latest?'signals':'intent'),editingBrand=params.get('edit')==='brand';
  if(view==='preparing')return preparation(c);
  if(view==='opportunities')return renderOpportunityBrief(data,c,new URLSearchParams(currentRoute().split('?')[1]||'').get('research'));
  if(view==='setup'||(!latest&&!snap.frozenAt&&view!=='signals'&&!editingBrand))return brandSetup(c);
  if(view==='intent'&&!dirty)focusSignals=new Set(brief.focusSignals||['竞品动作','用户语言']);
  const factField=(label,name,value,source,status='已确认',area=false,confidence='高置信度')=>`<label class="fact-field"><span class="field-heading"><span>${label}</span><span class="field-source">${source} · ${status} · ${confidence}</span></span>${area?`<textarea name="${name}" rows="3" maxlength="2000">${esc(value)}</textarea>`:`<input name="${name}" value="${esc(value)}" maxlength="2000">`}</label>`;
  const sources=new Map((latest?data.discoverySources.filter(x=>x.discoveryId===latest.id):[]).map(x=>[x.id,x]));
  const signalRecords=latest?data.signals.filter(x=>x.discoveryId===latest.id):[];
  const signals=signalRecords.map(signal=>{
    const evidence=data.evidence.find(item=>signal.evidenceIds?.includes(item.id));
    const source=sources.get(evidence?.discoverySourceId);
    const sourceLabel=source?.sourceType==='brand_website'?'品牌官网':source?.sourceType==='meta_ad_library_demo'?'Meta 演示样本':'Meta 公开广告页面';
    return {id:signal.id,evidenceId:evidence?.id,type:signal.type,title:signal.title,summary:signal.contentSummary,source:sourceLabel,sourceType:source?.sourceType,status:source?.status||'coverage_insufficient',time:signal.observedAt?date(signal.observedAt):'未记录',relevance:signal.relevanceBasis,coverage:signal.coverage,url:evidence?.sourceUrl,attributes:evidence?.attributes||{}};
  });
  const opportunities=latest?.opportunities||[];
  const brand=byId('brands',c.brandId);
  const demoOnly=Boolean(latest?.coverage?.demoMetaAds)&&!latest?.coverage?.liveMetaAds;
  const sampleSignals=demoOnly
    ? signals.filter(signal=>signal.sourceType==='meta_ad_library_demo')
    : signals.filter(signal=>isBrandRelevantMetaSample(signal,brand));
  const excludedLiveSamples=Math.max(0,Number(latest?.coverage?.liveMetaAds||0)-sampleSignals.length);
  const formatOrder=['VIDEO','IMAGE','CAROUSEL','DPA','DCO','UNKNOWN'];
  const creativeGroups=sampleSignals.reduce((groups,signal)=>{const key=creativeFormats[signal.attributes?.displayFormat]?signal.attributes.displayFormat:'UNKNOWN';(groups[key]||=[]).push(signal);return groups;},{});
  const opportunitySignalIds=opportunities.flatMap(opportunity=>opportunity.signalIds||[]);
  const featuredSignals=formatOrder.flatMap(key=>(creativeGroups[key]||[]).slice(0,key==='UNKNOWN'?1:2)).toSorted((a,b)=>{
    const aIndex=opportunitySignalIds.indexOf(a.id),bIndex=opportunitySignalIds.indexOf(b.id);
    return (aIndex<0?Number.MAX_SAFE_INTEGER:aIndex)-(bIndex<0?Number.MAX_SAFE_INTEGER:bIndex);
  }).slice(0,6);
  const featuredIds=new Set(featuredSignals.map(signal=>signal.id)),remainingSignals=sampleSignals.filter(signal=>!featuredIds.has(signal.id));
  const displaySignals=[...featuredSignals,...remainingSignals];
  const patternSummary=formatOrder.filter(key=>creativeGroups[key]?.length&&key!=='UNKNOWN').map(key=>{const format=creativeFormats[key],items=creativeGroups[key];return `<article class="creative-pattern format-${key.toLowerCase()}"><div><span class="pattern-mark" aria-hidden="true">${format.mark}</span><small>${demoOnly?'整理维度':`${items.length} 份样本`}</small></div><h3>${format.label}</h3><p>${format.purpose}</p><strong>拿到真实素材后重点观察</strong><span>${format.variable}</span></article>`;}).join('');
  const product=brief.product||snap.facts.product||'当前产品';
  const sampleContent=demoOnly?`<section class="demo-data-state"><div><span class="eyebrow">CURRENT DATA STATUS</span><h2>当前还没有真实竞品素材</h2><p>这 ${latest.coverage?.demoMetaAds||sampleSignals.length} 条记录由系统生成，只用于检查采集、整理和生成 Card 的流程。它们不需要逐条阅读，也不能用于市场判断。</p></div><dl><div><dt>真实 Meta 素材</dt><dd>0 条</dd></div><div><dt>流程演示记录</dt><dd>${latest.coverage?.demoMetaAds||sampleSignals.length} 条</dd></div><div><dt>当前能否形成结论</dt><dd>不能</dd></div></dl></section><div class="pattern-section-heading"><h2>拿到真实素材后，系统会这样整理</h2><p>下面只展示整理维度，不代表本轮发现了这些市场规律。</p></div>${patternSummary?`<div class="creative-pattern-grid">${patternSummary}</div>`:''}<div class="future-sample-outline"><strong>真实样本将包含</strong><span>原广告缩略图或视频封面</span><span>开场文案与画面结构</span><span>系统整理后的表达方式</span><span>可带入本轮的测试变量</span></div>`:`${excludedLiveSamples?`<div class="discovery-boundary-note"><span>另有 ${excludedLiveSamples} 条真实广告只在正文提到该品牌，已排除在品牌样本之外。</span></div>`:''}${patternSummary?`<div class="creative-pattern-grid">${patternSummary}</div>`:''}<div class="sample-section-heading"><div><h2>代表样本拆解</h2><p>只展示广告主或落地页与当前品牌一致的公开广告。</p></div><span>${featuredSignals.length} / ${sampleSignals.length}</span></div><div class="creative-sample-grid">${featuredSignals.map((signal,index)=>creativeSignalCard(signal,index,product)).join('')||'<p class="muted">本轮没有形成可展示的品牌相关样本。</p>'}</div>${remainingSignals.length?`<details class="more-samples"><summary>查看其余 ${remainingSignals.length} 份样本</summary><div class="creative-sample-grid">${remainingSignals.map((signal,index)=>creativeSignalCard(signal,index+featuredSignals.length,product)).join('')}</div></details>`:''}`;
  const subnav=`<nav class="discovery-sections" aria-label="Discovery 设置">${[['brand','01','Brand Profile',confirmed?'已确认':'待确认'],['intent','02','Creative Brief',`v${brief.version}`],['signals','03','Market Signals',analysisRunning?'分析中':latest?`${sampleSignals.length} 条品牌广告`:'未开始']].map(([key,num,title,status])=>link(`/campaigns/${c.id}/discover?view=${key}`,`<span>${num}</span><strong>${title}</strong><small>${status}</small>`,view===key?'selected':'')).join('')}</nav>`;
  const brandSummary=`<section class="panel brand-summary"><div class="section-title"><div><span class="eyebrow">CONFIRMED BRAND CONTEXT</span><h2>已确认品牌背景</h2><p class="muted">本轮分析将使用这份固定信息；需要时再展开编辑。</p></div>${pill('ready',snap.frozenAt?'快照已固定':`快照 v${snap.version}`)}</div><div class="brand-fact-grid">${[['产品',snap.facts.product],['核心主张',snap.facts.claim],['受众',snap.facts.audience],['市场',snap.facts.market],['竞品范围',snap.facts.competitors],['表达边界',snap.facts.limitations]].map(([label,value])=>`<div><span>${label}</span><strong>${esc(value||'未填写')}</strong></div>`).join('')}</div><div class="summary-actions">${snap.frozenAt?link('/settings?view=brand','管理未来版本 ↗','button secondary'):link(`/campaigns/${c.id}/discover?view=brand&edit=brand`,'编辑品牌背景','button secondary')}${link(`/campaigns/${c.id}/discover?view=intent`,'继续设置本轮意图 →','button')}</div></section>`;
  const brandEditor=`<form class="panel focused-form" id="brand-form" data-campaign="${c.id}"><div class="section-title"><div><h2>${confirmed?'编辑品牌背景':'确认品牌背景'}</h2><p class="muted">只保留会影响本轮判断与创作的信息。</p></div>${pill(confirmed?'ready':'draft',snap.frozenAt?'快照已固定':'品牌快照 v'+snap.version)}</div><fieldset ${snap.frozenAt||c.archived?'disabled':''}>${factField('产品与主要用途','product',snap.facts.product,'品牌信息')}${factField('可使用的核心主张','claim',snap.facts.claim,'用户确认')}${factField('核心受众','audience',snap.facts.audience,'品牌信息')}${factField('竞品与品类范围','competitors',snap.facts.competitors,'品牌信息')}${factField('市场范围','market',snap.facts.market,'用户确认')}${factField('表达限制','limitations',snap.facts.limitations,'用户补充','已确认',true)}<div class="fact-legend"><span><i class="source-web"></i>品牌信息</span><span><i class="source-user"></i>用户确认</span></div><div class="actions"><button class="button" type="submit">${confirmed?'保存品牌背景':'确认并继续'}</button>${!confirmed?`<button class="button secondary" type="button" data-action="skip-brand" data-id="${c.id}">稍后补充</button>`:''}${confirmed?link(`/campaigns/${c.id}/discover?view=brand`,'取消','text-button'):''}</div></fieldset></form>`;
  const intentContent=`<div class="focused-layout"><form class="panel focused-form intent-panel" id="brief-form" data-campaign="${c.id}"><div class="section-title"><div><h2>这一轮要验证什么？</h2><p class="muted">这些选择只影响本轮信号排序与 Card 生成。</p></div><span>v${brief.version}</span></div><fieldset ${c.archived?'disabled':''}>${field('增长目标','objective',brief.objective,{required:true})}${field('本轮主推产品','product',brief.product)}${field('目标受众','audience',brief.audience)}<div class="two-col">${field('渠道','channel',brief.channel,{select:['Meta','TikTok']})}${field('表达风格','style',brief.style,{select:['产品演示','真人 UGC','产品实拍','CGI','动效']})}</div><label>优先关注什么？<div class="choice-chips">${['竞品动作','用户语言','热门创意','品类变化'].map(item=>`<button type="button" class="choice-chip ${focusSignals.has(item)?'selected':''}" aria-pressed="${focusSignals.has(item)}" data-action="focus-signal" data-value="${item}">${focusSignals.has(item)?'✓ ':''}${item}</button>`).join('')}</div></label>${field('本轮限制','limitations',brief.limitations,{area:true})}<p class="help">修改会形成新版本；已发布 Card 和历史素材不会被改写。</p><div class="actions"><button class="button" type="submit">保存并继续 →</button><button class="text-button" type="button" data-action="reset-intent" data-id="${c.id}">按品牌背景恢复</button></div></fieldset></form><aside class="context-summary"><span class="eyebrow">BRAND BASELINE</span><h3>${esc(byId('brands',c.brandId)?.name||'当前品牌')}</h3><p>${esc(snap.facts.claim||'尚未确认核心主张')}</p>${link(`/campaigns/${c.id}/discover?view=brand`,'查看品牌背景 ↗','text-button')}</aside></div>`;
  const resultSection=params.get('section')==='samples'?'samples':'tests';
  const signalResults=latest?`<div class="discovery-result-bar"><nav class="result-tabs" aria-label="发现结果">${link(`/campaigns/${c.id}/discover?view=signals&section=tests`,`${icon('flask-conical')}建议测试 <span>${opportunities.length}</span>`,resultSection==='tests'?'selected':'')}${link(`/campaigns/${c.id}/discover?view=signals&section=samples`,`${icon('scan-search')}市场样本 <span>${demoOnly?0:sampleSignals.length}</span>`,resultSection==='samples'?'selected':'')}</nav><button class="text-button" data-action="analysis-preview" data-id="${c.id}" ${analysisRunning||c.archived?'disabled':''}>${icon('refresh-cw')}${analysisRunning?'分析中…':'重新分析'}</button></div>
  ${latest.limitations?.length?`<details class="source-boundary"><summary>${icon('info')}数据范围与来源说明</summary><div class="discovery-boundary-note">${latest.limitations.map(item=>`<span>${esc(readableDiscoveryLimit(item))}</span>`).join('')}</div></details>`:''}
  ${demoOnly?'<div class="notice">本轮尚未取得真实广告样本。以下建议仅基于品牌背景，效果需要后续测试验证。</div>':''}
  ${resultSection==='samples'?`<section class="signal-section"><div class="signal-intro"><div><h2>${demoOnly?'暂无真实广告样本':'品牌正在如何表达产品？'}</h2><p>查看公开广告的开场、卖点和表达方式。</p></div><div class="signal-summary"><strong>${demoOnly?0:sampleSignals.length}</strong><span>份品牌样本<br>Meta 公开广告</span></div></div>${sampleContent}</section>`:`<section class="opportunity-section"><div class="section-title"><div><h2>这一轮，先验证哪种表达？</h2><p class="muted">${esc(product)} · ${esc(brief.channel)}</p></div></div><div class="opportunity-grid">${opportunities.map((op,index)=>opportunityTestCard(op,index,displaySignals)).join('')}</div><div class="opportunity-action"><div><strong>把测试建议带入创作</strong><small>接下来选择方案，确认创意路线。</small></div>${forCampaign('cards',c).some(card=>card.discoveryId===latest.id&&card.status!=='superseded')?link(`/campaigns/${c.id}/cards`,`${icon('arrow-right')}选择测试方案`,'button'):`<button class="button" data-action="cards" data-id="${c.id}" ${c.archived||analysisRunning?'disabled':''}>${icon('arrow-right')}生成测试方案</button>`}</div></section>`}`:`<section class="panel discovery-ready"><span class="eyebrow">READY TO DISCOVER</span><h2>${analysisRunning?'正在整理市场信号':'品牌与本轮意图已就绪'}</h2><p>${analysisRunning?'任务会在后台继续，完成后可从任务中心返回。':'采集品牌官网和 Meta 公开广告，整理可测试的创意方向。'}</p><dl><div><dt>本轮目标</dt><dd>${esc(brief.objective)}</dd></div><div><dt>主推产品</dt><dd>${esc(brief.product||snap.facts.product)}</dd></div><div><dt>渠道与风格</dt><dd>${esc(brief.channel)} · ${esc(brief.style)}</dd></div></dl><button class="button" data-action="analysis-preview" data-id="${c.id}" ${!confirmed||c.archived||analysisRunning?'disabled':''}>${analysisRunning?'分析进行中…':'开始市场发现 →'}</button></section>`;
  const signalContent=signalResults;
  return `${heading('RESEARCH & STRATEGY',view==='brand'?'Brand Profile':view==='intent'?'Creative Brief':'Market Signals',view==='brand'?'确认产品、受众和可以使用的品牌主张。':view==='intent'?'确定产品、受众，以及这次想验证的问题。':'从公开广告中寻找本轮值得验证的表达方式。')}${subnav}${view==='brand'?(confirmed&&!editingBrand?brandSummary:brandEditor):view==='intent'?intentContent:signalContent}`;
}
function cards(c) {
  const direction=new URLSearchParams(currentRoute().split('?')[1]||'').get('direction');
  return renderCreativeChoices(data,c,direction||creatorChoices.get(c.id)||creatorDrafts?.read(`creative:${c.id}`).selectedCardId);
}
function cardTile(card,allowCompare=false,returnTo='') {
  const detailPath=`/campaigns/${card.campaignId}/cards/${card.id}${returnTo?`?returnTo=${encodeURIComponent(returnTo)}`:''}`,selected=comparedCards(card.campaignId);
  const campaign=byId('campaigns',card.campaignId),product=byId('briefs',card.briefId)?.product||byId('briefs',campaign.briefId)?.product||card.claim;
  const productionAction=card.status==='adopted'?link(`/campaigns/${card.campaignId}/create?cardId=${card.id}&cardVersion=${card.version}`,`继续制作 ${icon('arrow-right')}`,'button small'):['candidate','reviewed'].includes(card.status)?`<button class="button small" data-action="adopt" data-id="${card.id}" ${campaign.archived?'disabled':''}>使用这个创意 ${icon('arrow-right')}</button>`:'';
  return `<article class="strategy-card visual-strategy ${selected.includes(card.id)?'compared':''} ${card.status==='adopted'?'adopted':''}">${creativeSketch(product,card.creativeRoute.hook,card.priority-1,true)}<div class="tile-top"><span class="eyebrow">创意 ${String(card.priority).padStart(2,'0')}</span>${card.status==='adopted'?pill('adopted','已选'):card.priority===1?pill('ready','先试这个'):''}</div><h3>${link(detailPath,esc(card.title.replace(/^(品牌信息|公开样本|待验证)[｜|]\s*/,'')))}</h3><p class="creative-opening">${esc(card.creativeRoute.proof)}</p><div class="creative-question"><span>${icon('flask-conical')}这次验证什么</span><p>${esc(card.testHypothesis)}</p></div>${card.testPlan?`<details class="creative-test-details"><summary>查看 A/B 测试设计</summary><div class="card-test-pair"><div><span>A <small>基准版</small></span><p>${esc(card.testPlan.control)}</p></div><div><span>B <small>测试版</small></span><p>${esc(card.testPlan.variant)}</p></div></div><p class="help">${esc(card.testPlan.successSignal)}</p></details>`:''}<div class="tags"><span>${esc(card.creativeRoute.style)}</span><span>${esc(card.evidenceStrength||'效果待验证')}</span></div><div class="tile-bottom">${allowCompare?`<button class="text-button compare-toggle" aria-pressed="${selected.includes(card.id)}" data-action="compare" data-id="${card.id}">${icon(selected.includes(card.id)?'square-check':'square')}比较</button>`:link(detailPath,'查看详情','text-button')}${allowCompare&&productionAction?productionAction:returnTo?`<button class="text-button" data-action="reuse-card" data-id="${card.id}">用于新一轮 ${icon('arrow-up-right')}</button>`:''}</div></article>`;
}
function cardDetail(c,cardId) {
  const card=byId('cards',cardId);if(!card||card.campaignId!==c.id)return empty('Campaign Card 不存在','请返回卡片列表。');
  const assets=data.assets.filter(x=>x.cardId===card.id),plans=data.plans.filter(x=>x.cardId===card.id),conclusions=data.conclusions.filter(x=>x.cardId===card.id),mappings=data.mappings.filter(x=>plans.some(p=>p.id===x.planId));
  const adopted=card.status==='adopted',dismissed=card.status==='dismissed';
  const requestedReturn=new URLSearchParams(currentRoute().split('?')[1]||'').get('returnTo'),returnTo=requestedReturn?.startsWith('/library')?requestedReturn:`/campaigns/${c.id}/cards`;
  const nextAction=adopted?link(`/campaigns/${c.id}/create?cardId=${card.id}&cardVersion=${card.version}`,'进入创作 →','button wide'):dismissed?`<button class="button secondary wide" data-action="restore-card" data-id="${card.id}">恢复为候选</button>`:`<button class="button wide" data-action="adopt" data-id="${card.id}" ${c.archived?'disabled':''}>采纳当前版本并继续 →</button>`;
  const factRows=(card.facts||[]).map(fact=>`<div class="evidence-row"><span class="pill">${esc(evidenceLabels[card.evidenceBasis]||'来源观察')}</span><p>${esc(fact.statement)}<small>${fact.observedAt?`观察于 ${date(fact.observedAt)} · `:''}${fact.evidenceIds?.length||0} 条 Evidence${String(fact.sourceUrl||'').startsWith('http')?` · <a href="${esc(fact.sourceUrl)}" target="_blank" rel="noreferrer">查看公开来源 ↗</a>`:''}</small></p></div>`).join('');
  return `<div class="detail-back">${link(returnTo,`${icon('arrow-left')}${returnTo.startsWith('/library')?'返回素材库':'全部 Campaign Cards'}`)}</div>${heading(`CAMPAIGN CARD · V${card.version}`,esc(card.title.replace(/^(品牌信息|公开样本|待验证)[｜|]\s*/,'')),esc(card.testHypothesis),pill(card.status))}<div class="review-mobile-action">${nextAction}</div>
  <div class="detail-layout card-review-layout"><div>
    ${card.validationPlan?`<section class="review-section"><h2>本轮先验证一条完整广告</h2><p>${esc(card.validationPlan.scope)}</p><p class="help">${esc(card.validationPlan.successSignal)}</p></section>`:''}
    ${card.testPlan?`<section class="review-section"><h2>两种表达，验证同一个问题</h2><div class="test-versions"><div><small>A · 基准版</small><p>${esc(card.testPlan.control.replace(/^A\s*基准版[：:]\s*/,''))}</p></div><div class="test-variant"><small>B · 测试版</small><p>${esc(card.testPlan.variant.replace(/^B\s*测试版[：:]\s*/,''))}</p></div></div><dl class="review-test-conditions"><div><dt>保持一致</dt><dd>${esc(card.testPlan.constant)}</dd></div><div><dt>判断指标</dt><dd>${esc(card.testPlan.successSignal)}</dd></div></dl></section>`:''}
    <section class="review-section"><h2 lang="en">Creative Brief</h2><dl class="details"><dt>Key Message · 核心主张</dt><dd class="large-copy">${esc(card.claim)}</dd><dt>Audience · 目标受众</dt><dd>${esc(card.audience)}</dd><dt>渠道与市场</dt><dd>${esc(card.applicability.channel)} · ${esc(card.applicability.market)}</dd></dl><div class="route-scenes">${(c.replay&&card.advertisingPlan?card.advertisingPlan.shots.map(s=>[`${s.timing} · ${s.title}`,`${s.description} 屏幕文案：${s.screenCopy}`]):[['开场',card.creativeRoute.hook],['产品证明',card.creativeRoute.proof],['画面风格',card.creativeRoute.style]]).map(([title,copy],index)=>`<div><span>0${index+1} / ${esc(title)}</span><h3>${esc(copy)}</h3></div>`).join('')}</div></section>
    <details class="review-evidence"><summary>${icon('scan-search')}查看依据与推断 <span>${esc(evidenceLabels[card.evidenceBasis]||'历史证据待复核')}</span></summary><p class="help">${esc(card.opportunity)}</p>${factRows||'<p class="muted">暂无直接公开样本，当前方向需要通过测试验证。</p>'}${card.inferences.map(item=>`<div class="evidence-row"><span class="pill">推断</span><p>${esc(item.statement)}<small>${esc(item.basis)}</small></p></div>`).join('')}<p class="help">${esc(card.relevanceMethod||'历史来源需要复核')}</p></details>
    <section class="review-section"><h2>制作时需要留意</h2><ul class="plain-list">${card.risksAndBoundaries.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></section>
  </div><aside><section class="panel sticky-panel"><span class="eyebrow">NEXT STEP</span><h2>${adopted?'方案已采纳':dismissed?'方案已略过':'带入素材创作'}</h2><p>${adopted?'继续制作当前版本的素材。':dismissed?'恢复后可以重新选择。':'选择后，产品主张、创意路线和测试条件会一起带入创作。'}</p>${nextAction}<div class="review-secondary-actions"><button class="text-button" aria-pressed="${Boolean(card.saved)}" data-action="save-card" data-id="${card.id}">${icon('bookmark')}${card.saved?'已收藏':'收藏方案'}</button>${!adopted&&!dismissed?`<button class="text-button" data-action="dismiss-card" data-id="${card.id}">略过</button>`:''}</div><details class="review-exports"><summary>${icon('download')}导出方案</summary><a class="source-link" href="#" data-export="cards" data-export-mode="creative" data-id="${card.id}">创意 Brief</a><a class="source-link" href="#" data-export="cards" data-export-mode="campaign" data-id="${card.id}">Campaign Brief</a></details><details class="review-exports"><summary>版本与关联记录</summary><p class="source-label">方案 v${card.version}<br>创建于 ${date(card.createdAt)}</p>${assets.map(asset=>link(`/campaigns/${c.id}/create?cardId=${card.id}&cardVersion=${card.version}&angleId=${asset.angleId}&view=results`,`${asset.type==='video'?'视频':'分镜'} v${asset.version}`,'source-link')).join('')}${plans.map(plan=>link(`/campaigns/${c.id}/launch`,`投放计划 v${plan.version}`,'source-link')).join('')}${mappings.length?link(`/campaigns/${c.id}/launch?view=mapping`,`${mappings.length} 条素材映射`,'source-link'):''}${conclusions.map(item=>link(`/campaigns/${c.id}/learn`,esc(item.title),'source-link')).join('')}</details></section></aside></div>`;
}
function create(c) {
  const packs=forCampaign('packages',c).filter(p=>byId('cards',p.cardId)?.status==='adopted'),params=new URLSearchParams(currentRoute().split('?')[1]||''),cardId=params.get('cardId'),cardVersion=Number(params.get('cardVersion')||0),pack=cardId?packs.find(x=>x.cardId===cardId&&(!cardVersion||x.cardVersion===cardVersion)):packs.at(-1);
  if(!pack)return empty('先选择一个广告创意','选择后，产品卖点和画面安排会一起带入脚本。',link(`/campaigns/${c.id}/cards`,'选择广告创意','button'));
  const card=byId('cards',pack.cardId),angles=data.angles.filter(x=>x.packageId===pack.id).sort((a,b)=>a.position-b.position),angle=angles.find(x=>x.id===params.get('angleId'))||angles[0];
  const strategy=renderStrategyAnchor(data,c,card);
  const selectedProduction=data.generationRequests.find(r=>r.id===params.get('productionId')&&r.workflow==='shot_pipeline'&&r.packageId===pack.id&&r.angleId===angle.id);
  const config=selectedProduction?byId('configs',selectedProduction.configId):data.configs.filter(x=>x.packageId===pack.id&&x.angleId===angle.id).at(-1),draft=creatorDrafts?.read(`script:${angle.id}`)||{};
  const brandAssets=data.brandAssets.filter(x=>x.brandId===c.brandId&&x.status==='ready');
  const dossierIds=card.productDossier?.materials?.map(m=>m.id);
  const selectedAssets=brandAssetSelections.get(pack.id)||new Set((draft.brandAssetIds||config?.brandAssetIds||dossierIds||byId('snapshots',c.brandSnapshotId)?.assetIds||[]).filter(id=>brandAssets.some(a=>a.id===id)));
  if(!brandAssetSelections.has(pack.id))brandAssetSelections.set(pack.id,selectedAssets);
  const templates=data.videoTemplates.filter(x=>x.packageId===pack.id&&x.angleId===angle.id).toReversed(),selectedTemplateId=templateSelections.get(angle.id)??draft.templateId??config?.templateId??'';
  const assets=data.assets.filter(x=>x.packageId===pack.id&&x.angleId===angle.id).toReversed(),jobs=forCampaign('jobs',c).filter(j=>['storyboard','video','production'].includes(j.type)&&byId('generationRequests',j.input?.generationRequestId)?.angleId===angle.id).toReversed(),activeJob=jobs.find(j=>['queued','running'].includes(j.status));
  const campaignJob=forCampaign('jobs',c).find(j=>['storyboard','video','production'].includes(j.type)&&['queued','running'].includes(j.status)),blockedJob=!activeJob&&campaignJob;
  const waiting=blockedJob?`<section class="maker-processing" role="status"><div><h2>另一个创意方向正在制作</h2><p>可以继续修改脚本，等当前任务完成后再保存预览或生成。</p>${jobRow(blockedJob)}</div></section>`:'';
  if(params.get('view')==='results'){
    const request=selectedProduction||data.generationRequests.filter(r=>r.workflow==='shot_pipeline'&&r.configId===config?.id&&r.angleId===angle.id).at(-1);
    if(request){
      const selection=productionScenes.get(request.id);
      return strategy+waiting+renderProduction({data,c,request,job:byId('jobs',request.jobId),path:`/campaigns/${c.id}/create?cardId=${card.id}&cardVersion=${card.version}&angleId=${angle.id}`,jobRow,selectedShot:selection?.phase===request.production.phase?selection.index:undefined});
    }
    return strategy+waiting+renderResults({data,c,card,pack,angle,config,assets,activeJob,blockedJob,jobs,jobRow});
  }
  return strategy+waiting+renderStudio({data,c,card,pack,angle,angles,config,draft,selectedAssets,selectedTemplateId,templates,activeJob:campaignJob,selectedScene:scriptScenes.get(angle.id)||0});
}
function assetTile(a,returnTo='') {
  const angle=byId('angles',a.angleId),detailPath=`/campaigns/${a.campaignId}/cards/${a.cardId}${returnTo?`?returnTo=${encodeURIComponent(returnTo)}`:''}`,isVideo=a.type==='video';
  return `<article class="asset-tile">${isVideo?`<div class="video-preview"><video controls preload="metadata" src="/api/assets/${a.id}/preview"></video></div>`:`<img src="/api/assets/${a.id}/preview" alt="创意分镜 v${a.version}" loading="lazy">`}<div class="asset-body"><div class="tile-top"><h3>${isVideo?'视频素材':'创意分镜'} <span>v${a.version}</span></h3>${pill(a.status,isVideo&&a.status==='launch_ready'?'可模拟投放':undefined)}</div><p class="source-label">${esc(angle?.name||'角度待确认')} · ${isVideo?esc(a.source==='orynt_composed'?'真实镜头 · 本地剪辑成片':a.source==='youmind_seedance'?'YouMind Seedance · 本地已保存':'本地导入'):'本地分镜预览'}</p><details class="asset-copy"><summary>脚本与来源记录</summary>${a.script?`<p><strong>脚本：</strong>${esc(a.script)}</p><p><strong>文案：</strong>${esc(a.copy)}</p>`:''}<p class="help">创意方案 v${a.cardVersion} · 设置 v${a.configVersion}</p>${link(detailPath,'查看创意依据 ↗','text-button')}</details><div class="actions">${!isVideo?`<a class="text-button" href="/api/assets/${a.id}/download" download>${icon('download')}下载分镜</a>${!byId('campaigns',a.campaignId)?.archived?`<button class="button small" data-action="video" data-id="${a.configId}" data-angle="${a.angleId}" ${forCampaign('jobs',byId('campaigns',a.campaignId)).some(j=>['video','storyboard','production'].includes(j.type)&&['queued','running'].includes(j.status))?'disabled':''}>继续生成视频 ${icon('arrow-right')}</button>`:''}`:a.status!=='generating'?`<a class="text-button" href="/api/assets/${a.id}/download" download>${icon('download')}下载视频</a>`:''}${isVideo&&a.status==='ready'&&!byId('campaigns',a.campaignId)?.archived?`<button class="button small" data-action="launch-ready" data-id="${a.id}">审核并模拟投放 ${icon('arrow-right')}</button>`:''}${isVideo&&a.status==='launch_ready'?link(`/campaigns/${a.campaignId}/launch`,'模拟投放 →','button small'):''}</div></div></article>`;
}
function launchComposer(c,assets,plan,card,brief) {
  return `${heading('TEST & LEARN','Creative Testing','选择素材和观察指标，系统会自动建立映射并生成模拟回收结果。')}
  <div class="notice">演示模式：不会连接广告账户、发布广告或产生投放费用。所有指标均为模拟数据。</div>${plan?.simulatedLaunchAt?`<div class="creative-options-note"><span>${icon('check')}上次模拟测试已完成</span>${link(`/campaigns/${c.id}/learn`,'查看上次结果 →','text-button')}</div>`:''}
  <div class="launch-composer"><form class="panel" id="plan-form" data-campaign="${c.id}"><fieldset ${c.archived?'disabled':''}><div class="section-title"><h2>选择要测试的视频</h2><span>${assets.length} 份可用</span></div>${assets.map(a=>`<label class="launch-video-option"><input type="checkbox" name="assetIds" value="${a.id}" ${(plan?.assetIds||assets.map(x=>x.id)).includes(a.id)?'checked':''}><video muted preload="metadata" src="/api/assets/${a.id}/preview" aria-hidden="true"></video><span><strong>${esc(byId('angles',a.angleId)?.name||'视频素材')} · v${a.version}</strong><small>已核对内容 · 来源创意可追溯</small></span></label>`).join('')}<div class="two-col">${field('模拟渠道','channel',plan?.channel||brief.channel,{select:['Meta','TikTok']})}${field('重点看哪个指标？','metric',plan?.metric||'CTR',{select:['CTR','CPC','CVR','视频完播率']})}</div>${field('目标受众','audience',plan?.audience||brief.audience||card.audience,{required:true})}${field('这条素材要验证什么？','hypothesis',plan?.hypothesis||card.testHypothesis,{area:true})}<details class="setup-optional"><summary>更多测试设置 <span>可选</span></summary>${field('本轮目标','goal',plan?.goal||brief.objective,{required:true})}<div class="two-col">${field('模拟预算','budget',plan?.budget||'USD 300–500')}${field('模拟观察周期','period',plan?.period||'7 天',{select:['7 天','14 天','28 天']})}</div></details><button class="button wide" type="submit">${icon('flask-conical')}开始模拟测试，查看结果</button><p class="setup-footnote">自动保存计划 → 模拟投放 → 模拟回收 → 效果复盘</p></fieldset></form><aside class="launch-summary">${icon('flask-conical')}<h3>先看清楚，一轮测试如何完成</h3><p>结果会对应回你选择的素材和创意问题，帮助理解产品的完整工作方式。</p><div class="setup-benefits"><span>${icon('check')}自动建立素材与广告的映射</span><span>${icon('check')}展示点击与转化等模拟指标</span><span>${icon('check')}回到这次创意的测试问题</span></div><p class="help">模拟结果用于体验流程，不能用于判断广告的真实表现。</p>${plan?link(`/campaigns/${c.id}/launch?view=mapping`,'查看映射记录','text-button'):''}</aside></div>`;
}
function launch(c) {
  const assets=forCampaign('assets',c).filter(a=>a.type==='video'&&a.status==='launch_ready'),plans=forCampaign('plans',c).toReversed(),plan=plans[0],mappings=plan?forCampaign('mappings',c).filter(item=>item.planId===plan.id):[],completeMapping=Boolean(plan)&&plan.assetIds.every(assetId=>mappings.some(item=>item.assetId===assetId)),simulatedMetrics=plan?forCampaign('metrics',c).filter(item=>item.planId===plan.id&&item.simulation):[],simulatedLaunch=Boolean(plan?.simulatedLaunchAt&&plan?.dataMode==='simulation'),connection=data.connections[0],params=new URLSearchParams(currentRoute().split('?')[1]||''),view=params.get('view')||'plan',card=byId('cards',plan?.cardId||assets[0]?.cardId),brief=byId('briefs',c.briefId);
  if(!assets.length)return empty('尚无准备投放的视频','在创作页导入并审核视频，再进入投放准备。分镜预览不属于可投放视频。',link(`/campaigns/${c.id}/create`,'返回创作','button'));
  if(view==='plan')return launchComposer(c,assets,plan,card,brief);
  return `${heading('TEST & LEARN','Simulated Launch','选择素材，确认受众和观察指标，开始一轮模拟测试。')}
  <div class="notice">内部版默认使用模拟投放：计划、广告映射和后续指标均保存在本机，不登录 Meta 或 TikTok，也不会创建真实广告或消耗广告预算。</div>
  <nav class="workspace-tabs">${[['plan','01 投放计划'],['connection','02 模拟渠道'],['mapping','03 素材映射']].map(([key,label])=>link(`/campaigns/${c.id}/launch?view=${key}`,label,view===key?'selected':'')).join('')}</nav>
  ${view==='plan'?`<div class="launch-layout"><form class="panel" id="plan-form" data-campaign="${c.id}"><div class="section-title"><div><h2>投放计划 ${plan?`· v${plan.version}`:''}</h2><p class="muted">推荐值来自 Card；你的修改只记录在当前 Plan。</p></div>${pill(plan?.status||'draft')}</div><div class="recommendation"><span>Card 推荐</span><p>${esc(card.testHypothesis)}</p></div><fieldset ${c.archived?'disabled':''}><div class="launch-assets">${assets.map(a=>`<label><input type="checkbox" name="assetIds" value="${a.id}" ${(plan?.assetIds||assets.map(x=>x.id)).includes(a.id)?'checked':''}><span><strong>${esc(byId('angles',a.angleId)?.name||'视频素材')} · v${a.version}</strong><small>Card v${a.cardVersion} · 配置 v${a.configVersion} · 9:16</small></span></label>`).join('')}</div><div class="two-col">${field('模拟渠道','channel',plan?.channel||brief.channel,{select:['Meta','TikTok']})}${field('本轮目标','goal',plan?.goal||brief.objective,{required:true})}</div>${field('目标受众组','audience',plan?.audience||brief.audience,{required:true})}${field('测试假设','hypothesis',plan?.hypothesis||card.testHypothesis,{area:true})}<div class="two-col">${field('模拟预算区间','budget',plan?.budget||'USD 300–500')}${field('模拟观察周期','period',plan?.period||'7 天',{select:['7 天','14 天','28 天']})}</div>${field('主要观察指标','metric',plan?.metric||'CTR',{select:['CTR','CPC','CVR','视频完播率']})}<div class="launch-checklist"><span>模拟上线检查</span><label><input type="checkbox" checked> 品牌表达与权利已确认</label><label><input type="checkbox" checked> 素材与 Card 版本可回溯</label><label><input type="checkbox" checked> 明确标记为模拟投放</label></div><button class="button" type="submit">保存投放计划</button></fieldset></form><aside><section class="panel"><h2>执行出口</h2><p>${simulatedLaunch?'当前计划已进入模拟观察，系统没有连接或修改任何真实广告账户。':'保存计划后可直接开始模拟投放，系统会自动建立素材映射。'}</p>${plan?`<a class="button secondary wide" href="#" data-export="plans" data-id="${plan.id}">导出投放 Brief ↓</a>${simulatedLaunch?`${pill('observing','模拟投放中')}${link(`/campaigns/${c.id}/launch?view=mapping`,'查看模拟映射 →','button wide')}`:`<button class="button wide" data-action="simulate-launch" data-id="${plan.id}">开始模拟投放</button>`}`:'<p class="help">先保存计划，再开始模拟投放。</p>'}</section><section class="panel section-gap"><h3>来源基线</h3><p class="source-label">${esc(card.title)}<br>Card v${card.version} · ${esc(card.applicability.channel)}<br>${assets.length} 份准备投放素材</p>${link(`/campaigns/${c.id}/cards/${card.id}`,'查看策略与边界 ↗','source-link')}</section></aside></div>`:''}
  ${view==='connection'?`<div class="two-col"><section class="panel connection-card"><div class="section-title"><div><span class="eyebrow">META ADS</span><h2>${connection.status==='connected'?'模拟连接已开启':'连接可选，不阻断投放准备'}</h2></div>${pill(connection.status)}</div><dl class="details"><dt>权限范围</dt><dd>${connection.scopes.join(', ')} · 只读广告数据</dd><dt>最后可用时间</dt><dd>${connection.lastSyncedAt?date(connection.lastSyncedAt):'尚未同步'}</dd><dt>产品边界</dt><dd>不创建广告、不改预算、不返回访问凭据。</dd></dl><button class="button ${connection.status==='connected'?'secondary':''}" data-action="toggle-connection" data-id="${connection.id}" data-status="${connection.status==='connected'?'disconnected':'connected'}">${connection.status==='connected'?'关闭模拟连接':'开启模拟连接'}</button></section><aside class="panel"><h2>连接后可以做什么？</h2><ul class="plain-list"><li>读取外部 Campaign / Ad Set / Ad</li><li>建议素材到广告的映射</li><li>在映射与质量足够时进入复盘</li></ul><div class="notice">当前按钮只保存模拟状态，不发起 OAuth 或外部网络请求。</div>${link(`/campaigns/${c.id}/launch?view=mapping`,'继续到广告映射 →','button secondary')}</aside></div>`:''}
  ${view==='mapping'?`<div class="mapping-workspace"><section class="panel"><div class="section-title"><div><h2>${simulatedLaunch?'素材到模拟广告':'素材映射'}</h2><p class="muted">${simulatedLaunch?'模拟投放已按当前计划自动建立映射，无需填写真实广告 ID。':'开始模拟投放后，系统会为每份素材自动建立本地映射。'}</p></div><span>${assets.length-mappings.length} 份待映射</span></div>${!plan?empty('还没有投放计划','先保存计划，再开始模拟投放。',link(`/campaigns/${c.id}/launch?view=plan`,'返回计划','button')):assets.map(asset=>{const existing=mappings.find(m=>m.assetId===asset.id);return `<article class="mapping-row"><div class="mapping-source"><span class="video-mini">VIDEO</span><div><strong>${esc(byId('angles',asset.angleId)?.name)} · v${asset.version}</strong><small>Card v${asset.cardVersion} · ${existing?'已映射':'待模拟投放'}</small></div></div><span class="mapping-arrow">→</span>${existing?`<div class="mapping-target"><strong>${esc(existing.externalCampaign||'模拟 Campaign')}</strong><small>${esc(existing.externalAdSet||'模拟 Ad Set')} · Ad ${esc(existing.externalAdId)}</small>${pill(existing.simulation?'simulation':'mapped',existing.simulation?'本地模拟映射':'用户确认')}</div>`:'<div class="mapping-target"><strong>等待模拟投放</strong><small>返回投放计划并开始模拟投放</small></div>'}</article>`}).join('')}</section><aside class="panel"><h2>映射完整度</h2><div class="mapping-score"><strong>${assets.length?Math.round(mappings.length/assets.length*100):0}%</strong><span>${mappings.length} / ${assets.length} 份素材</span></div><p>${simulatedLaunch?'映射只用于验证素材、Card 与回收数据之间的链路。':'尚未开始模拟投放。'}</p>${completeMapping?`<button class="button wide" data-action="simulate-metrics" data-id="${plan.id}" data-replace="${simulatedMetrics.length?'true':'false'}">${simulatedMetrics.length?'重新生成模拟数据':'生成模拟回收数据'} →</button><p class="help">仅用于验证追踪与归因；不会读取广告平台或代表真实效果。</p>`:plan?link(`/campaigns/${c.id}/launch?view=plan`,'返回并开始模拟投放 →','button wide'):''}</aside></div>`:''}`;
}
function learn(c) {
  const plan=forCampaign('plans',c).at(-1),mappings=plan?forCampaign('mappings',c).filter(item=>item.planId===plan.id):[],mappingIds=new Set(mappings.map(item=>item.id)),metrics=forCampaign('metrics',c).filter(item=>mappingIds.has(item.mappingId)),conclusions=plan?forCampaign('conclusions',c).filter(item=>item.planId===plan.id):[],simulated=metrics.length>0&&metrics.every(x=>x.simulation),ready=Boolean(mappings.length)&&metrics.some(x=>x.simulation||x.quality==='sufficient'),card=plan?byId('cards',plan.cardId):null;
  const metricCopy={曝光:['广告被展示多少次','曝光次数'],CTR:['看到广告的人中，有多少人点击','点击率'],CPC:['获得一次点击的平均花费','单次点击成本'],CVR:['点击后完成目标动作的比例','转化率'],视频完播率:['看完视频的观众比例','视频完播率']};
  return `${heading('TEST & LEARN','Creative Insights','把表现对应回具体素材，再回到最初想验证的问题。',simulated?pill('draft','模拟结果'):pill(ready?'ready':'draft',ready?'已保存结果':'数据待补齐'))}
  <section class="result-question"><span>${icon('flask-conical')}这次要验证的问题</span><h2>${esc(plan?.hypothesis||card?.testHypothesis||'测试问题尚未保存')}</h2><div class="tags"><span>${esc(plan?.channel||'渠道待确认')}</span><span>${esc(plan?.audience||'受众待确认')}</span><span>重点观察：${esc(plan?.metric||'待确认')}</span></div></section>
  ${!ready?empty('还没有可用的回收结果','回到模拟测试页，选择视频并开始测试。',link(`/campaigns/${c.id}/launch`,'继续模拟测试','button')):`<div class="notice">${simulated?'以下是模拟数据，用于体验素材 → 投放 → 回收 → 复盘的完整流程，不代表真实广告表现。':'这里展示已保存的指标，结论仍需结合样本和数据质量判断。'}</div><section class="metric-grid readable-metrics">${metrics.map(item=>{const copy=metricCopy[item.metric]||['当前已保存指标',item.metric];return `<div><span>${esc(copy[1])}</span><strong>${esc(item.value??'待核对')}</strong><p>${esc(copy[0])}</p><small>${item.simulation?'模拟数据':esc(item.source||'来源待核对')}${item.assetId?` · ${esc(byId('angles',byId('assets',item.assetId)?.angleId)?.name||'当前素材')}`:''}</small></div>`;}).join('')}</section>
  ${simulated?`<section class="result-takeaway"><div>${icon('circle-check')}<h2>流程跑通了，真实效果还需要实际投放验证</h2></div><p>当前已把 ${new Set(metrics.map(m=>m.assetId)).size} 份视频的模拟指标对应回创意方案。${c.replay?'这次演示展示了数据与素材、创意问题的对应关系；模拟数值不能判断广告的真实效果。':'你可以换一个开场再做一版，但这组模拟数值不能判断哪种表达更好。'}</p></section>`:''}
  ${conclusions.length?`<details class="review-evidence result-records" ${simulated?'':'open'}><summary>查看${simulated?'模拟回收记录':'复盘建议'} <span>${conclusions.length} 条</span></summary><div class="conclusion-grid">${conclusions.map(item=>`<article class="conclusion-card"><span class="eyebrow">${item.simulation?'仅用于演示':'适用条件需核对'}</span><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p><details><summary>依据与适用条件</summary><p>${esc(item.basis)}</p><small>${esc(item.applicability)}</small></details><div class="actions">${link(`/campaigns/${c.id}/cards/${item.cardId}`,'查看来源创意','text-button')}${item.simulation?pill('draft','只读模拟记录'):item.status==='adopted'?pill('adopted','已采纳'):`<button class="text-button" data-action="adopt-conclusion" data-id="${item.id}">采纳结论</button><button class="text-button" data-action="ignore-conclusion" data-id="${item.id}">暂不采用</button>`}</div></article>`).join('')}</div></details>`:''}<details class="source-boundary section-gap"><summary>查看素材归因与版本记录</summary><p class="help">${mappings.length} 条映射 · 测试计划 v${plan.version}${card?` · 创意方案 v${card.version}`:''}</p>${link(`/campaigns/${c.id}/launch?view=mapping`,'查看素材映射 →','text-button')}${card?link(`/campaigns/${c.id}/cards/${card.id}`,'查看创意依据 →','text-button'):''}</details>`}
  <section class="panel result-next"><div><h2>${c.replay?'现在，试试你的产品。':'下一步，试试另一种表达'}</h2><p>${c.replay?'演示已完成。可以用自己的产品开始创作，也可以建立新的演示项目，再体验一次完整流程。':'沿用这次产品与创意，改变开场或制作要求，再生成一个版本。'}</p></div><div class="actions">${c.replay?`${link('/campaigns/new','用自己的产品创作','button')}${link('/campaigns/demo','重新体验完整流程','button secondary')}`:`${stageAccess(c).create?link(`/campaigns/${c.id}/create`,'再做一个版本','button'):''}${conclusions.some(x=>x.status==='adopted')?`<button class="button secondary" data-action="reuse-conclusion" data-id="${conclusions.find(x=>x.status==='adopted').id}">带入结论，开始新一轮</button>`:link('/campaigns/new','开始新一轮','button secondary')}`}</div></section>`;
}
function library() {
  const params=new URLSearchParams(currentRoute().split('?')[1]||''),defaultType=data.cards.length?'cards':data.assets.some(item=>item.type==='video')?'videos':data.brandAssets.length?'brand':'cards',type=['cards','videos','brand'].includes(params.get('type'))?params.get('type'):defaultType,q=(params.get('q')||'').toLowerCase(),campaignId=params.get('campaign')||'all',status=params.get('status')||'all',product=params.get('product')||'all',audience=params.get('audience')||'all',style=params.get('style')||'all',channel=params.get('channel')||'all',time=params.get('time')||'all',returnTo=currentRoute();
  const campaigns=data.campaigns,matchCampaign=id=>campaignId==='all'||id===campaignId,matchText=(...values)=>!q||values.some(v=>String(v||'').toLowerCase().includes(q)),matchTime=value=>time==='all'||Date.now()-new Date(value).getTime()<Number(time)*86400000;
  const products=distinctValues(data.briefs.map(item=>item.product)),audiences=distinctValues([...data.briefs.map(item=>item.audience),...data.cards.map(item=>item.audience)]),styles=distinctValues([...data.briefs.map(item=>item.style),...data.cards.map(item=>item.creativeRoute?.style)]),channels=distinctValues([...data.briefs.map(item=>item.channel),...data.cards.map(item=>item.applicability?.channel)]);
  const matchCardFilters=card=>{const brief=byId('briefs',byId('campaigns',card.campaignId)?.briefId);return (product==='all'||brief?.product===product)&&(audience==='all'||card.audience===audience)&&(style==='all'||card.creativeRoute.style===style)&&(channel==='all'||card.applicability.channel===channel);};
  const cards=data.cards.filter(card=>matchCampaign(card.campaignId)&&matchCardFilters(card)&&matchTime(card.createdAt)&&(status==='all'||card.status===status)&&matchText(card.title,card.claim,card.audience,byId('campaigns',card.campaignId)?.name)).toReversed();
  const videos=data.assets.filter(asset=>{const card=byId('cards',asset.cardId);return asset.type==='video'&&matchCampaign(asset.campaignId)&&matchCardFilters(card)&&matchTime(asset.createdAt)&&(status==='all'||asset.status===status)&&matchText(byId('angles',asset.angleId)?.name,byId('campaigns',asset.campaignId)?.name,card?.title);}).toReversed();
  const brandAssets=data.brandAssets.filter(item=>matchText(item.name,item.format));
  const queryFor=nextType=>`/library?type=${nextType}`;
  const hasFilters=[q,campaignId,status,product,audience,style,channel,time].some(value=>value&&value!=='all');
  const availableCount=type==='cards'?data.cards.length:type==='videos'?data.assets.filter(item=>item.type==='video').length:data.brandAssets.length;
  const commonFilters=`<input type="hidden" name="type" value="${esc(type)}"><label>关键词<input name="q" value="${esc(params.get('q')||'')}" placeholder="${type==='brand'?'搜索素材名称':'搜索主张、角度或素材'}"></label>`;
  const campaignFilters=`<label>来源 Campaign<select name="campaign"><option value="all">全部 Campaign</option>${campaigns.map(item=>`<option value="${item.id}" ${campaignId===item.id?'selected':''}>${esc(item.name)}</option>`).join('')}</select></label><label>产品<select name="product">${filterOptions('全部产品',products,product)}</select></label><label>受众<select name="audience">${filterOptions('全部受众',audiences,audience)}</select></label><label>风格<select name="style">${filterOptions('全部风格',styles,style)}</select></label><label>渠道<select name="channel">${filterOptions('全部渠道',channels,channel)}</select></label><label>时间<select name="time">${[['all','全部时间'],['7','最近 7 天'],['30','最近 30 天']].map(([key,label])=>`<option value="${key}" ${time===key?'selected':''}>${label}</option>`).join('')}</select></label><label>状态<select name="status">${[['all','全部状态'],['candidate','待审阅'],['adopted','已采纳'],['ready','可预览'],['launch_ready','已准备投放']].map(([key,label])=>`<option value="${key}" ${status===key?'selected':''}>${label}</option>`).join('')}</select></label>`;
  const filterForm=`<form class="library-filter panel ${type==='brand'?'compact-filter':''}" id="library-filter">${commonFilters}${type==='brand'?'':`<details class="library-more-filters" ${hasFilters?'open':''}><summary>更多筛选 <span>产品、受众、渠道与版本</span>${icon('chevron-down')}</summary><div>${campaignFilters}</div></details>`}<button class="button secondary" type="submit">应用筛选</button>${hasFilters?link(`/library?type=${type}`,'清除全部','text-button'):''}</form>`;
  const content=type==='videos'?`<div class="section-title"><h2 lang="en">Videos <span>${videos.length}</span></h2><span>仅展示可预览视频，分镜保留在 Storyboard</span></div>${videos.length?`<div class="asset-grid library-grid">${videos.map(a=>assetTile(a,returnTo)).join('')}</div>`:empty('还没有视频素材','完成一次视频生成或导入后，素材会出现在这里。',data.campaigns[0]?link(resume(data.campaigns[0]),'返回当前 Campaign','button secondary'):'')}`:type==='cards'?`<div class="section-title"><h2>Campaign Cards <span>${cards.length}</span></h2><span>从策略回到它的证据与执行上下文</span></div>${cards.length?`<div class="card-grid">${cards.map(c=>cardTile(c,false,returnTo)).join('')}</div>`:empty('还没有 Campaign Card','完成 Discover 后生成的 Campaign Cards（广告提案）会集中保存在这里。',data.campaigns[0]?link(`/campaigns/${data.campaigns[0].id}/discover?view=signals`,'继续市场发现','button secondary'):'')}`:`<div class="section-title"><h2 lang="en">Brand Assets <span>${brandAssets.length}</span></h2><span>原图保存在本机，可加入生成配置</span></div>${brandAssets.length?`<div class="brand-library-grid">${brandAssets.map(item=>`<article class="brand-library-item"><div class="brand-asset-preview"><img src="/api/brand-assets/${item.id}/preview" alt="${esc(item.name)}"></div><div><strong>${esc(item.name)}</strong><small>${esc(item.format)} · ${date(item.updatedAt)}</small><div class="actions"><a class="text-button" href="/api/brand-assets/${item.id}/download" download>下载 ↓</a><button class="text-button" data-action="reuse-brand-asset" data-id="${item.id}">沿用该品牌 →</button>${link('/settings?view=assets','管理 ↗','text-button')}</div></div></article>`).join('')}</div>`:empty('还没有品牌素材','在品牌设置中上传 Logo、包装或产品图。',link('/settings?view=assets','管理品牌素材','button secondary'))}`;
  return `${heading('YOUR CREATIVE ASSETS','Library','查找已保存的 Campaign Cards、视频和品牌素材。')}<nav class="package-tabs library-tabs" aria-label="资产类型">${[['cards','Campaign Cards'],['videos','Videos'],['brand','Brand Assets']].map(([key,label])=>link(queryFor(key),label,type===key?'selected':'')).join('')}</nav>${availableCount||hasFilters?filterForm:''}${content}`;
}
function settings() {
  const connection=data.connections[0],params=new URLSearchParams(currentRoute().split('?')[1]||''),view=['brand','assets','connections','activity'].includes(params.get('view'))?params.get('view'):'brand';
  const nav=`<nav class="workspace-tabs settings-tabs" aria-label="设置分类">${[['brand','Brand Profile'],['assets','Brand Assets'],['connections','Connections'],['activity','Activity']].map(([key,label])=>link(`/settings?view=${key}`,label,view===key?'selected':'')).join('')}</nav>`;
  const brandContent=`<div class="settings-page">${data.brands.map(b=>`<form class="panel brand-settings" data-brand="${b.id}"><div class="section-title"><div><h2>${esc(b.name)}</h2><p class="source-label">${esc(b.websiteUrl)}</p></div><span class="muted">品牌版本 v${b.version}</span></div><div class="notice">这里的更新只用于未来 Campaign；已启动任务继续使用当时固定的品牌快照。</div><div class="settings-form-grid"><div>${field('品牌名称','name',b.name,{required:true})}${field('产品与主要用途','product',b.facts.product)}${field('已确认核心主张','claim',b.facts.claim)}</div><div>${field('核心受众','audience',b.facts.audience)}${field('竞品与品类范围','competitors',b.facts.competitors)}${field('市场范围','market',b.facts.market)}</div></div>${field('品牌表达边界','limitations',b.facts.limitations,{area:true})}<div class="actions"><button class="button" type="submit">保存为未来版本</button><a class="text-button" href="#" data-export="brands" data-id="${b.id}">导出品牌信息</a><button class="text-button danger" type="button" data-action="reset-brand" data-id="${b.id}">重置长期记忆</button></div><hr><h3 lang="en">Brand Memory · ${b.memory.length}</h3>${b.memory.length?b.memory.map(item=>`<div class="memory-row"><div><strong>${esc(item.title)}</strong><small>${esc(item.applicability)}</small></div><button class="text-button danger" data-action="delete-memory" data-id="${item.id}" data-brand="${b.id}" type="button">删除</button></div>`).join(''):'<p class="muted">只有用户确认的事实、偏好和已采纳结论会进入长期记忆。</p>'}</form>`).join('')}</div>`;
  const assetContent=`<div class="settings-page"><div class="settings-asset-head"><div><h2 lang="en">Brand Assets</h2><p>用于创作配置的 Logo、包装和产品图；原图不会随视频生成请求上传。</p></div><label class="button secondary compact-upload">+ 新增素材<input class="settings-asset-import" data-brand="${data.brands[0]?.id||''}" type="file" accept="image/png,image/jpeg,image/svg+xml"></label></div>${data.brandAssets.length?`<div class="brand-library-grid settings-asset-grid">${data.brandAssets.map(item=>`<article class="brand-library-item"><div class="brand-asset-preview"><img src="/api/brand-assets/${item.id}/preview" alt="${esc(item.name)}"></div><div><strong>${esc(item.name)}</strong><small>${esc(item.format)} · 保存在本机</small><div class="actions"><a class="text-button" href="/api/brand-assets/${item.id}/download" download>下载</a><button class="text-button danger" type="button" data-action="delete-brand-asset" data-id="${item.id}">删除</button></div></div></article>`).join('')}</div>`:empty('还没有品牌素材','添加 Logo、包装或产品图后，可在创作阶段选择使用。','')}</div>`;
  const connectionContent=`<div class="settings-page narrow"><section class="panel connection-detail"><div class="section-title"><div><span class="eyebrow">META ADS</span><h2>模拟广告数据连接</h2><p class="muted">当前内部版本只验证投放与回收链路，不连接真实账户。</p></div>${pill(connection.status,connection.status==='connected'?'模拟已开启':'模拟未开启')}</div><div class="boundary-grid"><div><span>当前会做</span><strong>在本机保存连接状态与模拟映射</strong></div><div><span>当前不会做</span><strong>OAuth 登录、读取账户或修改广告</strong></div></div><button class="button secondary" data-action="toggle-connection" data-id="${connection.id}" data-status="${connection.status==='connected'?'disconnected':'connected'}">${connection.status==='connected'?'关闭模拟连接':'开启模拟连接'}</button></section><section class="panel section-gap"><h2>外部服务边界</h2><div class="privacy-list"><div><strong>Discovery</strong><span>官网和公开样本在本机采集、整理与保存。</span></div><div><strong>YouMind 视频生成</strong><span>只有用户点击生成时，才发送 Card、配置与品牌素材的文字描述；图片原件不会上传。</span></div><div><strong>模拟投放</strong><span>不创建广告、不修改预算、不访问真实广告账户。</span></div></div></section></div>`;
  const activityContent=`<section class="panel settings-page narrow"><div class="section-title"><div><h2 lang="en">Recent Activity</h2><p class="muted">只展示用户能理解的产品事件，不显示内部状态代码。</p></div><span>${data.audit.length} 条记录</span></div><div class="activity-list">${data.audit.toReversed().slice(0,30).map(event=>`<div class="audit-row"><span>${esc(auditLabels[event.action]||'更新了本地工作空间')}</span><time>${date(event.createdAt)}</time></div>`).join('')||'<p class="muted">暂无操作记录。</p>'}</div></section>`;
  const titles={brand:['Brand Profile','管理未来 Campaign 会使用的长期品牌信息。'],assets:['Brand Assets','管理品牌 Logo、包装和产品图，作为后续创作的视觉参考。'],connections:['Connections','查看数据、外部服务与模拟能力的连接状态。'],activity:['Activity','查看工作空间最近发生的重要变化。']};
  return `${heading('BRAND HUB',titles[view][0],titles[view][1])}${nav}${view==='brand'?brandContent:view==='assets'?assetContent:view==='connections'?connectionContent:activityContent}`;
}
function jobRow(j) {
  const names={reference_media:'补齐广告参考图片',product_import:'读取产品页',discovery:'品牌与来源分析',cards:'策略草案生成',template_analysis:'参考模板分析',storyboard:'分镜预览',video:'视频生成',production:'逐镜头制作与剪辑'};
  const campaign=byId('campaigns',j.campaignId),config=byId('configs',j.input?.configId),pack=byId('packages',config?.packageId),destination=j.type==='product_import'?`/campaigns/${j.campaignId}/discover?view=setup`:['discovery','cards'].includes(j.type)?`/campaigns/${j.campaignId}/discover?view=preparing`:pack?`/campaigns/${pack.campaignId}/create?cardId=${pack.cardId}&cardVersion=${pack.cardVersion}&angleId=${config.angleId}&view=results${j.type==='production'?'&productionId='+j.input.generationRequestId:''}`:campaign?resume(campaign):'/home';
  const recovery=j.status==='failed'&&j.type==='production'?videoRecoveryButton(data.generationRequests.find(r=>r.id===j.input.generationRequestId)):'';
  return `<div class="job-row" data-job-id="${j.id}"><div class="job-main"><div><strong>${names[j.type]||j.type}</strong><small data-job-steps>${j.steps.filter(s=>s.status==='succeeded').length} / ${j.steps.length} 步 · ${date(j.createdAt)}</small></div><span data-job-status>${pill(j.status)}</span></div><progress max="${j.steps.length}" value="${j.steps.filter(s=>s.status==='succeeded').length}"></progress><div data-job-error>${j.error?`<p class="job-error">${esc(j.error.message)}</p>`:''}</div><div class="actions">${link(destination,'返回任务','text-button')}${['failed','cancelled'].includes(j.status)?recovery||`<button class="text-button" data-action="retry" data-id="${j.id}">重试未完成步骤</button>`:''}${['queued','running'].includes(j.status)?`<button class="text-button" data-action="cancel" data-id="${j.id}">取消</button>`:''}</div></div>`;
}
function patchJobState(state,jobId){
  data=state;const job=data.jobs.find(item=>item.id===jobId);if(!job)return;
  const done=job.steps.filter(step=>step.status==='succeeded').length;
  document.querySelectorAll('[data-job-id]').forEach(row=>{if(row.dataset.jobId!==jobId)return;const steps=row.querySelector('[data-job-steps]'),status=row.querySelector('[data-job-status]'),progress=row.querySelector('progress'),error=row.querySelector('[data-job-error]');if(steps)steps.textContent=`${done} / ${job.steps.length} 步 · ${date(job.createdAt)}`;if(status)status.innerHTML=pill(job.status);if(progress){progress.max=job.steps.length;progress.value=done;}if(error)error.innerHTML=job.error?`<p class="job-error">${esc(job.error.message)}</p>`:'';});
}
async function watchProduction(jobId) {
  if(watchedJobs.has(jobId))return;
  watchedJobs.add(jobId);
  let signature='';
  try {
    while(true){
      const state=await readApiState(),job=state.jobs.find(j=>j.id===jobId),request=state.generationRequests.find(r=>r.id===job?.input.generationRequestId);
      if(!job||!request)return;
      const next=JSON.stringify([job.status,job.error,job.steps.map(s=>s.status),request.production.phase,request.production.shots.map(s=>[s.status,s.version,s.technical,s.review,s.keyframe?.status,s.keyframe?.version,s.keyframe?.review])]);
      patchJobState(state,jobId);
      if(next!==signature){
        if(!document.querySelector('.production-shot-form textarea:focus, .production-keyframe-form textarea:focus'))signature=next;
        if(currentPath()===`/campaigns/${job.campaignId}/create`&&currentRoute().includes('view=results')&&!document.querySelector('.production-shot-form textarea:focus, .production-keyframe-form textarea:focus'))render({preserveEdits:true});
      }
      if(!['queued','running'].includes(job.status)||['awaiting_review','awaiting_keyframe_review'].includes(request.production.phase))return;
      await new Promise(resolve=>setTimeout(resolve,2500));
    }
  }catch(error){toast('制作状态暂未更新，刷新页面可恢复查看。',true);}
  finally{watchedJobs.delete(jobId);}
}
async function watchGeneration(jobId,mode) {
  if(watchedJobs.has(jobId))return;
  watchedJobs.add(jobId);
  try {
    const completed=await waitForJob(jobId,{timeoutMs:mode==='video'?240_000:90_000,onState:state=>patchJobState(state,jobId)});
    data=completed.state;render({preserveEdits:true});toast(mode==='video'?'视频已制作完成，可以预览或模拟投放。':'分镜已准备好，可以继续生成视频。');
  } catch(error) {await refreshState();render({preserveEdits:true});toast(error.message,true);}
  finally {watchedJobs.delete(jobId);}
}
async function watchProductImport(jobId) {
  if(!jobId||watchedJobs.has(jobId))return;
  watchedJobs.add(jobId);
  const campaignId=byId('jobs',jobId)?.campaignId;
  try {
    const result=await waitForJob(jobId,{timeoutMs:120_000,onState:state=>{data=state;}});
    data=result.state;
  } catch { await refreshState(); }
  finally {
    watchedJobs.delete(jobId);
    if($('#setup-form')?.dataset.campaign===campaignId) {
      saveCreatorDraft($('#setup-form'));
      render();
    }
    if(['queued','running'].includes(byId('jobs',jobId)?.status))setTimeout(()=>void watchProductImport(jobId),1500);
  }
}
async function startGeneration(configId,mode,angleId) {
  const queued=await command(mode==='video'?'production.start':'generation.start',configId,{mode,angleId,...(mode==='video'?{keyframes:true}:{})});
  const config=byId('configs',configId),pack=byId('packages',config.packageId);
  dirty=false;
  await navigate(`/campaigns/${pack.campaignId}/create?cardId=${pack.cardId}&cardVersion=${pack.cardVersion}&angleId=${angleId}&view=results${mode==='video'?'&productionId='+queued.generationRequestId:''}`);
  if(mode==='video')void watchProduction(queued.jobId);else void watchGeneration(queued.jobId,mode);
}
function taskDrawer() {return `<div class="drawer-overlay" data-action="drawer"></div><aside class="task-drawer" role="dialog" aria-modal="true" aria-label="任务中心"><div class="section-title"><h2 lang="en">Tasks</h2><button aria-label="关闭任务中心" title="关闭任务中心" class="icon-button" data-action="drawer">${icon('x')}</button></div><p class="muted">${data.jobs.filter(job=>['running','queued'].includes(job.status)).length?'任务在后台继续运行。':'当前没有进行中的任务。'}</p>${data.jobs.length?data.jobs.toReversed().slice(0,20).map(jobRow).join(''):empty('暂无任务','开始市场发现或生成素材后，可在这里查看进度。')}</aside>`;}
function saveCreatorDraft(form) {
  if(!form||!creatorDrafts)return false;
  let fields=Object.fromEntries(new FormData(form));
  const key=form.id==='config-form'?`script:${form.dataset.angle}`:form.id==='setup-form'?`product:${form.dataset.campaign}`:form.id==='new-form'?'start':null;
  if(!key||form.querySelector('fieldset:disabled'))return false;
  if(form.id==='config-form')fields.brandAssetIds=[...(brandAssetSelections.get(form.dataset.package)||[])];
  if(form.id==='setup-form'){
    fields.importImageIds=new FormData(form).getAll('importImageIds');
    const campaign=byId('campaigns',form.dataset.campaign),snapshot=byId('snapshots',campaign.brandSnapshotId);
    if(snapshot.productImport)fields=productDraftEdits(fields,snapshot,byId('briefs',campaign.briefId),byId('brands',campaign.brandId));
  }
  if(form.id==='new-form')fields.source=newCampaignSource;
  return creatorDrafts.write(key,fields);
}
function bind() {
  $('#config-form')?.addEventListener('invalid',event=>{
    const panel=event.target.closest('[data-script-scene]');
    if(panel?.hidden)document.querySelector(`[data-action="edit-scene"][data-index="${panel.dataset.scriptScene}"]`)?.click();
  },true);
  document.querySelectorAll('[data-nav]').forEach(a=>a.addEventListener('click',e=>{if(e.metaKey||e.ctrlKey||e.shiftKey)return;e.preventDefault();navigate(a.getAttribute('href').slice(1));}));
  document.querySelectorAll('input:not([type=file]),textarea,select').forEach(el=>el.addEventListener('input',()=>{
    dirty=true;
    if(saveCreatorDraft(el.closest('form')))dirty=false;
    updateSaveState();
    if(el.name==='duration')document.querySelectorAll('[data-scene-time]').forEach(node=>{const time=sceneTiming(el.value)[Number(node.dataset.sceneTime)];node.textContent=`${time.start}–${time.end} 秒`;});
    if(el.name==='templateId'){templateSelections.set(el.closest('#config-form')?.dataset.angle,el.value);render({preserveEdits:true});return;}
    if(el.closest('#new-form')) {
      if(el.name==='brandUrl') newCampaignUrl=el.value;
      if(el.name==='brandId') selectedBrandId=el.value;
      if(['name','objective','product'].includes(el.name)) newCampaignDraft[el.name]=el.value;
      if(el.name==='brandId') {
        const brand=byId('brands',el.value),productInput=$('#new-form [name=product]');
        newCampaignDraft.product=brand?.facts?.product||'';if(productInput)productInput.value=newCampaignDraft.product;
        render({preserveEdits:true});
      }
    }
  }));
  $('[data-angle-choice]')?.addEventListener('change',async e=>{
    saveCreatorDraft($('#config-form'));dirty=false;
    const params=new URLSearchParams(currentRoute().split('?')[1]||'');params.set('angleId',e.target.value);params.set('view','setup');await navigate(`${currentPath()}?${params}`);
  });
  $('#config-form [name=productTreatment]')?.addEventListener('change',()=>{
    if(saveCreatorDraft($('#config-form'))){dirty=false;render();}
  });
  const submit=(selector,fn)=>document.querySelectorAll(selector).forEach(form=>form.addEventListener('submit',async e=>{e.preventDefault();if(busy)return;busy=true;const submittedRoute=currentRoute(),btn=e.submitter||form.querySelector('[type=submit]'),original=btn?.innerHTML;form.querySelector('.form-error')?.remove();if(btn){btn.disabled=true;btn.setAttribute('aria-busy','true');btn.textContent='正在处理…';}try{await fn(Object.fromEntries(new FormData(form)),form,e.submitter);if(currentRoute()===submittedRoute){dirty=false;render();toast('已保存');}}catch(error){if(form.isConnected){const message=document.createElement('p');message.className='form-error';message.setAttribute('role','alert');message.textContent=error.message;if(btn)btn.before(message);else form.prepend(message);}toast(error.message,true);}finally{busy=false;if(btn){btn.disabled=false;btn.removeAttribute('aria-busy');btn.innerHTML=original;}}}));
  submit('#home-start-form',async fields=>{
    const result=await command('campaign.create',null,{...fields,importFromUrl:true,objective:'让用户更快理解产品卖点'});dirty=false;
    await navigate(`/campaigns/${result.campaignId}/discover?view=setup`);
    void watchProductImport(result.jobId);
  });
  submit('#new-form',async fields=>{if(fields.brandId){const brand=byId('brands',fields.brandId);if(!brand)throw new Error('请选择已有品牌。');fields.brandUrl=brand.websiteUrl;}fields.importFromUrl=!fields.brandId&&fields.mode!=='guided_demo';if(newCampaignContext?.type==='学习结论')fields.inheritedLearningId=newCampaignContext.id;const r=await command('campaign.create',null,fields);newCampaignSource='website';newCampaignUrl='';selectedBrandId=null;newCampaignDraft={name:'',objective:'让用户更快理解产品卖点',product:''};newCampaignContext=null;creatorDrafts.remove('start');dirty=false;await navigate(`/campaigns/${r.campaignId}/discover?view=setup`);void watchProductImport(r.jobId);});
  submit('#setup-form',async(fields,f)=>{
    const campaign=byId('campaigns',f.dataset.campaign),snapshot=byId('snapshots',campaign.brandSnapshotId);
    if(!snapshot.frozenAt)await command('snapshot.confirm',campaign.id,{...snapshot.facts,...fields,importImageIds:new FormData(f).getAll('importImageIds')});
    const brief=byId('briefs',byId('campaigns',campaign.id).briefId);
    await command('brief.update',campaign.id,{...brief,...fields});dirty=false;
    creatorDrafts.remove(`product:${campaign.id}`);
    await navigate(`/campaigns/${campaign.id}/discover?view=preparing`);void beginPreparation(campaign.id);
  });
  submit('#brand-form',async(fields,f)=>{await command('snapshot.confirm',f.dataset.campaign,fields);dirty=false;await navigate(`/campaigns/${f.dataset.campaign}/discover?view=intent`);});
  submit('#brief-form',async(fields,f)=>{await command('brief.update',f.dataset.campaign,{...fields,focusSignals:[...focusSignals]});dirty=false;await navigate(`/campaigns/${f.dataset.campaign}/discover?view=preparing`);void beginPreparation(f.dataset.campaign);});
  submit('#config-form',async(fields,f,button)=>{
    const config=data.configs.filter(x=>x.packageId===f.dataset.package&&x.angleId===f.dataset.angle).at(-1);
    const configId=await saveGenerationConfig({command,packageId:f.dataset.package,angleId:f.dataset.angle,fields,brandAssetIds:[...(brandAssetSelections.get(f.dataset.package)||[])],config});
    await startGeneration(configId,button?.dataset.mode||'storyboard',f.dataset.angle);
    creatorDrafts.remove(`script:${f.dataset.angle}`);
  });
  submit('.production-shot-form',async(fields,f)=>{const result=await command('production.reviseShot',f.dataset.request,{index:Number(f.dataset.index),version:Number(f.dataset.version),text:fields.text,direction:shotDirectionFromFields(fields)});void watchProduction(result.jobId);});
  submit('.production-keyframe-form',async(fields,f)=>{const result=await command('production.reviseKeyframe',f.dataset.request,{index:Number(f.dataset.index),version:Number(f.dataset.version),shotVersion:Number(f.dataset.shotVersion),text:fields.text,direction:shotDirectionFromFields(fields)});void watchProduction(result.jobId);});
  submit('#production-edit-form',async(fields,f)=>{const result=await command('production.reedit',f.dataset.request,{copy:{opening:fields.opening,detail:fields.detail,cta:fields.cta},music:fields.music});void watchProduction(result.jobId);});
  submit('#production-fork-edit-form',async(fields,f)=>{const result=await command('production.forkEdit',f.dataset.request,{copy:{opening:fields.opening,detail:fields.detail,cta:fields.cta},music:fields.music});dirty=false;await navigate(currentRoute().replace(/&productionId=[^&]+/,'')+'&productionId='+result.generationRequestId);void watchProduction(result.jobId);});
  submit('#production-review-form',async(fields,f)=>{await command('production.reviewFinal',f.dataset.asset,{checks:Object.fromEntries(['identity','motion','copy','sound'].map(key=>[key,fields[key]==='on']))});});
  submit('#plan-form',async(fields,f)=>{
    await simulatePlan({command,campaignId:f.dataset.campaign,fields:{...fields,assetIds:[...f.querySelectorAll('[name=assetIds]:checked')].map(x=>x.value)}});
    dirty=false;await navigate(`/campaigns/${f.dataset.campaign}/learn`);toast('模拟测试已完成，以下结果均为演示数据。');
  });
  submit('.mapping-form',(fields,f)=>command('mapping.save',f.dataset.plan,fields));
  submit('.brand-settings',(fields,f)=>command('brand.update',f.dataset.brand,fields));
  submit('#library-filter',async fields=>{dirty=false;const next=new URLSearchParams();Object.entries(fields).forEach(([key,value])=>{if(value&&value!=='all')next.set(key,value);else if(key==='type')next.set(key,value);});await navigate(`/library?${next.toString()}`);});
  document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',async()=>{
    const action=button.dataset.action,id=button.dataset.id;
    if(action==='collect-reference-images'){
      button.disabled=true;
      try{
        const queued=await command('references.collectImages',id);
        render({preserveEdits:true});
        const completed=await waitForJob(queued.jobId,{timeoutMs:120_000,onState:state=>{data=state;}});
        data=completed.state;render({preserveEdits:true});
        const count=byId('jobs',queued.jobId)?.summary?.savedImages||0;
        toast(count?`已保存 ${count} 张真实广告图片或封面。`:'本次未能取得图片，已保留原文和来源；历史素材链接可能失效。',!count);
      }catch(error){await refreshState();render({preserveEdits:true});toast(error.message,true);}
      return;
    }
    if(action==='show-all-campaigns'){document.querySelectorAll('[data-extra-campaign]').forEach(el=>{el.hidden=false;});button.hidden=true;return;}
    if(action==='view-edit-source'){await navigate(currentRoute().replace(/&productionId=[^&]+/,'')+'&productionId='+id);return;}
    if(action==='restore-imported-fields'){
      const campaign=byId('campaigns',id),snapshot=campaign&&byId('snapshots',campaign.brandSnapshotId);
      if(busy||!snapshot||snapshot.frozenAt||snapshot.confirmation!=='pending'||snapshot.productImport?.status!=='ready')return;
      saveCreatorDraft($('#setup-form'));
      const draft=creatorDrafts.read(`product:${id}`);
      for(const key of Object.keys(snapshot.productImport.fields||{}))delete draft[key];
      creatorDrafts.write(`product:${id}`,draft);dirty=false;render();return;
    }
    if(action==='skip-product-import'||action==='start-product-import'){
      if(busy)return;busy=true;button.disabled=true;button.setAttribute('aria-busy','true');
      try{
        saveCreatorDraft($('#setup-form'));dirty=false;
        const result=await command(action==='skip-product-import'?'productImport.skip':'productImport.start',id,button.dataset.productUrl?{productUrl:button.dataset.productUrl}:{});
        if(button.dataset.productUrl)creatorDrafts.remove(`product:${id}`);
        render();if(result.jobId)void watchProductImport(result.jobId);
      }catch(error){toast(error.message,true);}finally{busy=false;button.disabled=false;button.removeAttribute('aria-busy');}
      return;
    }
    if(action==='edit-scene'){
      const index=Number(button.dataset.index),form=$('#config-form');
      scriptScenes.set(form.dataset.angle,index);
      document.querySelectorAll('[data-script-scene]').forEach(panel=>panel.hidden=Number(panel.dataset.scriptScene)!==index);
      document.querySelectorAll('[data-action="edit-scene"]').forEach(tab=>tab.setAttribute('aria-pressed',String(Number(tab.dataset.index)===index)));
      return;
    }
    if(action==='production-scene'){
      if(dirty&&!await confirmAction('当前镜头的修改尚未提交，切换后会丢弃这些修改。','切换镜头？'))return;
      const request=byId('generationRequests',id);if(!request)return;
      const index=button.dataset.index==='final'?'final':Number(button.dataset.index);
      productionScenes.set(id,{phase:request.production.phase,index});dirty=false;render();
      document.querySelector(`.production-rail [data-index="${index}"]`)?.focus({preventScroll:true});return;
    }
    if(action==='jump-direction'||action==='jump-options'){const target=action==='jump-direction'?$('.direction-preview'):$('.direction-options');target?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});return;}
    if(action==='pick-creative'){const card=byId('cards',id);creatorChoices.set(card.campaignId,id);creatorDrafts?.write(`creative:${card.campaignId}`,{selectedCardId:id});const route=new URL(location.href);const query=new URLSearchParams(currentRoute().split('?')[1]||'');query.set('direction',id);route.hash=`${currentPath()}?${query}`;history.replaceState(null,'',route);activeRoute=currentRoute();const position=window.scrollY;render();requestAnimationFrame(()=>{if(window.matchMedia('(max-width:680px)').matches){$('.direction-preview')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});$('[data-action="play-direction"]')?.focus({preventScroll:true});}else{window.scrollTo(0,position);document.querySelector(`.direction-pick[data-id="${id}"]`)?.focus({preventScroll:true});}});return;}
    if(action==='rerun-demo'){
      if(busy||!demoCase?.product?.url)return;
      busy=true;button.disabled=true;button.setAttribute('aria-busy','true');
      try{
        if(!await confirmAction('将新建独立项目，重新读取固定产品的公开网址。后续按正常流程核对资料、发现市场和制作；不会改写演示基准，也不会在此自动发起付费生成。','重新运行验证'))return;
        const result=await command('campaign.create',null,{brandUrl:demoCase.product.url,importFromUrl:true,name:'Owala · 独立重新验证',objective:demoCase.creative?.question||'验证随身出行广告方向'});
        dirty=false;await navigate(`/campaigns/${result.campaignId}/discover?view=setup`);void watchProductImport(result.jobId);
      }catch(error){toast(error.message,true);}finally{busy=false;button.disabled=false;button.removeAttribute('aria-busy');}return;
    }
    if(action==='start-demo'){
      const brand=byId('brands',id);newCampaignSource='existing';selectedBrandId=id;newCampaignDraft={product:brand.facts.product||'',objective:'让用户更快理解产品卖点',name:`${brand.name} · 演示创作`,mode:'guided_demo'};
      creatorDrafts.write('start',{...newCampaignDraft,source:'existing',brandId:id});dirty=false;await navigate('/campaigns/new');return;
    }
    if(action==='continue-preparation'){void beginPreparation(id);return;}
    if(action==='new-example'){newCampaignSource='existing';selectedBrandId=id;newCampaignDraft.product=byId('brands',id)?.facts?.product||'';newCampaignDraft.mode='guided_demo';creatorDrafts.write('start',{...newCampaignDraft,source:'existing',brandId:id});dirty=false;render();return;}
    if(action==='clear-context'){newCampaignContext=null;render();return;}
    if(action==='toggle-brand-asset'){
      const selected=brandAssetSelections.get(button.dataset.package)||new Set();selected.has(id)?selected.delete(id):selected.add(id);brandAssetSelections.set(button.dataset.package,selected);dirty=!saveCreatorDraft($('#config-form'));render({preserveEdits:true});return;
    }
    if(action==='reset-intent'){
      const campaign=byId('campaigns',id),snapshot=byId('snapshots',campaign.brandSnapshotId),facts=snapshot?.facts||{};
      focusSignals=new Set(['竞品动作','用户语言']);await command('brief.update',id,{objective:`找到让目标受众愿意了解${facts.product||'当前产品'}的表达方式`,product:facts.product||'',audience:facts.audience||'',channel:'Meta',style:'产品演示',limitations:facts.limitations||'不使用未经证明的效果承诺',focusSignals:[...focusSignals]});dirty=false;render();toast('已按当前品牌背景恢复本轮意图，并保留为新版本');return;
    }
    if(action==='new-source'){
      const form=$('#new-form');
      if(form){const fields=Object.fromEntries(new FormData(form));newCampaignUrl=fields.brandUrl||newCampaignUrl;selectedBrandId=fields.brandId||selectedBrandId;newCampaignDraft={name:fields.name||'',objective:fields.objective||'让用户更快理解产品卖点',product:fields.product||''};}
      newCampaignSource=button.dataset.value;newCampaignDraft.mode='standard';creatorDrafts.write('start',{...newCampaignDraft,source:newCampaignSource,brandUrl:newCampaignUrl,brandId:selectedBrandId||''});dirty=false;render();return;
    }
    if(action==='focus-signal'){
      const value=button.dataset.value;
      if(focusSignals.has(value))focusSignals.delete(value);else focusSignals.add(value);
      const selected=focusSignals.has(value);button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));button.textContent=(selected?'✓ ':'')+value;dirty=true;return;
    }
    if(action==='analysis-preview'){
      if(dirty)return toast('请先保存品牌信息或本轮意图。',true);
      if(discoveryRunning.has(id))return;
      try{
        const queued=await command('discovery.start',id);discoveryRunning.add(id);render();
        const completed=await waitForJob(queued.jobId,{onState:state=>{data=state;}});data=completed.state;
        discoveryRunning.delete(id);render();toast(`Discovery 已完成 · v${forCampaign('discoveries',byId('campaigns',id)).at(-1)?.version||1}`);
      }catch(error){discoveryRunning.delete(id);await refreshState();render();toast(error.message,true);}return;
    }
    if(action==='drawer'){toggleTaskDrawer();return;}
    if(action==='compare'){
      const card=byId('cards',id),selected=[...comparedCards(card.campaignId)],index=selected.indexOf(id);
      if(index>=0)selected.splice(index,1);else if(selected.length<3)selected.push(id);else return toast('最多比较三张卡片。');
      compareByCampaign.set(card.campaignId,selected);render({preserveEdits:true});return;
    }
    if(action==='reuse-card'||action==='reuse-brand-asset'||action==='reuse-conclusion'){
      if(action==='reuse-card'){
        const card=byId('cards',id);newCampaignContext={type:'Campaign Card',id,label:`${card.title} · Card v${card.version}`};newCampaignDraft={name:`${card.title} · 新一轮`,objective:card.testHypothesis};
      }else if(action==='reuse-brand-asset'){
        const asset=byId('brandAssets',id);newCampaignContext={type:'品牌素材',id,label:asset.name};selectedBrandId=asset.brandId;newCampaignDraft={name:'',objective:'验证新的产品表达'};
      }else{
        const conclusion=byId('conclusions',id);newCampaignContext={type:'学习结论',id,label:`${conclusion.title} · ${conclusion.applicability}`};newCampaignDraft={name:`${conclusion.title} · 下一轮`,objective:`在新一轮中继续验证：${conclusion.title}`};
      }
      newCampaignSource='existing';await navigate('/campaigns/new');return;
    }
    if(busy)return;if(dirty&&action!=='skip-brand')return toast('请先保存当前编辑，再执行下一步。',true);
    busy=true;button.disabled=true;button.setAttribute('aria-busy','true');
    try{
      if(action==='skip-brand'){await command('snapshot.confirm',id,{skip:true,...Object.fromEntries(new FormData($('#brand-form')))});dirty=false;await navigate(`/campaigns/${id}/discover?view=intent`);return;}
      if(action==='discover')await command('discovery.start',id);
      if(action==='cards'){
        const queued=await command('cards.generate',id);discoveryRunning.add(id);render();
        const completed=await waitForJob(queued.jobId,{onState:state=>{data=state;}});data=completed.state;discoveryRunning.delete(id);
        await navigate(`/campaigns/${id}/cards`);
      }
      if(action==='refresh-cards'&&await confirmAction('当前 Card、关联素材和投放计划会保留；刷新将创建一组新版本。','刷新 Campaign Cards？')){
        const queued=await command('cards.refresh',id);discoveryRunning.add(id);render();
        const completed=await waitForJob(queued.jobId,{onState:state=>{data=state;}});data=completed.state;discoveryRunning.delete(id);
      }
      if(action==='adopt'){
        const card=byId('cards',id);
        await command('card.adopt',id);await navigate(`/campaigns/${card.campaignId}/create?cardId=${id}&cardVersion=${card.version}`);
      }
      if(action==='save-card'||action==='dismiss-card'||action==='restore-card')await command('card.feedback',id,{type:action==='save-card'?'save':action==='restore-card'?'restore':'dismiss'});
      if(action==='storyboard'||action==='video'){
        await startGeneration(id,action,button.dataset.angle);
      }
      if(action==='approve-production-shot'){const result=await command('production.approveShot',id,{index:0,version:Number(button.dataset.version)});void watchProduction(result.jobId);}
      if(action==='approve-production-keyframe'){const result=await command('production.approveKeyframe',id,{index:Number(button.dataset.index),version:Number(button.dataset.version),shotVersion:Number(button.dataset.shotVersion)});void watchProduction(result.jobId);}
      if(action==='recover-production-video'){const result=await command('production.recoverVideo',id,{index:Number(button.dataset.index),version:Number(button.dataset.version),resubmit:true});void watchProduction(result.jobId);}
      if(action==='local-product-version'){
        const result=await command('production.localProductVersion',id,{});
        productionScenes.set(result.generationRequestId,0);
        location.hash=currentRoute().replace(/&productionId=[^&]+/,'')+'&productionId='+result.generationRequestId;
        void watchProduction(result.jobId);
      }
      if(action==='launch-ready'&&byId('assets',id)?.source==='orynt_composed'&&byId('assets',id).qualityReview?.status!=='accepted'){const a=byId('assets',id),p=byId('packages',a.packageId);await navigate(`/campaigns/${a.campaignId}/create?cardId=${p.cardId}&cardVersion=${p.cardVersion}&angleId=${a.angleId}&view=results&productionId=${a.generationRequestId}`);toast('请先播放视频，完成产品、镜头、文案和声音检查。');return;}
      if(action==='launch-ready'&&await confirmAction('请确认视频内容、品牌表达和素材使用权利已经核对。下一步进入本地模拟投放，不会发布真实广告。','确认视频并继续')){await command('asset.launch-ready',id,{reviewed:true});await navigate(`/campaigns/${byId('assets',id).campaignId}/launch`);}
      if(action==='simulate-metrics'){
        const replace=button.dataset.replace==='true';
        if(!await confirmAction(replace?'现有模拟指标和模拟建议将被替换；真实数据不会受影响。':'系统将生成明确标注的本地模拟指标，不会连接广告平台，也不能用于业务决策。',replace?'重新生成模拟数据？':'生成模拟回收数据？'))return;
        const plan=byId('plans',id);
        await command('metrics.simulate',id,{confirmSimulation:true,replace});
        await navigate(`/campaigns/${plan.campaignId}/learn`);
      }
      if(action==='simulate-launch'){
        const plan=byId('plans',id);
        await command('plan.simulate-launch',id);
        await navigate(`/campaigns/${plan.campaignId}/launch?view=mapping`);return;
      }
      if(action==='manual-launch')await command('plan.manual',id);
      if(action==='toggle-connection')await command('connection.toggle',id,{status:button.dataset.status});
      if(action==='adopt-conclusion'||action==='ignore-conclusion')await command('conclusion.adopt',id,{status:action==='adopt-conclusion'?'adopted':'dismissed'});
      if(action==='delete-brand-asset'&&await confirmAction('如果已被历史快照或配置引用，将不能删除该记录。','删除品牌素材记录？'))await command('brandAsset.remove',id);
      if(action==='delete-memory'){
        const brand=byId('brands',button.dataset.brand);
        if(await confirmAction('这条长期记忆将不再影响未来 Campaign，历史 Campaign 保持不变。','删除 Brand Memory？'))await command('brandMemory.remove',brand.id,{memoryId:id});
      }
      if(action==='retry'||action==='cancel'){
        await command(`job.${action}`,id);
        if(action==='retry'){
          const job=byId('jobs',id);
          if(['video','storyboard'].includes(job.type))void watchGeneration(id,job.type);
          if(job.type==='production')void watchProduction(id);
          if(job.type==='product_import')void watchProductImport(id);
          if(['discovery','cards'].includes(job.type))void beginPreparation(job.campaignId);
        }
      }
      if(action==='archive'&&await confirmAction('归档后保留策略、素材和任务记录。','归档 Campaign'))await command('campaign.archive',id);
      if(action==='reset-brand'&&await confirmAction('清空长期品牌事实和显性记忆。已固定的 Campaign 快照与历史素材仍保留。','重置品牌记忆'))await command('brand.reset',id,{confirm:true});
      render();
    }catch(e){discoveryRunning.delete(id);toast(e.message,true);}finally{busy=false;button.disabled=false;button.removeAttribute('aria-busy');}
  }));
  document.querySelectorAll('[data-export]').forEach(a=>a.addEventListener('click',e=>{
    e.preventDefault(); const item=byId(a.dataset.export,a.dataset.id),mode=a.dataset.exportMode;
    if(!item)return toast('导出对象不存在，请刷新后重试。',true);
    let payload=item,name=`orynt-${a.dataset.export}-${item.id}.json`;
    if(a.dataset.export==='cards'&&mode==='creative'){payload={id:item.id,version:item.version,title:item.title,claim:item.claim,audience:item.audience,creativeRoute:item.creativeRoute,risksAndBoundaries:item.risksAndBoundaries,quality:item.quality};name=`orynt-creative-brief-${item.id}.json`;}
    if(a.dataset.export==='cards'&&mode==='campaign'){payload={...item,launchDirection:{channel:item.applicability.channel,market:item.applicability.market,metric:'CTR'},testHypothesis:item.testHypothesis};name=`orynt-campaign-brief-${item.id}.json`;}
    const url=URL.createObjectURL(new Blob([JSON.stringify({notice:'本地策略草案；证据仅为已标注的小样本，尚未经投放验证。',...payload},null,2)],{type:'application/json'}));
    const download=document.createElement('a');download.href=url;download.download=name;download.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }));
  $('#template-video-import')?.addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;const uploadRoute=currentRoute(),angleId=e.target.dataset.angle,extension=file.name.split('.').at(-1)?.toLowerCase(),mime=file.type||({mp4:'video/mp4',webm:'video/webm'})[extension];if(!['video/mp4','video/webm'].includes(mime)||file.size>20*1024*1024)return toast('参考模板仅支持 20 MB 以内、最长 90 秒的 MP4 或 WebM。',true);e.target.disabled=true;try{const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});const queued=await command('template.import',e.target.dataset.package,{angleId,filename:file.name,mime,base64});render({preserveEdits:true});const completed=await waitForJob(queued.jobId,{timeoutMs:140_000,onState:state=>patchJobState(state,queued.jobId)});data=completed.state;templateSelections.set(angleId,queued.templateId);if(currentRoute()===uploadRoute){dirty=true;render({preserveEdits:true});const selection=$('#config-form [name=templateId]');if(selection)selection.value=queued.templateId;dirty=!saveCreatorDraft($('#config-form'));updateSaveState();}toast('参考视频已分析完成，下一次生成会使用它的镜头节奏。');}catch(error){await refreshState();render({preserveEdits:true});toast(error.message,true);}});
  $('#video-import')?.addEventListener('change',async e=>{
    const input=e.target,file=input.files[0];if(!file||busy)return;
    const extension=file.name.split('.').at(-1)?.toLowerCase(),mime=file.type||({mp4:'video/mp4',webm:'video/webm'})[extension];
    if(!['video/mp4','video/webm'].includes(mime)||file.size>20*1024*1024)return toast('仅支持 20 MB 以内的 MP4 或 WebM。',true);
    const packageId=input.dataset.package,angleId=input.dataset.angle;busy=true;input.disabled=true;toast('正在导入视频…');
    try{
      let configId=input.dataset.config;
      const form=$('#config-form');
      if(form){const fields=Object.fromEntries(new FormData(form)),config=data.configs.filter(x=>x.packageId===packageId&&x.angleId===angleId).at(-1);configId=await saveGenerationConfig({command,packageId,angleId,fields,brandAssetIds:[...(brandAssetSelections.get(packageId)||[])],config});}
      if(!configId)throw new Error('请先保存并预览画面脚本，再导入成片。');
      const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
      await command('asset.import',configId,{angleId,filename:file.name,base64});const pack=byId('packages',packageId);dirty=false;
      await navigate(`/campaigns/${pack.campaignId}/create?cardId=${pack.cardId}&cardVersion=${pack.cardVersion}&angleId=${angleId}&view=results`);toast('视频已导入，可以预览或继续模拟测试。');
    }catch(error){toast(error.message,true);}finally{busy=false;if(input.isConnected){input.disabled=false;input.value='';}}
  });
  $('#brand-asset-import')?.addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;const uploadRoute=currentRoute();try{const result=await uploadBrandAsset(file,e.target.dataset.brand);const selected=brandAssetSelections.get(e.target.dataset.package)||new Set();selected.add(result.assetId);brandAssetSelections.set(e.target.dataset.package,selected);if(currentRoute()===uploadRoute)dirty=true;render({preserveEdits:true});if(currentRoute()===uploadRoute){dirty=!saveCreatorDraft($('#config-form'));updateSaveState();}toast('品牌素材已加入，下次生成时会一起保存选择。');}catch(error){toast(error.message,true);}});
  document.querySelectorAll('.settings-asset-import').forEach(input=>input.addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{const brandId=input.dataset.brand||input.closest('form')?.dataset.brand;if(!brandId)throw new Error('请先创建品牌，再添加素材。');await uploadBrandAsset(file,brandId);render({preserveEdits:true});toast('产品素材已保存在本机。');}catch(error){toast(error.message,true);}}));

}
async function uploadBrandAsset(file,brandId){
  if(file.size>5*1024*1024)throw new Error('品牌图片不能超过 5 MB。');
  const extension=file.name.split('.').at(-1)?.toLowerCase(),mime=file.type||({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',svg:'image/svg+xml'})[extension];
  if(!['image/png','image/jpeg','image/webp','image/svg+xml'].includes(mime))throw new Error('仅支持 PNG、JPG、WebP 或 SVG 图片。');
  const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
  return command('brandAsset.add',brandId,{name:file.name,mime,base64,type:/logo|标志/i.test(file.name)?'logo':'image'});
}
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
function restoreHistoryRoute(){
  const target=currentRoute();if(target===activeRoute)return;
  routeStates.set(activeRoute,{scrollY:window.scrollY});activeRoute=target;dirty=false;routeRecoveryMessage='';render();
  const saved=routeStates.get(target);requestAnimationFrame(()=>window.scrollTo(0,saved?.scrollY||0));
}
window.addEventListener('popstate',restoreHistoryRoute);
window.addEventListener('hashchange',restoreHistoryRoute);
window.addEventListener('keydown',e=>{
  if($('#confirm-dialog').open)return;
  if(e.key==='Escape'&&drawer){e.preventDefault();toggleTaskDrawer();return;}
  if(e.key==='Tab'&&drawer){
    const controls=[...document.querySelectorAll('.task-drawer a,.task-drawer button:not(:disabled)')].filter(el=>el.getClientRects().length),first=controls[0],last=controls.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
  }
});
async function boot() {
  try {
    const demoPromise=readDemoCase().catch(()=>null);
    const initialized=await initializeApi();data=initialized.state;
    let draftStorage;try{draftStorage=window.localStorage;}catch{/* Private browser settings can disable storage access. */}
    creatorDrafts=createDraftStore(draftStorage,data.workspace.id);
    const draft=creatorDrafts.read('start');newCampaignSource=draft.source==='existing'&&data.brands.length?'existing':'website';newCampaignUrl=draft.brandUrl||'';selectedBrandId=draft.brandId||null;
    newCampaignDraft={name:draft.name||'',objective:draft.objective||'让用户更快理解产品卖点',product:draft.product||'',mode:draft.mode||'standard'};render();
    void demoPromise.then(demo=>{demoCase=demo;if(demo)render({preserveEdits:true});});
    for(const job of data.jobs.filter(j=>['storyboard','video'].includes(j.type)&&['queued','running'].includes(j.status)))void watchGeneration(job.id,job.type);
    for(const job of data.jobs.filter(j=>j.type==='production'&&['queued','running'].includes(j.status)))void watchProduction(job.id);
    for(const job of data.jobs.filter(j=>j.type==='product_import'&&['queued','running'].includes(j.status)))void watchProductImport(job.id);
    const campaign=data.campaigns.find(c=>currentPath()===`/campaigns/${c.id}/discover`&&currentRoute().includes('view=preparing'));
    if(campaign&&forCampaign('jobs',campaign).some(j=>['discovery','cards'].includes(j.type)&&['queued','running'].includes(j.status)))void beginPreparation(campaign.id);
  } catch (error) {
    $('#app').innerHTML=`<main class="boot-error"><h1>工作台暂时未能加载</h1><p>${esc(error.message)}</p><p>请检查网络后重试，已保存的项目不会丢失。</p><a class="button" href="${esc(location.href)}">重新加载</a></main>`;
  }
}
void boot();
