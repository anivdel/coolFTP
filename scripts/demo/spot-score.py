"""
Music and sound design for the 4:5 social spot, synthesized from scratch with numpy.
Reads the voice track out of site/social-4x5.mp4, composes a lo-fi bed with a four-note
jingle, cues sound effects to the on-screen moments in social-spot.html, ducks the music
under the narration, and writes site/social-4x5-music.mp4 (the voice-only file is kept).
    python scripts/demo/spot-score.py [video.mp4] [out.mp4]
Intermediate WAVs land in scripts/demo/audio/spot.
"""
import json
import os
import subprocess
import sys
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VIDEO = os.path.join(ROOT, sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "site", "social-4x5.mp4")
OUT = os.path.join(ROOT, sys.argv[2]) if len(sys.argv) > 2 else VIDEO.replace(".mp4", "-music.mp4")
AUDIO = os.path.join(ROOT, "scripts", "demo", "audio", "spot")
FFMPEG = subprocess.run(["node", "-p", "require('ffmpeg-static')"], capture_output=True, text=True, cwd=ROOT).stdout.strip()

SR = 44100
LEN = 66.0
N = int(SR * LEN)
BPM = 90.0
BEAT = 60.0 / BPM
BAR = BEAT * 4
rng = np.random.default_rng(7)


# ---------- helpers ----------
def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def tt(dur):
    return np.arange(int(SR * dur)) / SR


def env_adsr(n, a, d, s, r, hold=None):
    """Linear attack, exponential-ish decay to sustain, release at the end. n samples total."""
    t = np.arange(n) / SR
    total = n / SR
    a = max(a, 0.001)
    e = np.minimum(t / a, 1.0)
    dec = s + (1 - s) * np.exp(-np.maximum(t - a, 0) / max(d, 0.001))
    e = e * dec
    rel = np.clip((total - t) / max(r, 0.001), 0, 1)
    return e * rel


def fft_filter(x, gain_fn):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X * gain_fn(f), n=len(x))


def lowpass(x, fc, order=2):
    return fft_filter(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))


def highpass(x, fc, order=2):
    return fft_filter(x, lambda f: 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-3)) ** (2 * order)))


def bandpass(x, lo, hi):
    return highpass(lowpass(x, hi), lo)


def add(buf, sig, at, gain=1.0, pan=0.0):
    """Mix a mono signal into the stereo buffer at time `at` (s). pan in [-1, 1]."""
    i = int(at * SR)
    if i >= N or i + len(sig) <= 0:
        return
    if i < 0:
        sig = sig[-i:]
        i = 0
    sig = sig[: N - i]
    l = np.sqrt(0.5 * (1 - pan))
    r = np.sqrt(0.5 * (1 + pan))
    buf[i : i + len(sig), 0] += sig * gain * l * 1.4142
    buf[i : i + len(sig), 1] += sig * gain * r * 1.4142


def reverb(buf, seconds=1.4, mix=0.25, predelay=0.02):
    """Cheap plate: convolve with an exponentially decaying noise tail."""
    n = int(SR * seconds)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * (6.9 / seconds))
    ir = lowpass(ir, 5000, 1)
    ir[: int(SR * predelay)] = 0
    ir /= np.sqrt(np.sum(ir**2))
    out = np.empty_like(buf)
    for ch in range(2):
        wet = np.fft.irfft(np.fft.rfft(buf[:, ch], N + n) * np.fft.rfft(ir, N + n))[:N]
        out[:, ch] = buf[:, ch] + wet * mix
    return out


# ---------- instruments ----------
def pluck(note, dur, bright=1.0):
    """Soft electric-piano pluck: decaying harmonics, higher ones die first."""
    t = tt(dur)
    f = midi(note)
    y = np.zeros_like(t)
    for k in range(1, 8):
        if f * k > 15000:
            break
        y += (1 / k**1.6) * np.sin(2 * np.pi * f * k * t + 0.3 * k) * np.exp(-t * (2.2 + k * 1.6 / bright))
    y *= np.minimum(t / 0.004, 1)
    return y * 0.5


