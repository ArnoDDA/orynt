import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Repository} from '../src/repository.js';
import {createApplication} from '../src/server.js';
import {onlineDeployment} from '../src/deployment-policy.js';
import {createSharedGateway} from '../src/shared-gateway.js';

const publicOrigin='https://orynt-example.ngrok-free.dev';
const deployment=()=>onlineDeployment({ORYNT_PUBLIC_ORIGIN:publicOrigin,ORYNT_ACCESS_USER:'demo',ORYNT_ACCESS_PASSWORD:'test-password',ORYNT_DEMO_ONLY:'0'});
function request(port,path,{method='GET',headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:new URL(publicOrigin).host,...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks),json:()=>JSON.parse(Buffer.concat(chunks))}));
    });req.on('error',reject);req.end(body);
  });
}
test('public gateway uses the live local session, state and media, with public authentication and origin checks',async()=>{
  const repository=new Repository(),app=createApplication({repository,tickMs:0});let gateway;
  try{
    repository.transact(s=>{
      s.brandAssets.push({id:'fixture-image',workspaceId:'local',status:'ready',mime:'image/png',base64:Buffer.from('image-fixture').toString('base64'),name:'product.png'});
      s.assets.push({id:'fixture-video',workspaceId:'local',type:'video',mime:'video/mp4',base64:Buffer.from('0000ftyp-video-fixture').toString('base64')});
    });
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const localPort=app.server.address().port;
    gateway=createSharedGateway({deployment:deployment(),upstream:`http://127.0.0.1:${localPort}`});
    await new Promise(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
    const port=gateway.server.address().port;
    assert.equal((await request(port,'/api/state')).status,401);
    assert.equal((await request(port,'/api/state',{headers:{Host:'attacker.example'}})).status,403);
    assert.equal((await request(port,'/login')).status,200);
    const login=await request(port,'/auth/login',{method:'POST',headers:{Origin:publicOrigin,'Content-Type':'application/x-www-form-urlencoded'},body:'username=demo&password=test-password'});
    assert.equal(login.status,303);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    const session=(await request(port,'/api/session',{headers:{Cookie:cookie}})).json();
    const localSession=await(await fetch(`http://127.0.0.1:${localPort}/api/session`)).json();
    assert.equal(session.token,localSession.token);
    const commandBody=JSON.stringify({action:'campaign.create',data:{brandUrl:'https://example.com/products/bottle',product:'Shared product'}});
    const commandHeaders={Cookie:cookie,Origin:publicOrigin,'Content-Type':'application/json','X-Local-Session':session.token,'Idempotency-Key':'shared-gateway-command'};
    assert.equal((await request(port,'/api/commands',{method:'POST',headers:{...commandHeaders,Origin:'https://attacker.example'},body:commandBody})).status,403);
    const command=await request(port,'/api/commands',{method:'POST',headers:commandHeaders,body:commandBody});
    assert.equal(command.status,200);
    const campaignId=command.json().result.campaignId;
    assert.ok(app.core.state().campaigns.some(c=>c.id===campaignId));
    assert.deepEqual((await request(port,'/api/state',{headers:{Cookie:cookie}})).json(),app.core.state());
    const image=await request(port,'/api/brand-assets/fixture-image/preview',{headers:{Cookie:cookie}});
    assert.equal(image.status,200);assert.equal(image.bytes.toString(),'image-fixture');
    const video=await request(port,'/api/assets/fixture-video/preview',{headers:{Cookie:cookie,Range:'bytes=4-7'}});
    assert.equal(video.status,206);assert.equal(video.bytes.toString(),'ftyp');
    assert.equal(video.headers['content-range'],'bytes 4-7/22');
    const logout=await request(port,'/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:publicOrigin}});
    assert.equal(logout.status,303);
    assert.equal((await request(port,'/api/state',{headers:{Cookie:cookie}})).status,401);
  }finally{if(gateway)await gateway.close();await app.close();}
});

test('gateway cannot target an external upstream or create a second data store',()=>{
  for(const upstream of ['https://example.com','http://192.168.1.1','http://127.0.0.1/private','http://user:pass@127.0.0.1'])assert.throws(()=>createSharedGateway({deployment:deployment(),upstream}));
});
