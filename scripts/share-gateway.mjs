import {onlineDeployment} from '../apps/api/src/deployment-policy.js';
import {createSharedGateway} from '../apps/api/src/shared-gateway.js';

const gateway=createSharedGateway({deployment:onlineDeployment(),upstream:'http://127.0.0.1:4173'});
gateway.server.on('error',error=>{console.error('Shared gateway failed:',error.code);process.exit(1);});
gateway.server.listen(Number(process.env.PORT||4193),'127.0.0.1',()=>console.log('Orynt public gateway → existing localhost workspace on port 4173'));
const stop=()=>gateway.close().then(()=>process.exit(0));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
