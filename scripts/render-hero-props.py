#!/usr/bin/env python3
# Usage: python3 scripts/render-hero-props.py <foil.jpg> docs/brand/fonts/Tansa-Bold.ttf <out-dir>
# Renders the waitlist hero props (version tickets, commit coins). Needs Pillow and numpy.
# <foil.jpg> comes from the same shader port as render-logo.py.

# Renders chamoji's hero props: holographic version tickets (foil from the
# Iridescence shader port) and silver commit coins. Transparent PNGs.
import math, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

foil_path, tansa_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
SS = 2
foil_src = Image.open(foil_path).convert('RGB')

def rounded_mask(w, h, r):
    m = Image.new('L', (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], r, fill=255)
    return m

def shadow(img, offset=(0, 30), blur=40, alpha=0.32):
    a = img.getchannel('A').point(lambda v: int(v * alpha))
    pad = blur * 3
    canvas = Image.new('L', (img.width + pad * 2, img.height + pad * 2), 0)
    canvas.paste(a, (pad + offset[0], pad + offset[1]))
    canvas = canvas.filter(ImageFilter.GaussianBlur(blur))
    out = Image.new('RGBA', canvas.size, (24, 20, 40, 0))
    out.putalpha(canvas)
    out.alpha_composite(img, (pad, pad))
    return out

# ---------- tickets ----------
def ticket(label, foil_offset):
    W, H = 900 * SS, 470 * SS
    r = 46 * SS
    notch_x, notch_r = int(W * 0.27), 40 * SS
    mask = rounded_mask(W, H, r)
    d = ImageDraw.Draw(mask)
    d.ellipse([notch_x - notch_r, -notch_r, notch_x + notch_r, notch_r], fill=0)
    d.ellipse([notch_x - notch_r, H - notch_r, notch_x + notch_r, H + notch_r], fill=0)
    fx, fy = foil_offset
    face = foil_src.resize((int(W * 1.5), int(W * 1.5 * foil_src.height / foil_src.width))).crop((fx, fy, fx + W, fy + H))
    face = Image.eval(face, lambda v: min(255, int(v * 1.02)))
    t = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    t.paste(face, (0, 0), mask)
    # bright rim and a soft inner sheen
    rim = mask.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.MaxFilter(5))
    t.alpha_composite(Image.merge('RGBA', [Image.new('L', (W, H), 255)] * 3 + [rim.point(lambda v: int(v * 0.85))]))
    sheen = Image.new('L', (W, H), 0)
    ImageDraw.Draw(sheen).ellipse([-W * 0.2, -H * 0.9, W * 0.9, H * 0.45], fill=70)
    sheen = ImageChops.multiply(sheen.filter(ImageFilter.GaussianBlur(60 * SS)), mask)
    t.alpha_composite(Image.merge('RGBA', [Image.new('L', (W, H), 255)] * 3 + [sheen]))
    d = ImageDraw.Draw(t)
    # perforation
    for i in range(5):
        y0 = int(H * 0.2 + i * H * 0.13)
        d.rounded_rectangle([notch_x - 9 * SS, y0, notch_x + 9 * SS, y0 + 34 * SS], 6 * SS, fill=(10, 10, 14, 255))
    # black label
    lx0, ly0, lx1, ly1 = int(W * 0.37), int(H * 0.15), int(W * 0.93), int(H * 0.85)
    d.rounded_rectangle([lx0, ly0, lx1, ly1], 30 * SS, fill=(8, 8, 11, 255))
    font = ImageFont.truetype(tansa_path, 118 * SS)
    bb = d.textbbox((0, 0), label, font=font)
    tx = lx0 + (lx1 - lx0 - (bb[2] - bb[0])) / 2 - bb[0]
    ty = ly0 + (ly1 - ly0 - (bb[3] - bb[1])) / 2 - bb[1]
    d.text((tx, ty), label, font=font, fill=(250, 250, 252, 255))
    # thickness: a darker copy offset behind
    side = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    side_face = Image.eval(face, lambda v: int(v * 0.72))
    side.paste(side_face, (0, 0), mask)
    T = 16 * SS
    thick = Image.new('RGBA', (W + T, H + T), (0, 0, 0, 0))
    for k in range(T, 0, -1):
        thick.alpha_composite(side, (k, k))
    thick.alpha_composite(t, (0, 0))
    return thick

