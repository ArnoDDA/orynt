import { renderShotDirectionEditor } from './shot-direction-view.js';
import { renderKeyframeReview, renderReferenceStatus, keyframeUrl } from './keyframe-view.js';
import { renderPlanChecks, renderDeliveryChecks } from './production-quality-view.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
const names={pending:'等待制作',planning:'正在准备图片',awaiting_keyframe_review:'等待确认图片',submitting:'正在提交',generating:'视频制作中',checking:'正在检查文件',ready:'镜头已完成',failed:'需要处理',local:'产品原图收尾'};
const preview=(request,shot)=>`/api/productions/${request.id}/shots/${shot.index}/preview?version=${shot.version}`;
const poster=(request,shot)=>`/api/productions/${request.id}/shots/${shot.index}/poster?version=${shot.version}`;
export const videoRecoveryTarget=request=>request?.production?.shots.find(s=>s.status==='failed'&&s.keyframe?.review?.status==='accepted'&&s.providerState?.chatId&&!s.providerState.url&&!s.base64);
export const videoRecoveryButton=request=>{
  const shot=videoRecoveryTarget(request);
  return shot?`<button type="button" class="button secondary" data-action="recover-production-video" data-id="${request.id}" data-index="${shot.index}" data-version="${shot.version}">核查并重试视频</button>`:'';
};

export function productionFocus(request, selected) {
  const p=request.production;
  if(selected==='final'&&p.phase==='completed')return 'final';
  if(selected!==undefined&&p.shots.some(s=>s.index===selected))return selected;
  if(p.phase==='completed')return 'final';
  const pendingFrame=p.shots.find(s=>s.keyframe&&s.keyframe.review?.status!=='accepted'&&['ready','failed'].includes(s.keyframe.status));
  if(pendingFrame)return pendingFrame.index;
  if(p.phase==='awaiting_review')return 0;
  return p.shots.find(s=>s.kind==='generated_shot'&&!['ready','local'].includes(s.status))?.index??0;
}

export function renderProductionProcess(request, job) {
  const p=request.production, generated=p.shots.filter(s=>s.kind==='generated_shot');
  const framed=generated.filter(s=>s.keyframe?.sha256).length, filmed=generated.filter(s=>s.technical&&!s.technical.issues?.length).length;
  const complete=p.phase==='completed'&&job.status==='succeeded';
  const reference=p.productTreatment==='product_reference'||request.replay;
  const stages=[
    ['image','产品素材',p.productImage ? '产品图已带入' : '等待产品素材',Boolean(p.productImage)],
    ['scan','静帧与构图',p.referenceMode==='generated_first_frame'?`${framed} / ${generated.length} 张静帧已接收`:'按镜头脚本制作视频',p.referenceMode==='generated_first_frame'&&generated.length>0&&framed===generated.length],
    ['video','运动镜头',`${filmed} / ${generated.length} 段视频已接收`,generated.length>0&&filmed===generated.length],
    ['scissors','剪辑成片',complete?'已保存成片':p.phase==='assembly'?(request.replay?'正在载入已保存剪辑':'正在合成字幕与配乐'):'等待镜头完成',complete]
  ];
  return `<section class="capability-process" aria-label="真实制作流程"><header><span class="opportunity-label">${request.replay?'RECORDED WORKFLOW / 真实结果回放':'PRODUCTION WORKFLOW / 制作流程'}</span><p>${request.replay?'以下状态来自本轮已接收的素材与确认记录，不会现场重新生成或剪辑。':reference?'以产品图约束画面，确认静帧与运动，再合成为广告。':'沿用本轮脚本和素材，逐镜头制作后剪辑成片。'}</p></header><ol>${stages.map(([glyph,title,detail,done])=>`<li class="${done?'is-done':''}"><span><i data-lucide="${glyph}" aria-hidden="true"></i></span><div><strong>${title}</strong><small>${esc(detail)}</small></div>${done?'<i data-lucide="check" aria-hidden="true"></i>':''}</li>`).join('')}</ol></section>`;
}

