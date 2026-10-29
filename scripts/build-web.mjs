import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url));
const web=new URL('../apps/web/public/',import.meta.url);
let tool=process.env.ORYNT_ESBUILD;
if(!tool){try{tool=createRequire(import.meta.url).resolve('esbuild/bin/esbuild');}catch{tool=fileURLToPath(new URL('../.local/build-tools/package/bin/esbuild',import.meta.url));}}
execFileSync(tool,['apps/web/public/app.js','--bundle','--format=iife','--target=es2022','--minify','--outfile=apps/web/public/app.bundle.js'],{cwd:root,stdio:'inherit'});
await writeFile(new URL('app.bundle.js',web),(await readFile(new URL('vendor/lucide.js',web),'utf8'))+'\n'+(await readFile(new URL('app.bundle.js',web),'utf8')));
const index=await readFile(new URL('index.html',web),'utf8');
const styles=[...index.matchAll(/<link rel="stylesheet" href="\/([^\"]+)">/g)].map(m=>m[1]);
await writeFile(new URL('app.bundle.css',web),(await Promise.all(styles.map(name=>readFile(new URL(name,web),'utf8')))).join('\n'));
const html=index.replace(/  <link rel="stylesheet"[^>]+>\n/g,'').replace('</head>','  <link rel="stylesheet" href="/app.bundle.css">\n</head>').replace('正在打开本地工作空间…','正在打开工作台…').replace('  <script src="/lucide.js"></script>\n','').replace('<script type="module" src="/app.js"></script>','<script src="/bootstrap.js" defer></script>');
await writeFile(new URL('index-online.html',web),html);
console.log('Online UI built: one script bundle and one stylesheet.');
