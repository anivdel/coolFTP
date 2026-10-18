"""
Music for the Claude Code Toolkit promo, synthesized with numpy: a 100 bpm bed (C G Am F) with a pluck
arpeggio, swooshes on each scene change and a chime when the price lands, ducked under the narration.
Reads the narrated video and writes the final one with voice and music.
    python scripts/toolkit/score.py [narrated.mp4] [out.mp4] [timing.json]
Defaults to the 48s promo (site/toolkit.mp4 -> site/toolkit-promo.mp4). For the long upsell pass a timing
file with {"len": seconds, "cuts": [scene starts], "chimes": [[at, base_midi, gain], ...]}.
"""
import json
import os
import subprocess
import sys
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VIDEO = os.path.join(ROOT, sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "site", "toolkit.mp4")
OUT = os.path.join(ROOT, sys.argv[2]) if len(sys.argv) > 2 else os.path.join(ROOT, "site", "toolkit-promo.mp4")
WORK = os.path.join(ROOT, "scripts", "toolkit", "audio")
os.makedirs(WORK, exist_ok=True)

TIMING = json.load(open(os.path.join(ROOT, sys.argv[3]))) if len(sys.argv) > 3 else None
SR = 44100
LEN = float(TIMING["len"]) if TIMING else 48.0
N = int(SR * LEN)
BPM = 100.0
BEAT = 60.0 / BPM
BAR = BEAT * 4
# Scene starts in toolkit.html's SCENES table, and the finale's price and button moments.
CUTS = TIMING["cuts"] if TIMING else [4.6, 13.1, 21.8, 30.3, 38.4]
CHIMES = TIMING["chimes"] if TIMING else [[38.4 + 4.2, 84, 0.12], [38.4 + 6.0, 79, 0.07]]
rng = np.random.default_rng(11)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n, a, r):
    e = np.ones(n)
    a, r = int(SR * a), int(SR * r)
    if a: e[:a] = np.linspace(0, 1, a)
    if r: e[-r:] *= np.linspace(1, 0, r)
    return e


def lowpass(x, fc):
    """One-pole low-pass, applied in the frequency domain (same response as the sample loop, much faster)."""
    k = 1 - np.exp(-2 * np.pi * fc / SR)
    n = 1 << int(np.ceil(np.log2(len(x) * 2)))
    w = 2 * np.pi * np.fft.rfftfreq(n) 
    h = k / (1 - (1 - k) * np.exp(-1j * w))
    return np.fft.irfft(np.fft.rfft(x, n) * h, n)[: len(x)]


def add(buf, at, sig, gain=1.0):
    i = int(at * SR)
    if i >= len(buf): return
    sig = sig[: len(buf) - i]
    buf[i : i + len(sig)] += sig * gain


L = np.zeros(N)
R = np.zeros(N)
CHORDS = [(48, [60, 64, 67, 71]), (43, [59, 62, 67, 74]), (45, [60, 64, 69, 72]), (41, [60, 65, 69, 72])]

# pad: two detuned saws per note, softened, one chord per bar
for b in range(int(LEN / BAR) + 1):
    bass, notes = CHORDS[b % 4]
    t0 = b * BAR
    n = int(SR * BAR)
    tt = np.arange(n) / SR
    pad = np.zeros(n)
    for m in notes:
        for det in (-0.12, 0.12):
            f = midi(m + det)
            pad += 2 * ((tt * f) % 1) - 1
    pad = lowpass(pad / 8, 1400) * env(n, 0.35, 0.4)
    add(L, t0, pad, 0.10); add(R, t0, pad, 0.10)
    # bass on each beat
    for k in range(4):
        nb = int(SR * BEAT * 0.9)
        tb = np.arange(nb) / SR
        s = np.sin(2 * np.pi * midi(bass - 12) * tb) + 0.3 * np.sin(4 * np.pi * midi(bass - 12) * tb)
        s *= env(nb, 0.01, 0.25)
        add(L, t0 + k * BEAT, s, 0.16); add(R, t0 + k * BEAT, s, 0.16)
    # pluck arpeggio in eighths, from the second scene on
    if t0 >= CUTS[0] - 0.01:
        for k in range(8):
            m = notes[[0, 1, 2, 3, 2, 1, 3, 2][k]] + 12
            np_ = int(SR * 0.35)
            tp = np.arange(np_) / SR
            s = np.sin(2 * np.pi * midi(m) * tp) * np.exp(-tp * 9)
            pan = 0.35 if k % 2 else -0.35
            add(L, t0 + k * BEAT / 2, s, 0.05 * (1 - pan)); add(R, t0 + k * BEAT / 2, s, 0.05 * (1 + pan))

# drums: kick on 1 and 3, hat on the off-beats, from the first cut to the end
beats = np.arange(CUTS[0], LEN - 1.5, BEAT)
for i, t in enumerate(beats):
    if i % 2 == 0:
        nk = int(SR * 0.28); tk = np.arange(nk) / SR
        kick = np.sin(2 * np.pi * (48 + 90 * np.exp(-tk * 28)) * tk) * np.exp(-tk * 11)
        add(L, t, kick, 0.32); add(R, t, kick, 0.32)
    nh = int(SR * 0.05)
    hat = rng.standard_normal(nh) * np.exp(-np.arange(nh) / SR * 70)
    hat = hat - lowpass(hat, 6000)
    add(L, t + BEAT / 2, hat, 0.05); add(R, t + BEAT / 2, hat, 0.04)

# swoosh into each scene
for c in CUTS:
    nw = int(SR * 0.7); tw = np.arange(nw) / SR
    noise = rng.standard_normal(nw)
    sw = lowpass(noise, 2500) * np.sin(np.pi * tw / 0.7) ** 2
    add(L, c - 0.45, sw, 0.10); add(R, c - 0.45, sw, 0.10)

# chime when the price lands, and a soft one for the button
for at, base, g in CHIMES:
    for j, m in enumerate((base, base + 4, base + 7)):
        nc = int(SR * 1.4); tc = np.arange(nc) / SR
        s = (np.sin(2 * np.pi * midi(m) * tc) + 0.25 * np.sin(4 * np.pi * midi(m) * tc)) * np.exp(-tc * 3.5)
        add(L, at + j * 0.07, s, g); add(R, at + j * 0.07, s, g)

# voice from the narrated video
voice_wav = os.path.join(WORK, "voice.wav")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", VIDEO, "-vn", "-ac", "2", "-ar", str(SR), "-f", "wav", voice_wav], check=True)
with wave.open(voice_wav) as w:
    v = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768
v = v.reshape(-1, 2)
if len(v) < N: v = np.vstack([v, np.zeros((N - len(v), 2))])
v = v[:N]

# duck the music under the voice: a smoothed loudness envelope, down to about -9 dB while talking
lvl = np.abs(v).mean(axis=1)
win = int(SR * 0.25)
lvl = np.convolve(lvl, np.ones(win) / win, mode="same")
duck = 1 - 0.65 * np.clip(lvl / 0.02, 0, 1)
duck = np.convolve(duck, np.ones(win) / win, mode="same")
music = np.stack([L, R], axis=1) * duck[:, None]
music *= env(N, 1.0, 2.5)[:, None]

mix = v * 1.0 + music
peak = np.abs(mix).max()
if peak > 0.98: mix *= 0.98 / peak
pcm = (mix * 32767).astype(np.int16)
mix_wav = os.path.join(WORK, "mix.wav")
with wave.open(mix_wav, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", VIDEO, "-i", mix_wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", OUT], check=True)
print(f"wrote {OUT}")
