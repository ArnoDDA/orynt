"""Read one public product page locally; never execute scripts or call a model."""
import argparse
import base64
import json
import re
import sys
import socket
import hashlib
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.parse
from html.parser import HTMLParser

from orynt_crawler import FetchError, HttpClient, UrlPolicy, WebsiteConnector, utc_now, USER_AGENT
from product_media import product_media, shopify_endpoint, MAX_IMAGES, MAX_BYTES


class ProductPageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.json_ld = []
        self.title = []
        self.heading = []
        self.language = ""
        self._script = None
        self._capture = None
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'html':
            self.language = values.get('lang') or ''
        if tag == 'meta':
            key = (values.get('property') or values.get('name') or '').lower()
            if key and values.get('content'):
                self.meta[key] = values['content']
        if tag == 'script':
            self._script = [] if (values.get('type') or '').lower() == 'application/ld+json' else None
            self._skip += 1
        elif tag in {'style', 'noscript', 'svg'}:
            self._skip += 1
        if tag in {'title', 'h1'} and not self._skip:
            self._capture = tag

    def handle_endtag(self, tag):
        if tag == 'script':
            if self._script is not None:
                try:
                    self.json_ld.append(json.loads(''.join(self._script)))
                except (ValueError, RecursionError):
                    pass
            self._script = None
        if tag in {'script', 'style', 'noscript', 'svg'}:
            self._skip = max(0, self._skip - 1)
        if tag == self._capture:
            self._capture = None

    def handle_data(self, text):
        if self._script is not None:
            self._script.append(text)
        if not self._skip:
            if self._capture == 'title':
                self.title.append(text)
            elif self._capture == 'h1':
                self.heading.append(text)


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, text):
        self.parts.append(text)


def clean(value, limit=1200):
    if not isinstance(value, str):
        return ''
    parser = PlainText()
    parser.feed(value)
    return re.sub(r'\s+', ' ', ' '.join(parser.parts)).strip()[:limit]


def product_nodes(value, depth=0):
    if depth > 12:
        return []
    if isinstance(value, list):
        return [item for child in value[:100] for item in product_nodes(child, depth + 1)]
    if not isinstance(value, dict):
        return []
    types = value.get('@type', [])
    types = [types] if isinstance(types, str) else types
    if isinstance(types, list) and any(kind in {'Product', 'ProductGroup'} for kind in types if isinstance(kind, str)):
        return [value]
    return [item for key in ['@graph', 'mainEntity'] for item in product_nodes(value.get(key), depth + 1)]


