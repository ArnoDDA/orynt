// Conceptual reference: HKUDS/ViMax interfaces/shot_description.py and
// agents/storyboard_artist.py. Keep static frame states separate from motion.
// These are text directions, not generated keyframes or image conditioning.
export const shotDirectionFields = [
  { key: 'shotIntent', label: '这一镜要让观众看懂什么', promptLabel: 'Shot intent', hint: '例如：让观众看清杯柄握持空间，而不是只展示一个漂亮的杯子。' },
  { key: 'firstFrame', label: '开始时看见什么', promptLabel: 'Static first-frame composition', hint: '描述画面起点，例如：杯子位于画面右下方，左侧留出标题空间。' },
  { key: 'lastFrame', label: '结束时停在哪里', promptLabel: 'Static last-frame composition', hint: '描述动作完成后的画面，不要增加新场景。' },
  { key: 'subjectMotion', label: '画面里发生什么', promptLabel: 'Subject action', hint: '只安排一个清楚、自然的动作；也可以保持主体静止。' },
  { key: 'cameraMotion', label: '镜头怎么移动', promptLabel: 'Camera movement', hint: '例如：固定机位，或缓慢靠近；与主体动作分开描述。' },
  { key: 'lighting', label: '光线与色调', promptLabel: 'Lighting and palette', hint: '例如：窗边柔光，低饱和暖色，保留材质细节。' },
  { key: 'continuity', label: '哪些细节要保持一致', promptLabel: 'Continuity requirements', hint: '明确主体形状、位置、背景或光线；不要只写“同上一镜”。' }
];
export const shotDirectionLimit = 400;
const keys = new Set(shotDirectionFields.map(field => field.key));

export function isValidShotDirection(value) {
  return value == null || (typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([key, text]) => keys.has(key) && typeof text === 'string' && text.length <= shotDirectionLimit));
}

export function normalizeShotDirection(value) {
  return Object.fromEntries(shotDirectionFields
    .filter(({ key }) => typeof value?.[key] === 'string' && value[key].trim())
    .map(({ key }) => [key, value[key].trim()]));
}

export const hasShotDirection = value => Object.keys(normalizeShotDirection(value)).length > 0;
export const shotDirectionFieldName = (prefix, key) => `${prefix}_${key}`;

export function shotDirectionFromFields(fields, prefix = 'direction') {
  return normalizeShotDirection(Object.fromEntries(shotDirectionFields.map(({ key }) => [key, fields[shotDirectionFieldName(prefix, key)]])));
}

export function formatShotDirection(direction) {
  return shotDirectionFields.filter(({ key }) => direction?.[key]).map(({ key, promptLabel }) => `${promptLabel}: ${direction[key]}`).join('\n');
}
