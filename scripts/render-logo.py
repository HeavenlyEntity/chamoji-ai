#!/usr/bin/env python3
# Usage: python3 scripts/render-logo.py docs/brand/fonts/MarowBlock-Regular.ttf docs/brand/chamoji-plate.png [time]
# Needs Pillow and numpy, plus the local Marow Block font (see docs/brand/fonts/README.md).

# Renders the ChamojiPlate: the Iridescence shader (ported from GLSL to numpy,
# CHAMOJI_FOIL settings) inside a 35° parallelogram, with the Marow Block
# wordmark. Output: transparent PNG.
import math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

font_path, out = sys.argv[1], sys.argv[2]
SS = 2                      # supersampling
PH = 300                    # plate height (final px)
SKEW = math.tan(math.radians(35))
PW = 760                    # plate width at mid-height (final px)
PAD = 12
W = int(PW + PH * SKEW + PAD * 2)
H = PH + PAD * 2
w, h = W * SS, H * SS

# --- shader (CHAMOJI_FOIL) ---
color = np.array([0xff, 0xf1, 0xea]) / 255
hue = math.radians(-12); sat, bright, contrast = 0.9, 1.12, 0.9
scale, detail, warp, t = 1.25, 8, 1.0, float(sys.argv[3]) if len(sys.argv) > 3 else 4.2

ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
vu = (xs + 0.5) / w; vv = 1 - (ys + 0.5) / h
mr = min(w, h); ax, ay = w / mr, h / mr
ux = (vu * 2 - 1) * ax / scale
uy = (vv * 2 - 1) * ay / scale
d = np.full_like(ux, -t * 0.5); a = np.zeros_like(ux)
for i in range(detail):
    a = a + np.cos(i - d - a * ux * warp)
    d = d + np.sin(uy * i + a)
d = d + t * 0.5
c0 = np.cos(ux * d) * 0.6 + 0.4
c1 = np.cos(uy * a) * 0.6 + 0.4
c2 = np.cos(a + d) * 0.5 + 0.5
k = np.stack([np.cos(d), np.cos(a), np.full_like(d, math.cos(2.5))], -1)
col = np.cos(np.stack([c0, c1, c2], -1) * k * 0.5 + 0.5) * color
# hueRotate
kv = np.full(3, 0.57735027); ca, sa = math.cos(hue), math.sin(hue)
col = col * ca + np.cross(kv, col) * sa + kv * (col @ kv)[..., None] * (1 - ca)
luma = col @ np.array([0.2126, 0.7152, 0.0722])
col = luma[..., None] + (col - luma[..., None]) * sat
col = (col - 0.5) * contrast + 0.5
col = np.clip(col * bright, 0, 1)
foil = Image.fromarray((col * 255).round().astype(np.uint8), 'RGB')

# --- parallelogram mask ---
mask = Image.new('L', (w, h), 0)
p = PAD * SS; ph = PH * SS; off = ph * SKEW
x0 = p; x1 = w - p - off
ImageDraw.Draw(mask).polygon([(x0 + off, p), (w - p, p), (x1, p + ph), (x0, p + ph)], fill=255)
img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
img.paste(foil, (0, 0), mask)

# --- wordmark ---
font = ImageFont.truetype(font_path, int(PH * 0.36 * SS))
draw = ImageDraw.Draw(img)
text = 'chamoji'
bbox = draw.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
draw.text(((w - tw) / 2 - bbox[0], (h - th) / 2 - bbox[1]), text, font=font, fill=(7, 7, 8, 255))

img.resize((W, H), Image.LANCZOS).save(out, optimize=True)
print(out, W, H)
