"""Keep public ad images/posters locally; never infer motion from a poster."""
import base64
import hashlib
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

from orynt_crawler import HttpClient, UrlPolicy, WebsiteConnector, USER_AGENT
from product_import import image_format

MAX_MEDIA_BYTES = 6_000_000
MAX_IMAGE_BYTES = 1_500_000


def ad_media_candidates(ad):
    snapshot = ad.get('snapshot') if isinstance(ad.get('snapshot'), dict) else {}
    found, seen = [], set()

    def add(value, kind):
        if not isinstance(value, str):
            return
        try:
            url = urllib.parse.urlsplit(value)
            valid = url.scheme == 'https' and url.hostname and not url.username and not url.password and url.port in (None, 443)
        except ValueError:
            valid = False
        if valid and value not in seen:
            seen.add(value)
            found.append({'sourceUrl': value, 'kind': kind})

    def visit(container):
        if not isinstance(container, dict):
            return
        for video in container.get('videos') or []:
            if isinstance(video, dict):
                add(video.get('video_preview_image_url') or video.get('thumbnail_url'), 'video_poster')
        for image in container.get('images') or []:
            if isinstance(image, dict):
                add(image.get('original_image_url') or image.get('resized_image_url') or image.get('url'), 'image')
            elif isinstance(image, str):
                add(image, 'image')
        add(container.get('video_preview_image_url'), 'video_poster')
        add(container.get('original_image_url') or container.get('resized_image_url') or container.get('image_url'), 'image')

    visit(snapshot)
    for card in snapshot.get('cards') or []:
        visit(card)
    return found[:2]


def download_ad_image(candidate, *, check_robots=True):
    url = candidate['sourceUrl']
    policy = UrlPolicy(url)
    client = HttpClient(policy, timeout_seconds=5, max_retries=1, max_bytes=MAX_IMAGE_BYTES)
    if check_robots:
        rules = WebsiteConnector()._load_robots(client, url)
        if not rules.can_fetch(USER_AGENT, url):
            raise ValueError('ROBOTS_DENIED')
    image = client.get(url, accepted_types=('image/png', 'image/jpeg', 'image/webp'))
    mime, _ = image_format(image.body)
    return {**candidate, 'sourceUrl': image.url, 'status': 'available', 'mime': mime,
            'base64': base64.b64encode(image.body).decode('ascii'),
            'bytes': len(image.body), 'sha256': hashlib.sha256(image.body).hexdigest()}


def attach_ad_media(items, *, loader=download_ad_image, direct_urls=frozenset()):
    """Download at most two visuals per real ad, without failing its text evidence."""
    tasks = [(item, candidate) for item in items if not item.get('demo') for candidate in item.get('mediaCandidates', [])[:2]]

    def load(task):
        item, candidate = task
        try:
            # The normal collector never supplies this set. A separate, explicit
            # one-use hydration request may authorize exact public asset URLs.
            return item, loader(candidate,check_robots=False) if candidate['sourceUrl'] in direct_urls else loader(candidate)
        except Exception as error:
            reason = 'ROBOTS_DENIED' if str(error) == 'ROBOTS_DENIED' else 'DOWNLOAD_FAILED'
            return item, {**candidate, 'status': 'unavailable', 'reason': reason}

    total = 0
    for item in items:
        item['media'] = []
        item['mediaStatus'] = 'not_found' if not item.get('mediaCandidates') else 'unavailable'
    with ThreadPoolExecutor(max_workers=4) as pool:
        for item, media in pool.map(load, tasks):
            if media.get('status') == 'available':
                if total + media['bytes'] > MAX_MEDIA_BYTES:
                    media = {**{k: media[k] for k in ('sourceUrl', 'kind')}, 'status': 'unavailable', 'reason': 'BATCH_LIMIT'}
                else:
                    total += media['bytes']
                    item['mediaStatus'] = 'available'
            item['media'].append(media)
    for item in items:
        item.pop('mediaCandidates', None)
    return items