export function renderEditingWorkspace(request, {asset, editable=true} = {}) {
  const p=request.production, replay=Boolean(request.replay), total=p.shots.reduce((sum,s)=>sum+Math.max(0,Number(s.end)-Number(s.start)),0)||1;
  const copy=asset?.productionManifest?.copy || asset?.manifest?.copy || p.copy || {}, keys=['opening','detail','cta'];
  const canEdit=editable&&!replay&&p.phase==='completed'&&asset;
  const canFork=editable&&replay&&p.phase==='completed'&&asset;
  const sourceNotice=request.localEdit?`<div class="local-edit-notice"><div><strong>本地重剪 · 真实镜头复用</strong><p>${p.phase==='assembly'?'正在重新排版字幕与配乐，通常需要 1–3 分钟；可以先回看原版。':'这版修改了字幕与声音，原始镜头、原版广告和历史输出都保留。'}</p></div><button type="button" class="button secondary" data-action="view-edit-source" data-id="${esc(request.localEdit.sourceRequestId)}">回看原版 ${icon('arrow-up-right')}</button></div>`:'';
  const thumb=s=>s.kind==='continuing_video'?p.shots.find(v=>v.kind==='generated_shot'&&v.index===s.index-1):s;
  const image=s=>{const source=thumb(s);return source?.technical?poster(request,source):source?.keyframe?.sha256?keyframeUrl(request,source):s.kind==='product_endcard'?`/api/productions/${request.id}/product`:'';};
  return `<section class="editing-workspace" aria-label="剪辑与字幕工作区"><header class="capability-heading"><div><span class="opportunity-label">EDITING WORKSPACE</span><h2 lang="en">The Edit</h2><p>${replay?'查看这条已保存广告的画面编排、字幕和配乐。演示方案固定，修改后不能复用原成片。':canEdit?'查看编排，调整字幕与声音。重新剪辑会复用已有镜头，无需重新生成视频。':'先查看当前剪辑安排；镜头完成后，可调整字幕和声音并输出成片。'}</p></div><span class="editing-version">${replay?'已保存剪辑':`剪辑 v${Number(p.editVersion)||1}`} · ${total} 秒</span></header>
    ${sourceNotice}<div class="editing-timeline"><div class="editing-ruler"><span>0s</span><span>${total}s</span></div><div class="editing-track"><span><i data-lucide="film" aria-hidden="true"></i>画面</span><div class="editing-cuts">${p.shots.map(s=>`<button type="button" data-edit-duration="${Math.max(.01,Number(s.end)-Number(s.start))}" data-action="production-scene" data-id="${request.id}" data-index="${s.index}" aria-label="查看剪辑段落：${esc(s.title)}">${image(s)?`<img loading="lazy" src="${image(s)}" alt="">`:'<span class="editing-pending">待制作</span>'}<span><strong>${esc(s.title)}</strong><small>${s.start}–${s.end}s · ${s.kind==='continuing_video'?'延续上一镜头':s.kind==='product_endcard'?'产品图收尾':s.technical?'视频已接收':'等待视频'}</small></span></button>`).join('')}</div></div>
    <div class="editing-track"><span><i data-lucide="type" aria-hidden="true"></i>字幕</span><div class="editing-caption-cuts">${p.shots.map((s,i)=>`<div data-edit-duration="${Math.max(.01,Number(s.end)-Number(s.start))}"><small>${s.start}–${s.end}s</small><span>${esc(copy[keys[i]] || '本段无标题')}</span></div>`).join('')}</div></div><div class="editing-track"><span><i data-lucide="audio-lines" aria-hidden="true"></i>声音</span><div class="editing-audio ${p.music==='none'?'is-silent':''}"><span>${p.music==='none'?'无声版本':'轻配乐 · 无旁白'}</span><small>${asset?'已包含在成片中':'计划在剪辑时加入'}</small></div></div></div>
    ${asset?`<div class="editing-playback"><button class="button secondary" type="button" data-action="production-scene" data-id="${request.id}" data-index="final">播放完整剪辑 <i data-lucide="play" aria-hidden="true"></i></button><a class="text-button" href="/api/assets/${asset.id}/download" download>下载这版成片 <i data-lucide="download" aria-hidden="true"></i></a></div>`:''}
    ${canEdit||canFork?`<form id="${canFork?'production-fork-edit-form':'production-edit-form'}" class="editing-controls" data-request="${request.id}"><div><span class="opportunity-label" lang="en">MAKE IT YOURS</span><h3>同样的镜头，试试你的表达。</h3><p>${canFork?'复用真实镜头，另存剪辑版本；原版保留，不消耗生成额度。':'字幕和声音在本机重新剪辑；历史成片保留，新版需要重新检查。'}</p>${request.localEdit?'<span class="opportunity-basis">本地重剪版本 · 真实生成镜头复用</span>':''}</div><fieldset>${[['opening','开场标题',70],['detail','第二幕标题',70],['cta','收尾引导',24]].map(([key,label,max])=>`<label>${label}<input name="${key}" maxlength="${max}" value="${esc(copy[key])}" ${key==='detail'?'':'required'}></label>`).join('')}<label>声音<select name="music"><option value="ambient" ${p.music!=='none'?'selected':''}>轻配乐 · 无旁白</option><option value="none" ${p.music==='none'?'selected':''}>无声</option></select></label><button type="submit" class="button">${canFork?'另存并输出新版本':'保存并重新剪辑'} <i data-lucide="scissors" aria-hidden="true"></i></button><small>本地剪辑需要短暂等待，可以离开页面后回来查看。</small></fieldset></form>`:''}</section>`;
}

