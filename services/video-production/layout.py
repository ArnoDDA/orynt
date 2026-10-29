"""Local typography, product end card and an original quiet music bed. No network."""
import json
import math
import os
import struct
import sys
import wave
from PIL import Image, ImageDraw, ImageFont, ImageOps


def font(size):
    choices = [os.environ.get('ORYNT_FONT', ''), '/System/Library/Fonts/STHeiti Light.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    for path in choices:
        if path and os.path.isfile(path):
            return ImageFont.truetype(path, size)
    raise RuntimeError('未找到可用的字幕字体，请配置 ORYNT_FONT。')


def wrapped(draw, text, face, width, limit=3):
    lines, current = [], ''
    # Word wrapping for Latin text; individual glyph wrapping for CJK.
    words = text.split(' ') if ' ' in text else list(text)
    separator = ' ' if ' ' in text else ''
    for word in words:
        if draw.textlength(word, font=face) > width:
            if current:
                lines.append(current)
                current = ''
            for char in word:
                if current and draw.textlength(current + char, font=face) > width:
                    lines.append(current)
                    current = ''
                current += char
            continue
        candidate = current + (separator if current else '') + word
        if current and draw.textlength(candidate, font=face) > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current: lines.append(current)
    if len(lines) > limit:
        lines = lines[:limit]
        lines[-1] = lines[-1].rstrip(' .') + '…'
        while len(lines[-1]) > 1 and draw.textlength(lines[-1], font=face) > width:
            lines[-1] = lines[-1][:-2] + '…'
    return '\n'.join(lines)


def fitted_font(draw, text, size, width):
    face = font(size)
    while draw.textlength(text, font=face) > width and size > 10:
        size -= 1
        face = font(size)
    return face


def render(data, directory):
    width, height = data['width'], data['height']
    scale = min(width / 720, height / 1280)
    margin = int(64 * scale)
    for index in [0, 1]:
        image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        for y in range(height):
            alpha = int(190 * max(0, (y / height - .5) / .5))
            if y < height * .2: alpha = max(alpha, int(60 * (1 - y / (height * .2))))
            draw.line((0, y, width, y), fill=(12, 13, 12, alpha))
        small, large = font(int(23 * scale)), font(int(47 * scale))
        draw.text((margin, int(height * .075)), data['brandName'][:45], font=fitted_font(draw, data['brandName'][:45], int(23 * scale), width - 2 * margin), fill='#f2ebde')
        draw.line((margin, int(height * .115), margin + int(48 * scale), int(height * .115)), fill='#d7bc8b', width=max(1, int(2 * scale)))
        text = data['copy']['opening'] if index == 0 else data['copy']['detail']
        text = wrapped(draw, text, large, width - 2 * margin, 3)
        box = draw.multiline_textbbox((0, 0), text, font=large, spacing=int(12 * scale))
        draw.multiline_text((margin, height - int(170 * scale) - (box[3] - box[1])), text, font=large, spacing=int(12 * scale), fill='#fff9ed')
        image.save(os.path.join(directory, f'overlay-{index}.png'))

    image = Image.new('RGB', (width, height), '#f4f0e7')
    draw = ImageDraw.Draw(image)
    small, large = font(int(24 * scale)), font(int(46 * scale))
    draw.text((margin, int(height * .07)), data['brandName'][:45], font=fitted_font(draw, data['brandName'][:45], int(24 * scale), width - 2 * margin), fill='#5c604f')
    title = wrapped(draw, data['product'], large, width - 2 * margin, 2)
    draw.multiline_text((margin, int(height * .14)), title, font=large, spacing=int(9 * scale), fill='#202a23')
    photo = Image.open(os.path.join(directory, 'product.png')).convert('RGBA')
    plate = (margin, int(height * .33), width - margin, int(height * .78))
    draw.rounded_rectangle(plate, radius=int(18 * scale), fill='#ffffff')
    fitted = ImageOps.contain(photo, (plate[2] - plate[0] - int(28 * scale), plate[3] - plate[1] - int(28 * scale)), Image.Resampling.LANCZOS)
    image.paste(fitted, ((width - fitted.width) // 2, (plate[1] + plate[3] - fitted.height) // 2), fitted)
    cta = data['copy']['cta'][:32]
    cta_face = fitted_font(draw, cta, int(25 * scale), width - 2 * margin - int(64 * scale))
    cta_width = min(width - 2 * margin, int(draw.textlength(cta, font=cta_face) + 64 * scale))
    top = int(height * .84)
    draw.rounded_rectangle((margin, top, margin + cta_width, top + int(65 * scale)), radius=int(32 * scale), fill='#25362c')
    draw.text((margin + int(32 * scale), top + int(16 * scale)), cta, font=cta_face, fill='#fff9ed')
    image.save(os.path.join(directory, 'endcard.png'))


def music(seconds, path):
    rate = 32000
    # Original soft plucked chords, deliberately quiet behind the pictures.
    pitches = [220.0, 261.63, 329.63, 293.66, 196.0, 246.94, 293.66, 261.63]
    output = bytearray()
    for i in range(int(seconds * rate)):
        t = i / rate
        value = 0
        for offset in range(3):
            note = int(t / .75) - offset
            if note < 0: continue
            elapsed = t - note * .75
            frequency = pitches[note % len(pitches)]
            envelope = min(1, elapsed / .025) * math.exp(-2.1 * elapsed)
            value += envelope * (math.sin(2 * math.pi * frequency * t) + .2 * math.sin(4 * math.pi * frequency * t))
        fade = min(1, t / .8, max(0, (seconds - t) / 1.2))
        output.extend(struct.pack('<h', int(max(-1, min(1, value * .18 * fade)) * 32767)))
    with wave.open(path, 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(rate); audio.writeframes(output)


if __name__ == '__main__':
    directory = sys.argv[1]
    with open(os.path.join(directory, 'layout.json'), encoding='utf-8') as stream: data = json.load(stream)
    render(data, directory)
    if data['music'] != 'none': music(data['duration'], os.path.join(directory, 'music.wav'))
