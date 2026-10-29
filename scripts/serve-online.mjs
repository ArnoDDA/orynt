import { onlineDeployment } from '../apps/api/src/deployment-policy.js';
import { DemoLibrary } from '../apps/api/src/demo-library.js';

const deployment=onlineDeployment();
if(deployment.demoOnly){
  const demo=await new DemoLibrary().load();
  if(!demo.view.integrity||demo.view.technical.status!=='passed'||!(demo.view.media.finalVideo||demo.view.reviewMedia?.finalVideo))throw new Error('演示素材缺失或校验失败，未开放线上服务。');
}
const { createApplication }=await import('../apps/api/src/server.js');
const port=Number(process.env.PORT||3000);
if(!Number.isInteger(port)||port<0||port>65535)throw new Error('PORT 无效。');
const application=createApplication({deployment});
application.server.on('error',error=>{console.error(`Unable to serve: ${error.code||'START_FAILED'}`);application.repository.close();process.exit(1);});
application.server.listen(port,'0.0.0.0',()=>console.log(`Orynt online preview: ${deployment.publicOrigin} · ${deployment.demoOnly?'fixed replay':'configured live services'} · shared workspace`));
const stop=()=>application.close().then(()=>process.exit(0));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
