#!/usr/bin/env python3
"""D2, ASKED PROPERLY: is there a level line in the frame that is NOT the horizon?

measure.py reports the biggest level luminance step anywhere in the frame, and on a lake shot at
pitch 0 that is almost always the water meeting the sky — which every body of water has. Run against
the ORIGINAL ocean, the one the owner never complained about, it scores 150/255. So the raw number
cannot answer D2 on its own; what answers D2 is whether there is a SECOND level line: a cap where the
water sheet stops short of the horizon, or a hue edge where the off-map margin ends.

Where the horizon is, is not a guess. With pitch 0 and a symmetric frustum the true horizon — level
with the eye, infinitely far — projects to the exact vertical centre of the frame. So rows H/2 ± PAD
are the horizon, and any level step outside that band is something else: that is the number to read.

usage: horizon.py <dir> [label]
"""
import os, sys
import numpy as np
from PIL import Image

WGT = np.array([0.2126, 0.7152, 0.0722])
PAD = 14   # rows either side of the centre row that count as "the horizon itself"


def rows_of(path):
    return (np.asarray(Image.open(path).convert('RGB'), dtype=np.float64) @ WGT).mean(axis=1)


def best_step(rows, lo, hi, skip=None, maxwin=14):
    """Strongest luminance step whose window lies inside [lo,hi), optionally skipping a row range."""
    best = (0.0, 0, 1)
    for w in range(1, maxwin + 1):
        for i in range(lo, hi - w):
            if skip and not (i + w < skip[0] or i > skip[1]):
                continue
            d = rows[i] - rows[i + w]
            if abs(d) > abs(best[0]):
                best = (float(d), i, w)
    return best


def levelness(path, row, win):
    """Share of columns where the step has the same sign and most of the magnitude of the mean."""
    L = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64) @ WGT
    d = L[row] - L[row + win]
    ref = float(np.mean(d))
    if ref == 0:
        return 0.0
    return float(np.mean((np.sign(d) == np.sign(ref)) & (np.abs(d) > abs(ref) * 0.4)))


if __name__ == '__main__':
    D = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else os.path.basename(D)
    print('=' * 100)
    print(f'D2 - IS THERE A LEVEL LINE THAT IS NOT THE HORIZON?  [{label}]')
    print('=' * 100)
    print(f'{"shot":20s} {"horizon step":>13s} {"OTHER step":>11s} {"row":>5s} {"level":>6s}')
    worst = (0.0, '-', 0)
    for name in sorted(n for n in os.listdir(D) if n.startswith('cap-') and n.endswith('.png')):
        path = os.path.join(D, name)
        rows = rows_of(path)
        H = len(rows)
        lo, hi = int(H * 0.10), int(H * 0.80)
        band = (H // 2 - PAD, H // 2 + PAD)
        hz = best_step(rows, band[0], band[1] + 1)
        ot = best_step(rows, lo, hi, skip=band)
        lvl = levelness(path, ot[1], ot[2])
        if lvl > 0.6 and abs(ot[0]) > worst[0]:
            worst = (abs(ot[0]), name, ot[1])
        print(f'{name[:-4]:20s} {abs(hz[0]):13.1f} {abs(ot[0]):11.1f} {ot[1]:5d} {lvl:6.2f}')
    print(f'\nWORST NON-HORIZON LEVEL LINE: {worst[0]:.1f}/255  ({worst[1]}, row {worst[2]})')