def bell(note, dur):
    """The jingle voice: sine with a touch of FM shimmer and a long tail."""
    t = tt(dur)
    f = midi(note)
    fm = 0.35 * np.sin(2 * np.pi * f * 3.51 * t) * np.exp(-t * 6)
    y = np.sin(2 * np.pi * f * t + fm) * np.exp(-t * 1.6)
    y += 0.25 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t * 3.2)
    y += 0.12 * np.sin(2 * np.pi * f * 4.02 * t) * np.exp(-t * 7)
    y *= np.minimum(t / 0.003, 1)
    return y * 0.55


def pad_chord(notes, dur, cutoff=1400, attack=0.9, release=0.9):
    """Warm detuned-saw pad, low-passed, with a slow swell."""
    t = tt(dur)
    y = np.zeros_like(t)
    for n in notes:
        f = midi(n)
        for det in (-5, 0, 5):  # cents
            fd = f * 2 ** (det / 1200)
            ph = rng.uniform(0, 2 * np.pi)
            saw = np.zeros_like(t)
            for k in range(1, 24):
                if fd * k > 9000:
                    break
                saw += np.sin(2 * np.pi * fd * k * t + ph * k) / k
            y += saw
    y = lowpass(y, cutoff, 2)
    y *= env_adsr(len(t), attack, 0.5, 0.85, release)
    return y / (len(notes) * 3) * 0.9


def bass_note(note, dur):
    t = tt(dur)
    f = midi(note)
    y = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t * 4)
    y = np.tanh(y * 1.6) / 1.6
    y *= env_adsr(len(t), 0.01, 0.3, 0.7, 0.08)
    return y * 0.8


def kick():
    t = tt(0.45)
    f = 42 + 90 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.sin(ph) * np.exp(-t * 7.5)
    y += 0.5 * rng.standard_normal(len(t)) * np.exp(-t * 400)
    return np.tanh(y * 1.8) * 0.9


def snare():
    t = tt(0.22)
    n = bandpass(rng.standard_normal(len(t)), 1200, 5200) * np.exp(-t * 22)
    body = np.sin(2 * np.pi * 185 * t) * np.exp(-t * 32)
    return (n * 0.7 + body * 0.6) * 0.7


def hat(open_=False):
    d = 0.32 if open_ else 0.055
    t = tt(d)
    n = highpass(rng.standard_normal(len(t)), 6500, 2) * np.exp(-t * (7 if open_ else 60))
    return n * 0.35


def shaker():
    t = tt(0.09)
    n = bandpass(rng.standard_normal(len(t)), 3000, 9000) * np.exp(-t * 45) * np.minimum(t / 0.02, 1)
    return n * 0.3


def swell(dur=1.2):
    """Cymbal-like noise swell into a downbeat."""
    t = tt(dur)
    n = bandpass(rng.standard_normal(len(t)), 2500, 11000) * (t / dur) ** 2.2
    return n * 0.5


# ---------- sound effects ----------
def sfx_whoosh(dur=0.55, up=True):
    t = tt(dur)
    n = rng.standard_normal(len(t))
    sweep = (t / dur) if up else (1 - t / dur)
    n = fft_filter(n, lambda f: np.exp(-((np.log(np.maximum(f, 1) / 900)) ** 2) * 1.2))
    return n * np.sin(np.pi * sweep) ** 1.3 * 0.55


def sfx_click():
    t = tt(0.03)
    y = rng.standard_normal(len(t)) * np.exp(-t * 350)
    y = bandpass(y, 1500, 7000)
    return y * 0.7


def sfx_tick(pitch=2400):
    t = tt(0.05)
    y = np.sin(2 * np.pi * pitch * t) * np.exp(-t * 140)
    return y * 0.5


def sfx_thud():
    t = tt(0.35)
    f = 70 * np.exp(-t * 10) + 45
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11)
    y += 0.3 * bandpass(rng.standard_normal(len(t)), 300, 1800) * np.exp(-t * 90)
    return y * 0.8


