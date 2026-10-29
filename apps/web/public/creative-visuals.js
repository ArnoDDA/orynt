// Local storyboard illustrations: no stock photos, brand claims, or external requests.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function creativeKind(card) {
  const hook = card?.creativeRoute?.hook || '';
  if (/特写|纹理|细节|结构|近景/.test(hook)) return 'detail';
  if (/穿上|用户|人物|体验|过程|准备|打开/.test(hook)) return 'process';
  return 'scene';
}

export function productCategory(product = '') {
  if (/咖啡|coffee|espresso/i.test(product)) return 'coffee';
  if (/运动|训练|健身|服饰|leggings?|seamless|gymshark|activewear/i.test(product)) return 'apparel';
  return 'product';
}

const palettes = {
  scene: { sky: '#e4ecde', wall: '#adc3a3', floor: '#6f8978', ink: '#18352e', accent: '#d9ef9d' },
  detail: { sky: '#f1e5d6', wall: '#d7b89a', floor: '#947b68', ink: '#483426', accent: '#f4cda4' },
  process: { sky: '#e5e5f4', wall: '#b9b8d6', floor: '#797593', ink: '#35304f', accent: '#dad3ff' }
};

function room(p, category) {
  return `<rect width="600" height="400" fill="${p.sky}"/><path d="M0 0H600V294L0 330Z" fill="${p.wall}"/><path d="M0 330L600 294V400H0Z" fill="${p.floor}"/><path d="M0 330L600 294M110 322L44 400M275 314L300 400M440 304L556 400" fill="none" stroke="${p.sky}" stroke-opacity=".28" stroke-width="2"/><path d="M54 0V249L200 226V0" fill="${p.sky}" opacity=".72"/><path d="M128 0V237M54 106L200 97" stroke="${p.wall}" stroke-width="7"/><path d="M54 246L350 400H480L198 221Z" fill="${p.sky}" opacity=".19"/>${category === 'apparel' ? `<rect x="426" y="112" width="125" height="128" rx="5" fill="${p.ink}" opacity=".12"/><path d="M440 126H536M440 137H501" stroke="${p.sky}" stroke-width="3" opacity=".5"/><path d="M450 202H526M466 190V213M514 190V213M442 182V222M534 182V222" fill="none" stroke="${p.ink}" stroke-width="10" stroke-linecap="round"/>` : `<rect x="429" y="155" width="107" height="10" rx="3" fill="${p.ink}" opacity=".65"/><path d="M459 155V118Q487 84 488 129Q514 105 506 154" fill="${p.ink}" opacity=".3"/><rect x="472" y="143" width="24" height="13" fill="${p.sky}"/>`}`;
}

function person(p, pose = 'stretch') {
  const skin = '#d8a286', darkSkin = '#bb8069';
  const head = `<path d="M289 61Q318 48 329 75L324 104L298 106Z" fill="${p.ink}"/><ellipse cx="309" cy="86" rx="18" ry="23" fill="${skin}"/><path d="M290 77Q300 56 324 75L329 72Q316 44 294 62Z" fill="${p.ink}"/><path d="M319 69Q348 53 349 85L338 123L324 114Z" fill="${p.ink}"/><path d="M304 104V119L320 123L319 102" fill="${darkSkin}"/>`;
  const torso = `<path d="M303 113Q274 116 265 158L268 219Q306 238 337 218L333 154Q331 125 319 116Z" fill="${p.ink}"/><path d="M274 183Q303 196 331 182L336 221Q305 237 270 219Z" fill="${p.accent}"/><path d="M276 173Q304 184 330 174" fill="none" stroke="${p.accent}" stroke-width="2" opacity=".7"/>`;
  const legs = pose === 'squat'
    ? `<path d="M277 220L230 277L303 326M329 220L365 274L336 332" fill="none" stroke="${p.ink}" stroke-width="31" stroke-linejoin="round"/><path d="M288 333L318 337M325 339L348 343" stroke="#faf9ed" stroke-width="15" stroke-linecap="round"/>`
    : pose === 'walk'
      ? `<path d="M281 220L274 289L230 343M325 222L348 277L361 343" fill="none" stroke="${p.ink}" stroke-width="28" stroke-linejoin="round"/><path d="M219 350L243 355M350 351H377" stroke="#faf9ed" stroke-width="15" stroke-linecap="round"/>`
      : `<path d="M282 222L282 283L265 346M325 222L327 286L339 345" fill="none" stroke="${p.ink}" stroke-width="29" stroke-linejoin="round"/><path d="M253 352L278 355M331 353H356" stroke="#faf9ed" stroke-width="15" stroke-linecap="round"/>`;
  const arms = pose === 'stretch'
    ? `<path d="M277 132L250 92L278 48M326 132L347 92L319 48" fill="none" stroke="${skin}" stroke-width="17" stroke-linejoin="round" stroke-linecap="round"/>`
    : pose === 'squat'
      ? `<path d="M279 137L240 173L205 164M329 137L282 176L239 163" fill="none" stroke="${skin}" stroke-width="17" stroke-linejoin="round" stroke-linecap="round"/>`
      : `<path d="M274 137L245 179L251 217M329 137L355 178L382 170" fill="none" stroke="${skin}" stroke-width="17" stroke-linejoin="round" stroke-linecap="round"/>`;
  return `<ellipse cx="304" cy="360" rx="88" ry="13" fill="${p.ink}" opacity=".15"/>${legs}${arms}${torso}${head}`;
}