def extract(html, url):
    parser = ProductPageParser()
    parser.feed(html)
    products = [node for value in parser.json_ld for node in product_nodes(value)]
    same_page = lambda node: urllib.parse.urljoin(url, str(node.get('url', ''))).split('?')[0].rstrip('/') == url.split('?')[0].rstrip('/')
    product = next((node for node in products if node.get('url') and same_page(node)), None)
    if product is None and len(products) == 1:
        product = products[0]
    product = product or {}
    def scalar(value):
        if isinstance(value, dict):
            value = value.get('name') or value.get('value')
        return clean(value, 300) if isinstance(value, str) else ''

    attributes = []
    for key, label in [('material', '材质'), ('color', '颜色'), ('size', '规格')]:
        value = scalar(product.get(key))
        if value:
            attributes.append({'name': label, 'value': value})
    properties = product.get('additionalProperty') or []
    properties = properties if isinstance(properties, list) else [properties]
    for item in properties[:12]:
        if isinstance(item, dict) and scalar(item.get('name')) and scalar(item.get('value')):
            attributes.append({'name': scalar(item['name']), 'value': scalar(item['value'])})
    candidates = []
    for node in products[:8]:
        target = urllib.parse.urljoin(url, str(node.get('url') or ''))
        parsed = urllib.parse.urlparse(target)
        if node.get('url') and parsed.scheme in {'https', 'http'} and parsed.netloc == urllib.parse.urlparse(url).netloc and not parsed.username and scalar(node.get('name')):
            if not any(item['url'] == target for item in candidates):
                candidates.append({'name': scalar(node.get('name')), 'url': target})
    details = {'category': scalar(product.get('category')), 'model': scalar(product.get('model')), 'sku': scalar(product.get('sku')), 'attributes': attributes[:12], 'candidates': candidates}
    meta = parser.meta
    fields = {}

    def put(key, value, source, confidence):
        value = clean(value)
        if value:
            fields[key] = {'value': value, 'sourceType': source, 'sourceUrl': url, 'confidence': confidence, 'confirmation': 'pending'}

    put('product', product.get('name'), 'schema_product', .95)
    if 'product' not in fields:
        put('product', meta.get('og:title') or ' '.join(parser.heading) or ' '.join(parser.title), 'page_title', .65)
    put('claim', product.get('description'), 'schema_description', .8)
    if 'claim' not in fields:
        put('claim', meta.get('description') or meta.get('og:description'), 'page_description', .65)
    brand = product.get('brand') or {}
    put('brandName', brand.get('name') if isinstance(brand, dict) else brand, 'schema_brand', .95)
    if 'brandName' not in fields:
        put('brandName', meta.get('og:site_name'), 'site_name', .8)
    images = product.get('image') or []
    images = images if isinstance(images, list) else [images]
    images += [meta.get('og:image'), meta.get('twitter:image')]
    candidates = []
    for image in images:
        value = image.get('url') or image.get('contentUrl') if isinstance(image, dict) else image
        if not isinstance(value, str) or not value.strip():
            continue
        image_url = urllib.parse.urljoin(url, value.strip())
        if image_url not in candidates:
            candidates.append(image_url)
    limitations = ['网页描述是品牌自述，尚未经用户确认，不代表市场或效果验证。']
    meta_product = not products and meta.get('og:type', '').lower() in {'product', 'product.item'}
    if meta_product:
        limitations.append('网站将此页标为商品页；名称、简介和图片来自页面标记，未提供可读取的结构化商品属性，请核对。')
    elif not product:
        limitations.append('未找到明确的商品结构化信息；标题和描述可能属于整站，请核对或改用具体商品页。')
    if len(products) > 1 and not product:
        limitations.append('页面包含多个商品，尚未自动选择；请选择具体商品页面，避免混用不同产品的资料。')
    if 'claim' not in fields:
        limitations.append('网页没有提供可提取的产品描述，请补充本次想表达的卖点。')
    media = product_media(html, url, candidates) if product or meta_product else {'images': [{'url': c} for c in candidates], 'videos': [], 'variants': [], 'selectedVariantId': ''}
    return {'sourceUrl': url, 'observedAt': utc_now(), 'pageKind': 'product' if product or meta_product else 'website', 'fields': fields, 'details': details, 'language': parser.language[:40], 'imageUrls': [im['url'] for im in media['images']][:MAX_IMAGES], 'mediaCandidates': media['images'][:MAX_IMAGES], 'videos': media['videos'], 'variants': media['variants'], 'selectedVariantId': media['selectedVariantId'], 'limitations': limitations}


def image_format(body):
    if body.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png', 'png'
    if body.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg', 'jpg'
    if len(body) >= 12 and body[:4] == b'RIFF' and body[8:12] == b'WEBP':
        return 'image/webp', 'webp'
    raise ValueError('图片格式不支持，当前只读取 PNG、JPG 和 WebP')


