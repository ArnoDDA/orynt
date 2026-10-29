import { renderShotDirectionEditor } from './shot-direction-view.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const keyframeUrl=(request,shot,frame=shot.keyframe)=>`/api/productions/${request.id}/shots/${shot.index}/keyframe?shotVersion=${shot.version}&version=${frame.version}`;

export function renderKeyframeReview(request,shot,{canAct=true,canApprove=canAct}={}) {
  const replay=Boolean(request.replay);
  if(replay) {
    const frame=shot.keyframe,ready=frame.status==='ready' && frame.sha256 && !frame.technical?.issues?.length;
    return `<section class="production-first keyframe-review"><div class="production-player"><img class="production-keyframe" src="${keyframeUrl(request,shot)}" alt="镜头 ${shot.index+1} 的真实生成静帧"></div><aside><span class="maker-kicker">镜头 ${shot.index+1} · 已保存的真实静帧</span><h2>先确认这张画面</h2><p>${esc(shot.text)}</p><div class="production-review-hint"><strong>产品、构图和光线是否合适？</strong><p>检查同款黑色水杯的瓶盖、提环、标识与比例，以及场景是否契合随身出行方向。</p></div><p class="production-file-check">${frame.technical?.width} × ${frame.technical?.height} · 静帧 v${frame.version}</p>${ready&&canAct&&canApprove?`<button class="button wide" type="button" data-action="approve-production-keyframe" data-id="${request.id}" data-index="${shot.index}" data-version="${frame.version}" data-shot-version="${shot.version}">画面可以，查看视频 →</button>`:''}<p class="help">此图此前已通过官网产品图参考生成。本轮确认后加载对应的真实视频，不重新生成，不消耗额度。</p></aside></section>`;
  }
  const f=shot.keyframe,local=request.production?.productTreatment==='local_product_overlay',productReference=request.production?.productTreatment==='product_reference';
  const verified=!productReference||f.providerState?.productReferenceEvidence?.status==='product_reference_confirmed';
  const ready=Boolean(f.sha256)&&f.status==='ready'&&f.technical&&!f.technical.issues.length&&(!local||Boolean(f.productPreview))&&verified;
  const received=Boolean(f.sha256)&&(!local||Boolean(f.productPreview)),generated=Boolean(f.providerState?.url);
  return `<section class="production-first keyframe-review"><div class="production-player">${received?`<img class="production-keyframe" src="${keyframeUrl(request,shot)}" alt="镜头 ${shot.index+1} 的画面预览，第 ${f.version} 版">`:`<div class="production-waiting"><h2>${generated?'图片已生成，尚未接收完成':'关键帧尚未完成'}</h2><p>视频镜头尚未开始生成。</p></div>`}</div><aside>
    <span class="maker-kicker">镜头 ${shot.index+1} · ${received?(local?'产品合成预览':'生成图片'):'图片准备'} v${f.version}</span>
    <h2>${ready?'先确认这张画面':received?'图片未通过文件检查':generated?'先恢复图片接收':'先完成图片准备'}</h2>
    <div class="production-review-hint"><strong>${ready?(local?'产品是否正确、完整，位置是否合适？':'主体、构图和光线是否合适？'):'当前还不能确认画面'}</strong><p>${ready?(local?'这里已经叠加你的真实产品原图。确认后，视频使用相同的产品图和排版，背景可以运动；产品主体保持静态。':'满意后，用这张图片制作视频；不满意可以调整并重新出图。'):generated?'生成回执已保留。继续未完成步骤会先接收并检查已有图片，不会重新提交出图。':'先恢复图片准备，完成文件检查后再确认画面。'}</p></div>
    ${f.technical?`<p class="production-file-check">${local?f.productPreview?.composition?.width||f.technical.width:f.technical.width} × ${local?f.productPreview?.composition?.height||f.technical.height:f.technical.height} · ${local?'合成预览':'关键帧'} v${f.version}${f.technical.issues.length?' · 文件检查未通过':''}</p>`:''}
    ${productReference?`<p class="production-reference-status">${verified?'回执已证实使用官网产品图。请核对瓶盖、提环、标识和颜色，并判断场景是否表达选定的广告方向。':'尚未证实产品图进入生图工具，已停止继续视频。'}</p>`:''}
    ${ready&&canAct&&canApprove?`<button class="button wide" type="button" data-action="approve-production-keyframe" data-id="${request.id}" data-index="${shot.index}" data-version="${f.version}" data-shot-version="${shot.version}">${local&&shot.reusedFrom?'画面可以，合成已有镜头':'画面可以，制作视频'} →</button>`:''}
    <details class="production-revise"><summary>查看镜头脚本与生成记录</summary><p class="help">${esc(shot.text)}</p><p class="help">${local?'产品原图只在本机合成，不发送给生成服务。视频服务接收的是未叠加产品的背景首帧；不是让模型重新画产品，也不支持手持、开盖等实物动作。':productReference?'已获准的官网公开产品图用于场景参考生成；局部细节可能被重绘，须人工核对。确认后图片作为视频首帧，未自动提交视频。':'图片由 YouMind 生成并保存在本机；产品原图仍仅用于本地收尾。是否实际绑定为视频首帧，以后续服务回执为准。'}</p></details>
    ${canAct&&!replay?`<details class="production-revise"><summary>${received?'画面不合适？调整后重新出图':'需要更换方案？重新出图'}</summary><form class="production-keyframe-form" data-request="${request.id}" data-index="${shot.index}" data-version="${f.version}" data-shot-version="${shot.version}"><label>希望画面怎么改？<textarea name="text" maxlength="600" rows="4" required>${esc(shot.text)}</textarea></label>${renderShotDirectionEditor(shot.direction,'direction',{localProduct:local})}<p class="help">会提交一次新的图片生成，可能消耗服务额度；已有图片与回执保留。这一步不生成视频。</p><button class="button secondary" type="submit">${received?'不采用这张，重新出图':'放弃恢复，重新出图'}</button></form></details>`:''}
    ${f.history?.length?`<details class="production-revise"><summary>之前未采用的 ${f.history.length} 张图片</summary><div class="keyframe-candidates">${f.history.filter(c=>c.sha256).map(c=>`<a href="${keyframeUrl(request,shot,c)}" target="_blank" rel="noreferrer"><img src="${keyframeUrl(request,shot,c)}" alt="未采用的关键帧 v${c.version}"><span>v${c.version} · 未采用</span></a>`).join('')}</div></details>`:''}
  </aside></section>`;
}

export function renderReferenceStatus(shot) {
  if(shot.replay)return '<p class="production-reference-status">本轮加载已保存的真实素材 · 未提交新的生成任务</p>';
  if(!shot.keyframe)return '';
  if(shot.productComposition)return `<p class="production-reference-status">真实产品原图已在本机合成 · 产品保持静态 · 背景首帧 v${shot.keyframe.version}</p>`;
  if(!shot.submissionStartedAt&&!shot.providerState?.chatId)return `<p class="production-reference-status">${shot.keyframe.review?.status==='accepted'?'关键帧已确认，等待提交视频':shot.keyframe.status==='ready'?'关键帧待确认':'等待关键帧'} · 关键帧 v${shot.keyframe.version}</p>`;
  const status=shot.providerState?.controlEvidence?.status;
  const label=status==='first_frame_confirmed'?'服务回执已确认：图片作为首帧输入':status==='reference_confirmed'?'服务已使用参考图，未确认首帧绑定':'已提供参考图，尚未核验首帧绑定';
  return `<p class="production-reference-status">${label} · 关键帧 v${shot.keyframe.version}</p>`;
}