def sfx_chime(notes=(81, 86), gap=0.09):
    dur = 1.1 + gap * len(notes)
    y = np.zeros(int(SR * dur))
    for i, n in enumerate(notes):
        b = bell(n, 1.0)
        i0 = int(i * gap * SR)
        y[i0 : i0 + len(b)] += b
    return y * 0.55


def sfx_blip():
    return sfx_chime((74, 81), 0.07) * 0.7


def sfx_pop():
    t = tt(0.12)
    f = 900 * np.exp(-t * 40) + 300
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 40)
    return y * 0.6


def sfx_rewind(dur=0.5):
    t = tt(dur)
    f = 1400 * np.exp(-t * 5) + 180
    y = np.sin(2 * np.pi * np.cumsum(f) / SR)
    y = y * np.sin(np.pi * t / dur) ** 0.7
    y += 0.4 * lowpass(rng.standard_normal(len(t)), 3000, 2) * np.sin(np.pi * t / dur)
    return y * 0.35


# ---------- the score ----------
music = np.zeros((N, 2))
drums = np.zeros((N, 2))
sfx = np.zeros((N, 2))

DMAJ7 = ([62, 66, 69, 73], 38)
AADD9 = ([61, 64, 69, 71], 45)
BM7 = ([62, 66, 69, 71], 47)
GMAJ7 = ([62, 66, 67, 71], 43)
EM7 = ([62, 64, 67, 71], 40)
A7SUS = ([62, 64, 67, 69], 45)

bar_t = lambda b: b * BAR  # bar 6 lands on 16.0 s, just after "Meet coolFTP"

# harmony: (start bar, length in bars, chord, pad gain, cutoff)
harmony = [(0, 2, DMAJ7, 0.9, 1500)]
for i, ch in enumerate([BM7, GMAJ7, EM7, A7SUS]):
    harmony.append((2 + i, 1, ch, 0.55, 700))
for cyc in range(4):
    for i, ch in enumerate([DMAJ7, AADD9, BM7, GMAJ7]):
        harmony.append((6 + cyc * 4 + i, 1, ch, 0.8, 1300 + 150 * cyc))
harmony += [(22, 1, GMAJ7, 0.8, 1600), (23, 0.5, AADD9, 0.8, 1600), (23.5, 3, DMAJ7, 1.0, 1900)]

for start, length, (notes, root), g, cutoff in harmony:
    dur = length * BAR + 0.15
    add(music, pad_chord(notes, dur, cutoff=cutoff, attack=0.7 if start >= 6 else 1.1, release=0.35 if length <= 1 else 1.4), bar_t(start), gain=0.28 * g)

# bass: from the drop through the outro
for start, length, (notes, root), g, cutoff in harmony:
    if start < 6:
        continue
    if start >= 22:
        add(music, bass_note(root, length * BAR * 0.98), bar_t(start), gain=0.55)
        continue
    b0 = bar_t(start)
    add(music, bass_note(root, BEAT * 1.4), b0, gain=0.6)
    add(music, bass_note(root, BEAT * 0.9), b0 + BEAT * 2.5, gain=0.5)
    if start % 2 == 1:
        add(music, bass_note(root + 7 if root < 44 else root - 5, BEAT * 0.45), b0 + BEAT * 3.5, gain=0.4)

# drums: kick and hats from bar 6, snare from bar 8, out at bar 22
STEP = BEAT / 4
for bar in range(6, 22):
    b0 = bar_t(bar)
    swing = 0.055 * STEP
    for step in range(16):
        t0 = b0 + step * STEP + (swing if step % 2 else 0)
        if step in (0, 6) or (step == 10 and bar % 2 == 1):
            add(drums, kick(), t0, gain=0.9 if step == 0 else 0.7)
        if step in (4, 12) and bar >= 8:
            add(drums, snare(), t0, gain=0.55)
        if step % 2 == 0:
            add(drums, hat(open_=(step == 14 and bar % 4 == 3)), t0, gain=0.5 if step % 4 == 0 else 0.32, pan=0.25)
        if step % 4 == 2 and bar >= 10:
            add(drums, shaker(), t0, gain=0.35, pan=-0.3)
