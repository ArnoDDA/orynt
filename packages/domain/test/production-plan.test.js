import test from 'node:test';
import assert from 'node:assert/strict';
import { productionPlan, buildShotPrompt,buildKeyframePrompt } from '../src/production-plan.js';
import { isValidShotDirection } from '../src/shot-direction.js';

test('coffee scenes retain the approved action without category-specific substitutions', () => {
  const config = { duration: 15, ratio: '9:16', scenePlan: [
    { text: '静止的磨豆机特写，不出现杯子和液体。' },
    { text: '手指按下磨豆机开关。' }, { text: '产品收尾' }
  ] };
  const production = productionPlan({ config, product: 'Coffee', claim: 'Daily blend', brandName: 'Example' });
  for (const shot of production.shots.slice(0, 2)) {
    const prompt = buildShotPrompt({ production }, config, shot);
    assert.ok(prompt.includes(shot.text));
    assert.doesNotMatch(prompt, /ivory ceramic cup|dark walnut|coffee pouring|delicate rising steam|No people or hands/);
    assert.match(prompt, /text-only generation request/);
  }
});

test('shot design is normalized and frozen separately from its source config', () => {
  const config = { duration: 30, ratio: '16:9', scenePlan: [
    { text: '杯子近景', direction: { firstFrame: '  杯子居右  ', lastFrame: '杯子原位', subjectMotion: '保持静止', cameraMotion: '固定机位', lighting: '左侧柔光', continuity: '单把杯、灰色桌面' } },
    { text: '材质特写' }, { text: '产品收尾' }
  ] };
  const production = productionPlan({ config, product: 'Coffee' });
  config.scenePlan[0].direction.subjectMotion = '未确认的新动作';
  const prompt = buildShotPrompt({ production }, config, production.shots[0]);
  assert.equal(production.shots[0].direction.firstFrame, '杯子居右');
  assert.match(prompt, /Subject action: 保持静止/);
  assert.match(prompt, /Camera movement: 固定机位/);
  assert.doesNotMatch(prompt, /未确认的新动作/);
  assert.equal(production.shots[0].requestedDuration, 10);
  assert.equal(production.shots[2].kind, 'product_endcard');
});

test('shot design accepts only bounded text fields, never file bytes or unrecognized controls', () => {
  for (const value of [[], 'text', { cameraMotion: 4 }, { firstFrame: 'x'.repeat(401) }, { referenceImage: 'not-supported' }]) assert.equal(isValidShotDirection(value), false);
  assert.equal(isValidShotDirection({}), true);
  assert.equal(isValidShotDirection({ firstFrame: '静态构图' }), true);
});
test('generated reference URLs are isolated JSON strings without appended sentence punctuation',()=>{
  const config={duration:15,ratio:'9:16'},production=productionPlan({config,product:'Test'}),url='https://cdn.youmindassets.com/reference.png';
  production.shots[0].keyframe={review:{status:'accepted'},providerState:{url}};
  for(const prompt of [buildShotPrompt({production},config,production.shots[0]),buildKeyframePrompt({production},config,production.shots[1])]){
    assert.ok(prompt.includes(`\n${JSON.stringify(url)}\n`));assert.ok(!prompt.includes(`${url}.`));
  }
});
test('local product mode generates only backdrops and does not forward original photo bytes or subject actions',()=>{
  const config={duration:15,ratio:'9:16'},production=productionPlan({config,product:'Actual product'});
  production.productTreatment='local_product_overlay';production.productImage={base64:'PRIVATE_ORIGINAL_BYTES'};
  const shot=production.shots[0];shot.direction={subjectMotion:'PRIVATE_SUBJECT_ACTION',cameraMotion:'PRIVATE_CAMERA_MOVE',lighting:'Soft window light'};
  for(const prompt of [buildShotPrompt({production},config,shot),buildKeyframePrompt({production},config,shot)]) {
    assert.match(prompt,/background|backdrop/i);assert.match(prompt,/Soft window light/);
    assert.doesNotMatch(prompt,/PRIVATE_ORIGINAL_BYTES|PRIVATE_SUBJECT_ACTION|PRIVATE_CAMERA_MOVE/);
    assert.doesNotMatch(prompt,/use the specified subject action and camera movement/);
  }
});