function apparelDetail(p, closing) {
  if (closing) return `<ellipse cx="300" cy="350" rx="150" ry="19" fill="${p.ink}" opacity=".16"/><path d="M185 83Q292 62 408 83L379 345L309 345L294 197L276 345H205Z" fill="${p.ink}"/><path d="M185 82Q291 103 408 82L402 129Q293 153 190 129Z" fill="${p.accent}"/><path d="M297 140L294 197M204 139L224 329M385 139L362 329" stroke="${p.sky}" stroke-width="2" opacity=".45"/>`;
  return `<path d="M76 35Q322 0 524 68L499 400H66Z" fill="${p.ink}"/><path d="M76 35Q322 114 524 68L516 152Q299 194 71 119Z" fill="${p.accent}"/><path d="M304 171L276 400" stroke="${p.sky}" stroke-width="3" opacity=".55"/>${Array.from({ length: 23 }, (_, n) => `<path d="M${85 + n * 19} 197L${69 + n * 19} 394" stroke="${p.sky}" stroke-width="2" stroke-opacity=".17"/>`).join('')}<path d="M381 127L457 176L491 155L414 100Z" fill="#d8a286"/><path d="M433 126L502 139L583 83V45L508 99L447 87Q417 93 433 126Z" fill="#e1b096"/><circle cx="170" cy="223" r="71" fill="none" stroke="${p.accent}" stroke-width="2"/><path d="M225 266L283 313" stroke="${p.accent}" stroke-width="2"/><path d="M140 209L164 227L201 188" fill="none" stroke="${p.accent}" stroke-width="4" stroke-linecap="round"/>`;
}

