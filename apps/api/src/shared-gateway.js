import http from 'node:http';
import {readFile} from 'node:fs/promises';

const web=new URL('../../web/public/',import.meta.url);
const loginFiles=new Map([['/login','login.html'],['/login.css','login.css'],['/login.js','login.js'],['/orynt-logo.svg','orynt-logo.svg']]);
const hopHeaders=['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'];

// This gateway owns only public access control. All product state and jobs remain
// in the running localhost application, with one Repository and one job runner.
export function createSharedGateway({deployment,upstream='http://127.0.0.1:4173'}){
  const target=new URL(upstream);
  if(target.protocol!=='http:'||!['127.0.0.1','localhost'].includes(target.hostname)||target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw new Error('共享入口只能转发到本机产品服务。');
  const agent=new http.Agent({keepAlive:true});
  const server=http.createServer(async(req,res)=>{
    const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
    const redirect=location=>{res.writeHead(303,{Location:location});res.end();};
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      if((req.headers.host||'').toLowerCase()!==deployment.host)return json(403,{error:{code:'HOST_REJECTED'}});
      if(req.headers.origin&&req.headers.origin!==deployment.publicOrigin)return json(403,{error:{code:'ORIGIN_REJECTED'}});
      if(!req.url?.startsWith('/')||req.url.startsWith('//'))return json(400,{error:{code:'INVALID_PATH'}});
      const url=new URL(req.url,deployment.publicOrigin);
      if(req.method==='GET'&&loginFiles.has(url.pathname)){
        if(url.pathname==='/login'&&deployment.authenticate(req))return redirect('/#/home');
        const name=loginFiles.get(url.pathname);
        const mime=name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'image/svg+xml';
        res.writeHead(200,{'Content-Type':mime+'; charset=utf-8'});res.end(await readFile(new URL(name,web)));return;
      }
      if(req.method==='POST'&&url.pathname==='/auth/login'){
        if(req.headers.origin!==deployment.publicOrigin)return json(403,{error:{code:'ORIGIN_REJECTED'}});
        if(!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))return json(415,{error:{code:'FORM_REQUIRED'}});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>4096)return json(413,{error:{code:'BODY_TOO_LARGE'}});chunks.push(chunk);}
        const form=new URLSearchParams(Buffer.concat(chunks).toString());
        const result=deployment.login(form.get('username'),form.get('password'));
        if(result.status!==200)return redirect('/login?error='+(result.status===429?'limited':'invalid'));
        res.setHeader('Set-Cookie',result.cookie);return redirect('/#/home');
      }
      if(req.method==='POST'&&url.pathname==='/auth/logout'){
        if(req.headers.origin!==deployment.publicOrigin)return json(403,{error:{code:'ORIGIN_REJECTED'}});
        res.setHeader('Set-Cookie',deployment.logout(req));return redirect('/login');
      }
      const health=req.method==='GET'&&url.pathname==='/healthz';
      if(!health&&!deployment.authenticate(req)){
        if(req.method==='GET'&&!url.pathname.startsWith('/api/'))return redirect('/login');
        return json(401,{error:{code:'AUTH_REQUIRED',message:'请先登录。'}});
      }
      const headers={...req.headers,host:target.host};
      for(const name of [...hopHeaders,'authorization','cookie','forwarded','x-forwarded-host','x-forwarded-proto','x-forwarded-for'])delete headers[name];
      if(headers.origin)headers.origin=target.origin;
      const proxy=http.request({hostname:target.hostname,port:target.port||80,path:health?'/api/health':url.pathname+url.search,method:req.method,headers,agent},upstreamResponse=>{
        if(res.destroyed){upstreamResponse.destroy();return;}
        const outgoing={...upstreamResponse.headers};
        for(const name of hopHeaders)delete outgoing[name];
        res.writeHead(upstreamResponse.statusCode,outgoing);
        upstreamResponse.on('error',()=>res.destroy());upstreamResponse.pipe(res);
      });
      proxy.on('error',()=>{
        if(res.destroyed)return;
        if(res.headersSent)return res.destroy();
        json(503,{error:{code:'LOCAL_SERVICE_UNAVAILABLE',message:'本机产品服务暂未运行，请在这台电脑上启动 Orynt。'}});
      });
      req.on('aborted',()=>proxy.destroy());
      res.on('close',()=>{if(!res.writableFinished)proxy.destroy();});
      req.pipe(proxy);
    }catch{
      if(!res.headersSent)json(500,{error:{code:'GATEWAY_ERROR',message:'访问入口暂不可用。'}});else res.destroy();
    }
  });
  return {server,close:()=>new Promise(resolve=>{server.close(()=>{agent.destroy();resolve();});server.closeIdleConnections();})};
}
