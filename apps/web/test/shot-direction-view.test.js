import test from 'node:test';
import assert from 'node:assert/strict';
import { renderShotDirectionEditor, renderShotDirectionSummary } from '../public/shot-direction-view.js';

test('shot design is optional text and cannot inject markup into the editor or summary', () => {
  const direction = { firstFrame: '</textarea><script>bad()</script>', subjectMotion: '保持静止' };
  const editor = renderShotDirectionEditor(direction, 'sceneOpening');
  const summary = renderShotDirectionSummary(direction);
  assert.match(editor, /name="sceneOpening_firstFrame"/);
  assert.match(editor, /文字方案；关键帧图片会在制作时单独生成并确认/);
  assert.doesNotMatch(editor, /<script>/);
  assert.doesNotMatch(summary, /<script>/);
  assert.equal(renderShotDirectionSummary({}), '');
});
