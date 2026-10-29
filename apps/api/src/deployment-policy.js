import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export function onlineDeployment(env = process.env) {
  let origin;
  try {
    origin = new URL(env.ORYNT_PUBLIC_ORIGIN);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    if (origin.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(origin.hostname)) throw new Error();
  } catch { throw new Error('ORYNT_PUBLIC_ORIGIN 必须是完整的 HTTPS 站点地址，不含路径；本机测试可使用 HTTP。'); }
  const username = env.ORYNT_ACCESS_USER || 'demo', password = env.ORYNT_ACCESS_PASSWORD || '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(username) || password.length < 8 || /[\r\n]/.test(password) || /^(change|replace|example)/i.test(password)) throw new Error('请配置用户名以及至少 8 位的独立访问密码。');
  const hash = value => createHash('sha256').update(value).digest();
  const expected = hash('Basic ' + Buffer.from(`${username}:${password}`).toString('base64'));
  const sessions = new Map(), failures = [];
  const cookieName = origin.protocol === 'https:' ? '__Host-orynt_session' : 'orynt_session';
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.protocol === 'https:' ? '; Secure' : ''}`;
  const sessionId = request => (request.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  return Object.freeze({ publicOrigin: origin.origin, host: origin.host, demoOnly: env.ORYNT_DEMO_ONLY !== '0',
    authenticate(request) {
      if(typeof request.headers.authorization === 'string' && timingSafeEqual(hash(request.headers.authorization), expected))return true;
      const id=sessionId(request),expiry=sessions.get(id);
      if(expiry>Date.now())return true;
      if(id)sessions.delete(id);
      return false;
    },
    login(user, pass) {
      const now=Date.now();
      while(failures.length && failures[0]<now-60_000)failures.shift();
      if(failures.length>=20)return {status:429};
      if(typeof user!=='string'||typeof pass!=='string'||!timingSafeEqual(hash('Basic '+Buffer.from(`${user}:${pass}`).toString('base64')),expected)){
        failures.push(now);return {status:401};
      }
      for(const [id,expiry] of sessions)if(expiry<=now)sessions.delete(id);
      if(sessions.size>=256)sessions.delete(sessions.keys().next().value);
      const id=randomBytes(32).toString('base64url');sessions.set(id,now+12*60*60_000);
      return {status:200,cookie:cookie(id,12*60*60)};
    },
    logout(request){sessions.delete(sessionId(request));return cookie('',0);}
  });
}

export const blockedDemoProvider = new Proxy({}, {
  get: (_, key) => key === 'available' ? false : async () => { throw Object.assign(new Error('线上演示不调用外部采集或付费生成服务。'), { code:'ONLINE_DEMO_ONLY' }); }
});
