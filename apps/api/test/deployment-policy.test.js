import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { onlineDeployment } from '../src/deployment-policy.js';
import { createApplication } from '../src/server.js';
import { Repository } from '../src/repository.js';

test('online deployment requires HTTPS and an independent password, with explicit local HTTP for testing',()=>{
  const password=randomUUID();
  for(const origin of ['http://public.example','https://user:pass@public.example','https://public.example/path','file:///tmp/demo','https://public.example/?x=1'])assert.throws(()=>onlineDeployment({ORYNT_PUBLIC_ORIGIN:origin,ORYNT_ACCESS_PASSWORD:password}));
  assert.throws(()=>onlineDeployment({ORYNT_PUBLIC_ORIGIN:'https://public.example',ORYNT_ACCESS_PASSWORD:'short'}));
  assert.throws(()=>onlineDeployment({ORYNT_PUBLIC_ORIGIN:'https://public.example',ORYNT_ACCESS_PASSWORD:'REPLACE_WITH_A_RANDOM_PASSWORD'}));
  assert.equal(onlineDeployment({ORYNT_PUBLIC_ORIGIN:'http://127.0.0.1:3000',ORYNT_ACCESS_PASSWORD:password}).demoOnly,true);
});

test('hosted HTTP protects UI, state and media, rejects foreign origins and live creation, and exposes only generic health',async()=>{
  const password=randomUUID(),deployment=onlineDeployment({ORYNT_PUBLIC_ORIGIN:'https://preview.example',ORYNT_ACCESS_PASSWORD:password});
  const app=createApplication({repository:new Repository(),tickMs:0,deployment});
  const auth={Host:deployment.host,Authorization:'Basic '+Buffer.from('demo:'+password).toString('base64')};
  try{
    await new Promise((ok,fail)=>{app.server.once('error',fail);app.server.listen(0,'127.0.0.1',ok);});
    const call=(path,headers={},body)=>new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:app.server.address().port,path,headers,method:body?'POST':'GET'},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString(),headers:res.headers}));
      });req.on('error',reject);req.end(body);
    });
    const entry=await call('/',{Host:deployment.host});assert.equal(entry.status,303);assert.equal(entry.headers.location,'/login');assert.equal(entry.headers['www-authenticate'],undefined);
    for(const path of ['/api/session','/api/state','/api/assets/example/preview'])assert.equal((await call(path,{Host:deployment.host})).status,401);
    assert.equal((await call('/api/state',{...auth,Origin:'https://other.example'})).status,403);
    assert.equal((await call('/api/state',{...auth,Host:'other.example','X-Forwarded-Host':deployment.host})).status,403);
    assert.deepEqual(JSON.parse((await call('/healthz')).text),{status:'ok'});
    const session=JSON.parse((await call('/api/session',auth)).text);assert.equal(session.deployment.sharedWorkspace,true);
    const state=await call('/api/state',auth);assert.equal(state.status,200);assert.ok(!state.text.includes(password));
    const result=await call('/api/commands',{...auth,Origin:deployment.publicOrigin,'Content-Type':'application/json','X-Local-Session':session.token,'Idempotency-Key':randomUUID()},JSON.stringify({action:'campaign.create',data:{brandUrl:'https://example.com'}}));
    assert.equal(result.status,409);assert.equal(JSON.parse(result.text).error.code,'ONLINE_DEMO_ONLY');
    assert.equal(app.jobRunner.videoProvider.available,false);assert.equal(app.jobRunner.productionRunner.videoProvider.available,false);
  }finally{await app.close();}
});

test('dedicated login issues a private cookie, protects forms, rejects bad passwords and revokes logout sessions',async()=>{
  const password=randomUUID(),deployment=onlineDeployment({ORYNT_PUBLIC_ORIGIN:'https://preview.example',ORYNT_ACCESS_PASSWORD:password});
  const app=createApplication({repository:new Repository(),tickMs:0,deployment});
  try{
    await new Promise((ok,fail)=>{app.server.once('error',fail);app.server.listen(0,'127.0.0.1',ok);});
    const call=(path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:app.server.address().port,path,method,headers:{Host:deployment.host,...headers}},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString(),headers:res.headers}));
      });req.on('error',reject);req.end(body);
    });
    for(const path of ['/login','/login.css','/login.js','/orynt-logo.svg']){
      const res=await call(path);assert.equal(res.status,200);assert.ok(!res.text.includes(password));
    }
    const headers={Origin:deployment.publicOrigin,'Content-Type':'application/x-www-form-urlencoded'};
    const body=new URLSearchParams({username:'demo',password}).toString();
    assert.equal((await call('/auth/login',{method:'POST',body,headers:{...headers,Origin:'https://other.example'}})).status,403);
    const wrong=await call('/auth/login',{method:'POST',headers,body:'username=demo&password=wrong'});
    assert.equal(wrong.headers.location,'/login?error=invalid');assert.equal(wrong.headers['set-cookie'],undefined);
    const login=await call('/auth/login',{method:'POST',headers,body});assert.equal(login.status,303);assert.equal(login.headers.location,'/#/home');
    const raw=login.headers['set-cookie'][0];assert.match(raw,/HttpOnly/);assert.match(raw,/; Secure/);assert.match(raw,/SameSite=Lax/);assert.ok(!raw.includes(password));
    const Cookie=raw.split(';')[0];assert.equal((await call('/api/state',{headers:{Cookie}})).status,200);
    assert.equal((await call('/api/state',{headers:{Cookie:Cookie+'tampered'}})).status,401);
    assert.equal((await call('/login',{headers:{Cookie}})).headers.location,'/#/home');
    assert.equal((await call('/auth/logout',{method:'POST',headers:{Cookie,Origin:deployment.publicOrigin}})).status,303);
    assert.equal((await call('/api/state',{headers:{Cookie}})).status,401);
    for(let i=0;i<20;i++)deployment.login('demo','wrong');assert.equal(deployment.login('demo',password).status,429);
  }finally{await app.close();}
});
