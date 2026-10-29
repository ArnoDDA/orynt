import test from 'node:test';
import assert from 'node:assert/strict';
import { productionPlan } from '../src/production-plan.js';
import { reviewProductionPlan, reviewProductionDelivery } from '../src/production-quality.js';
import { scoreSlideshowRisk, validateMotionDelivery } from '../src/vendor/openmontage/production-checks.js';

function fixture(duration = 15) {
  const config = { duration, scenePlan: [{ text: '杯子在窗边，手指穿过杯柄。' }, { text: '近景展示杯壁的釉面纹理。' }, { text: '产品与购买引导' }] };
  const production = productionPlan({ config, product: 'Cup' });
  production.productImage = { base64: 'saved-local-photo' };
  for (const shot of production.shots.slice(0, 2)) {
    Object.assign(shot, { status: 'ready', base64: 'downloaded-video', technical: { width: 720, height: 1280, duration: shot.requestedDuration, issues: [] } });
  }
  production.shots[0].review = { status: 'accepted', version: 1 };
  return { config, production };
}

test('OpenMontage heuristics distinguish purposeful video plans from repeated text slides', () => {
  const weak = scoreSlideshowRisk(Array.from({ length: 4 }, () => ({ type: 'text_card', description: 'Same headline' })), 'cinematic');
  const strong = scoreSlideshowRisk(['wide', 'close_up', 'insert'].map((size, i) => ({ type: i % 2 ? 'animation' : 'video', description: `Action ${i}`, shot_intent: 'Explain a feature', hero_moment: i === 0, shot_language: { shot_size: size, camera_movement: 'dolly_in', lighting_key: 'natural' } })), 'cinematic');
  assert.equal(weak.verdict, 'fail');
  assert.equal(strong.verdict, 'strong');
  assert.equal(scoreSlideshowRisk([]).verdict, 'fail');
});

test('delivery counts edited seconds, preserving a short original-photo endcard', () => {
  const report = validateMotionDelivery([{ duration: 3, motion: true }, { duration: 8, motion: true }, { duration: 4, motion: false }]);
  assert.equal(report.valid, true);
  assert.equal(report.motionSeconds, 11);
  assert.ok(Math.abs(report.motionRatio - 11 / 15) < 1e-9);
  assert.equal(validateMotionDelivery([{ duration: 5, motion: true }, { duration: 10, motion: false }]).valid, false);
  // A file extension or declared type alone cannot satisfy the delivery policy.
  assert.equal(validateMotionDelivery([{ duration: 15, source: 'fake.mp4', type: 'video' }]).valid, false);
  for (const duration of [0, -1, NaN, Infinity]) assert.equal(validateMotionDelivery([{ duration, motion: true }]).valid, false);
});

test('optional shot design yields actionable advice without blocking existing scripts', () => {
  const { production, config } = fixture();
  const before = structuredClone(production);
  const report = reviewProductionPlan(production, config);
  assert.equal(report.valid, true);
  assert.match(report.warnings[0].message, /镜头 1.*让观众看懂什么/);
  for (const shot of production.shots.slice(0, 2)) shot.direction = { shotIntent: '看清产品细节', firstFrame: '产品居中', subjectMotion: '保持静止', cameraMotion: '固定机位', continuity: '相同杯子和桌面' };
  assert.deepEqual(reviewProductionPlan(production, config).warnings, []);
  assert.equal(before.shots[0].direction.shotIntent, undefined);
});

test('identical scenes and broken timelines fail before generation', () => {
  const { production, config } = fixture();
  production.shots[1].text = ` ${production.shots[0].text.replaceAll('。', '！')} `;
  assert.ok(reviewProductionPlan(production, config).errors.some(e => e.code === 'DUPLICATE_SCENES' && e.shotIndex === 1));
  production.shots[1].text = '釉面纹理';
  production.shots[1].start = 4;
  assert.ok(reviewProductionPlan(production, config).errors.some(e => e.code === 'SHOT_TIMING'));
});

test('delivery needs inspected files, enough source duration and current-version approval', () => {
  for (const duration of [15, 30]) {
    const f = fixture(duration);
    assert.equal(reviewProductionDelivery(f.production, f.config).valid, true);
  }
  const cases = [
    [p => { delete p.shots[1].base64; }, 'SHOT_MEDIA'],
    [p => { p.shots[1].technical.duration = 2; }, 'SHOT_MEDIA'],
    [p => { p.shots[1].technical.issues.push('bad aspect'); }, 'SHOT_MEDIA'],
    [p => { p.shots[0].review.version = 0; }, 'FIRST_SHOT_APPROVAL'],
    [p => { p.shots[1].keyframe = { version: 2, review: { version: 1, status: 'accepted' } }; }, 'KEYFRAME_APPROVAL'],
    [p => { delete p.productImage.base64; }, 'PRODUCT_IMAGE']
  ];
  for (const [mutate, code] of cases) {
    const f = fixture(); mutate(f.production);
    const report = reviewProductionDelivery(f.production, f.config);
    assert.equal(report.valid, false, code);
    assert.ok(report.errors.some(e => e.code === code), code);
  }
  const f = fixture();
  f.production.deliveryPromise = { minMotionRatio: 0, stillFallbackAllowed: true };
  f.production.shots[1].base64 = '';
  assert.equal(reviewProductionDelivery(f.production, f.config).valid, false);
});
test('local product delivery requires matching original and layout evidence for every shot',()=>{
  const make=()=>{
    const f=fixture(),p=f.production;p.productTreatment='local_product_overlay';p.productImage.assetId='photo';p.productPreparation={sourceSha256:'original-hash'};
    for(const shot of p.shots.slice(0,2)) {
      shot.productComposition={sourceSha256:'original-hash',productImageId:'photo',layoutVersion:'v1'};
      shot.backgroundBase64='real-background-video';shot.backgroundTechnical={issues:[]};
      shot.keyframe={version:1,review:{status:'accepted',version:1},productPreview:{base64:'local-preview',composition:{...shot.productComposition}}};
    }
    return f;
  };
  const f=make();assert.equal(reviewProductionDelivery(f.production,f.config).valid,true);
  assert.match(reviewProductionDelivery(f.production,f.config).note,/静态原图/);
  for(const mutate of [
    p=>{p.shots[0].productComposition.sourceSha256='different-image';},
    p=>{p.shots[1].keyframe.productPreview.composition.layoutVersion='different-layout';},
    p=>{delete p.shots[1].backgroundBase64;},
    p=>{delete p.shots[0].keyframe.productPreview.base64;}
  ]) {
    const f=make();mutate(f.production);const report=reviewProductionDelivery(f.production,f.config);
    assert.equal(report.valid,false);assert.ok(report.errors.some(e=>e.code==='PRODUCT_COMPOSITION'));
  }
});
