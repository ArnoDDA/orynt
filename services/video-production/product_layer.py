"""Deterministic original-photo layer. No models, network, or guessed cutouts."""
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageOps

Image.MAX_IMAGE_PIXELS = 40_000_000


def render(directory):
    with open(os.path.join(directory, 'composition.json'), encoding='utf-8') as stream:
        data = json.load(stream)
    width, height = data['width'], data['height']
    with Image.open(os.path.join(directory, 'product-source')) as source:
        source.load()
        photo = ImageOps.exif_transpose(source).convert('RGBA')
    # Only trim genuinely transparent padding. Never erase pale product pixels
    # using a white-background heuristic; opaque photos retain their full image.
    alpha = photo.getchannel('A')
    bbox = alpha.getbbox()
    if not bbox:
        raise ValueError('产品图完全透明，请更换可见的产品图。')
    has_alpha = alpha.getextrema()[0] < 255
    if has_alpha:
        photo = photo.crop(bbox)
    if max(photo.size) > 8000 or photo.width * photo.height > 40_000_000:
        raise ValueError('产品图像素过大，请使用不超过 4000 万像素的图片。')

    # A deliberate product-photo plate, not a claim of 3D insertion into a scene.
    # Same normalized geometry is used for still and moving previews.
    portrait = height > width
    x0, y0, x1, y1 = ((.16, .20, .84, .70) if portrait else (.29, .18, .71, .72))
    if data.get('index') == 1:
        x0, x1 = ((.12, .88) if portrait else (.25, .75))
    plate = tuple(round(v * (width if i % 2 == 0 else height)) for i, v in enumerate((x0, y0, x1, y1)))
    radius = round(min(width, height) * .026)
    layer = Image.new('RGBA', (width, height), (10, 14, 19, 40))
    pad = max(12, round(min(width, height) * .035))
    fitted = ImageOps.contain(photo, (plate[2] - plate[0] - 2 * pad, plate[3] - plate[1] - 2 * pad), Image.Resampling.LANCZOS)
    position = ((plate[0] + plate[2] - fitted.width) // 2, (plate[1] + plate[3] - fitted.height) // 2)
    shadow = Image.new('RGBA', (width, height))
    offset = max(3, round(height * .012))
    if has_alpha:
        # Use supplied transparency directly, without an unnecessary white card.
        # This is photo compositing, not a model-generated or guessed cutout.
        silhouette = Image.new('RGBA', fitted.size, (0, 0, 0, 0))
        silhouette.putalpha(fitted.getchannel('A').point(lambda a: round(a * .32)))
        shadow.alpha_composite(silhouette, (position[0] + offset, position[1] + offset))
    else:
        ImageDraw.Draw(shadow).rounded_rectangle((plate[0], plate[1] + offset, plate[2], plate[3] + offset), radius=radius, fill=(0, 0, 0, 85))
    layer = Image.alpha_composite(layer, shadow.filter(ImageFilter.GaussianBlur(min(width, height) * .025)))
    if not has_alpha:
        ImageDraw.Draw(layer).rounded_rectangle(plate, radius=radius, fill=(255, 255, 255, 255))
    layer.alpha_composite(fitted, position)
    layer.save(os.path.join(directory, 'product-layer.png'))
    if os.path.exists(os.path.join(directory, 'background-source')):
        with Image.open(os.path.join(directory, 'background-source')) as background:
            background.load()
            background = ImageOps.fit(ImageOps.exif_transpose(background).convert('RGBA'), (width, height), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(12))
        Image.alpha_composite(background, layer).convert('RGB').save(os.path.join(directory, 'product-preview.jpg'), quality=95)
    print(json.dumps({'layoutVersion': 'original-photo-plate-v1', 'treatment': 'original_alpha' if has_alpha else 'original_photo_plate', 'width': width, 'height': height, 'plate': list(plate), 'sourceWidth': photo.width, 'sourceHeight': photo.height, 'backgroundBlur': 12, 'productMotion': 'static_local_layer', 'network': False}))


if __name__ == '__main__':
    render(sys.argv[1])
