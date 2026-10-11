"""Turns the hosting-company logos in scripts/demo/hosts/ into one-colour cutouts for the yeti spot.

    python scripts/demo/host-logos.py

Each source logo sits on white. The ink is how far a pixel is from white, so coloured marks, grey text and
black all survive; white details inside the mark (HostGator's gator, DreamHost's crescent) become see-through.
Writes scripts/demo/yeti/hosts/<name>.png in navy, trimmed to the mark.
"""
import pathlib

import numpy as np
from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "hosts"
OUT = HERE / "yeti" / "hosts"
INK = (11, 27, 51)   # --ink in yeti.html


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for f in sorted(SRC.glob("*.png")):
        rgb = np.array(Image.open(f).convert("RGB")).astype(float)
        alpha = np.clip((255 - rgb.min(axis=-1)) / 150, 0, 1)
        alpha[alpha < .06] = 0
        ys, xs = np.nonzero(alpha)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        out = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
        out[..., :3] = INK
        out[..., 3] = (alpha[y0:y1, x0:x1] * 255).astype(np.uint8)
        Image.fromarray(out, "RGBA").save(OUT / f.name)
        print(f.name, out.shape[1], out.shape[0])


if __name__ == "__main__":
    main()