export function renderProduction({data,c,request,job,path,jobRow,selectedShot}) {
  const p=request.production,done=p.phase==='completed',asset=done&&data.assets.find(a=>a.id===request.assetId);
  const localProduct=p.productTreatment==='local_product_overlay', replay=Boolean(request.replay||request.localEdit);
  const failed=job.status==='failed',cancelled=job.status==='cancelled',active=['queued','running'].includes(job.status),editable=!c.archived;
  const focus=productionFocus(request,selectedShot),shot=p.shots.find(s=>s.index===focus);
  const pendingFrame=p.shots.find(s=>s.keyframe&&s.keyframe.review?.status!=='accepted'&&['ready','failed'].includes(s.keyframe.status));
  const frameReview=shot===pendingFrame&&(p.phase==='awaiting_keyframe_review'||failed);
  const waiting=p.phase==='awaiting_review',needsAttention=p.phase==='awaiting_keyframe_review'||waiting;
  const uncertain=['VIDEO_SUBMISSION_UNCERTAIN','KEYFRAME_SUBMISSION_UNCERTAIN'].includes(job.error?.code);
  const canMakeLocal=editable&&!replay&&!uncertain&&!localProduct&&p.productTreatment!=='product_reference'&&p.referenceMode==='generated_first_frame'&&['awaiting_review','completed','failed'].includes(p.phase)&&p.shots[0]?.technical&&!p.shots[0].technical.issues.length&&p.shots[0].keyframe?.sha256;
  const attentionIndex=pendingFrame?.index??0;
  const completedShots=p.shots.filter(s=>s.kind==='generated_shot'&&s.technical&&!s.technical.issues?.length).length;
  const recoverableFrame=p.shots.find(s=>s.keyframe?.providerState?.url&&!s.keyframe.sha256);
  const recoverableVideo=videoRecoveryTarget(request);
  const receivingFrame=active&&recoverableFrame&&p.phase!=='awaiting_keyframe_review';
  const recoveryTitle=completedShots?'已完成的镜头仍保留':recoverableFrame?'图片生成回执已保留，视频尚未开始':'制作记录已保留';
  const status=failed?'制作需要处理':cancelled?'制作已暂停':done?(asset?.qualityReview?.status==='accepted'?'成片已确认':'成片待检查'):p.phase==='awaiting_keyframe_review'?`镜头 ${attentionIndex+1} · 等待确认图片`:receivingFrame?'正在恢复图片接收':waiting?'首镜头 · 等待检查视频':p.phase==='assembly'?'正在剪辑成片':'镜头制作中';
  const selectButton=(index,label)=>`<button type="button" data-action="production-scene" data-id="${request.id}" data-index="${index}">${label}</button>`;
  const thumbnail=s=>s.kind==='continuing_video'&&p.shots[1].keyframe?.sha256?`<img src="${keyframeUrl(request,p.shots[1])}" alt="">`:s.kind==='product_endcard'?`<img src="/api/productions/${request.id}/product" alt="">`:s.technical?`<img src="${poster(request,s)}" alt="">`:s.keyframe?.sha256?`<img src="${keyframeUrl(request,s)}" alt="">`:`<span>0${s.index+1}</span>`;
  const railStatus=s=>s.kind==='continuing_video'?'动态画面与品牌收尾':s.keyframe?.status==='ready'&&s.keyframe.review?.status!=='accepted'?'图片待确认':esc(names[s.status]||s.status);
  const rail=`<nav class="production-rail" aria-label="镜头与成片"><h2 lang="en">Production Assets</h2>${p.shots.map(s=>`<button type="button" class="production-rail-shot" data-action="production-scene" data-id="${request.id}" data-index="${s.index}" aria-pressed="${focus===s.index}"><div class="production-rail-thumb">${thumbnail(s)}</div><div><strong>0${s.index+1} · ${esc(s.title)}</strong><small>${s.start}–${s.end} 秒</small><span>${railStatus(s)}</span></div></button>`).join('')}${asset?`<button type="button" class="production-rail-final" data-action="production-scene" data-id="${request.id}" data-index="final" aria-pressed="${focus==='final'}"><strong>完整广告</strong><small>${asset.qualityReview?.status==='accepted'?'已确认，可导出':'待检查成片'}</small></button>`:''}<a href="#${path}&view=setup" data-nav class="text-button">${replay?'查看已确认脚本':'编辑脚本与设置'}</a></nav>`;
  const revision=s=>replay?'':`<details class="production-revise"><summary>调整这个镜头</summary><form class="production-shot-form" data-request="${request.id}" data-index="${s.index}" data-version="${s.version}"><label>希望画面怎么改？<textarea name="text" rows="4" maxlength="600" required>${esc(s.text)}</textarea><small>只重做这个镜头，旧版本会保留。</small></label>${renderShotDirectionEditor(s.direction,'direction',{localProduct})}<button type="submit" class="button secondary">重新制作这个镜头</button></form></details>`;
  const history=s=>s.history?.length?`<details class="production-revise"><summary>镜头历史 · ${s.history.length} 个版本</summary>${s.history.map(t=>t.technical?`<a class="source-link" href="/api/productions/${request.id}/shots/${s.index}/preview?version=${t.version}" target="_blank" rel="noreferrer">查看 v${t.version}</a>`:`<p class="help">v${t.version} · ${esc(names[t.status]||t.status)}</p>`).join('')}</details>`:'';
  const final=asset?`<section class="production-final"><div class="production-player"><video controls playsinline preload="metadata" src="/api/assets/${asset.id}/preview"></video></div><aside><span class="maker-kicker" lang="en">FINAL CUT</span><h2>${esc(p.product)}</h2><p>${asset.technical?.width} × ${asset.technical?.height} · ${Number(asset.technical?.duration||0).toFixed(1)} 秒 · ${p.music==='none'?'无声':'轻配乐，无旁白'}</p><a class="button wide" href="/api/assets/${asset.id}/download" download>下载这版成片</a>
    ${asset.qualityReview?.status==='accepted'?(editable?(asset.status==='launch_ready'?`<a class="button secondary wide" data-nav href="#/campaigns/${c.id}/launch">继续模拟测试</a>`:`<button type="button" class="button secondary wide" data-action="launch-ready" data-id="${asset.id}">进入模拟测试</button>`):''):`<form id="production-review-form" data-asset="${asset.id}"><fieldset ${editable?'':'disabled'}><legend>看完整条视频后确认</legend>${[['identity','产品图、名称与品牌正确'],['motion','主体与动作自然，没有明显变形'],['copy','文案清楚，与产品资料一致'],['sound',p.music==='none'?'确认使用无声版本':'配乐音量和节奏合适']].map(([key,label])=>`<label class="production-check"><input type="checkbox" name="${key}" required>${label}</label>`).join('')}<button type="submit" class="button secondary wide">确认成片可用</button></fieldset></form>`}
    <details class="production-revise" open><summary>这版成片对应的策略与脚本</summary>${p.advertisingPlan ? `<p>${esc(p.advertisingPlan.focus?.value)}</p>` : ''}${p.shots.map((s,i)=>`<div><strong>${s.start}–${s.end} 秒 · ${esc(s.title)}</strong><p class="help">${esc(s.text)}</p><p>屏幕文案：${esc([p.copy.opening,p.copy.detail,p.copy.cta][i])}</p></div>`).join('')}<p class="help">${replay?'本条只有一个场景版，未制作 A/B 对照版。':'对应本轮制作保存的脚本；修改其他版本不会改变这条成片。'}</p></details>
    <p class="help">模拟测试不会发布真实广告。</p></aside></section>`:'';
  const closing=`<section class="production-first"><div class="production-player">${asset?`<video controls playsinline preload="metadata" src="/api/assets/${asset.id}/preview#t=11,15"></video>`:p.shots[1].keyframe?.sha256?`<img class="production-keyframe" src="${keyframeUrl(request,p.shots[1])}" alt="动态收尾使用的城市窗边画面">`:'<div class="production-waiting"><h2>等待前两个镜头确认</h2></div>'}</div><aside><span class="maker-kicker">11–15 秒 · 动态收尾</span><h2>让日常继续</h2><p>延续城市窗边的运镜，依次加入广告语、产品名和官网入口。没有切回静态产品图。</p><p class="help">${asset?'这里预览成片的最后四秒；完整广告中包含字幕与配乐。':'前两个镜头确认后，将显示已保存成片中的动态收尾。'}</p></aside></section>`;
  const current=frameReview?renderKeyframeReview(request,shot,{canAct:editable&&!cancelled&&!uncertain&&!shot.submissionStartedAt,canApprove:p.phase==='awaiting_keyframe_review'}):shot?.kind==='continuing_video'?closing:shot?`<section class="production-first"><div class="production-player">${shot.kind==='product_endcard'?`<img class="production-keyframe" src="/api/productions/${request.id}/product" alt="原始产品图">`:shot.technical?`<video controls playsinline preload="metadata" poster="${poster(request,shot)}" src="${preview(request,shot)}"></video>`:shot.keyframe?.sha256?`<img class="production-keyframe" src="${keyframeUrl(request,shot)}" alt="已生成的镜头图片">`:`<div class="production-waiting"><span class="production-orbit">◎</span><h2>${esc(names[shot.status]||'等待制作')}</h2><p>完成后，真实画面会显示在这里。</p></div>`}</div><aside><span class="maker-kicker">镜头 0${shot.index+1} · ${shot.technical?(localProduct?'本地合成视频':'生成视频'):shot.keyframe?.sha256?'生成图片':shot.kind==='product_endcard'?'原始产品图':'尚未生成'}</span><h2>${esc(shot.title)}</h2><p>${shot.kind==='product_endcard'?'使用真实产品图、品牌名和行动引导收尾。字幕会在合成成片时加入。':`${shot.start}–${shot.end} 秒 · ${shot.technical?'已有视频镜头':'按已保存的脚本制作'}`}</p>
    ${waiting&&shot.index===0?`<div class="production-review-hint"><strong>这个镜头可以用吗？</strong><p>${localProduct?'检查是否使用了正确产品、边缘是否完整、背景是否干扰主体。产品保持静态，之后会加入字幕。':'检查主体是否稳定、动作是否自然，以及是否有变形或穿帮。'}</p></div>${editable?`<button type="button" class="button wide" data-action="approve-production-shot" data-id="${request.id}" data-index="0" data-version="${shot.version}">镜头可用，继续制作</button>`:''}`:active?`<p class="production-live-status" role="status">${p.phase==='assembly'?'正在剪辑、添加字幕与配乐':needsAttention?'先确认待办镜头，再继续制作。':'当前制作会自动更新，可以稍后继续。'}</p>`:''}
    ${editable&&!uncertain&&shot.kind==='generated_shot'&&(waiting&&shot.index===0||['completed','failed'].includes(p.phase)&&['ready','failed'].includes(shot.status))&&(!shot.keyframe||shot.keyframe.review?.status==='accepted')?revision(shot):''}
    ${history(shot)}
    <details class="production-revise"><summary>镜头脚本与文件记录</summary><p class="help">${esc(shot.text)}</p>${shot.technical?`<p class="help">${shot.technical.width} × ${shot.technical.height} · ${shot.technical.duration.toFixed(1)} 秒 · v${shot.version}</p>`:''}${renderReferenceStatus(shot)}</details></aside></section>`:'';
  return `<section class="production-workspace"><header class="workspace-heading"><div><span class="maker-kicker" lang="en">04 / PRODUCTION STUDIO</span><h1>${esc(p.product)}</h1><p role="status">${status}</p></div><span class="production-summary">${p.shots.filter(s=>s.kind==='generated_shot'&&s.technical).length} / ${p.shots.filter(s=>s.kind==='generated_shot').length} 视频镜头完成</span></header>
    ${renderProductionProcess(request,job)}
    ${localProduct?`<div class="production-review-hint"><strong>真实产品原图 + AI 背景</strong><p>每个镜头都在本机叠加同一张产品原图，产品不会由模型重画。产品主体保持静态，不是手持、开盖等实物使用演示。${p.shots[0]?.reusedFrom?'首镜头复用已有背景，无需重新生成。':''}</p></div>`:canMakeLocal?`<div class="maker-recovery"><div><strong>当前版本只在收尾展示真实产品</strong><p>可以保留这版，另做一版本地产品合成：复用已有背景，在每个镜头加入产品原图。首镜头不消耗新的生成额度。</p></div><button type="button" class="button secondary" data-action="local-product-version" data-id="${request.id}">使用产品原图制作本地新版</button></div>`:''}
    ${failed||cancelled?`<div class="maker-recovery" role="alert"><div><strong>${recoveryTitle}</strong><p>${esc(job.error?.message||'可以继续未完成的步骤。')}</p>${recoverableVideo?'<p>先核查已有任务：有视频就接收，仍在生成就等待；仅在确认失败且没有视频时重新提交。保留已确认图片，重新提交可能消耗生成额度。</p>':''}</div>${editable&&!uncertain?(recoverableVideo?videoRecoveryButton(request):`<button type="button" class="button secondary" data-action="retry" data-id="${job.id}">${recoverableFrame?'继续接收已有图片':'继续未完成步骤'}</button>`):''}</div>`:''}
    ${needsAttention&&focus!==attentionIndex?`<div class="production-attention"><span>镜头 ${attentionIndex+1} ${waiting?'的视频':'的图片'}需要你确认，才能继续制作。</span>${selectButton(attentionIndex,'去确认 →')}</div>`:''}
    <div class="production-workbench">${rail}<div class="production-canvas">${focus==='final'?final:current}</div></div>
    ${renderEditingWorkspace(request,{asset,editable})}
    ${p.qualityChecks?`<details class="maker-advanced production-quality-details"><summary>素材检查与制作建议 <span>可选查看</span></summary>${renderPlanChecks(p.qualityChecks.plan,`${path}&view=setup`)}${renderDeliveryChecks(p.qualityChecks.delivery)}</details>`:''}
    <details class="maker-advanced"><summary>制作任务与版本记录</summary>${editable&&!uncertain?jobRow(job):'<p class="help">本次制作记录已保留。</p>'}<p class="help">文件检查不代表画面质量通过；图片、镜头与成片均保留人工确认记录。</p></details></section>`;
}
