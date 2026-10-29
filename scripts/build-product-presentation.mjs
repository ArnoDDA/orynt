// Local artifact assembly: preserve the supplied deck, embed actual UI captures.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.argv[2];
if (!source) throw new Error('Supply the original presentation HTML path.');
let html = await readFile(source, 'utf8');
const captures = [
  ['brand-product.png', 'Orynt 产品确认页：官网产品图、产品资料、受众与创作边界'],
  ['brand-strategy.png', 'Orynt 广告策略页：出行情境、市场依据与测试假设'],
  ['brand-production.png', 'Orynt 制作页：镜头安排、真实广告成片与导出']
];
const placeholder = /<div class="screen-placeholder"><div class="screen-placeholder-inner">[\s\S]*?<\/div><\/div>/g;
if ([...html.matchAll(placeholder)].length !== captures.length) throw new Error('Unexpected screenshot placeholders.');
const images = await Promise.all(captures.map(async ([name, alt]) => {
  const image = await readFile(join(root, '.local/ui-review', name));
  const mime = image.readUInt32BE(0) === 0x89504e47 ? 'image/png' : image.readUInt16BE(0) === 0xffd8 ? 'image/jpeg' : null;
  if (!mime) throw new Error('Expected a real screenshot image.');
  return `<img class="product-capture" src="data:${mime};base64,${image.toString('base64')}" alt="${alt}" title="点击查看完整界面" tabindex="0">`;
}));
let index = 0;
html = html.replace(placeholder, () => images[index++]);
html = html.replace('产品仍在验证，本轮先说明体验必须兑现的三个原则，界面位置暂时保留。', '以下为当前内部版本的真实界面：以 Owala 固定案例展示产品确认、策略选择与制作审阅。');
html = html.replace('交付可比较的测试方案</h2><p class="enter" style="--d:160ms">少量 Card 在受众、主张、Hook、证明方式和视觉语言上形成可解释差异，让团队知道该选什么、为什么。', '把市场依据变成可执行方案</h2><p class="enter" style="--d:160ms">把公开参考、目标受众、画面方向和测试假设放在一起，让团队知道为什么这样拍。本次展示单条 Owala 场景方案，不构成 A/B 测试结果。');
const presentationStyle = `
  <style id="embedded-product-captures">
    .screen-frame { margin:0; background:#f7faf4; display:flex; align-items:center; justify-content:center; }
    .screen-frame::after { display:none; }
    .screen-frame img.product-capture { width:100%; height:100%; object-fit:contain; object-position:center; cursor:zoom-in; }
    .present .screen-frame img.product-capture { transform:none; }
    .product-capture:focus-visible { outline:3px solid #caff4a; outline-offset:-3px; }
    .capture-lightbox { position:fixed; inset:0; z-index:1000; border:0; padding:42px 18px 18px; margin:auto; width:100vw; max-width:100vw; height:100vh; max-height:100vh; background:#070907f5; color:#f7faf4; }
    .capture-lightbox::backdrop { background:#070907ed; }
    .capture-lightbox img { display:block; max-width:100%; max-height:calc(100vh - 60px); object-fit:contain; margin:auto; }
    .capture-lightbox button { position:absolute; top:8px; right:18px; background:#caff4a; color:#070907; border:0; padding:6px 14px; border-radius:4px; cursor:pointer; }
    .capture-hint { position:absolute; right:10px; bottom:10px; z-index:4; padding:6px 10px; background:#070907dd; color:#caff4a; font-size:11px; pointer-events:none; }
    @media(prefers-reduced-motion:reduce) { .product-capture { transition:none!important; } }
  </style>`;
html = html.replace('</head>', presentationStyle + '\n</head>');
const lightbox = `
  <dialog class="capture-lightbox" aria-label="产品界面大图"><button type="button" autofocus>关闭 · Esc</button><img alt=""></dialog>
  <script>
  (() => {
    const dialog=document.querySelector('.capture-lightbox'),large=dialog.querySelector('img');
    let origin;
    for(const img of document.querySelectorAll('.product-capture')) {
      const hint=document.createElement('span');hint.className='capture-hint';hint.textContent='真实产品界面 · 点击放大';img.parentElement.append(hint);
      const open=()=>{origin=img;large.src=img.src;large.alt=img.alt;dialog.showModal();};
      img.addEventListener('click',open);
      img.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();open();}});
    }
    dialog.querySelector('button').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('keydown',e=>e.stopPropagation());
    dialog.addEventListener('close',()=>origin?.focus());
  })();
  </script>`;
html = html.replace('</body>', lightbox + '\n</body>');
if (html.includes('<div class="screen-placeholder">')) throw new Error('A screenshot is still missing.');
const outputDir = join(root, 'outputs/产品宣讲');
await mkdir(outputDir, { recursive:true });
const output = join(outputDir, 'Orynt.ai_产品宣讲_动态版_含产品截图.html');
await writeFile(output, html, { mode:0o600 });
console.log(JSON.stringify({output,screenshots:images.length,bytes:Buffer.byteLength(html),selfContainedImages:true}));
