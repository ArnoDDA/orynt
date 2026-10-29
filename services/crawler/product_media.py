"""Bounded extraction of product galleries; embedded data is parsed, never executed."""
import json
import re
import urllib.parse
from html.parser import HTMLParser

MAX_IMAGES = 12
MAX_BYTES = 12_000_000
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
EXCLUDED = re.compile(r'recommend|related|recently.viewed|upsell|cross.sell|predictive.search|cart.drawer|header|footer', re.I)
GALLERY = re.compile(r'product.{0,30}(gallery|media|image)|(?:gallery|media).{0,20}product', re.I)


def public_url(value, base):
    if not isinstance(value, str) or not value.strip():
        return ''
    value = urllib.parse.urljoin(base, value.strip())
    parsed = urllib.parse.urlsplit(value)
    return value if parsed.scheme in {'http', 'https'} and parsed.hostname and not parsed.username and not parsed.password else ''


def identity(url):
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    # Resize and encoding parameters do not make a new product photograph.
    query = [(k, v) for k, v in query if k.lower() not in {'width', 'height', 'w', 'h', 'quality', 'format', 'crop', 'fit'}]
    path = re.sub(r'_(?:\d+x\d*|\d*x\d+)(?=\.[a-z]+$)', '', parsed.path, flags=re.I)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, urllib.parse.urlencode(sorted(query)), ''))


class GalleryParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.images = []
        self.videos = []
        self.scripts = []
        self.script = None
        self.is_shopify = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        marker = ' '.join(str(a.get(k) or '') for k in ['id', 'class', 'data-section-type'])
        excluded = (self.stack[-1][1] if self.stack else False) or bool(EXCLUDED.search(marker)) or tag in {'header', 'footer', 'nav'}
        gallery = (self.stack[-1][2] if self.stack else False) or bool(GALLERY.search(marker)) or a.get('itemprop') == 'image'
        self.is_shopify |= 'shopify' in (a.get('src') or '').lower() or 'shopify' in marker.lower()
        if tag == 'script':
            self.script = {'type': a.get('type', ''), 'id': a.get('id', ''), 'parts': []}
        if tag == 'img' and gallery and not excluded:
            srcset = a.get('data-srcset') or a.get('srcset') or ''
            choices = []
            for candidate in srcset.split(','):
                parts = candidate.strip().split()
                if parts:
                    try: size = float(parts[-1].rstrip('wx')) if len(parts) > 1 else 0
                    except ValueError: size = 0
                    choices.append((size, parts[0]))
            source = max(choices)[1] if choices else a.get('data-src') or a.get('src')
            if source:
                self.images.append({'url': source, 'alt': a.get('alt', '')[:240], 'sourceType': 'product_gallery', 'role': 'product_view'})
        if tag in {'video', 'source'} and gallery and not excluded and a.get('src') and ('video' in a.get('type', '') or tag == 'video' or '.mp4' in a['src']):
            self.videos.append({'url': a['src'], 'sourceType': 'product_gallery', 'role': 'product_video'})
        if tag not in VOID:
            self.stack.append((tag, excluded, gallery))

    def handle_endtag(self, tag):
        if tag == 'script' and self.script:
            raw = ''.join(self.script['parts'])
            self.is_shopify |= 'Shopify.' in raw
            if self.script['type'] == 'application/json' and re.search(r'product', self.script['id'], re.I):
                try: self.scripts.append(json.loads(raw))
                except (ValueError, RecursionError): pass
            self.script = None
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if self.script is not None:
            self.script['parts'].append(data)


def shopify_endpoint(url):
    parsed = urllib.parse.urlsplit(url)
    if not re.search(r'/products/[^/]+/?$', parsed.path):
        return None
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip('/') + '.js', '', ''))


