import {readFile,writeFile,chmod,open} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {emitKeypressEvents} from 'node:readline';
import http from 'node:http';
import {fixedEndpoint} from './fixed-tunnel.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),control=join(root,'.local/public-demo');
const config=join(control,'ngrok.yml'),binary=join(root,'.local/build-tools/ngrok');
async function readSecret(){
  if(!process.stdin.isTTY)throw new Error('请在本机终端或双击启动文件配置账号。');
  process.stdout.write('粘贴 ngrok Authtoken（输入不显示，回车确认）：');
  emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise(resolve=>{
    let value='';
    const done=()=>{process.stdin.off('keypress',handler);process.stdin.setRawMode(false);process.stdin.pause();console.log();resolve(value.trim());};
    const handler=(text,key)=>{
      if(key?.ctrl&&key.name==='c'){process.stdin.setRawMode(false);process.exit(0);}
      if(key?.name==='return')return done();
      if(key?.name==='backspace')value=value.slice(0,-1);
      else if(text&&!key?.ctrl&&!key?.meta)value+=text.replace(/[\r\n]/g,'');
    };
    process.stdin.on('keypress',handler);
  });
}
async function oldSupervisor(){
  try{
    const pid=Number(await readFile(join(control,'supervisor.pid'),'utf8'));
    if(pid>1){
      const args=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});
      if(args.includes('public-demo/serve.mjs'))return pid;
    }
  }catch{}
  // Older versions did not save a PID. Match the script and its actual working directory.
  const rows=execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n');
  for(const row of rows){
    const match=/^\s*(\d+)\s+\S*node\s+(?:\.local\/public-demo\/serve\.mjs|\S+\/public-demo\/serve\.mjs)\s*$/.exec(row);
    if(!match)continue;
    try{
      const cwd=execFileSync('/usr/sbin/lsof',['-a','-p',match[1],'-d','cwd','-Fn'],{encoding:'utf8'});
      if(cwd.split('\n').includes('n'+root.replace(/\/$/,'')))return Number(match[1]);
    }catch{}
  }
  return null;
}

async function verifyAccount(expected){
  console.log('正在验证固定入口；验证通过前，现有分享保持运行。');
  return new Promise((resolve,reject)=>{
    const client=spawn(binary,['http','http://127.0.0.1:4193','--config',config,'--log','stdout','--log-format','json','--inspect=false'],{stdio:['ignore','pipe','pipe']});
    let buffer='',origin=null,error=null;
    const timer=setTimeout(()=>{error=new Error('连接验证超时，现有分享未更改。请确认 ngrok 账号及网络。');client.kill('SIGTERM');},25000);
    const consume=bytes=>{
      buffer+=bytes.toString();const lines=buffer.split('\n');buffer=lines.pop().slice(-100000);
      for(const line of lines){
        try{
          const found=fixedEndpoint(line,expected);
          if(found){origin=found;client.kill('SIGTERM');}
          const event=JSON.parse(line);
          if(event.lvl==='eror'||event.lvl==='error'){
            error=new Error('ngrok 未通过连接验证，现有分享未更改。请检查账号凭证及网络。');client.kill('SIGTERM');
          }
        }catch(e){if(e.message==='FIXED_ADDRESS_CHANGED'){error=new Error('账号返回了不同地址，已阻止更换原有固定链接。');client.kill('SIGTERM');}}
      }
    };
    client.stdout.on('data',consume);client.stderr.on('data',consume);
    client.on('error',()=>{clearTimeout(timer);reject(new Error('ngrok 客户端未能启动，现有分享未更改。'));});
    client.on('exit',()=>{clearTimeout(timer);origin&&!error?resolve(origin):reject(error||new Error('固定入口未连接，现有分享未更改。'));});
  });
}
function loginReady(origin){
  return new Promise(resolve=>{
    const request=http.get({hostname:'127.0.0.1',port:4193,path:'/login',headers:{Host:new URL(origin).host},timeout:1500},response=>{response.resume();resolve(response.statusCode===200);});
    request.on('error',()=>resolve(false));request.on('timeout',()=>request.destroy());
  });
}

try{
  try{if(process.argv.includes('--configure'))throw new Error();await readFile(config);}catch{
    console.log('首次配置：在 ngrok 免费账号中复制 Authtoken。之后再次启动会沿用同一个地址。');
    spawn('/usr/bin/open',['https://dashboard.ngrok.com/get-started/your-authtoken'],{stdio:'ignore'}).unref();
    const token=await readSecret();
    if(!/^[A-Za-z0-9_-]{20,300}$/.test(token))throw new Error('Token 格式不完整，未更改当前分享服务。');
    await writeFile(config,JSON.stringify({version:'3',agent:{authtoken:token,web_addr:'127.0.0.1:4043'}},null,2)+'\n',{mode:0o600});
  }
  await chmod(config,0o600);
  execFileSync(binary,['config','check','--config',config],{stdio:'ignore'});
  const previous=await readFile(join(control,'fixed-tunnel.json'),'utf8').then(JSON.parse).catch(()=>({}));
  const existing=await oldSupervisor();
  if(previous.origin&&existing&&await loginReady(previous.origin)){
    console.log('分享已运行：'+previous.origin+'/login');
    spawn('/usr/bin/open',[previous.origin+'/login'],{stdio:'ignore'}).unref();process.exit(0);
  }
  const origin=await verifyAccount(previous.origin);
  await writeFile(join(control,'fixed-tunnel.json'),JSON.stringify({...previous,provider:'ngrok',origin}),{mode:0o600});
  const old=await oldSupervisor();
  if(old){
    process.kill(old,'SIGTERM');
    for(let i=0;i<30;i++){
      try{process.kill(old,0);}catch{break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  const log=await open(join(control,'supervisor.log'),'a',0o600);
  const child=spawn(process.execPath,[join(control,'serve.mjs')],{cwd:root,detached:true,stdio:['ignore',log.fd,log.fd]});
  child.unref();await log.close();
  console.log('正在启动固定链接。请保持电脑开机联网。');
  for(let i=0;i<40;i++){
    await new Promise(resolve=>setTimeout(resolve,500));
    const fixed=await readFile(join(control,'fixed-tunnel.json'),'utf8').then(JSON.parse).catch(()=>({}));
    if(fixed.origin){
      const supervisor=Number(await readFile(join(control,'supervisor.pid'),'utf8').catch(()=>''));
      if(supervisor===child.pid&&await loginReady(fixed.origin)){console.log('分享地址：'+fixed.origin+'/login');spawn('/usr/bin/open',[fixed.origin+'/login'],{stdio:'ignore'}).unref();process.exit(0);}
    }
  }
  console.log('尚未取得可用地址。请检查 ngrok 账号状态和网络；没有生成新的随机链接。');
}catch(error){console.error(/^(请|Token|ngrok|连接|账号|固定)/.test(error.message)?error.message:'固定入口尚未启动，请检查本机 ngrok 配置。');process.exitCode=1;}
