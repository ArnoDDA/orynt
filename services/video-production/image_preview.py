"""Small local display derivative; original images remain untouched."""
import sys
from pathlib import Path
from PIL import Image, ImageOps

directory = Path(sys.argv[1])
with Image.open(directory / 'source') as source:
    image = ImageOps.exif_transpose(source).convert('RGBA')
    image.thumbnail((560, 1000), Image.Resampling.LANCZOS)
    background = Image.new('RGBA', image.size, 'white')
    background.alpha_composite(image)
    background.convert('RGB').save(directory / 'preview.jpg', quality=85, optimize=True)
