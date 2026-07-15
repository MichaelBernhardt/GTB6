"""Build the deterministic 2048px Quantum Express base-colour atlas."""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()

SIZE = 2048
WHITE = (244, 245, 239)
YELLOW = (242, 197, 33)
PALETTE = [WHITE, (231, 24, 35), (24, 66, 177), (0, 119, 73), (12, 15, 17), YELLOW]

source = Image.open(args.source).convert("RGB")
source = ImageOps.fit(source, (SIZE, 1024), method=Image.Resampling.LANCZOS)
pixels = source.load()
for y in range(source.height):
    for x in range(source.width):
        colour = pixels[x, y]
        pixels[x, y] = min(PALETTE, key=lambda candidate: sum((colour[index] - candidate[index]) ** 2 for index in range(3)))

atlas = Image.new("RGB", (SIZE, SIZE), WHITE)
atlas.paste(source, (0, 900))
draw = ImageDraw.Draw(atlas)

def font(size):
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)
    except OSError:
        return ImageFont.load_default(size=size)

# Registration patch (top-left atlas reserve) used by both plate meshes.
draw.rounded_rectangle((64, 72, 608, 314), radius=28, fill=(250, 249, 231), outline=(22, 24, 24), width=18)
plate_font = font(88)
plate_text = "GP 26 QE"
plate_box = draw.textbbox((0, 0), plate_text, font=plate_font)
draw.text(((672 - (plate_box[2] - plate_box[0])) / 2 - 32, 193 - (plate_box[3] - plate_box[1]) / 2), plate_text, font=plate_font, fill=(18, 20, 20))

# Side-panel identity and safety copy. Generated pixels never determine spelling.
brand_font = font(132)
brand = "QUANTUM EXPRESS"
brand_box = draw.textbbox((0, 0), brand, font=brand_font)
draw.text(((SIZE - (brand_box[2] - brand_box[0])) / 2, 590), brand, font=brand_font, fill=(18, 21, 22))
draw.rectangle((0, 846, SIZE, 872), fill=YELLOW)

safety_font = font(48)
safety = "HOOT TWICE  -  ARRIVE SAFE"
safety_box = draw.textbbox((0, 0), safety, font=safety_font)
draw.rounded_rectangle((SIZE - (safety_box[2] - safety_box[0]) - 100, 1930, SIZE - 36, 2010), radius=16, fill=(244, 245, 239))
draw.text((SIZE - (safety_box[2] - safety_box[0]) - 68, 1941), safety, font=safety_font, fill=(15, 17, 18))

output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
atlas.save(output, format="JPEG", quality=90, subsampling=0, optimize=True, progressive=True)
print(f"Built taxi atlas: {output} ({SIZE}x{SIZE})")
