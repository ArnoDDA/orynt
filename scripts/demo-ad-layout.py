"""Owala fixed-case editorial typography and original sound design. Local only."""
import json
import sys
import wave
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / '.local/demo-baselines/owala-commute/v1'
VERSION = sys.argv[1] if len(sys.argv) > 1 else 'v1'
if VERSION not in ('v1', 'v2'):
    raise ValueError('Choose v1 or v2')
OUT = ROOT / f'.local/product-reference-quality/owala-commute-v1/edit-{VERSION}'
W, H = 1080, 1920
REG = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'


def face(size, bold=False):
    return ImageFont.truetype(BOLD if bold else REG, size)


def label(draw, text, xy, size=22, spacing=4, fill='#434438'):
    x, y = xy
    font = face(size, True)
    for char in text:
        draw.text((x, y), char, font=font, fill=fill)
        x += draw.textlength(char, font=font) + spacing


def graphics():
    OUT.mkdir(parents=True, exist_ok=True)
    for index, title in enumerate(['Before you\nhead out.', 'Make it part\nof your day.']):
        im = Image.new('RGBA', (W, H))
        d = ImageDraw.Draw(im)
        # Copy lives entirely in the quiet upper quarter of the approved frames.
        # The second frame has a dark window mullion on the left. Place copy
        # in the clear sky to its right rather than losing contrast over it.
        left = 300 if index == 1 else 78
        label(d, 'OWALA  /  EVERYDAY CARRY', (left+4, 206), 19, 3, '#424336')
        d.multiline_text((left, 264), title, font=face(82), spacing=2, fill='#262b23')
        d.line((left+5, 488, left+67, 488), fill='#575e47', width=3)
        im.save(OUT / f'overlay-{index}.png')

    im = Image.new('RGB', (W, H), '#f6f4ef')
    d = ImageDraw.Draw(im)
    label(d, 'OWALA', (82, 195), 27, 6)
    d.multiline_text((78, 271), 'Find your\neveryday.', font=face(101), spacing=0, fill='#252c23')
    # Keep the actual official photo intact: no reconstruction or inferred cutout.
    photo = Image.open(PACK / 'product.png').convert('RGBA')
    plate = Image.new('RGBA', (860, 860), 'white')
    fitted = ImageOps.contain(photo, (830, 830), Image.Resampling.LANCZOS)
    plate.alpha_composite(fitted, ((860-fitted.width)//2, (860-fitted.height)//2))
    im.paste(plate.convert('RGB'), (110, 551))
    d.text((82, 1450), 'FreeSip Twist', font=face(48, True), fill='#252c23')
    d.text((84, 1522), '18oz  /  Very, Very Dark', font=face(25), fill='#65685d')
    d.line((82, 1593, 998, 1593), fill='#c9cbbf', width=2)
    d.text((84, 1630), 'Discover at owalalife.sg', font=face(29), fill='#252c23')
    d.text((948, 1624), '→', font=face(42), fill='#252c23')
    im.save(OUT / 'endcard.png')

    if VERSION == 'v2':
        # Local typography layers over continuing real generated footage.
        # A soft scrim protects contrast across the moving city background.
        scrim = Image.new('RGBA', (W, H))
        sd = ImageDraw.Draw(scrim)
        for y in range(H):
            top = 155 * max(0, 1-y/800)
            bottom = 185 * max(0, (y-1200)/720)
            sd.line((0, y, W, y), fill=(18, 24, 19, int(max(top, bottom))))
        scrim.save(OUT / 'closing-scrim.png')
        title = Image.new('RGBA', (W, H))
        td = ImageDraw.Draw(title)
        label(td, 'OWALA  /  FREESIP TWIST', (84, 216), 21, 3, '#f7f4eb')
        td.multiline_text((78, 278), 'Find your\neveryday.', font=face(94), spacing=2, fill='#fffaf1')
        title.save(OUT / 'closing-title.png')
        cta = Image.new('RGBA', (W, H))
        cd = ImageDraw.Draw(cta)
        cd.text((83, 1530), 'FreeSip Twist', font=face(46, True), fill='#fffaf1')
        cd.text((85, 1595), '18oz  /  Very, Very Dark', font=face(24), fill='#e2e4d7')
        cd.line((84, 1653, 996, 1653), fill='#b8bda9', width=2)
        cd.text((85, 1680), 'Explore at owalalife.sg', font=face(28), fill='#fffaf1')
        cd.text((949, 1673), '→', font=face(40), fill='#fffaf1')
        cta.save(OUT / 'closing-cta.png')


def sound():
    # Original 15-second ambient cue. No downloaded music, voice cloning or claims.
    sr, seconds = 48000, 15
    t = np.arange(sr * seconds) / sr
    stereo = np.zeros((len(t), 2), dtype=np.float64)
    rng = np.random.default_rng(281028)
    beat = 60 / 96
    chords = [[52, 59, 63, 66], [49, 56, 59, 63], [45, 52, 56, 59], [47, 54, 61, 66], [52, 59, 63, 66], [52, 56, 59, 64]]
    def add_note(start, midi, length, level, pan, pad=False):
        begin = int(start * sr)
        count = min(int(length * sr), len(t)-begin)
        if count <= 0:
            return
        u = np.arange(count) / sr
        f = 440 * 2 ** ((midi-69)/12)
        if pad:
            env = np.minimum(u/.45, 1) * np.minimum((length-u)/.8, 1)
            wavelet = (np.sin(2*np.pi*f*u) + .22*np.sin(2*np.pi*f*1.002*u) + .08*np.sin(4*np.pi*f*u)) * env
        else:
            env = (1-np.exp(-u/.008)) * np.exp(-u/1.05) * np.minimum((length-u)/.12, 1)
            wavelet = (np.sin(2*np.pi*f*u) + .19*np.sin(2*np.pi*f*2.001*u) + .045*np.sin(2*np.pi*f*3.99*u)) * env
        stereo[begin:begin+count, 0] += wavelet * level * np.cos(pan*np.pi/2)
        stereo[begin:begin+count, 1] += wavelet * level * np.sin(pan*np.pi/2)
    for bar, chord in enumerate(chords):
        start = bar * 4 * beat
        for j, midi in enumerate(chord):
            add_note(start, midi, 3.8, .035, .2+.2*j, True)
        for j in range(8):
            add_note(start+j*beat/2, chord[[0, 2, 1, 3, 2, 1, 3, 2][j]]+12, 2.6, .09 if j%2==0 else .06, .25+.5*(j%3)/2)
    for n in range(24):
        start = n*beat
        begin = int(start*sr)
        u = np.arange(min(int(.2*sr), len(t)-begin)) / sr
        kick = np.sin(2*np.pi*(52*u+5*(1-np.exp(-u*28)))) * np.exp(-u*29) * .075
        stereo[begin:begin+len(u)] += kick[:, None]
        # Quiet brushed pulse, softened rather than an abrasive click.
        h = rng.normal(0, 1, len(u))
        h = np.convolve(h, np.ones(14)/14, mode='same') * np.exp(-u*55) * .018
        stereo[begin:begin+len(u)] += h[:, None]
    # Short diffuse echoes give the cue space; the end resolves before the logo.
    dry = stereo.copy()
    for seconds_delay, gain in [(.13,.11), (.27,.07), (.41,.035)]:
        delay = int(seconds_delay*sr)
        stereo[delay:] += dry[:-delay, ::-1]*gain
    fade = np.minimum(t/.6, 1) * np.minimum(np.maximum((seconds-t)/1.4, 0), 1)
    stereo *= fade[:, None]
    peak = np.max(np.abs(stereo))
    stereo *= min(1, .72/max(peak, 1e-9))
    with wave.open(str(OUT/'sound-design.wav'), 'wb') as stream:
        stream.setparams((2, 2, sr, 0, 'NONE', 'not compressed'))
        stream.writeframes((stereo*32767).astype('<i2').tobytes())


if __name__ == '__main__':
    graphics()
    sound()
    print(json.dumps({'directory': str(OUT), 'width': W, 'height': H, 'sound': 'original_local_composition', 'duration': 15}))