add(drums, swell(1.3), bar_t(23.5) - 1.3, gain=0.5)
add(drums, kick(), bar_t(23.5), gain=0.9)

# arpeggio: 8th-note plucks over the main groove from bar 10
main = [ch for (s, l, ch, g, c) in harmony if 6 <= s < 22]
for i, (notes, root) in enumerate(main):
    bar = 6 + i
    if bar < 10:
        continue
    b0 = bar_t(bar)
    hi = [n + 12 for n in notes]
    pattern = [hi[0], hi[1], hi[2], hi[3], hi[2], hi[1], hi[3], hi[0]]
    for k, n in enumerate(pattern):
        if bar % 4 == 3 and k >= 6:
            continue
        t0 = b0 + k * BEAT / 2 + (0.03 if k % 2 else 0)
        add(music, pluck(n, 0.7, bright=0.8), t0, gain=0.16 if k % 2 == 0 else 0.11, pan=0.35 * (1 if k % 2 else -1))

# the jingle: four notes for "cool F T P", at the logo and again at the close
def jingle(at, last=83, gain=0.5):
    for k, (n, dt) in enumerate([(74, 0.0), (78, 0.23), (81, 0.46), (last, 0.72)]):
        add(music, bell(n, 2.6 if k == 3 else 1.4), at + dt, gain=gain * (1.0 if k == 3 else 0.8), pan=-0.2 + 0.13 * k)

jingle(0.45)
jingle(bar_t(23.5), last=86, gain=0.55)
add(music, bell(78, 3.0), bar_t(23.5) + 1.0, gain=0.25, pan=0.3)
add(music, bell(81, 3.0), bar_t(23.5) + 1.25, gain=0.2, pan=-0.3)

# sound effects, cued to social-spot.html (ms in the timeline)
cues = [
    (0.15, sfx_whoosh(0.7), 0.5, 0),
    (7.6, sfx_thud(), 0.7, 0), (9.9, sfx_thud(), 0.7, 0), (12.3, sfx_thud(), 0.8, 0),
    (16.0, sfx_click(), 0.6, 0.1), (16.7, sfx_blip(), 0.5, 0.2),
    (17.6, sfx_tick(1800), 0.25, -0.3),
    (20.3, sfx_tick(2200), 0.35, -0.3), (22.45, sfx_whoosh(0.5), 0.45, 0.2), (22.95, sfx_pop(), 0.35, 0.2),
    (27.4, sfx_chime(), 0.55, 0.2), (27.65, sfx_pop(), 0.3, 0.3),
    (29.4, sfx_tick(), 0.3, 0), (29.9, sfx_tick(2600), 0.3, 0), (30.4, sfx_tick(2800), 0.3, 0), (31.3, sfx_tick(2000), 0.2, 0), (32.2, sfx_chime(), 0.5, 0),
    (36.3, sfx_tick(), 0.3, 0), (36.8, sfx_tick(2600), 0.3, 0), (37.3, sfx_tick(2800), 0.3, 0), (37.9, sfx_chime((81, 85)), 0.45, 0),
    (39.6, sfx_tick(), 0.3, 0), (40.2, sfx_tick(2600), 0.3, 0), (40.8, sfx_tick(2800), 0.3, 0), (41.5, sfx_chime((81, 86, 90)), 0.5, 0),
    (46.4, sfx_click(), 0.6, 0.3), (46.42, sfx_rewind(0.5), 0.6, 0.3), (46.95, sfx_chime((78, 86)), 0.5, 0),
    (55.5, sfx_chime(), 0.45, 0), (55.8, sfx_pop(), 0.35, -0.2),
    (59.05, sfx_whoosh(0.8), 0.5, 0),
]
for at, sig, g, pan in cues:
    add(sfx, sig, at, gain=g, pan=pan)
