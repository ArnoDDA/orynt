"""Typography over continuing footage. Uses supplied copy; no network or product redraw."""
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont
from layout import font, wrapped, music


def face(text, size):
    path = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
    if text.isascii() and os.path.isfile(path):
        return ImageFont.truetype(path, size)
    return font(size)


def render(data, directory):
    w, h = 1080, 1920
    copy = data['copy']
    for index, key in enumerate(['opening', 'detail']):
        im = Image.new('RGBA', (w, h))
        d = ImageDraw.Draw(im)
        left, available = (78, 900) if index == 0 else (300, 690)
        text = copy[key]
        size = 82 if index == 0 else 72
        f = face(text, size)
        while size > 36 and len(wrapped(d, text, f, available, 20).splitlines()) > 3:
            size -= 2
            f = face(text, size)
        d.text((left, 140), data['brandName'][:40].upper(), font=face(data['brandName'], 24), fill='#434438')
        d.multiline_text((left, 200), wrapped(d, text, f, available, 4), font=f, spacing=10, fill='#282b23', stroke_width=1)
        im.save(os.path.join(directory, f'overlay-{index}.png'))
    im = Image.new('RGBA', (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        d.line((0, y, w, y), fill=(14, 21, 17, int(200 * max(0, (y / h - .38) / .62))))
    im.save(os.path.join(directory, 'closing-scrim.png'))
    for name, text, y, size in [('closing-title', data['product'], 1260, 68), ('closing-cta', copy['cta'], 1510, 42)]:
        im = Image.new('RGBA', (w, h))
        d = ImageDraw.Draw(im)
        f = face(text, size)
        d.multiline_text((78, y), wrapped(d, text, f, 910, 3), font=f, spacing=12, fill='#fffdf5')
        if name == 'closing-cta':
            d.line((78, y - 35, 150, y - 35), fill='#c7f56b', width=4)
        im.save(os.path.join(directory, name + '.png'))
    if data['music'] != 'none':
        music(15, os.path.join(directory, 'music.wav'))


if __name__ == '__main__':
    with open(os.path.join(sys.argv[1], 'layout.json'), encoding='utf-8') as stream:
        render(json.load(stream), sys.argv[1])
