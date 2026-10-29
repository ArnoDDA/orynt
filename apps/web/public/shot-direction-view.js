import { shotDirectionFields, shotDirectionFieldName, normalizeShotDirection } from '../../../packages/domain/src/shot-direction.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderShotDirectionEditor(direction, prefix = 'direction', {localProduct=false} = {}) {
  const filled = Object.keys(normalizeShotDirection(direction)).length;
  return `<details class="shot-design"><summary>镜头设计 <span>${filled ? `已设置 ${filled} 项` : '可选'}</span></summary>
    <p class="help">${localProduct?'本版只使用光线与色调要求生成背景；产品位置由本地排版决定，主体静态、机位固定。已有动作方案保留，但不会交给模型执行。':'需要更精确地控制画面时再调整。这里记录文字方案；关键帧图片会在制作时单独生成并确认。'}</p>
    <div class="shot-design-fields">${shotDirectionFields.map(({ key, label, hint }) => localProduct&&key!=='lighting'?`<input type="hidden" name="${shotDirectionFieldName(prefix,key)}" value="${esc(direction?.[key])}">`:`<label>${label}<textarea name="${shotDirectionFieldName(prefix, key)}" maxlength="400" rows="2" placeholder="${esc(hint)}">${esc(direction?.[key])}</textarea></label>`).join('')}</div>
  </details>`;
}

export function renderShotDirectionSummary(direction) {
  const fields = shotDirectionFields.filter(({ key }) => direction?.[key]);
  return fields.length ? `<dl class="shot-design-summary">${fields.map(({ key, label }) => `<div><dt>${label}</dt><dd>${esc(direction[key])}</dd></div>`).join('')}</dl>` : '';
}
