"""Cuts the yeti logo (site/logo.png) into animatable layers for scripts/demo/yeti.html.

    python scripts/demo/yeti-rig.py

Writes scripts/demo/yeti/: base.png (eyes, brow and teeth painted out with face blue) plus
eyeL.png, eyeR.png (plus -ice glow copies), brow.png and teeth.png, each a transparent crop at its spot in the logo.
Coordinates in yeti.html are logo pixels (538x594), so the crops land back where they came from.
"""
import json
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "scripts" / "demo" / "yeti"
FACE = np.array([106, 169, 212], float)   # light face blue
SHADE = np.array([83, 142, 181], float)   # brow and outline blue
BLACK = np.zeros(3)
WHITE = np.full(3, 255.0)

# (name, box x0, y0, x1, y1, feature colour)
PARTS = [
    ("eyeL", 172, 204, 238, 254, BLACK),
    ("eyeR", 303, 204, 369, 254, BLACK),
    ("brow", 186, 235, 337, 271, SHADE),
    ("teeth", 182, 284, 358, 331, WHITE),
]


def dilate(m, r):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    img = np.array(Image.open(ROOT / "site" / "logo.png").convert("RGBA")).astype(float)
    rgb = img[..., :3]
    base = img.copy()
    boxes = {}
    for name, x0, y0, x1, y1, col in PARTS:
        crop = rgb[y0:y1, x0:x1]
        d = col - FACE
        # How far each pixel sits from face blue toward the feature colour (0 = skin, 1 = feature).
        k = np.clip(((crop - FACE) @ d) / (d @ d), 0, 1)
        # Only the face interior belongs to the part: skip anything far from the face/feature line.
        resid = np.linalg.norm(crop - (FACE + k[..., None] * d), axis=-1)
        k[resid > 30] = 0
        if name.startswith("eye"):
            k[k < .3] = 0   # the brow's shade reads as a faint black; keep it out of the eyes
        layer = np.zeros((y1 - y0, x1 - x0, 4))
        layer[..., :3] = col
        layer[..., 3] = k * 255
        Image.fromarray(layer.astype(np.uint8), "RGBA").save(OUT / f"{name}.png")
        if name.startswith("eye"):   # glowing ice-blue copy for the dark opening
            layer[..., :3] = [186, 230, 253]
            Image.fromarray(layer.astype(np.uint8), "RGBA").save(OUT / f"{name}-ice.png")
        mask = np.zeros(rgb.shape[:2], bool)
        mask[y0:y1, x0:x1] = k > .02
        mask = dilate(mask, 3)
        box = np.zeros_like(mask)
        box[y0:y1, x0:x1] = True
        base[mask & box, :3] = FACE
        base[mask & box, 3] = 255   # the logo has see-through seams between colours; close them
        boxes[name] = [x0, y0, x1 - x0, y1 - y0]
    Image.fromarray(base.astype(np.uint8), "RGBA").save(OUT / "base.png")
    print(json.dumps(boxes))


if __name__ == "__main__":
    main()
