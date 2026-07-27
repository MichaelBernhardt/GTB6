#!/usr/bin/env python3
"""Measure D2 (level horizon step), D3 (shore colour), D4 (ground darkness) from in-engine frames."""
import colorsys, json, os, sys
import numpy as np
from PIL import Image

WGT = np.array([0.2126, 0.7152, 0.0722])


def lum(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float64) @ WGT


def strongest_level_step(path, ytop=0.10, ybot=0.80, maxwin=14):
    """The biggest LEVEL luminance step: the same sign in most columns. Contrast in 0-255."""
    L = lum(path)
    H, W = L.shape
    y0, y1 = int(H * ytop), int(H * ybot)
    rows = L.mean(axis=1)
    best = (0.0, 0, 1)
    for w in range(1, maxwin + 1):
        d = rows[y0:y1 - w] - rows[y0 + w:y1]
        if d.size == 0:
            continue
        i = int(np.argmax(np.abs(d)))
        if abs(d[i]) > abs(best[0]):
            best = (float(d[i]), y0 + i, w)
    d, y, w = best
    col = L[y] - L[y + w]
    frac = float(np.mean((np.sign(col) == np.sign(d)) & (np.abs(col) > abs(d) * 0.4)))
    return {'contrast': round(abs(d), 1), 'signed': round(d, 1), 'row': y, 'px': w,
            'level_frac': round(frac, 3)}


def horizon_profile(path, x=640, y0=330, y1=460):
    L = lum(path)
    return [(y, round(float(L[y, x - 40:x + 40].mean()), 1)) for y in range(y0, y1, 2)]


def patch(path, x, y, w=64, h=24):
    a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64)[y:y + h, x:x + w]
    r, g, b = a.reshape(-1, 3).mean(axis=0)
    hh, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return {'hex': '#%02x%02x%02x' % (int(r), int(g), int(b)), 'rgb': [round(r), round(g), round(b)],
            'hue': round(hh * 360), 'sat': round(s, 3), 'val': round(v, 3)}


def dark_stats(path):
    a = np.asarray(Image.open(path).convert('RGB'), dtype=np.float64)
    H = a.shape[0]
    g = (a[H // 2:] @ WGT)
    return {'ground_mean': round(float(g.mean()), 1), 'p05': round(float(np.percentile(g, 5)), 1),
            'frac_under_40': round(float((g < 40).mean()), 3), 'frac_under_60': round(float((g < 60).mean()), 3)}


if __name__ == '__main__':
    D = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else os.path.basename(D)
    names = sorted(n for n in os.listdir(D) if n.endswith('.png'))
    print('=' * 92)
    print(f'D2 - LEVEL HORIZON STEP  in-engine, eye height, pitch 0  [{label}]')
    print('=' * 92)
    print(f'{"shot":20s} {"contrast":>9s} {"px":>3s} {"row":>5s} {"level":>6s}')
    caps = []
    for n in names:
        if not n.startswith('cap-'):
            continue
        r = strongest_level_step(os.path.join(D, n))
        caps.append(r['contrast'])
        print(f'{n[:-4]:20s} {r["contrast"]:9.1f} {r["px"]:3d} {r["row"]:5d} {r["level_frac"]:6.2f}')
    if caps:
        print(f'{"WORST":20s} {max(caps):9.1f}      median {sorted(caps)[len(caps)//2]:.1f}')

    print()
    print('=' * 92)
    print(f'D3 - SHORE COLOUR  [{label}]')
    print('=' * 92)
    spots = [('sand-strand-13.png', [('strand  13u out (ring)', 600, 640)]),
             ('sand-strand-50.png', [('strand  50u out (grit)', 600, 640)]),
             ('sand-strand-110.png', [('strand 110u out (veld)', 600, 640)]),
             ('sand-strand-180.png', [('strand 180u out (ground)', 600, 640)]),
             ('sand-natural-down.png', [('natural strand, feet', 600, 640), ('natural strand, mid', 600, 520)]),
             ('sand-natural.png', [('natural level, near', 600, 660), ('natural level, mid', 600, 540)]),
             ('sand-natural2-down.png', [('natural z=0, feet', 600, 640), ('natural z=0, mid', 600, 520)]),
             ('sand-natural3.png', [('natural S arm, near', 600, 660)]),
             ('sand-resort-down.png', [('MISTY BAY resort, feet', 600, 640), ('MISTY BAY resort, mid', 600, 520)]),
             ('sand-resort.png', [('MISTY BAY level, near', 600, 660), ('MISTY BAY level, mid', 600, 540)]),
             ('sand-resort2-down.png', [('LEBOYA resort, feet', 600, 640), ('LEBOYA resort, mid', 600, 520)]),
             ('sand-resort2.png', [('LEBOYA level, near', 600, 660)])]
    for fn, ss in spots:
        p = os.path.join(D, fn)
        if not os.path.exists(p):
            continue
        for (nm, x, y) in ss:
            r = patch(p, x, y)
            print(f'  {nm:26s} {r["hex"]}  rgb{tuple(r["rgb"])}  hue={r["hue"]:3d}  SAT={r["sat"]:.3f}  val={r["val"]:.3f}')

    print()
    print('=' * 92)
    print(f'D4 - GROUND DARKNESS, lower half of frame  [{label}]')
    print('=' * 92)
    print(f'{"shot":22s} {"mean":>7s} {"p05":>7s} {"<40":>7s} {"<60":>7s}')
    for n in names:
        if not n.startswith('dark-'):
            continue
        r = dark_stats(os.path.join(D, n))
        tag = ' <- CONTROL' if 'ctrl' in n else ''
        print(f'{n[:-4]:22s} {r["ground_mean"]:7.1f} {r["p05"]:7.1f} {r["frac_under_40"]:7.3f} {r["frac_under_60"]:7.3f}{tag}')
