import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPlanChecks, renderDeliveryChecks } from '../public/production-quality-view.js';

test('quality advice is readable and does not present a heuristic score as film quality', () => {
  const html = renderPlanChecks({ valid: true, errors: [], warnings: [{ message: '镜头 1 建议补充主体动作 <script>bad()</script>' }], risk: { average: 4.9, verdict: 'fail' } }, '/create?view=setup');
  assert.match(html, /可以继续/);
  assert.match(html, /镜头设计为可选项/);
  assert.match(html, /返回调整镜头脚本/);
  assert.doesNotMatch(html, /<script>|4\.9|fail/);
  assert.match(html, /&lt;script&gt;/);
  const blocked = renderPlanChecks({ valid: false, errors: [{ message: '前两个镜头重复' }], warnings: [] });
  assert.match(blocked, /open.*先调整脚本/s);
  const delivery = renderDeliveryChecks({ valid: true, motionSeconds: 11, totalSeconds: 15, note: '动作自然度仍需人工确认。' });
  assert.match(delivery, /11\.0 \/ 15\.0 秒/);
  assert.match(delivery, /仍需观看成片/);
});
