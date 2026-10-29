const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
import { renderProductDossier } from './product-plan-view.js';
const sourceNames = { schema_product:'商品信息', schema_description:'商品描述', schema_brand:'商品品牌', product_data:'商品详情数据', page_title:'网页标题', page_description:'网页简介', site_name:'网站名称' };

function materialGallery(imported, snapshot, campaign, chosen, disabled) {
  const variantUrl=id=>{try{const u=new URL(imported.sourceUrl);u.searchParams.set('variant',id);return u.href;}catch{return '';}};
  return `<h2 lang="en">Product Assets</h2><p class="muted">选择同一款式的主图、角度和细节图。图片用途与款式来自页面标记，仍需你核对。</p>
    ${imported.variants?.length > 1 ? `<details class="import-notes"><summary>商品款式 · ${esc(imported.variants.find(v=>v.selected)?.name || '尚未指定')}</summary><div class="product-candidate-list">${imported.variants.map(v=>`<button type="button" class="button secondary" data-action="start-product-import" data-id="${campaign.id}" data-product-url="${esc(variantUrl(v.id))}" ${disabled||snapshot.confirmation!=='pending'||v.selected?'disabled':''}>${esc(v.name||v.id)}${v.selected?' · 当前款式':''}</button>`).join('')}</div></details>` : ''}
    <div class="import-image-grid">${(imported.images||[]).map((im,i)=>`<label class="import-image-option"><img loading="lazy" src="/api/product-imports/${encodeURIComponent(snapshot.id)}/images/${encodeURIComponent(im.id)}" alt="${esc(im.alt||`候选产品图 ${i+1}`)}"><span><input type="checkbox" name="importImageIds" value="${esc(im.id)}" ${chosen.has(im.id)?'checked':''} ${disabled||im.identityStatus==='other_variant'?'disabled':''}>使用图片 ${i+1}</span><small>${esc(im.variantName||'页面未标明具体款式')}${im.identityStatus==='other_variant'?' · 其他款式，请先切换':im.identityStatus==='selected_variant'?' · 当前款式':' · 请核对'}<br>${esc(im.alt||'可作外观或构图参考，未自动识别画面内容。')}</small></label>`).join('')||`<div class="import-no-images">${imported.status==='reading'?'正在查找候选产品图…':'暂无可用图片，可以上传自己的产品图。没有图片也能先看脚本。'}</div>`}</div>
    ${imported.videos?.length ? `<details class="import-notes"><summary>官网已有视频 · ${imported.videos.length} 个链接</summary><p>可打开核对使用方式；当前只找到视频链接，尚未下载或分析画面。</p>${imported.videos.map((v,i)=>`<a class="source-link" href="${esc(v.url)}" target="_blank" rel="noreferrer">查看官网视频 ${i+1} ↗</a>`).join('')}</details>` : ''}`;
}

export function importedProductValues(snapshot, brief, brand, draft = {}) {
  const imported = snapshot.productImport;
  const values = { ...snapshot.facts, ...brief, product: brief.product || snapshot.facts.product || '', claim:snapshot.facts.claim || '', brandName:snapshot.brandName||brand.name };
  if(snapshot.confirmation === 'pending')Object.assign(values,{product:brief.product||'',claim:'',audience:brief.audience||''});
  if(snapshot.confirmation === 'pending') for(const [key, field] of Object.entries(imported?.fields || {})) values[key]=field.value;
  return { ...values, ...(!snapshot.frozenAt ? draft : {}) };
}

export function productDraftEdits(fields, snapshot, brief, brand) {
  const baseline = importedProductValues(snapshot, brief, brand);
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => !['brandName', 'product', 'claim'].includes(key) || value !== (baseline[key] || '')));
}

