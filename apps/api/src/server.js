import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Repository } from './repository.js';
import { Core, DomainError } from './core.js';
import { LocalJobRunner } from './job-runner.js';
import { ClaudeTextProvider } from './claude-text-provider.js';
import { ProductStrategyPlanner } from './product-strategy-planner.js';
import { DemoLibrary } from './demo-library.js';
import { imagePreview } from './image-preview.js';
import { DemoWalkthrough } from './demo-walkthrough.js';
import { blockedDemoProvider } from './deployment-policy.js';

try { process.loadEnvFile?.(fileURLToPath(new URL('../../../.env', import.meta.url))); } catch { /* Local .env is optional and intentionally ignored by git. */ }
try { process.loadEnvFile?.(fileURLToPath(new URL('../../../.env.claude', import.meta.url))); } catch { /* Separate local text-provider credentials; never exposed to the browser. */ }

const web = new URL('../../web/public/', import.meta.url);
const localData = process.env.ORYNT_DATA_DIR ? resolve(process.env.ORYNT_DATA_DIR, 'orynt.sqlite') : fileURLToPath(new URL('../../../.local/orynt.sqlite', import.meta.url));
const staticFiles = new Map([
  ['/app.bundle.js', ['app.bundle.js', 'text/javascript']],
  ['/app.bundle.css', ['app.bundle.css', 'text/css']],
  ['/bootstrap.js', ['bootstrap.js', 'text/javascript']],
  ['/brand.css', ['brand.css', 'text/css']],
  ['/orynt-logo.svg', ['orynt-logo.svg', 'image/svg+xml']],
  ['/studio.css', ['studio.css', 'text/css']],
  ['/walkthrough-flow.js', ['walkthrough-flow.js', 'text/javascript']],
  ['/demo-flow.js', ['demo-flow.js', 'text/javascript']], ['/demo.css', ['demo.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']], ['/api-client.js', ['api-client.js', 'text/javascript']],
  ['/flow-actions.js', ['flow-actions.js', 'text/javascript']], ['/journey.css', ['journey.css', 'text/css']],
  ['/creator-flow.js', ['creator-flow.js', 'text/javascript']], ['/creator.css', ['creator.css', 'text/css']],
  ['/product-import-flow.js', ['product-import-flow.js', 'text/javascript']],
  ['/product-plan-view.js', ['product-plan-view.js', 'text/javascript']],
  ['/opportunity-flow.js', ['opportunity-flow.js', 'text/javascript']],
  ['/opportunity.css', ['opportunity.css', 'text/css']],
  ['/fundraising.css', ['fundraising.css', 'text/css']],
  ['/packages/domain/src/product-planning.js', ['../../../packages/domain/src/product-planning.js', 'text/javascript']],
  ['/packages/domain/src/market-planning.js', ['../../../packages/domain/src/market-planning.js', 'text/javascript']],
  ['/production-flow.js', ['production-flow.js', 'text/javascript']], ['/production.css', ['production.css', 'text/css']],
  ['/shot-direction-view.js', ['shot-direction-view.js', 'text/javascript']],
  ['/production-quality-view.js', ['production-quality-view.js', 'text/javascript']],
  ['/packages/domain/src/production-plan.js', ['../../../packages/domain/src/production-plan.js', 'text/javascript']],
  ['/packages/domain/src/production-quality.js', ['../../../packages/domain/src/production-quality.js', 'text/javascript']],
  ['/packages/domain/src/vendor/openmontage/production-checks.js', ['../../../packages/domain/src/vendor/openmontage/production-checks.js', 'text/javascript']],
  ['/keyframe-view.js', ['keyframe-view.js', 'text/javascript']],
  ['/packages/domain/src/shot-direction.js', ['../../../packages/domain/src/shot-direction.js', 'text/javascript']],
  ['/creative-visuals.js', ['creative-visuals.js', 'text/javascript']],
  ['/creative-directions.css', ['creative-directions.css', 'text/css']],
  ['/scene-script.js', ['../../../packages/domain/src/scene-script.js', 'text/javascript']],
  ['/packages/domain/src/scene-script.js', ['../../../packages/domain/src/scene-script.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']], ['/preview.css', ['preview.css', 'text/css']],
  ['/new-campaign.css', ['new-campaign.css', 'text/css']], ['/discover.css', ['discover.css', 'text/css']],
  ['/card-detail.css', ['card-detail.css', 'text/css']], ['/create.css', ['create.css', 'text/css']],
  ['/framework.css', ['framework.css', 'text/css']], ['/preview-data.js', ['preview-data.js', 'text/javascript']],
  ['/ui.css', ['ui.css', 'text/css']], ['/lucide.js', ['vendor/lucide.js', 'text/javascript']],
  ['/preview-logic.js', ['preview-logic.js', 'text/javascript']], ['/storyboard.svg', ['storyboard.svg', 'image/svg+xml']]
]);
const escape = s => String(s).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[x]));
function storyboard(asset) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720"><rect width="1200" height="720" fill="#102626"/><text x="56" y="70" fill="#c0e997" font-family="sans-serif" font-size="30">ORYNT · Storyboard preview</text><text x="56" y="108" fill="#acc5c0" font-family="sans-serif" font-size="18">Local draft · Not a generated video · Card v${asset.sourceCardVersion ?? '?'}</text>${asset.scenes.map((scene, i) => `<rect x="${56 + i * 368}" y="160" width="344" height="472" rx="16" fill="#23403b"/><text x="${80 + i * 368}" y="224" fill="#c0e997" font-family="sans-serif" font-size="26">0${i + 1} / ${escape(scene.title)}</text>${scene.text.match(/.{1,12}/gu)?.slice(0, 8).map((line, n) => `<text x="${80 + i * 368}" y="${300 + n * 34}" fill="#ffffff" font-family="sans-serif" font-size="22">${escape(line)}</text>`).join('') || ''}`).join('')}</svg>`;
}
export function createApplication({ repository = new Repository(localData), tickMs = 650, crawler, metaCrawler, videoProvider, templateAnalyzer, productImporter, videoAssembler, textProvider = new ClaudeTextProvider(), strategyPlanner = new ProductStrategyPlanner({ textProvider }), demoLibrary = new DemoLibrary(), deployment = null } = {}) {
  const walkthrough = new DemoWalkthrough(demoLibrary);
  const core = new Core(repository, { walkthrough }), token = randomUUID();
  const jobRunner = new LocalJobRunner({
    core, repository, strategyPlanner,
    ...(crawler ? { crawler } : {}),
    ...(metaCrawler !== undefined ? { metaCrawler } : {})
    ,...(videoProvider !== undefined ? { videoProvider } : {})
    ,...(templateAnalyzer !== undefined ? { templateAnalyzer } : {})
    ,...(productImporter !== undefined ? { productImporter } : {})
    ,...(videoAssembler !== undefined ? { videoAssembler } : {})
  });
  if (deployment?.demoOnly) {
    Object.assign(jobRunner, { crawler:blockedDemoProvider,metaCrawler:blockedDemoProvider,productImporter:blockedDemoProvider,templateAnalyzer:blockedDemoProvider,strategyPlanner:blockedDemoProvider });
    Object.assign(jobRunner.productionRunner, { videoProvider:blockedDemoProvider,videoAssembler:blockedDemoProvider });
    jobRunner.videoProvider = blockedDemoProvider;
  }
  const deploymentView = deployment ? { mode:deployment.demoOnly?'online_demo':'online_full',demoOnly:deployment.demoOnly,sharedWorkspace:true,storage:'server_sqlite' } : null;
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      if (deployment && req.method === 'GET' && req.url === '/healthz') return json(200, { status:'ok' });
      const host = req.headers.host || '';
      if (deployment ? host.toLowerCase() !== deployment.host : !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return json(403, { error: { code: 'HOST_REJECTED', message: '访问域名未配置。' } });
      const url = new URL(req.url, `http://${host}`);
      if (req.headers.origin && req.headers.origin !== (deployment?.publicOrigin || `http://${host}`)) return json(403, { error: { code: 'ORIGIN_REJECTED', message: '请求来源不匹配。' } });
      const redirect = location => {res.writeHead(303, {Location:location});res.end();};
      if(deployment && req.method==='GET' && ['/login','/login.css','/login.js','/orynt-logo.svg'].includes(url.pathname)){
        if(url.pathname==='/login'&&deployment.authenticate(req))return redirect('/#/home');
        // Native form POSTs need a same-origin referrer policy to retain Origin.
        res.setHeader('Referrer-Policy','same-origin');
        const file=url.pathname==='/login'?'login.html':url.pathname.slice(1);
        const type=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'image/svg+xml';
        res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(await readFile(new URL(file,web)));
      }
      if(deployment && req.method==='POST' && url.pathname==='/auth/login'){
        if(req.headers.origin!==deployment.publicOrigin)return json(403,{error:{code:'ORIGIN_REJECTED',message:'请从登录页重新登录。'}});
        if(!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))return json(415,{error:{code:'FORM_REQUIRED'}});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>4096)throw new DomainError('BODY_TOO_LARGE','登录信息过长。',413);chunks.push(chunk);}
        const form=new URLSearchParams(Buffer.concat(chunks).toString());
        const result=deployment.login(form.get('username'),form.get('password'));
        if(result.status!==200)return redirect('/login?error='+(result.status===429?'limited':'invalid'));
        res.setHeader('Set-Cookie',result.cookie);return redirect('/#/home');
      }
      if(deployment && req.method==='POST' && url.pathname==='/auth/logout'){
        if(req.headers.origin!==deployment.publicOrigin)return json(403,{error:{code:'ORIGIN_REJECTED'}});
        res.setHeader('Set-Cookie',deployment.logout(req));return redirect('/login');
      }
      if (deployment && !deployment.authenticate(req)) {
        if(req.method==='GET'&&!url.pathname.startsWith('/api/'))return redirect('/login');
        return json(401, { error: { code:'AUTH_REQUIRED',message:'请先登录。' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { status: 'ok', mode: 'local_guest', schema: 4, requestId });
      if (req.method === 'GET' && url.pathname === '/api/session') return json(200, { token, workspace: core.state().workspace, ...(deploymentView ? {deployment:deploymentView}:{}), lifecycle: { storage: deployment ? 'server_sqlite':'local_sqlite', retention: 'until_manual_clear', externalUpload: false }, requestId });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, { ...core.state(), ...(deploymentView ? {deployment:deploymentView}:{} ) });
      if (req.method === 'GET' && url.pathname === '/api/demo/owala-commute') return json(200, await demoLibrary.read());
      const demoMedia = /^\/api\/demo\/owala-commute\/(media|review-media)\/(\w+)$/.exec(url.pathname);
      if (req.method === 'GET' && demoMedia) {
        const file = await demoLibrary.media(demoMedia[2], url.searchParams.get('revision'), { review: demoMedia[1] === 'review-media' });
        if (!file) return json(404, { error: { code: 'DEMO_MEDIA_UNAVAILABLE', message: '此版本素材尚未通过检查或验收，请刷新案例。' } });
        const { bytes, mime } = url.searchParams.get('size')==='preview'&&file.mime.startsWith('image/')&&url.searchParams.get('download')!=='1' ? await imagePreview(file) : file;
        res.setHeader('Content-Type', mime); res.setHeader('Accept-Ranges', 'bytes');
        if (url.searchParams.get('download') === '1') res.setHeader('Content-Disposition', `attachment; filename="owala-${demoMedia[1] === 'review-media' ? 'candidate-' : ''}${demoMedia[2]}.${mime === 'video/mp4' ? 'mp4' : mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : 'png'}"`);
        if (req.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          const start = range?.[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range?.[2] || 0));
          const end = range?.[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
          if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) { res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); return res.end(); }
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end-start+1 }); return res.end(bytes.subarray(start,end+1));
        }
        res.writeHead(200, { 'Content-Length': bytes.length }); return res.end(bytes);
      }
      if (req.method === 'POST' && url.pathname === '/api/commands') {
        if (req.headers['x-local-session'] !== token) return json(403, { error: { code: 'SESSION_REQUIRED', message: '本地会话已更新，请刷新页面。' } });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: { code: 'JSON_REQUIRED', message: '需要 JSON 请求。', retryable: false }, requestId });
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 29_000_000) throw new DomainError('BODY_TOO_LARGE', '文件或请求内容过大。', 413); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new DomainError('INVALID_JSON', '请求内容无法解析。'); }
        if (deployment?.demoOnly && ((body.action === 'campaign.create' && body.data?.mode !== 'demo_replay') || ['workspace.clear','brand.remove-data','brand.reset','brandAsset.add','template.import','asset.import','productImport.start','connection.toggle'].includes(body.action))) throw new DomainError('ONLINE_DEMO_ONLY','线上体验使用固定案例，请从「体验完整流程」开始。',409);
        if ((body.action === 'campaign.create' && body.data?.mode === 'demo_replay') || body.action === 'demo.alignPlan') await walkthrough.prepare();
        const result = core.command(body.action, body.resourceId, body.data || {}, req.headers['idempotency-key']);
        return json(result?.jobId ? 202 : 200, { result, requestId });
      }
      const productRoute = /^\/api\/productions\/([^/]+)\/product$/.exec(url.pathname);
      const referenceMediaRoute = /^\/api\/evidence\/([^/]+)\/media\/([01])$/.exec(url.pathname);
      if (req.method === 'GET' && referenceMediaRoute) {
        const state = repository.read();
        const evidence = state.evidence.find(e => e.id === referenceMediaRoute[1] && e.workspaceId === state.workspace.id && e.sourceType === 'meta_ad_library' && !e.attributes?.demo);
        const media = evidence?.attributes?.media?.[Number(referenceMediaRoute[2])];
        if (!media?.base64 || media.status !== 'available' || !['image/png','image/jpeg','image/webp'].includes(media.mime) || !state.discoverySources.some(s => s.id === evidence.discoverySourceId && s.status === 'available')) throw new DomainError('NOT_FOUND','这条参考尚未取得可用图片。',404);
        if (url.searchParams.has('sha256') && url.searchParams.get('sha256') !== media.sha256) throw new DomainError('NOT_FOUND','参考图片版本已变化，请刷新页面。',404);
        const bytes = Buffer.from(media.base64,'base64');
        res.writeHead(200,{'Content-Type':media.mime,'Content-Length':bytes.length,'Content-Security-Policy':"default-src 'none'; sandbox"});
        return res.end(bytes);
      }
      if (req.method === 'GET' && productRoute) {
        const image = repository.read().generationRequests.find(r=>r.id===productRoute[1])?.production?.productImage;
        if (!image?.base64) throw new DomainError('NOT_FOUND','本轮产品图不存在。',404);
        const content=Buffer.from(image.base64,'base64');res.writeHead(200,{'Content-Type':image.mime,'Content-Length':content.length});return res.end(content);
      }
      const keyframeRoute = /^\/api\/productions\/([^/]+)\/shots\/(0|1)\/keyframe$/.exec(url.pathname);
      if(req.method==='GET'&&keyframeRoute){
        const request=repository.read().generationRequests.find(r=>r.id===keyframeRoute[1]&&r.workflow==='shot_pipeline');
        const shot=request?.production.shots[Number(keyframeRoute[2])];
        const take=shot&&[shot,...(shot.history||[])].find(t=>t.version===Number(url.searchParams.get('shotVersion')||shot.version));
        const current=take?.keyframe;
        const frame=current&&[current,...(current.history||[])].find(f=>f.version===Number(url.searchParams.get('version')||current.version));
        if(!frame?.base64)throw new DomainError('NOT_FOUND','关键帧图片尚未就绪。',404);
        const shown=url.searchParams.get('layer')==='background'?frame:request.production.productTreatment==='local_product_overlay'?frame.productPreview:frame;
        if(!shown?.base64)throw new DomainError('NOT_FOUND','产品合成预览尚未就绪。',404);
        const bytes=Buffer.from(shown.base64,'base64');res.writeHead(200,{'Content-Type':shown.mime,'Content-Length':bytes.length});return res.end(bytes);
      }
      const shotRoute = /^\/api\/productions\/([^/]+)\/shots\/(0|1)\/(preview|poster)$/.exec(url.pathname);
      if (req.method === 'GET' && shotRoute) {
        const request = repository.read().generationRequests.find(r => r.id === shotRoute[1] && r.workflow === 'shot_pipeline');
        const shot = request?.production.shots[Number(shotRoute[2])];
        const version = Number(url.searchParams.get('version') || shot?.version);
        const take = shot && [shot, ...(shot.history || [])].find(t => t.version === version);
        const encoded = shotRoute[3] === 'poster' ? take?.thumbnailBase64 : take?.base64;
        if (!encoded) throw new DomainError('NOT_FOUND', '这个版本的镜头文件尚未就绪。', 404);
        const content = Buffer.from(encoded, 'base64');
        res.setHeader('Content-Type', shotRoute[3] === 'poster' ? (take.thumbnailMime || 'image/jpeg') : 'video/mp4');
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (range) {
          const start = Number(range[1]), end = Math.min(Number(range[2] || content.length - 1), content.length - 1);
          if (start > end || start >= content.length) { res.writeHead(416, {'Content-Range': `bytes */${content.length}`}); return res.end(); }
          res.writeHead(206, {'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': end-start+1, 'Accept-Ranges':'bytes'}); return res.end(content.subarray(start,end+1));
        }
        res.writeHead(200, {'Content-Length':content.length,'Accept-Ranges':'bytes'}); return res.end(content);
      }
      const assetRoute = /^\/api\/assets\/([^/]+)\/(preview|download)$/.exec(url.pathname);
      if (req.method === 'GET' && assetRoute) {
        const asset = assetRoute[2] === 'download' ? core.download(assetRoute[1]) : repository.read().assets.find(a => a.id === assetRoute[1]);
        if (!asset) throw new DomainError('NOT_FOUND', '素材不存在。', 404);
        const content = asset.type === 'storyboard' ? Buffer.from(storyboard(asset)) : Buffer.from(asset.base64, 'base64');
        res.setHeader('Content-Type', asset.mime);
        if (assetRoute[2] === 'download') res.setHeader('Content-Disposition', `attachment; filename="${asset.id}.${asset.type === 'storyboard' ? 'svg' : asset.mime === 'video/mp4' ? 'mp4' : 'webm'}"`);
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (range) {
          const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : content.length - 1, content.length - 1);
          if (start > end || start >= content.length) { res.writeHead(416, { 'Content-Range': `bytes */${content.length}` }); return res.end(); }
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' }); return res.end(content.subarray(start, end + 1));
        }
        res.writeHead(200, { 'Content-Length': content.length, 'Accept-Ranges': 'bytes' }); return res.end(content);
      }
      const brandAssetRoute = /^\/api\/brand-assets\/([^/]+)\/(preview|download)$/.exec(url.pathname);
      const importImageRoute = /^\/api\/product-imports\/([^/]+)\/images\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && importImageRoute) {
        const snapshot = repository.read().snapshots.find(item => item.id === importImageRoute[1]);
        const image = snapshot?.productImport?.images?.find(item => item.id === importImageRoute[2]);
        if (!image?.base64) throw new DomainError('NOT_FOUND', '候选产品图不存在。', 404);
        const content = Buffer.from(image.base64, 'base64');
        res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': content.length, 'Content-Security-Policy': "default-src 'none'; sandbox" });
        return res.end(content);
      }
      if (req.method === 'GET' && brandAssetRoute) {
        const asset = repository.read().brandAssets.find(item => item.id === brandAssetRoute[1] && item.status === 'ready');
        if (!asset?.base64) throw new DomainError('NOT_FOUND', '品牌素材不存在。', 404);
        const content = Buffer.from(asset.base64, 'base64');
        res.setHeader('Content-Type', asset.mime || 'application/octet-stream');
        res.setHeader('Content-Length', content.length);
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        if (brandAssetRoute[2] === 'download') {
          const safeName = String(asset.name || 'brand-asset').replace(/[^\w.\-]+/g, '-');
          res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        }
        res.writeHead(200); return res.end(content);
      }
      const templateFrameRoute = /^\/api\/video-templates\/([^/]+)\/keyframes\/(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && templateFrameRoute) {
        const template = repository.read().videoTemplates.find(item => item.id === templateFrameRoute[1] && item.status === 'ready');
        const scene = template?.scenes?.find(item => item.index === Number(templateFrameRoute[2]));
        if (!scene?.keyframeBase64) throw new DomainError('NOT_FOUND', '关键帧不存在。', 404);
        const content = Buffer.from(scene.keyframeBase64, 'base64');
        res.setHeader('Content-Type', scene.keyframeMime || 'image/jpeg');
        res.setHeader('Content-Length', content.length);
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.writeHead(200); return res.end(content);
      }
      const exportRoute = /^\/api\/exports\/(cards|plans|brands)\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && exportRoute) {
        const state = core.state(), item = state[exportRoute[1]].find(x => x.id === exportRoute[2]);
        if (!item) throw new DomainError('NOT_FOUND', '导出对象不存在。', 404);
        res.setHeader('Content-Disposition', `attachment; filename="orynt-${exportRoute[1]}.json"`); return json(200, item);
      }
      if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return json(404, { error: { code: 'NOT_FOUND', message: '未找到该页面或接口。' } });
      const [file, type] = staticFiles.get(url.pathname) || [deployment?'index-online.html':'index.html', 'text/html'];
      let content=await readFile(new URL(file,web));
      if(deployment&&/\bgzip\b/.test(req.headers['accept-encoding']||'')&&content.length>1024){content=gzipSync(content);res.setHeader('Content-Encoding','gzip');res.setHeader('Vary','Accept-Encoding');}
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Length':content.length }); res.end(content);
    } catch (e) { if (!res.headersSent) json(e.status || 500, { error: { code: e.code || 'INTERNAL_ERROR', message: e instanceof DomainError ? e.message : '本地服务暂时无法完成操作。', retryable: Number(e.status || 500) >= 500 }, requestId }); else res.end(); }
  });
  const timer = tickMs ? setInterval(() => {
    void jobRunner.tick().catch(() => { /* Pending state stays durable for retry or inspection. */ });
  }, tickMs) : null;
  timer?.unref();
  return { server, core, repository, jobRunner, textProvider, close: () => { clearInterval(timer); return new Promise(done => server.close(() => { repository.close(); done(); })); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApplication(), port = Number(process.env.PORT || 3000);
  app.server.listen(port, '127.0.0.1', () => console.log(`Orynt local workspace: http://127.0.0.1:${port}`));
  const stop = () => app.close().then(() => process.exit(0));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