def collect(url):
    policy = UrlPolicy(url)
    http = HttpClient(policy, timeout_seconds=10, max_retries=1)
    rules = WebsiteConnector()._load_robots(http, url, strict=True)
    if not rules.can_fetch(USER_AGENT, url):
        raise FetchError('ROBOTS_DENIED', '该网站的自动访问规则不允许读取此商品页。可以手动填写产品资料。')
    page = http.get(url, accepted_types=('text/html', 'application/xhtml+xml'))
    html = page.body.decode('utf-8', errors='replace')
    result = extract(html, page.url)
    media = product_media(html, page.url, result['imageUrls'])
    endpoint = shopify_endpoint(page.url) if media['shopify'] else None
    if endpoint and rules.can_fetch(USER_AGENT, endpoint):
        try:
            response = http.get(endpoint, accepted_types=('application/json', 'text/javascript', 'application/javascript'))
            enriched = product_media(html, page.url, result['imageUrls'], json.loads(response.body))
            data = enriched.pop('data')
            if data:
                result.update({'mediaCandidates': enriched['images'], 'imageUrls': [im['url'] for im in enriched['images']], 'videos': enriched['videos'], 'variants': enriched['variants'], 'selectedVariantId': enriched['selectedVariantId'], 'pageKind': 'product'})
                for key, value in [('product', data.get('title')), ('claim', data.get('description')), ('brandName', data.get('vendor'))]:
                    if key not in result['fields'] and clean(value):
                        result['fields'][key] = {'value': clean(value), 'sourceType': 'product_data', 'sourceUrl': page.url, 'confidence': .85, 'confirmation': 'pending'}
                result['details']['category'] = result['details']['category'] or clean(data.get('type'), 160)
                selected = next((v for v in enriched['variants'] if v['selected']), None)
                if selected: result['details']['sku'] = selected['sku']
        except Exception:
            result['limitations'].append('补充商品数据暂不可读，已保留网页中找到的素材。')
    result['images'] = []
    total_bytes = 0
    seen = set()
    urls = result.pop('imageUrls')
    metadata = {im['url']: im for im in result.pop('mediaCandidates', [])}
    def download(image_url):
        try:
            image_policy = UrlPolicy(image_url)
            client = HttpClient(image_policy, timeout_seconds=6, max_retries=1, max_bytes=3_000_000)
            image_rules = WebsiteConnector()._load_robots(client, image_url)
            if not image_rules.can_fetch(USER_AGENT, image_url):
                raise ValueError('图片来源不允许自动读取')
            image = client.get(image_url, accepted_types=('image/png', 'image/jpeg', 'image/webp'))
            mime, extension = image_format(image.body)
            return image, mime, extension
        except Exception:
            return None
    with ThreadPoolExecutor(max_workers=3) as pool:
        for image_url, downloaded in zip(urls, pool.map(download, urls)):
            if downloaded is None:
                result['limitations'].append('有候选图片无法读取，可自行上传产品图。')
                continue
            image, mime, extension = downloaded
            digest = hashlib.sha256(image.body).hexdigest()
            if digest in seen: continue
            if total_bytes + len(image.body) > MAX_BYTES:
                result['limitations'].append('已达到本次素材下载容量，保留已读取的产品图。')
                continue
            seen.add(digest)
            total_bytes += len(image.body)
            meta = metadata.get(image_url, {})
            result['images'].append({'sourceUrl': image.url, 'mime': mime, 'name': f'product-image-{len(result["images"]) + 1}.{extension}', 'base64': base64.b64encode(image.body).decode('ascii'), 'sha256': digest, **{k: meta[k] for k in ['alt', 'sourceType', 'role', 'variantId', 'variantName', 'identityStatus'] if k in meta}})
    if not result['images']:
        result['limitations'].append('未取得可用产品图；可以上传本地图片，也可以先确认产品资料。')
    result['limitations'] = list(dict.fromkeys(result['limitations']))
    return result


if __name__ == '__main__':
    args = argparse.ArgumentParser()
    args.add_argument('--url', required=True)
    options = args.parse_args()
    try:
        print(json.dumps(collect(options.url), ensure_ascii=False))
    except Exception as error:
        code = getattr(error, 'code', None) if isinstance(error, FetchError) else None
        if isinstance(error, urllib.error.HTTPError):
            code = {404: 'PRODUCT_PAGE_NOT_FOUND', 401: 'PRODUCT_PAGE_RESTRICTED', 403: 'PRODUCT_PAGE_RESTRICTED', 429: 'PRODUCT_PAGE_RATE_LIMITED'}.get(error.code, 'PRODUCT_HTTP_ERROR')
        elif isinstance(error, socket.gaierror):
            code = 'PRODUCT_DNS_FAILED'
        elif isinstance(error, (TimeoutError, socket.timeout)):
            code = 'PRODUCT_IMPORT_TIMEOUT'
        elif isinstance(error, urllib.error.URLError):
            code = 'PRODUCT_CONNECTION_FAILED'
        print(json.dumps({'error': str(error), 'code': code or 'PRODUCT_IMPORT_UNAVAILABLE'}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