def product_media(html, url, schema_images, shopify=None):
    parser = GalleryParser()
    parser.feed(html)
    handle = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rstrip('/').rsplit('/', 1)[-1])
    data = shopify if isinstance(shopify, dict) else next((v for v in parser.scripts if isinstance(v, dict) and str(v.get('handle', '')) == handle), {})
    # Product JSON must belong to this page, not an arbitrary recommendation.
    if str(data.get('handle', '')) != handle:
        data = {}
    requested_variant = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get('variant', [''])[0]
    variants = []
    raw_variants = data.get('variants', [])
    for v in raw_variants[:80] if isinstance(raw_variants, list) else []:
        if not isinstance(v, dict): continue
        image = v.get('featured_image') or {}
        image = image.get('src') or image.get('url') if isinstance(image, dict) else image
        variants.append({'id': str(v.get('id', ''))[:100], 'name': str(v.get('public_title') or v.get('title') or '')[:160], 'sku': str(v.get('sku') or '')[:160], 'imageUrl': public_url(image, url), 'selected': bool(requested_variant and str(v.get('id')) == requested_variant)})
    selected = next((v for v in variants if v['selected']), None)
    # Shopify serves the identical file both on its CDN and under the store's
    # /cdn/shop/files path. Match only aliases proven by this product's data.
    aliases = {}
    for v in variants:
        if not v['imageUrl']: continue
        p = urllib.parse.urlsplit(v['imageUrl'])
        if p.hostname == 'cdn.shopify.com':
            aliases[urllib.parse.unquote(p.path.rsplit('/', 1)[-1])] = identity(v['imageUrl'])
    def media_key(target):
        p = urllib.parse.urlsplit(target)
        if p.hostname == urllib.parse.urlsplit(url).hostname and p.path.startswith('/cdn/shop/files/'):
            return aliases.get(urllib.parse.unquote(p.path.rsplit('/', 1)[-1]), identity(target))
        return identity(target)
    candidates = []
    if selected and selected['imageUrl']:
        candidates.append({'url': selected['imageUrl'], 'sourceType': 'product_variant', 'role': 'product_primary', 'variantId': selected['id'], 'variantName': selected['name'], 'identityStatus': 'selected_variant'})
    candidates.extend({'url': im, 'sourceType': 'schema_product_image', 'role': 'product_view'} for im in schema_images)
    raw_images = data.get('images', [])
    for im in raw_images[:40] if isinstance(raw_images, list) else []:
        candidates.append({'url': im.get('src') or im.get('url') if isinstance(im, dict) else im, 'alt': str(im.get('alt') or '')[:240] if isinstance(im, dict) else '', 'sourceType': 'product_data', 'role': 'product_view'})
    raw_media = data.get('media', [])
    for m in raw_media[:40] if isinstance(raw_media, list) else []:
        if not isinstance(m, dict) or m.get('media_type') != 'image': continue
        preview = m.get('preview_image') or {}
        if not isinstance(preview, dict): continue
        ids = m.get('variant_ids') or []
        linked = next((v for v in variants if isinstance(ids, list) and len(ids) == 1 and v['id'] == str(ids[0])), None)
        candidates.append({'url': m.get('src') or preview.get('src'), 'alt': str(m.get('alt') or preview.get('alt') or '')[:240], 'sourceType': 'product_data', 'role': 'product_view', **({'variantId': linked['id'], 'variantName': linked['name'], 'identityStatus': 'selected_variant' if linked['selected'] else 'other_variant' if selected else 'known_variant'} if linked else {})})
    candidates.extend(parser.images)
    for c in candidates:
        c['url'] = public_url(c.get('url'), url)
    unique = {}
    for c in candidates:
        if not c['url']: continue
        key = media_key(c['url'])
        if key in unique:
            if c.get('alt') and not unique[key].get('alt'): unique[key]['alt'] = c['alt']
            if c.get('variantId') and not unique[key].get('variantId'):
                unique[key].update({k: c[k] for k in ['variantId', 'variantName', 'identityStatus']})
            continue
        c.setdefault('identityStatus', 'needs_variant_check')
        matches = [v for v in variants if v['imageUrl'] and media_key(v['imageUrl']) == key]
        if len(matches) == 1:
            v = matches[0]
            c.update({'variantId': v['id'], 'variantName': v['name'], 'identityStatus': 'selected_variant' if v['selected'] else 'other_variant' if selected else 'known_variant'})
        unique[key] = c
    # Prefer this variant, then shared/unknown product views; other colors remain
    # explicitly marked and never automatically selected for generation.
    images = sorted(unique.values(), key=lambda c: c['identityStatus'] == 'other_variant')[:MAX_IMAGES]
    videos = list(parser.videos)
    raw_media = data.get('media', [])
    for m in raw_media[:30] if isinstance(raw_media, list) else []:
        if not isinstance(m, dict) or m.get('media_type') != 'video': continue
        for src in m.get('sources', [])[:3]:
            if isinstance(src, dict) and (src.get('mime_type') == 'video/mp4' or src.get('format') == 'mp4'):
                videos.append({'url': src.get('url'), 'role': 'product_video', 'sourceType': 'product_data'})
                break
    video_unique = {}
    for v in videos:
        target = public_url(v.get('url'), url)
        if target: video_unique[target] = {**v, 'url': target, 'status': 'link_only', 'visualVerification': 'not_performed'}
    return {'images': images, 'videos': list(video_unique.values())[:6], 'variants': variants, 'selectedVariantId': selected['id'] if selected else '', 'data': data, 'shopify': parser.is_shopify}
