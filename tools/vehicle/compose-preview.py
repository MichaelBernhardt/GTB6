"""Compose Blender verification renders into the committed turnaround."""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


parser = argparse.ArgumentParser()
parser.add_argument("--input-dir", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()

source_dir = Path(args.input_dir)
paths = sorted(source_dir.glob("*.png"))
if len(paths) != 4:
    raise RuntimeError(f"Expected four preview frames, found {len(paths)}")

canvas = Image.new("RGB", (1600, 960), (18, 22, 27))
draw = ImageDraw.Draw(canvas)
try:
    title_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 34)
    label_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 22)
except OSError:
    title_font = ImageFont.load_default(size=34)
    label_font = ImageFont.load_default(size=22)

draw.text((40, 20), "QUANTUM EXPRESS  -  BLENDER TURNAROUND", font=title_font, fill=(242, 197, 33))
for index, path in enumerate(paths):
    image = Image.open(path).convert("RGB").resize((760, 428), Image.Resampling.LANCZOS)
    x = 40 + (index % 2) * 800
    y = 78 + (index // 2) * 438
    canvas.paste(image, (x, y))
    label = path.stem.split("-", 1)[1].replace("-", " ").upper()
    draw.rounded_rectangle((x + 16, y + 16, x + 190, y + 52), radius=9, fill=(10, 12, 14))
    draw.text((x + 28, y + 22), label, font=label_font, fill=(245, 246, 240))

output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
canvas.save(output, "JPEG", quality=90, optimize=True, progressive=True)
print(f"Composed taxi turnaround: {output}")