# the upload progress ticks
for k in range(9):
    add(sfx, sfx_tick(1500 + 90 * k), 22.95 + 0.42 * k, gain=0.14, pan=0.1)
# the typed message
for k in range(14):
    add(sfx, sfx_click(), 52.72 + k * 0.083 + rng.uniform(-0.01, 0.01), gain=0.18, pan=-0.35)

# ---------- mix ----------
def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768
        if w.getnchannels() == 2:
            data = data.reshape(-1, 2).mean(axis=1)
    out = np.zeros(N)
    out[: min(N, len(data))] = data[:N]
    return out


def write_wav(path, stereo):
    pcm = np.clip(stereo, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((pcm * 32767).astype(np.int16).tobytes())


os.makedirs(AUDIO, exist_ok=True)
voice_path = os.path.join(AUDIO, "voice.wav")
subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", VIDEO, "-vn", "-ac", "1", "-ar", str(SR), voice_path], check=True)
voice = read_wav(voice_path)

# sidechain pump: pad and bass dip a little on every kick
pump = np.ones(N)
for bar in range(6, 22):
    for step in (0, 6):
        i = int((bar_t(bar) + step * STEP) * SR)
        n = int(0.28 * SR)
        pump[i : i + n] = np.minimum(pump[i : i + n], 1 - 0.35 * np.exp(-np.arange(min(n, N - i)) / SR * 9))
music *= pump[:, None]

music = reverb(music, 1.6, 0.22)
drums = lowpass(drums[:, 0], 9500, 1)[:, None] * [1, 0] + lowpass(drums[:, 1], 9500, 1)[:, None] * [0, 1]
sfx = reverb(sfx, 1.0, 0.18)
bed = music + drums * 0.85
bed = np.stack([lowpass(bed[:, 0], 11000, 1), lowpass(bed[:, 1], 11000, 1)], axis=1)

# duck the bed under the narration: envelope follower with a fast attack and a slow release
env = np.abs(voice)
frame = int(SR * 0.02)
rms = np.sqrt(np.convolve(env**2, np.ones(frame) / frame, mode="same"))
follow = np.zeros(N)
a_att, a_rel = np.exp(-1 / (SR * 0.03)), np.exp(-1 / (SR * 0.45))
v = 0.0
for i in range(0, N, 32):  # block-wise for speed
    x = rms[i]
    v = x + (a_att if x > v else a_rel) * (v - x)
    follow[i : i + 32] = v
speaking = follow > 0.02
duck = 1 - 0.5 * np.clip(follow / 0.06, 0, 1)

voice_rms = np.sqrt(np.mean(voice[speaking] ** 2)) if speaking.any() else 0.1
groove = slice(int(16 * SR), int(58 * SR))
bed_rms = np.sqrt(np.mean(bed[groove] ** 2))
bed *= (voice_rms * 10 ** (-4 / 20)) / bed_rms  # 4 dB under the voice before ducking, about 10 dB under while it speaks
bed *= duck[:, None]
sfx_peak = np.max(np.abs(sfx))
sfx *= (voice_rms * 10 ** (6 / 20)) / max(sfx_peak, 1e-6)

mix = bed + sfx + voice[:, None]
peak = np.max(np.abs(mix))
if peak > 0.94:
    mix *= 0.94 / peak
write_wav(os.path.join(AUDIO, "score.wav"), (bed + sfx) * (0.94 / peak if peak > 0.94 else 1))
mix_path = os.path.join(AUDIO, "mix.wav")
write_wav(mix_path, mix)

subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", VIDEO, "-i", mix_path, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", OUT], check=True)
print(json.dumps({"out": OUT, "voice_rms_db": round(20 * np.log10(voice_rms), 1), "bed_rms_db": round(20 * np.log10(np.sqrt(np.mean(bed[groove] ** 2))), 1), "peak": round(float(np.max(np.abs(mix))), 3)}))
