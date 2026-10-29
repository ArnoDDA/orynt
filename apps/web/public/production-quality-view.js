const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderPlanChecks(report, editPath) {
  if (!report) return '';
  const messages = report.valid ? report.warnings : report.errors;
  return `<details class="production-plan-checks" ${report.valid ? '' : 'open'}><summary>${report.valid ? messages.length ? '生成前建议 · 可以继续，补充后更容易控制画面' : '脚本结构检查通过 · 画面效果仍需生成后确认' : '先调整脚本，再生成画面'}</summary>
    ${messages.length ? `<ul>${messages.map(item => `<li>${esc(item.message)}</li>`).join('')}</ul>` : '<p>分镜描述与时间安排完整。</p>'}
    <p class="help">这里只检查脚本与素材安排，不代表成片质量通过。镜头设计为可选项。</p>
    ${editPath ? `<a class="text-button" data-nav href="#${esc(editPath)}">返回调整镜头脚本 →</a>` : ''}</details>`;
}

export function renderDeliveryChecks(report) {
  if (!report) return '';
  return `<details class="production-plan-checks" ${report.valid ? '' : 'open'}><summary>${report.valid ? '合成素材检查通过 · 仍需观看成片' : '合成素材检查未通过'}</summary>
    <p>检查通过的视频素材：${Number(report.motionSeconds || 0).toFixed(1)} / ${Number(report.totalSeconds || 0).toFixed(1)} 秒。产品原图收尾单独计算。</p>
    ${report.errors?.length ? `<ul>${report.errors.map(item => `<li>${esc(item.message)}</li>`).join('')}</ul>` : ''}
    <p class="help">${esc(report.note)}</p></details>`;
}
