import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../services/crawler/product_import.py', import.meta.url));
const failureMessages = {
  NETWORK_ADDRESS_BLOCKED: '此网址解析到本机、内网或保留地址，无法作为公开商品页读取。请确认商品网址和本机网络设置。',
  PUBLIC_DNS_UNAVAILABLE: '检测到代理虚拟地址，但暂未能查询到真实公网地址。请检查网络后点击「重新读取」。',
  PRODUCT_DNS_FAILED: '暂时无法解析商品网站域名。请检查网址或网络后重新读取。',
  ROBOTS_UNAVAILABLE: '未能读取网站的自动访问规则，暂未继续读取商品页。请检查网络或稍后重新读取。',
  ROBOTS_DENIED: '该网站的自动访问规则不允许读取此商品页。可以手动填写产品资料。',
  PRODUCT_PAGE_NOT_FOUND: '这个商品链接返回了 404，可能已下架或地区链接已变化。请使用浏览器中实际可打开的商品链接。',
  PRODUCT_PAGE_RESTRICTED: '网站限制了自动访问，可能需要登录或浏览器验证。你仍可手动填写产品资料。',
  PRODUCT_PAGE_RATE_LIMITED: '网站暂时限制了请求频率，请稍后再读取。',
  PRODUCT_HTTP_ERROR: '商品网站暂时返回异常，请稍后重新读取。',
  PRODUCT_CONNECTION_FAILED: '未能连接商品网站，请检查本机网络后重新读取。',
  PRODUCT_IMPORT_TIMEOUT: '商品页读取超时，请稍后重新读取；也可以先手动填写。',
  PRODUCT_IMPORT_UNAVAILABLE: '产品资料读取未完成。可以重新读取，或先手动填写产品名称和广告重点。'
};

export class LocalProductImporter {
  constructor({ python = 'python3', execute = run } = {}) { Object.assign(this, { python, execute }); }

  async collect({ url, signal }) {
    try {
      const { stdout } = await this.execute(this.python, [script, '--url', url], {
        timeout: 120_000, maxBuffer: 18_000_000, signal,
        env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1' }
      });
      const result = JSON.parse(stdout);
      if (!result.fields || !Array.isArray(result.images)) throw new Error('Invalid product import result');
      return result;
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      let code = error.killed ? 'PRODUCT_IMPORT_TIMEOUT' : 'PRODUCT_IMPORT_UNAVAILABLE';
      try {
        const detail = JSON.parse(error.stderr);
        if (Object.hasOwn(failureMessages, detail.code)) code = detail.code;
      } catch { /* Never expose arbitrary subprocess output or page text as a system error. */ }
      throw Object.assign(new Error(failureMessages[code]), { code });
    }
  }
}
