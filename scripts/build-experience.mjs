// Local-only distribution assembly. Source data and credentials are never modified.
import { cp, mkdir, readFile, writeFile, readdir, chmod, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] || join(source, '../exports/orynt-ai-experience-20261028'));
const online=process.argv.includes('--online');
await mkdir(output); // Never overwrite an earlier deliverable.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = join(source, '.local/distribution-cache');
const runtimes = [
  { platform:'darwin-arm64', archive:'node-darwin-arm64.tar.gz', hash:'89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7' },
  { platform:'darwin-x64', archive:'node-darwin-x64.tar.gz', hash:'d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035' },
  { platform:'win-x64', archive:'node-win-x64.exe', hash:'d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5' }
];
for (const name of ['apps','packages','services','supabase','demo-assets','demo-cases','third_party','scripts','outputs','deploy','Dockerfile','compose.yaml','.dockerignore','package.json','pnpm-lock.yaml','.gitignore','start.command','start-windows.cmd']) {
  await cp(join(source,name),join(output,name),{recursive:true,filter:path=>!path.endsWith('.DS_Store')&&!path.includes('/__pycache__')});
}
// Copy only the exact versioned replay inputs; no previous manifests, chats or workspaces.
const baseline = '.local/demo-baselines/owala-commute/v1';
const manifest = JSON.parse(await readFile(join(source,baseline,'manifest.json'),'utf8'));
await mkdir(join(output,baseline),{recursive:true});
for (const name of ['manifest.json',...new Set(Object.values(manifest.assets).map(a=>a.file))]) await cp(join(source,baseline,name),join(output,baseline,name));
await mkdir(join(output,'.local/youmind'),{recursive:true});
await cp(join(source,'.local/youmind/seedance-api-test.mp4'),join(output,'.local/youmind/seedance-api-test.mp4'));
const included=[];
for (const runtime of online?[]:runtimes) {
  let bytes;try{bytes=await readFile(join(cache,runtime.archive));}catch{continue;}
  if(sha(bytes)!==runtime.hash){console.log(`Not bundled: ${runtime.platform} (download incomplete)`);continue;}
  const dest=join(output,'runtime',runtime.platform);await mkdir(dest,{recursive:true});
  if(runtime.platform==='win-x64')await cp(join(cache,runtime.archive),join(dest,'node.exe'));
  else {
    const prefix=`node-v24.22.1-${runtime.platform}`;
    const binary=execFileSync('tar',['-xzOf',join(cache,runtime.archive),`${prefix}/bin/node`],{maxBuffer:150_000_000});
    await writeFile(join(dest,'node'),binary,{mode:0o755});
    await writeFile(join(dest,'LICENSE'),execFileSync('tar',['-xzOf',join(cache,runtime.archive),`${prefix}/LICENSE`],{maxBuffer:2_000_000}));
  }
  included.push(runtime.platform);
}
if(!online&&!included.includes('darwin-arm64'))throw new Error('Missing verified runtime for this Mac.');
// Node's license is identical across platform distributions.
if(included.includes('win-x64'))await cp(join(output,'runtime/darwin-arm64/LICENSE'),join(output,'runtime/win-x64/LICENSE'));
await chmod(join(output,'start.command'),0o755);
const distribution={edition:online?'online-experience':'local-experience',createdAt:new Date().toISOString(),nodeVersion:'24.22.1',bundledPlatforms:included,workspace:'clean-on-first-launch',replay:'real-saved-media',liveGeneration:'requires-own-provider-and-editor-setup',sourceDatabaseIncluded:false,credentialsIncluded:false};
await writeFile(join(output,'distribution.json'),JSON.stringify(distribution,null,2)+'\n');
const instructions=`# Orynt.ai · 本地体验包\n\n完整解压后启动，勿在压缩包内直接双击。\n\n- Mac：双击 start.command。系统若提示阻止打开，请右键选择「打开」；若仍受系统策略限制，可在终端进入本目录运行 \`zsh start.command\`。\n- Windows 64 位：双击 start-windows.cmd。\n- 启动后自动打开浏览器；请保留终端窗口。关闭窗口或 Ctrl-C 会停止服务。端口被占用时会自动换用空闲端口，以窗口显示的地址为准。\n- 已内置运行环境：${included.join('、')}。其他平台需自行安装支持 node:sqlite 的 Node.js 22.13+，然后运行 \`node scripts/launch.mjs\`。\n\n首页点击「体验完整流程」：产品链接 → 产品确认 → 市场参考 → 广告方案 → 分镜 → 静帧和镜头审阅 → 完整成片 → 模拟投放 → 模拟数据与复盘。可建立新项目重复体验，每次确认均保存在当前文件夹的 .local/orynt.sqlite。\n\n固定演示使用已保存的真实官网资料、公开广告文案、真实 AI 生成镜头与成片，不消耗额度，也不重新抓网页或调用生成服务。投放和回收明确为模拟，演示不能证明广告投放效果。当前成片保留每轮人工审阅，不伪造全局质量验收。\n\n普通创作的代码完整保留；真实生成需使用者自己的 YouMind 密钥、账户额度以及 FFmpeg / FFprobe / Python / Pillow。网页采集和可选模板分析也需对应 Python 依赖，并受外部网站限制。此包保证固定案例的完整产品操作流程，不承诺任意网址、任意产品均能直接生成高质量广告。\n\n可选模板分析：Python 3.10+ 创建 .local/template-python 环境后安装 services/video-template/requirements.txt；也可通过 ORYNT_TEMPLATE_PYTHON 指定解释器。模板上传不是演示流程的必选步骤。\n\n无原作者 API 密钥、私人配置、历史数据库及私人文档；完整源代码、测试、版本化演示素材与产品宣讲 HTML 均在包内。不要把自己的密钥写入前端代码。\n\n校验：\`node scripts/verify-experience.mjs\` 验证真实演示素材和全链路（零外部调用，不改动体验工作区）。\n`;
const onlineInstructions=`# Orynt.ai · 线上体验版\n\n这是可部署的单工作空间演示版。部署后，Windows、Mac、手机均通过 HTTPS 网址访问，无需在体验者电脑安装运行环境。\n\n## 有域名的服务器（Docker Compose）\n\n1. 将域名的 DNS A 记录指向服务器公网 IP；开放 TCP 80 和 443。服务器安装 Docker Engine 与 Compose 插件。\n2. 完整解压本项目，在项目目录执行：\n\n\`\`\`sh\ncp deploy/online.env.example .env\n# 编辑 .env：填写 ORYNT_DOMAIN 与自己的至少 16 位随机访问密码\ndocker compose up -d --build\ndocker compose logs --tail=50\n\`\`\`\n\nCaddy 自动申请 HTTPS 证书。打开 https://你的域名，使用 .env 中的用户名（默认 demo）与密码登录，点击「体验完整流程」。请使用真实域名；首次证书申请可能需要等待 DNS 生效。\n\n## 已有容器平台或 HTTPS 反向代理\n\n使用根目录 Dockerfile 构建。配置 ORYNT_PUBLIC_ORIGIN=https://你的访问域名、ORYNT_ACCESS_USER=demo、ORYNT_ACCESS_PASSWORD=你自己生成的长密码；PORT 默认 3000，挂载可写持久卷到 /data。探活地址 /healthz。反向代理必须保留原始 Host 请求头。\n\n## 体验与数据\n\n产品确认 → 市场参考 → 创意方案 → 分镜 → 静帧/视频审阅 → 下载真实成片 → 模拟投放 → 模拟数据与复盘。固定案例使用既有真实资料与生成结果回放，不消耗模型额度；投放和指标明确为模拟。每轮保留人工确认，不伪造质量验收。\n\n默认仅开放固定案例演示，不提供任意产品的在线采集或付费生成。完整源代码保留，普通创作需要额外配置服务和运行依赖。\n\n当前为共享工作空间：获准登录的体验者能看到同一批演示项目。请勿上传私人资料或把它当作多租户 SaaS。本包不含开发机密钥、私人配置或历史数据库。数据存储在持久卷 /data/orynt.sqlite，镜头与成片也随数据库保存；演示基线保留在镜像内，挂载 /data 不会遮住素材。停止/重建容器保留卷；不要运行 docker compose down -v，否则会删除体验数据。\n\n## 验证\n\n在支持 node:sqlite 的 Node.js 22.13+ 环境运行 \`ORYNT_VERIFY_PUBLIC=1 node scripts/verify-experience.mjs\`，验证密码、域名、来源限制、全流程、成片字节和重启持久化，不访问外部生成服务。INTEGRITY.json 记录打包时全部文件的 SHA256。\n\nDocker 容器构建需要联网拉取 Node 与 Caddy 官方基础镜像。开发机未安装 Docker，因此已验证线上服务与完整流程，尚未在目标服务器验证容器构建和 HTTPS 证书签发。\n`;
await writeFile(join(output,'README.md'),online?onlineInstructions:instructions);
// Check against actual local secret values without printing those values.
const secrets=[];
for(const file of ['.env','.env.claude'])try{
  for(const line of (await readFile(join(source,file),'utf8')).split(/\r?\n/)){
    const m=line.match(/^\s*(\w*(?:KEY|TOKEN|SECRET)\w*)\s*=\s*(.+)\s*$/i);
    if(m){const v=m[2].replace(/^['"]|['"]$/g,'').trim();if(v.length>=8)secrets.push(v);}
  }
}catch{}
const files=[];
async function inventory(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  const path=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Unexpected symlink in experience package');
  if(entry.isDirectory())await inventory(path);else{
    const bytes=await readFile(path);if(secrets.some(secret=>bytes.includes(Buffer.from(secret))))throw new Error(`Credential found in ${relative(output,path)}`);
    files.push({path:relative(output,path).split('\\').join('/'),bytes:bytes.length,sha256:sha(bytes)});
  }
}}
await inventory(output);
if(files.some(f=>/(^|\/)\.env($|\.)|orynt\.sqlite|\/logs\//.test(f.path)))throw new Error('Private files in experience package');
await writeFile(join(output,'INTEGRITY.json'),JSON.stringify({schema:1,files},null,2)+'\n');
console.log(JSON.stringify({output,files:files.length,bundledPlatforms:included,bytes:files.reduce((n,f)=>n+f.bytes,0),secretScan:'passed'},null,2));
