const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderProductDossier(dossier) {
  if (!dossier) return '';
  const attributes = dossier.facts.filter(f => f.id.startsWith('attribute_'));
  return `<section class="product-understanding" aria-label="产品资料整理"><header><span class="maker-kicker">从网页到制作</span><h2>我们会怎样呈现这个产品</h2></header>
    <p><strong>${esc(dossier.product || '先核对产品名称')}</strong> · ${esc(dossier.category.label)}<small>品类为初步判断，可通过修改产品资料纠正。</small></p>
    ${dossier.materialCoverage ? `<p class="material-coverage">找到 ${dossier.materialCoverage.availableImages} 张商品图片 · 已选 ${dossier.materialCoverage.selectedImages} 张${dossier.materialCoverage.videos ? ` · ${dossier.materialCoverage.videos} 个官网视频链接` : ''}</p>${dossier.materialCoverage.variantCheckRequired ? '<p class="help">请核对所选图片是否为同一颜色和款式；未自动进行视觉识别。</p>' : ''}` : ''}
    <p>${['apparel','beauty','electronics','software'].includes(dossier.category.id) ? '这类产品需要真实素材说明外观或功能。生成画面只承担辅助情境，不能代替实物演示。' : '先用具体使用情境吸引注意，再用真实产品图明确商品与品牌。'}</p>
    ${attributes.length ? `<details><summary>网页还提供了 ${attributes.length} 项商品属性 · 待核对</summary><dl>${attributes.map(a => `<div><dt>${esc(a.label)}</dt><dd>${esc(a.value)}</dd></div>`).join('')}</dl><p class="help">这些属性不自动写入广告字幕，也不作为效果证明。</p></details>` : ''}
    ${dossier.missing.length ? `<p class="help">还需留意：${dossier.missing.map(esc).join('；')}。</p>` : '<p class="help">产品资料与收尾图片已具备，可以继续安排广告。</p>'}
  </section>`;
}

export function renderAdvertisingPlan(card) {
  const plan = card?.advertisingPlan;
  if (!plan) return '';
  const basis = plan.marketBasis, visual = plan.visualBrief;
  return `<section class="product-understanding advertising-approach" aria-label="本条广告制作方案"><header><span class="maker-kicker">本条广告的思路</span><h2>${esc(plan.name || plan.route.label)}</h2><span class="plan-basis-label">${basis?.status === 'public_copy_observation' ? '参考公开广告表达' : '产品资料推导 · 待验证'}</span></header>
    <dl><div><dt>希望谁产生兴趣</dt><dd>${esc(plan.audience)}${plan.audienceBasis === 'creative_hypothesis' ? '<small>建议测试人群，并非已验证受众。</small>' : ''}</dd></div><div><dt>这条广告讲什么</dt><dd>${esc(plan.focus.value)}</dd></div><div><dt>这次要验证什么</dt><dd>${esc(plan.hypothesis)}</dd></div></dl>
    ${basis ? `<div class="plan-market-basis"><h3>为什么尝试这个方向</h3><p>${esc(basis.explanation)}</p>${basis.samples.map(s => `<blockquote><p>“${esc(s.quote)}”</p><footer>${esc(s.advertiser || '公开广告')} · <a href="${esc(s.sourceUrl)}" target="_blank" rel="noreferrer">查看样本 ↗</a>${s.observedAt ? ` · 采集于 ${esc(s.observedAt.slice(0, 10))}` : ''}</footer></blockquote>`).join('')}<small>${esc(basis.limitation)}</small></div>` : ''}
    ${visual ? `<div class="plan-visual-brief"><h3>准备怎样拍</h3><dl><div><dt>场景</dt><dd>${esc(visual.setting)}</dd></div><div><dt>光线与色调</dt><dd>${esc(visual.palette)}</dd></div></dl><p class="help">${esc(visual.rationale)}</p></div>` : ''}
    <details><summary>制作方式与素材分工</summary><p>${esc(plan.route.reason)}</p><p>${esc(plan.execution.label)}</p>
    <ol class="plan-material-roles">${plan.shots.map(s => `<li><strong>${s.index + 1}. ${esc(s.title)}${s.timing ? ` · ${esc(s.timing)}` : ''}</strong><span>${s.source === 'local_product_image' ? '真实产品图 · 在本机合成' : s.source === 'continuing_video' ? '延续上一镜头 · 本地动态字幕' : s.source === 'recorded_product_reference' ? '官网产品图参考 · 已保存的真实生成镜头' : '生成情境 · 不作为商品实物证明'}</span>${s.screenCopy ? `<p>${esc(s.description)}</p><p>屏幕文案：${esc(s.screenCopy)}</p>` : ''}</li>`).join('')}</ol>
    </details>
    <p class="help">${esc(card.planningNotice || '方案仍可修改，请核对具体动作与表达。')}</p>
    <details><summary>制作边界与资料来源</summary>${plan.limitations.map(t => `<p>${esc(t)}</p>`).join('')}${card.productDossier?.facts?.filter(f => plan.focus.factIds.includes(f.id)).map(f => `<p>${esc(f.label)}：${esc(f.value)} · ${f.confirmation === 'confirmed' ? '用户已确认' : '待确认'}</p>`).join('')}</details>
  </section>`;
}

export function renderMarketBrief(brief) {
  if (!brief) return '';
  return `<section class="market-brief" aria-label="市场参考整理"><div><span class="maker-kicker">广告方向的依据</span><h2>${brief.observations.length ? `从 ${brief.samples.length} 条相关公开文案中整理方向` : '暂未找到足够的相关市场表达'}</h2><p>${brief.observations.length ? '把样本中的表达转成新的广告构思。你可以检查来源，再选择适合本产品的方向。' : '下方先提供基于商品资料的创意假设。可以继续补充参考，不会将它们标成市场结论。'}</p></div>${brief.observations.length ? `<ul>${brief.observations.map(o => `<li>${esc(o.statement)}</li>`).join('')}</ul>` : ''}<small>当前只分析文案与格式标记；尚未分析视频画面，也没有广告效果数据。</small></section>`;
}
