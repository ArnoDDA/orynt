export function fixedEndpoint(line, expected = null) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (event.msg !== 'started tunnel' || typeof event.url !== 'string') return null;
  let url;
  try { url = new URL(event.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !/\.(ngrok-free\.(app|dev)|ngrok\.(app|dev|io))$/.test(url.hostname)) return null;
  if (expected && url.origin !== expected) throw new Error('FIXED_ADDRESS_CHANGED');
  return url.origin;
}