export function renderImportedProductReview(data, campaign, draft = {}) {
  const snapshot=data.snapshots.find(s=>s.id===campaign.brandSnapshotId), brief=data.briefs.find(b=>b.id===campaign.briefId), brand=data.brands.find(b=>b.id===campaign.brandId);
  const imported=snapshot.productImport, values=importedProductValues(snapshot,brief,brand,draft);
  const locked=Boolean(snapshot.frozenAt||campaign.archived), reading=imported.status==='reading'&&!locked;
  const confirmed=snapshot.confirmation!=='pending';
  const provenance=key=>{
    const field=imported.fields?.[key];
    if(reading)return '<small>正在从产品页查找…</small>';
    if(field&&values[key]!==field.value)return '<small class="import-provenance">你已修改 · 确认后保存</small>';
    return field ? `<small class="import-provenance">来自${sourceNames[field.sourceType]||'产品页'} · ${confirmed?'已核对':'请核对，可修改'}</small>` : '<small>网页未明确提供，可以自行填写。</small>';
  };
  const input=(label,key,area=false,required=false)=>`<label>${label}${area?`<textarea name="${key}" rows="4" maxlength="2000" ${required?'required':''}>${esc(values[key])}</textarea>`:`<input name="${key}" value="${esc(values[key])}" maxlength="${key==='brandName'?120:2000}" ${required?'required':''}>`}${provenance(key)}</label>`;
  const chosen=new Set(draft.importImageIds||imported.selectedImageIds||[]);
  const saved=data.brandAssets.filter(a=>a.brandId===brand.id&&a.status==='ready');
  return `<div class="maker-heading"><span class="maker-kicker" lang="en">01 / PRODUCT</span><h1>${reading?'Reading your product…':locked?'Product Profile':['failed','skipped'].includes(imported.status)?'Complete your product profile.':'Meet your product.'}</h1><p>${reading?'正在读取产品名称、官网描述和产品图，帮你准备好创作资料。':['failed','skipped'].includes(imported.status)?'暂未读取到完整资料。补充产品信息和图片后，可以继续制作。':'核对提取的产品信息和图片，确认表达重点，再选择广告创意。'}</p></div>
  <section class="import-status ${reading?'is-reading':''}" role="status"><span class="import-status-mark">${reading?'↻':imported.status==='failed'?'!':'✓'}</span><div><strong>${reading?'正在读取产品页':imported.status==='failed'?'这个网页暂时无法自动读取':imported.status==='skipped'?'手动填写产品资料':confirmed?'产品资料已确认':`已提取 ${Object.keys(imported.fields||{}).length} 项资料 · ${imported.images?.length||0} 张候选图`}</strong><p>${reading?'完成后会自动展示结果；也可以离开，稍后继续。':imported.status==='failed'?esc(imported.error?.message||'网页可能需要登录或浏览器加载。可以手动填写，或重新读取。'):imported.status==='skipped'?'填写产品名称和本次想表达的卖点即可继续。':'网页内容仍需你核对；只有确认的资料和选中的图片会保存到品牌。'}</p></div>${!locked&&!confirmed?`<button type="button" class="text-button" data-action="${reading?'skip-product-import':'start-product-import'}" data-id="${campaign.id}">${reading?'改为手动填写':'重新读取'}</button>`:''}</section>
  ${!reading && !locked && imported.pageKind !== 'product' && imported.details?.candidates?.length > 1 ? `<section class="product-understanding"><h2>先选一个具体产品</h2><p>这个页面包含多个商品。选定一个商品后会重新读取，避免把不同款式的图片和卖点混在一起。</p><div class="product-candidate-list">${imported.details.candidates.map(c => `<button type="button" class="button secondary" data-action="start-product-import" data-id="${campaign.id}" data-product-url="${esc(c.url)}">读取 ${esc(c.name)}</button>`).join('')}</div></section>` : ''}
  <form id="setup-form" class="maker-two-panel import-review" data-campaign="${campaign.id}"><section class="panel maker-product-form">${!reading ? renderProductDossier(snapshot.productDossier) : ''}<fieldset ${locked||reading?'disabled':''}>
  <div class="import-source"><span>产品来源</span><p>${esc(imported.sourceUrl||campaign.productUrl)}</p></div>
  ${!locked && imported.status === 'ready' && Object.entries(imported.fields || {}).some(([key, field]) => values[key] !== field.value) ? `<p class="import-disclaimer">已保留你的手动填写。也可以<button type="button" class="text-button" data-action="restore-imported-fields" data-id="${campaign.id}">使用网页提取的资料</button>。</p>` : ''}
  ${input('品牌名称','brandName')}${input('产品名称','product',false,true)}${input('这次广告想表达什么？','claim',true,true)}<p class="import-disclaimer">官网描述是品牌自述。可删去与本次广告无关的内容，不代表经过市场或效果验证。</p>
  <details class="maker-advanced"><summary>受众、渠道与其他要求（可选）</summary><label>想吸引谁？<input name="audience" value="${esc(values.audience)}" maxlength="2000" placeholder="例如：喜欢在家冲咖啡的人"><small>网页没有明确说明时不自动猜测，暂时留空也能继续。</small></label><label>渠道<select name="channel">${['Meta','TikTok'].map(v=>`<option ${values.channel===v?'selected':''}>${v}</option>`).join('')}</select></label><label>内容风格<select name="style">${['产品演示','产品实拍','真人 UGC','CGI','动效'].map(v=>`<option ${values.style===v?'selected':''}>${v}</option>`).join('')}</select></label><label>创作目标<input name="objective" value="${esc(values.objective)}" maxlength="2000"></label><label>不希望出现什么？<textarea name="limitations" maxlength="2000">${esc(values.limitations)}</textarea></label><input type="hidden" name="market" value="${esc(values.market)}"><input type="hidden" name="competitors" value="${esc(values.competitors)}"></details>
  </fieldset><div class="maker-step-footer"><span><strong>${reading?'稍等，正在读取产品资料':'下一步：发现广告机会'}</strong><small>整理产品事实与公开参考，再决定广告方向。</small></span>${locked?`<a class="button" data-nav href="#/campaigns/${campaign.id}/discover?view=opportunities">查看广告机会 →</a>`:`<button class="button" type="submit" ${reading?'disabled':''}>确认产品，发现机会 →</button>`}</div></section>
  <aside class="maker-product-assets">${materialGallery(imported,snapshot,campaign,chosen,locked||reading)}${saved.length?'<details class="import-notes"><summary>已保存的品牌素材</summary>':''}<div class="maker-image-grid">${saved.map(im=>`<figure><img loading="lazy" src="/api/brand-assets/${im.id}/preview" alt="${esc(im.name)}"><figcaption>${esc(im.name)}</figcaption></figure>`).join('')}</div>${saved.length?'</details>':''}${!locked?`<label class="maker-upload">＋ 上传自己的产品图<input class="settings-asset-import" data-brand="${brand.id}" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG / JPG / WebP，单张最多 5 MB</small></label>`:''}<details class="import-notes"><summary>本次读取情况与来源</summary><p>${esc(imported.sourceUrl)}</p>${(imported.limitations||[]).map(text=>`<p>${esc(text)}</p>`).join('')}<p>资料和图片保存在本机。官网公开图片可在后续经你允许后作为生成参考；本地上传图片不会自动外传。</p></details></aside></form>`;
}
