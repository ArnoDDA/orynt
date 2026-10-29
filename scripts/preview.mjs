import { createApplication } from '../apps/api/src/server.js';

const application = createApplication();
const firstPort = Number(process.env.PORT || 4173);
let port = firstPort;

application.server.on('error', error => {
  if (error.code === 'EADDRINUSE' && !process.env.PORT && port < firstPort + 20) {
    port++;
    application.server.listen(port, '127.0.0.1');
    return;
  }
  console.error(`Unable to start Orynt: ${error.code || error.message}`);
  application.repository.close();
  process.exit(1);
});
application.server.on('listening', () => {
  console.log(`Orynt local workspace: http://127.0.0.1:${port}/#/home`);
});
application.server.listen(port, '127.0.0.1');

const stop = () => application.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
