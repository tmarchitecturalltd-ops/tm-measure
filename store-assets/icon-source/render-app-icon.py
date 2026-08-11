#!/usr/bin/env python3
"""
Generate every app icon from the brand logo export.

See README.md in this directory for why the icon is raster-sourced
rather than vector, and for the platform constraints that must hold.

Run from the repo root:  python3 store-assets/icon-source/render-app-icon.py
"""
from PIL import Image, ImageFilter
import numpy as np
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, 'store-assets', 'icon-source', 'brand-logo-source.png')

INK = np.array([0x1c, 0x1c, 0x1a], float)
BEIGE = (0xf1, 0xe8, 0xd7)      # must match values/ic_launcher_background.xml
DILATE = 41                     # stroke weight; 1 = untouched, 53 = floors merge
COVERAGE = 0.70                 # mark width as a fraction of the icon
SEED = 11                       # texture seed -- keeps output reproducible
BIG = 3072                      # dilate at high res, then downsample

# --- recover the ink mask from luminance -----------------------------
# The source is a textured export with an alpha channel. Thresholding on
# luminance drops the paper grain and the alpha in one step while keeping
# the anti-aliased stroke edges.
_src = Image.open(SOURCE)
_flat = Image.new('RGB', _src.size, (243, 242, 240))
_flat.paste(_src, mask=_src.split()[-1] if _src.mode == 'RGBA' else None)
_L = np.array(_flat.convert('L'), float)
_alpha = np.clip((235.0 - _L) / 205.0, 0, 1)
_ys, _xs = np.where(_alpha > 0.35)
_alpha = _alpha[_ys.min():_ys.max() + 1, _xs.min():_xs.max() + 1]
_H, _W = _alpha.shape


def mark_alpha(px, coverage=COVERAGE):
    s = min(BIG * coverage / _W, BIG * coverage / _H)
    b = Image.fromarray((_alpha * 255).astype('uint8')) \
             .resize((round(_W * s), round(_H * s)), Image.LANCZOS) \
             .filter(ImageFilter.MaxFilter(DILATE))
    tw, th = round(b.width * px / BIG), round(b.height * px / BIG)
    b = b.resize((max(1, tw), max(1, th)), Image.LANCZOS)
    c = Image.new('L', (px, px), 0)
    c.paste(b, ((px - tw) // 2, (px - th) // 2))
    return c


def _blur(arr, r):
    return np.array(
        Image.fromarray(np.clip(arr * 8 + 128, 0, 255).astype('uint8'))
             .filter(ImageFilter.GaussianBlur(r)), float)[..., None]


def paper(px):
    """Beige stock: fine tooth, soft cloudiness, mottling, and discrete
    browner specks. Scaled by px so small icons aren't pure noise."""
    r = np.random.default_rng(SEED)
    k = px / 1024.0
    f = np.zeros((px, px, 3), float) + np.array(BEIGE, float)
    f += r.normal(0, 4.0, (px, px, 1))
    f += (_blur(r.normal(0, 4.0, (px, px)), max(1, 7 * k)) - 128) / 8 * 2.0
    f += (_blur(r.normal(0, 3.2, (px, px)), max(1, 22 * k)) - 128) / 8 * 2.2

    sp = np.zeros((px, px))
    n = int(5200 * k * k)
    for y, x, m in zip(r.integers(0, px, n), r.integers(0, px, n),
                       r.uniform(0.35, 1.0, n)):
        rad = int(r.integers(0, max(1, round(3 * k)) + 1))
        sl = (slice(max(0, y - rad), y + rad + 1), slice(max(0, x - rad), x + rad + 1))
        sp[sl] = np.maximum(sp[sl], m)
    sp = np.array(Image.fromarray((sp * 255).astype('uint8'))
                  .filter(ImageFilter.GaussianBlur(0.6)), float)[..., None] / 255.0
    f -= sp * np.array([30, 31.5, 37.5])
    return np.clip(f, 0, 255)


def full_icon(px):
    """Opaque icon. No alpha -- iOS rejects an icon that has one."""
    m = np.array(mark_alpha(px), float)[..., None] / 255.0
    return Image.fromarray((paper(px) * (1 - m) + INK * m).astype('uint8'))


def adaptive_foreground(px):
    """Transparent, mark held inside the central 66% so a circular
    launcher mask cannot clip the roofline or the floor lines."""
    a = mark_alpha(px, COVERAGE * 0.62)
    return Image.composite(Image.new('RGBA', (px, px), (0x1c, 0x1c, 0x1a, 255)),
                           Image.new('RGBA', (px, px), (0, 0, 0, 0)), a)


def main():
    p = lambda *a: os.path.join(ROOT, *a)
    full_icon(1024).save(p('ios', 'App', 'App', 'Assets.xcassets',
                           'AppIcon.appiconset', 'AppIcon-512@2x.png'))
    full_icon(1024).save(p('store-assets', 'exports', 'app-icon-1024.png'))
    full_icon(512).save(p('store-assets', 'exports', 'app-icon-512.png'))

    res = p('android', 'app', 'src', 'main', 'res')
    for d, launcher, fg in [('mdpi', 48, 108), ('hdpi', 72, 162),
                            ('xhdpi', 96, 216), ('xxhdpi', 144, 324),
                            ('xxxhdpi', 192, 432)]:
        ic = full_icon(launcher)
        ic.save(os.path.join(res, f'mipmap-{d}', 'ic_launcher.png'))
        ic.save(os.path.join(res, f'mipmap-{d}', 'ic_launcher_round.png'))
        adaptive_foreground(fg).save(
            os.path.join(res, f'mipmap-{d}', 'ic_launcher_foreground.png'))
    print('icons written')


if __name__ == '__main__':
    main()
