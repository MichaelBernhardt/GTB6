#!/usr/bin/env python3
"""Blender-free model inspector: render code-built geometry to a PNG you can actually look at.

    python3 tools/preview/shoot.py superbike
    python3 tools/preview/shoot.py bicycle motorbike courier superbike --out /tmp/bikes
    python3 tools/preview/shoot.py traincar traincar-interior plane

Spawns a throwaway vite dev server, loads tools/preview/model-preview.html in headless
Chromium (SwiftShader WebGL — no GPU needed), and screenshots a 2x2 turnaround per subject.
Prints the triangle count per subject so detail passes can be budgeted.

Subjects: any VehicleKind (bicycle, motorbike, courier, superbike, compact, sport, van,
police, taxi), plus `plane`, `traincar` and `traincar-interior` (rider-eye view from the aisle).
"""
import argparse
import base64
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('subjects', nargs='*', default=['superbike'])
    ap.add_argument('--out', default='/tmp/model-preview')
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--sharing', action='store_true',
                    help='also build each subject twice and report shared geometry/material counts')
    args = ap.parse_args()
    subjects = args.subjects or ['superbike']
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    port = args.port or free_port()

    vite = subprocess.Popen(
        ['npx', 'vite', '--port', str(port), '--strictPort', '--host', '127.0.0.1'],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
        env={**os.environ, 'NO_COLOR': '1'})
    try:
        for _ in range(120):
            try:
                with socket.create_connection(('127.0.0.1', port), 0.4):
                    break
            except OSError:
                time.sleep(0.5)
        else:
            print('vite never came up', file=sys.stderr)
            return 1

        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                '--disable-lcd-text',
            ])
            page = browser.new_page(viewport={'width': 1400, 'height': 1000})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{port}/tools/preview/model-preview.html', timeout=120000)
            page.wait_for_function('() => window.__preview?.ready', timeout=120000)
            for subject in subjects:
                # "motorbike@side" renders one full-canvas view; bare names render the 2x2 turnaround.
                name, _, view = subject.partition('@')
                inside = name.startswith('traincar') and name != 'traincar'
                mode = view or ('interior' if inside else 'turnaround')
                info = page.evaluate('([n, m]) => window.__preview.render(n, m)', [name, mode])
                shot = page.evaluate("() => document.querySelector('canvas').toDataURL('image/png')")
                path = out / (subject.replace('@', '-') + '.png')
                path.write_bytes(base64.b64decode(shot.split(',', 1)[1]))
                share = page.evaluate('(n) => window.__preview.sharing(n)', name) if args.sharing else None

                extra = (f'  shared geom {share["sharedGeometries"]}/{share["geometries"]}'
                         f'  shared mats {share["sharedMaterials"]}/{share["materials"]}') if share else ''
                print(f'{subject:22s} {info["label"]:32s} {info["tris"]:>7d} tris{extra}  ->  {path}')
            browser.close()
            if errors:
                print('page errors:', *errors[:8], sep='\n  ', file=sys.stderr)
    finally:
        vite.terminate()
        try:
            vite.wait(10)
        except subprocess.TimeoutExpired:
            vite.kill()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