def tilt(img, quad_scale):
    # map the image onto a skewed quad for a 3D tilt
    w, h = img.size
    (ax, ay), (bx, by), (cx, cy), (dx, dy) = quad_scale
    pad = int(w * 0.25)
    out_w, out_h = w + pad * 2, h + pad * 2
    # destination corners (TL, BL, BR, TR) in output; solve inverse mapping with PIL QUAD (source quad for each output)
    dst = [(pad + ax * w, pad + ay * h), (pad + bx * w, pad + by * h), (pad + cx * w, pad + cy * h), (pad + dx * w, pad + dy * h)]
    src = [(0, 0), (0, h), (w, h), (w, 0)]
    coeffs = perspective_coeffs(dst, src)
    return img.transform((out_w, out_h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)

def perspective_coeffs(src_pts, dst_pts):
    m = []
    for (x, y), (u, v) in zip(src_pts, dst_pts):
        m.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        m.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    A = np.array(m, dtype=float); B = np.array([c for p in dst_pts for c in p], dtype=float)
    return np.linalg.solve(A, B).tolist()

quad = ((0.04, 0.16), (0.0, 0.96), (0.9, 1.0), (0.98, 0.0))
back = tilt(ticket('v0.2.0', (260, 120)), quad)
mid = tilt(ticket('v0.3.0', (520, 260)), quad)
front = tilt(ticket('v0.4.0', (60, 330)), quad)
Wc, Hc = int(front.width * 1.18), int(front.height * 1.22)
stack = Image.new('RGBA', (Wc, Hc), (0, 0, 0, 0))
stack.alpha_composite(back, (int(front.width * 0.16), 0))
stack.alpha_composite(mid, (int(front.width * 0.08), int(front.height * 0.09)))
stack.alpha_composite(front, (0, int(front.height * 0.2)))
bbox = stack.getbbox(); stack = stack.crop(bbox)
stack = shadow(stack, offset=(0, 40 * SS), blur=36 * SS, alpha=0.28)
stack = stack.crop(stack.getbbox())
stack.resize((stack.width // SS, stack.height // SS), Image.LANCZOS).save(f'{out}/ticket-stack.png', optimize=True)

# ---------- coins ----------
def coin(tilt_x, angle, hue_shift):
    R = 260 * SS; D = R * 2
    yy, xx = np.mgrid[0:D, 0:D].astype(float)
    nx, ny = (xx - R) / R, (yy - R) / R
    rr = np.sqrt(nx ** 2 + ny ** 2)
    base = 0.62 + 0.30 * (-(nx + ny) / 2) + 0.10 * np.cos(nx * 6 + ny * 2)
    face = np.clip(np.stack([base * 0.96, base * 0.98, base * 1.04], -1), 0, 1)
    # inner raised ring
    ring = np.exp(-((rr - 0.8) / 0.035) ** 2)
    face = np.clip(face + ring[..., None] * 0.22 - np.exp(-((rr - 0.86) / 0.03) ** 2)[..., None] * 0.18, 0, 1)
    alpha = (rr <= 1.0).astype(float)
    img = Image.fromarray((np.dstack([face, alpha]) * 255).astype(np.uint8), 'RGBA')
    d = ImageDraw.Draw(img)
    # git commit glyph: a ring on a line, white with a soft shadow
    glyph = Image.new('RGBA', (D, D), (0, 0, 0, 0)); g = ImageDraw.Draw(glyph)
    lw = int(R * 0.12); cr = int(R * 0.27)
    g.line([(R - R * 0.62, R), (R - cr, R)], fill=(255, 255, 255, 255), width=lw)
    g.line([(R + cr, R), (R + R * 0.62, R)], fill=(255, 255, 255, 255), width=lw)
    g.ellipse([R - cr, R - cr, R + cr, R + cr], outline=(255, 255, 255, 255), width=lw)
    sh = glyph.getchannel('A').filter(ImageFilter.GaussianBlur(6 * SS)).point(lambda v: int(v * 0.45))
    sh_img = Image.new('RGBA', (D, D), (30, 32, 40, 0)); sh_img.putalpha(sh)
    img.alpha_composite(sh_img, (4 * SS, 8 * SS)); img.alpha_composite(glyph)
    # squash for tilt, then build the edge
    fw = int(D * tilt_x)
    flat = img.resize((fw, D), Image.LANCZOS)
    edge_src = foil_src.resize((fw, D)).convert('RGB')
    edge_src = Image.eval(edge_src, lambda v: int(v * 0.85))
    edge = Image.new('RGBA', (fw, D)); edge.paste(edge_src, (0, 0), flat.getchannel('A'))
    metal = Image.new('RGBA', (fw, D), (150, 156, 168, 255)); metal.putalpha(flat.getchannel('A'))
    T = int(46 * SS * (1 - tilt_x) + 10 * SS)
    out_img = Image.new('RGBA', (fw + T + 4, D + 4), (0, 0, 0, 0))
    for k in range(T, 0, -1):
        layer = edge if k < T * 0.5 else metal
        out_img.alpha_composite(layer, (k, 0))
    out_img.alpha_composite(flat, (0, 0))
    out_img = out_img.rotate(angle, resample=Image.BICUBIC, expand=True)
    out_img = shadow(out_img, offset=(0, 24 * SS), blur=26 * SS, alpha=0.26)
    out_img = out_img.crop(out_img.getbbox())
    return out_img.resize((out_img.width // SS // 2, out_img.height // SS // 2), Image.LANCZOS)

for i, (tx, ang) in enumerate([(0.78, -18), (0.62, 14), (0.86, 28)], 1):
    coin(tx, ang, 0).save(f'{out}/coin-{i}.png', optimize=True)
print('done')