function cup(x, y, scale = 1, fill = '#f6f0df') {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="M22 8Q63 12 71 28Q79 56 43 62" fill="none" stroke="${fill}" stroke-width="12"/><path d="M-36 0H37L29 52Q0 74-30 51Z" fill="${fill}"/><ellipse cy="0" rx="37" ry="12" fill="#e0cbb5"/><ellipse cy="-1" rx="29" ry="8" fill="#553723"/><path d="M-13-26Q-24-39-10-50M10-23Q25-37 13-52" fill="none" stroke="${fill}" stroke-width="3" opacity=".6"/></g>`;
}

function coffee(p, kind, stage) {
  if (kind === 'detail' && stage === 0) return `<rect width="600" height="400" fill="${p.ink}"/><ellipse cx="281" cy="291" rx="231" ry="126" fill="#614d3e"/>${[[129,227,-22],[210,303,32],[274,188,-8],[354,271,26],[418,195,-26],[114,335,14],[338,362,-40],[487,316,22]].map(([x,y,rotate])=>`<g transform="translate(${x} ${y}) rotate(${rotate})"><ellipse rx="42" ry="27" fill="#a5754d"/><path d="M-27 2Q0-10 27 2" fill="none" stroke="#483123" stroke-width="5"/><path d="M-24-10Q0-20 20-12" fill="none" stroke="#c99767" stroke-width="3" opacity=".65"/></g>`).join('')}<path d="M106 59H310M106 76H249" stroke="${p.accent}" stroke-width="3" opacity=".38"/>`;
  const bag = `<g transform="translate(${stage === 2 ? 360 : 422} 162)"><path d="M0 0H104L115 154L-8 156Z" fill="${p.ink}"/><path d="M0 0L15-20H90L104 0" fill="${p.floor}"/><path d="M6 58L101 55L108 127L-3 130Z" fill="${p.accent}"/><path d="M18 70L49 51L80 69L64 91L36 88Z" fill="${p.ink}" opacity=".8"/><path d="M20 108H81M32 117H70" stroke="${p.ink}" stroke-width="3" opacity=".6"/></g>`;
  const table = `<path d="M37 253L541 230L593 344L24 378Z" fill="${p.accent}"/><path d="M24 378L593 344V365L24 400Z" fill="${p.ink}" opacity=".65"/>`;
  const pour = stage < 2 && !(kind === 'process' && stage === 0) ? `<g transform="translate(202 104) rotate(20)"><path d="M0 0Q41-21 70 0L66 67H-4Z" fill="${p.ink}"/><path d="M68 14L95 4L102 14L69 38Z" fill="${p.ink}"/><path d="M3-4V-12H58V-6" stroke="${p.ink}" stroke-width="7"/><path d="M101 14Q115 46 130 83" fill="none" stroke="#ac7950" stroke-width="5"/><path d="M0 5Q-49-1-21 41L-4 48" fill="none" stroke="${p.ink}" stroke-width="10"/></g>` : '';
  const hand = kind === 'process' ? `<path d="M0 158Q71 152 137 199L201 211Q225 220 210 239L158 229L122 217L0 224Z" fill="#d8a286"/><path d="M0 141L80 160L54 231L0 222Z" fill="${p.ink}"/>` : '';
  return `${room(p,'coffee')}${table}${bag}${pour}${cup(stage === 2 ? 226 : 286, stage === 2 ? 269 : 287, 1.12)}${hand}`;
}

function generalProduct(p, kind, stage) {
  const bottle = `<g transform="translate(${kind === 'detail' ? 225 : 267} ${kind === 'detail' ? 18 : 130}) scale(${kind === 'detail' ? 1.6 : 1})"><ellipse cx="42" cy="205" rx="64" ry="11" fill="${p.ink}" opacity=".18"/><path d="M15 0H66V35Q91 41 91 66V182Q91 198 74 198H8Q-8 198-8 182V66Q-8 41 15 35Z" fill="${p.ink}"/><rect x="11" y="-11" width="60" height="25" rx="6" fill="${p.floor}"/><rect x="-1" y="82" width="85" height="75" rx="2" fill="${p.accent}"/><circle cx="41" cy="105" r="12" fill="${p.ink}" opacity=".75"/><path d="M14 131H68M24 141H58" stroke="${p.ink}" stroke-width="3" opacity=".55"/></g>`;
  return `${room(p,'product')}<path d="M94 287L479 264L573 362H25Z" fill="${p.sky}"/>${bottle}${kind === 'process' && stage < 2 ? '<path d="M600 134L432 170Q366 178 363 198L443 214L600 192Z" fill="#d8a286"/>' : ''}`;
}

export function renderCreativeVisual(category, kind, stage = 0, label = '镜头画面示意') {
  const p = palettes[kind] || palettes.scene;
  const content = category === 'apparel'
    ? kind === 'detail' ? stage === 1 ? `${room(p,'apparel')}${person(p,'squat')}` : apparelDetail(p, stage === 2) : `${room(p,'apparel')}${stage === 2 ? apparelDetail(p, true) : person(p, kind === 'process' ? stage === 0 ? 'walk' : 'stretch' : stage === 0 ? 'squat' : 'stretch')}`
    : category === 'coffee' ? coffee(p,kind,stage) : generalProduct(p,kind,stage);
  return `<svg class="direction-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" role="img" aria-label="${escape(label)}"><rect width="600" height="400" fill="${p.wall}"/>${content}<path d="M21 46V21H46M554 21H579V46M579 354V379H554M46 379H21V354" fill="none" stroke="${p.sky}" stroke-width="2" opacity=".6"/></svg>`;
}

export function creativePresentation(card, product) {
  if (card.advertisingPlan) {
    const p = card.advertisingPlan;
    return { kind: 'scene', category: p.route.id, title: p.name, tag: p.name, description: p.focus.value, purpose: p.route.reason, shots: p.shots.map(s => s.title), scenes: p.shots.map(s => s.description) };
  }
  const kind = creativeKind(card), category = productCategory(product);
  const content = {
    scene: { title: '先让人进入使用场景', tag: '场景开场', description: '先看到产品在生活中怎么用，再认识产品。', purpose: '适合想让用户快速代入使用场景', shots: category === 'apparel' ? ['训练动作', '穿着细节', '产品收尾'] : category === 'coffee' ? ['咖啡入杯', '冲煮细节', '包装与咖啡'] : ['实际使用', '产品细节', '产品收尾'] },
    detail: { title: '先把一个产品细节放大', tag: '细节开场', description: '用近景抓住注意力，再回到完整产品。', purpose: '适合突出可被镜头看见的产品细节', shots: category === 'apparel' ? ['面料特写', '细节展示', '完整产品'] : category === 'coffee' ? ['咖啡豆特写', '研磨与冲煮', '包装与咖啡'] : ['细节特写', '使用展示', '完整产品'] },
    process: { title: '跟着使用者走一遍', tag: '过程开场', description: '从准备到使用，讲清一个完整的小故事。', purpose: '适合让用户看懂产品的使用过程', shots: category === 'apparel' ? ['准备训练', '热身与运动', '产品收尾'] : category === 'coffee' ? ['打开咖啡袋', '手冲咖啡', '端起咖啡杯'] : ['准备使用', '实际操作', '产品收尾'] }
  }[kind];
  return { ...content, kind, category, scenes: defaultScenes(card) };
}

function defaultScenes(card) {
  return [card.creativeRoute.hook, card.creativeRoute.proof, card.claim ? `产品与使用场景一起收尾，强调：${card.claim}。` : '以完整产品画面收尾，引导观众了解产品。'];
}
