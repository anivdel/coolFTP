"""Scores the yeti spot: a bouncy 120 BPM track plus the cartoon sound effects scripts/demo/yeti.html cues in window.SFX.

    npm run yeti          renders site/yeti-4x5.mp4 and site/yeti-4x5.sfx.json (the cue list)
    npm run yeti:sound    -> site/yeti-4x5-sound.mp4 (this script; numpy only)

The music follows the page's beat grid (one beat = 0.5 s, one bar = 2 s): a glockenspiel intro, the groove
dropping in when the yeti bursts out, a full stop on the broken page (clock ticks), and back in a key higher
after Undo. Everything is synthesized here.
"""
import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VIDEO = os.path.join(ROOT, sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "site", "yeti-4x5.mp4")
OUT = os.path.join(ROOT, sys.argv[2]) if len(sys.argv) > 2 else VIDEO.replace(".mp4", "-sound.mp4")
CUES = VIDEO.replace(".mp4", ".sfx.json")
FFMPEG = subprocess.run(["node", "-p", "require('ffmpeg-static')"], capture_output=True, text=True, cwd=ROOT).stdout.strip()

SR = 48000
BEAT = .5
rng = np.random.default_rng(7)


def tt(sec):
    return np.arange(int(sec * SR)) / SR


def band(x, lo, hi):
    """Soft band-pass via FFT."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    m = 1 / (1 + (lo / np.maximum(f, 1)) ** 4) / (1 + (f / hi) ** 4)
    return np.fft.irfft(X * m, len(x))


def noise(sec, lo=20, hi=20000):
    x = band(rng.standard_normal(int(sec * SR)), lo, hi)
    return x / (np.abs(x).max() + 1e-9)


def adsr(n, a, r, curve=1.0):
    e = np.ones(n)
    na, nr = int(a * SR), int(r * SR)
    if na: e[:na] = np.linspace(0, 1, na) ** curve
    if nr: e[-nr:] *= np.linspace(1, 0, nr) ** curve
    return e


def expdecay(n, tau):
    return np.exp(-np.arange(n) / SR / tau)


def sweep(sec, f0, f1, shape=1.0):
    t = tt(sec)
    f = f0 + (f1 - f0) * (t / sec) ** shape
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def smooth_noise(n, rate):
    k = max(2, int(n / SR * rate) + 2)
    return np.interp(np.linspace(0, k - 1, n), np.arange(k), rng.uniform(-1, 1, k))


def put(out, x, at):
    o = int(round(at * SR))
    if o >= len(out) or o + len(x) <= 0: return
    if o < 0: x, o = x[-o:], 0
    out[o:o + len(x)] += x[:len(out) - o]


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


# ---------- the yeti's voice ----------

def beast(sec, f0, rough=.6, lo=90, hi=2600, rise=.25):
    """Growly voiced sound: a buzzy source with jitter, rough flutter and breath."""
    n = int(sec * SR)
    t = tt(sec)
    arc = np.sin(np.pi * np.clip(t / sec, 0, 1)) ** .7
    f = f0 * (1 + rise * arc) * (1 + .05 * smooth_noise(n, 9))
    ph = 2 * np.pi * np.cumsum(f) / SR
    src = sum(np.sin(k * ph) / k ** .9 for k in range(1, 28))
    flutter = 1 - rough * (.5 + .5 * np.sin(2 * np.pi * np.cumsum(32 + 14 * smooth_noise(n, 6)) / SR)) ** 2
    x = band((src * .22 + np.sin(ph / 2) * .3) * flutter + noise(sec, 300, 3500) * .35 * (.6 + .4 * arc), lo, hi)
    return x / (np.abs(x).max() + 1e-9)


def roar(len=1.0, pitch=1.0, **_):
    sec = len + .3
    n = int(sec * SR)
    e = np.clip(tt(sec) / .07, 0, 1) * np.clip((len + .25 - tt(sec)) / .35, 0, 1) ** 1.2
    low = sweep(sec, 70 * pitch, 48 * pitch, .6) * expdecay(n, .5) * .5
    return (beast(sec, 92 * pitch, .55, 80, 3200, .35) * e * .8 + low * e) * .85


def yelp(**_):
    sec = .45
    return beast(sec, 170, .35, 150, 3500, .6) * adsr(int(sec * SR), .02, .2) * .6


def grunt(pitch=1.0, **_):
    sec = .2
    t = tt(sec)
    ph = 2 * np.pi * np.cumsum(150 * pitch * (1 + .2 * t / sec)) / SR
    return band(np.sin(ph) + .4 * np.sin(2 * ph) + .15 * np.sin(3 * ph), 100, 900) * adsr(len(t), .03, .1) * .45


def inhale(**_):
    sec = .4
    n = int(sec * SR)
    return noise(sec, 600, 4000) * np.linspace(0, 1, n) ** 2 * adsr(n, 0, .04) * .3


def frost(len=.85, **_):
    sec = len + .4
    n = int(sec * SR)
    out = noise(sec, 1500, 11000) * adsr(n, .06, .45) * .35 + noise(sec, 300, 1800) * adsr(n, .05, .4) * .3
    for _ in range(18):
        put(out, np.sin(2 * np.pi * rng.uniform(2600, 6000) * tt(.12)) * expdecay(int(.12 * SR), .03) * .12, rng.uniform(.05, len))
    return out


def freeze(**_):
    out = np.zeros(int(.9 * SR))
    for i in range(26):
        put(out, noise(.02, 2500, 12000) * expdecay(int(.02 * SR), .003) * .5, (i / 26) ** 1.4 * .55 + rng.uniform(0, .02))
    for f, at in [(2093, .45), (2637, .5), (3136, .55)]:
        put(out, np.sin(2 * np.pi * f * tt(.4)) * expdecay(int(.4 * SR), .12) * .12, at)
    return out


# ---------- cartoon effects ----------

def clink(**_):
    out = np.zeros(int(.5 * SR))
    for f, a in [(2780, .3), (4130, .2), (5390, .14), (7020, .08)]:
        out += np.sin(2 * np.pi * f * tt(.5)) * expdecay(len(out), .09) * a
    out[:int(.004 * SR)] += noise(.004, 3000, 12000) * .4
    return out


def shatter(**_):
    out = np.zeros(int(1.4 * SR))
    n = int(.8 * SR)
    put(out, noise(.8, 1200, 12000) * expdecay(n, .012) * .9 + np.sin(2 * np.pi * 90 * tt(.8)) * expdecay(n, .06) * .5, 0)
    for i in range(16):
        put(out, clink() * rng.uniform(.25, .6), .04 + (i / 16) ** 1.3 * .8)
    return out


def breeze(**_):
    sec = 4.6
    n = int(sec * SR)
    gust = .6 + .4 * smooth_noise(n, .7)
    return noise(sec, 400, 3000) * gust * adsr(n, .8, 1.4) * .25


def keys(len=1.0, **_):
    out = np.zeros(int((len + .1) * SR))
    t = 0.0
    while t < len:
        c = noise(.02, 1800, 9000) * expdecay(int(.02 * SR), .004) * rng.uniform(.5, 1)
        c += np.sin(2 * np.pi * rng.uniform(380, 520) * tt(.02)) * expdecay(int(.02 * SR), .006) * .4
        put(out, c * .45, t)
        t += rng.uniform(.045, .09)
    return out


def pop(**_):
    sec = .12
    n = int(sec * SR)
    return (sweep(sec, 380, 1300, .5) * expdecay(n, .03) + noise(sec, 2000, 8000) * expdecay(n, .003) * .3) * .55


def blip(**_):
    a = np.sin(2 * np.pi * 1320 * tt(.09)) * expdecay(int(.09 * SR), .03)
    b = np.sin(2 * np.pi * 1980 * tt(.12)) * expdecay(int(.12 * SR), .04)
    out = np.zeros(int(.2 * SR)); out[:len(a)] += a; put(out, b, .06)
    return out * .35


def click(**_):
    return noise(.03, 1500, 9000) * expdecay(int(.03 * SR), .0025) + np.sin(2 * np.pi * 3200 * tt(.03)) * expdecay(int(.03 * SR), .004) * .4


def glitch(**_):
    parts = []
    for _ in range(12):
        n = int(rng.uniform(.015, .035) * SR)
        sq = np.sign(np.sin(2 * np.pi * rng.uniform(180, 1600) * np.arange(n) / SR))
        parts.append(np.round(sq * rng.uniform(.3, 1) * 4) / 4 * (rng.random() > .2))
    x = np.concatenate(parts)
    return band(x, 100, 6000) * adsr(len(x), .002, .05) * .2


def rumble(len=.7, **_):
    sec = len + .2
    n = int(sec * SR)
    x = noise(sec, 25, 220) + np.sin(2 * np.pi * 45 * tt(sec)) * .6
    return x * np.linspace(.2, 1, n) ** 1.5 * adsr(n, .05, .12) * .7


def burst(**_):
    sec = 1.4
    n = int(sec * SR)
    boom = sweep(sec, 130, 40, .5) * expdecay(n, .3)
    body = noise(sec, 60, 2500) * expdecay(n, .2)
    out = boom + body * .7
    for _ in range(30):   # snow chunks crunching
        put(out, noise(.03, 1500, 7000) * expdecay(int(.03 * SR), .008) * rng.uniform(.1, .35), rng.uniform(0, .6))
    return out * .8


def slide(**_):
    sec = .45
    t = tt(sec)
    f = 480 * (1700 / 480) ** ((t / sec) ** 1.3) * (1 + .02 * np.sin(2 * np.pi * 9 * t))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) + noise(sec, 1000, 5000) * .08
    return x * adsr(len(t), .03, .08) * .28


def swish(short=False, **_):
    sec = .25 if short else .4
    n = int(sec * SR)
    return noise(sec, 600, 6000) * np.sin(np.pi * np.linspace(0, 1, n)) ** 2 * .45


def stamp(**_):
    sec = .5
    n = int(sec * SR)
    thump = sweep(sec, 130, 50, .4) * expdecay(n, .09)
    slap = noise(sec, 200, 4000) * expdecay(n, .025)
    return (thump + slap * .8) * .85


def boing(**_):
    sec = .6
    t = tt(sec)
    f = (260 + 120 * np.sin(2 * np.pi * 16 * t) * np.exp(-t / .22)) * (1 - .25 * t / sec)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * expdecay(len(t), .22) * adsr(len(t), .005, .05) * .45


def scratch(**_):
    sec = .4
    t = tt(sec)
    tri = 1 - 2 * np.abs((t / sec * 2) % 1 - .5) * 2
    f = 700 + 600 * tri
    ph = 2 * np.pi * np.cumsum(f) / SR
    saw = sum(np.sin(k * ph) / k for k in range(1, 10))
    return band(saw * .35 + noise(sec, 800, 6000) * .4 * (.5 + .5 * np.abs(tri)), 200, 7000) * adsr(len(t), .005, .05) * .7


def wah(**_):
    """Sad trombone: three falling notes and a long wobbly one."""
    out = np.zeros(int(2.2 * SR))
    notes = [(0, .3, 392), (.32, .3, 370), (.64, .3, 349), (.96, 1.0, 330)]
    for at, d, f0 in notes:
        t = tt(d)
        f = np.full(len(t), float(f0))
        if d > .5: f *= (1 + .03 * np.sin(2 * np.pi * 6 * t) * (t / d)) * (1 - .04 * t / d)
        ph = 2 * np.pi * np.cumsum(f) / SR
        x = sum(np.sin(k * ph) / k ** 1.2 for k in range(1, 12))
        put(out, band(x, 150, 2200) * adsr(len(t), .04, .1) * .3, at)
    return out


def ding(**_):
    out = np.zeros(int(1.6 * SR))
    for f, at in [(1568, 0), (2093, .12)]:
        t = tt(1.4)
        put(out, (np.sin(2 * np.pi * f * t) + .3 * np.sin(2 * np.pi * f * 2.76 * t) * expdecay(len(t), .1)) * expdecay(len(t), .5) * .22, at)
    return out


def sparkle(**_):
    out = np.zeros(int(.9 * SR))
    for i, f in enumerate([2093, 2637, 3136, 3951, 4186]):
        n = len(out) - int(i * .05 * SR)
        put(out, np.sin(2 * np.pi * f * tt(n / SR)) * expdecay(n, .15) * .16, i * .05)
    return out


EFFECTS = {k: v for k, v in globals().items() if callable(v) and k in {
    'roar', 'yelp', 'grunt', 'inhale', 'frost', 'freeze', 'clink', 'shatter', 'breeze', 'keys', 'pop', 'blip', 'click',
    'glitch', 'rumble', 'burst', 'slide', 'swish', 'stamp', 'boing', 'scratch', 'wah', 'ding', 'sparkle'}}


# ---------- music: instruments ----------

def kick():
    sec = .35
    n = int(sec * SR)
    return (sweep(sec, 160, 45, .3) * expdecay(n, .16) + noise(sec, 1000, 6000) * expdecay(n, .003) * .3) * .9


def clap():
    out = np.zeros(int(.3 * SR))
    for i in range(3):
        put(out, noise(.012, 900, 6000) * .6, i * .01)
    put(out, noise(.25, 900, 5000) * expdecay(int(.25 * SR), .07) * .5, .03)
    return out * .55


def hat(open_=False):
    sec = .18 if open_ else .05
    return noise(sec, 7000, 16000) * expdecay(int(sec * SR), .06 if open_ else .015) * .22


def crash():
    return noise(1.6, 3000, 14000) * expdecay(int(1.6 * SR), .5) * .22


def bass(f, dur=.22):
    t = tt(dur + .05)
    ph = 2 * np.pi * f * t
    x = sum(np.sin(k * ph) / k for k in range(1, 10, 2)) + .5 * np.sin(ph)
    return band(x, 35, 900) * expdecay(len(t), .14) * adsr(len(t), .004, .03) * .45


def stab(fs):
    t = tt(.16)
    x = np.zeros(len(t))
    for f in fs:
        for d in (-.006, .006):
            ph = 2 * np.pi * f * (1 + d) * t
            x += sum(np.sin(k * ph) / k for k in range(1, 12))
    return band(x, 400, 4500) * expdecay(len(t), .05) * adsr(len(t), .003, .03) * .05


def marimba(f):
    t = tt(.5)
    x = np.sin(2 * np.pi * f * t) + .35 * np.sin(2 * np.pi * 4 * f * t) * expdecay(len(t), .04) + .12 * np.sin(2 * np.pi * 10 * f * t) * expdecay(len(t), .01)
    return x * expdecay(len(t), .18) * adsr(len(t), .002, .05) * .2


def glock(f):
    t = tt(1.2)
    x = np.sin(2 * np.pi * f * t) + .4 * np.sin(2 * np.pi * 2.76 * f * t) * expdecay(len(t), .15) + .15 * np.sin(2 * np.pi * 5.4 * f * t) * expdecay(len(t), .05)
    return x * expdecay(len(t), .45) * adsr(len(t), .002, .1) * .16


def pad(fs, sec, amp=.03):
    t = tt(sec)
    x = sum(np.sin(2 * np.pi * f * (1 + d) * t) for f in fs for d in (-.002, .002))
    return x * adsr(len(t), .5, .8) * amp


def riser(sec):
    t = tt(sec)
    n = len(t)
    x = noise(sec, 500, 9000) * (t / sec) ** 2 * .3 + sweep(sec, 200, 1200, 2) * (t / sec) ** 2 * .08
    return x * adsr(n, 0, .02)


def woodblock(f):
    t = tt(.08)
    return (np.sin(2 * np.pi * f * t) + noise(.08, 1500, 6000) * expdecay(len(t), .004) * .4) * expdecay(len(t), .02) * .35


# D major: chord tones, bass roots and a two-bar-ish marimba hook per chord (MIDI notes, eighth notes, None = rest)
CHORDS = ['D', 'A', 'Bm', 'G']
TRIADS = {'D': [62, 66, 69], 'A': [61, 64, 69], 'Bm': [62, 66, 71], 'G': [62, 67, 71]}
ROOTS = {'D': 38, 'A': 33, 'Bm': 35, 'G': 31}
RIFF = {
    'D': [74, None, 78, 81, None, 83, 81, 78],
    'A': [76, None, 81, 85, None, 83, 81, 76],
    'Bm': [78, None, 81, 86, None, 85, 83, 81],
    'G': [79, 78, 76, 74, None, 76, 78, None],
}
BASSLINE = [0, None, 12, 0, None, 12, 0, 7]


def music(total):
    n = int(total * SR)
    drums, inst = np.zeros(n + SR * 3), np.zeros(n + SR * 3)
    kicks = []
    E = BEAT / 2

    def bar(t0, chord, key=0, drums_on=True, lead=1.0, stabs=True, glk=False, until=None):
        for i in range(8):
            at = t0 + i * E
            if until is not None and at >= until: break
            if drums_on:
                if i % 2 == 0: put(drums, kick(), at); kicks.append(at)
                if i in (2, 6): put(drums, clap(), at)
                put(drums, hat(i == 7), at)
            b = BASSLINE[i]
            if b is not None and drums_on: put(inst, bass(hz(ROOTS[chord] + key + b)), at)
            if stabs and i % 2 == 1: put(inst, stab([hz(m + key) for m in TRIADS[chord]]), at)
            r = RIFF[chord][i]
            if r is not None and lead:
                put(inst, (glock(hz(r + key)) if glk else marimba(hz(r + key))) * lead, at)

    # Intro: glockenspiel hook over a soft pad, then a riser into the drop
    for j, ch in enumerate(['D', 'A']):
        put(inst, pad([hz(m) for m in TRIADS[ch]], 2.2), j * 2)
        bar(j * 2, ch, drums_on=False, stabs=False, glk=True, lead=.9)
    put(inst, riser(1.0), 3.0)
    for k in range(8):   # snare roll building to the burst
        put(drums, clap() * (.2 + .1 * k), 3.0 + k * .125)

    # Groove A until the page breaks
    STOP = 17.75
    put(drums, crash(), 4.0); put(drums, crash(), 12.0)
    for j, t0 in enumerate(np.arange(4.0, 18.0, 2.0)):
        bar(t0, CHORDS[j % 4], lead=.7 if 8.5 < t0 < 16 else 1.0, until=STOP)

    # Break: clock ticks and a low drone while the yeti panics
    for k, at in enumerate(np.arange(18.0, 21.6, BEAT)):
        put(drums, woodblock(1900 if k % 2 == 0 else 1450), at)
    t = tt(4.2)
    put(inst, (np.sin(2 * np.pi * hz(38) * t) * .5 + np.sin(2 * np.pi * hz(45) * t) * .3) * (.7 + .3 * np.sin(2 * np.pi * 2 * t)) * adsr(len(t), .4, .4) * .12, 17.9)
    put(inst, riser(1.0), 21.0)

    # Groove B, a whole step up, through the montage, the Claude Code panel, the hosts and the end card.
    # Anything past 40 s (the mod scene added 4 s at 32 s) lengthens the groove and moves the button.
    extra = max(0.0, total - 40.0)
    for at in (22.0, 28.0, 29.0, 30.0, 31.0, 32.0, 32.0 + extra, 34.0 + extra):
        put(drums, crash(), at)
    for j, t0 in enumerate(np.arange(22.0, 38.0 + extra, 2.0)):
        bar(t0, CHORDS[j % 4], key=2)

    # Button: a final hit and a glockenspiel run up the tonic chord
    HIT = 38.0 + extra
    put(drums, kick(), HIT); put(drums, crash() * 1.3, HIT); kicks.append(HIT)
    put(inst, bass(hz(ROOTS['D'] + 2), 1.0) * 1.2, HIT)
    put(inst, stab([hz(m + 2) for m in TRIADS['D']]) * 2.5, HIT)
    for k, m in enumerate([74, 78, 81, 86]):
        put(inst, glock(hz(m + 2)), HIT + k * .12)
    put(inst, pad([hz(m + 2) for m in TRIADS['D']], 2.2, .035), HIT)

    # Hard stop on the break, with a tiny fade so it does not click
    for buf in (drums, inst):
        a, b = int(STOP * SR), int((STOP + .02) * SR)
        buf[a:b] *= np.linspace(1, 0, b - a)
        buf[b:int(17.9 * SR)] = 0

    # Sidechain: everything melodic ducks under the kick for bounce
    duck = np.ones(len(inst))
    for k in kicks:
        o = int(k * SR)
        m = min(len(duck) - o, int(.25 * SR))
        duck[o:o + m] = np.minimum(duck[o:o + m], 1 - .45 * np.exp(-np.arange(m) / SR / .08))
    out = drums + inst * duck
    end = int(total * SR)
    fade = int(1.4 * SR)
    out[end - fade:end] *= np.linspace(1, 0, fade) ** 1.5
    out[end:] = 0
    return out[:n]


def reverb(x, sec=1.2, wet=.15):
    n = int(sec * SR)
    ir = band(rng.standard_normal(n) * np.exp(-np.arange(n) / SR / (sec / 5)), 200, 7000)
    ir /= np.sqrt((ir ** 2).sum())
    size = 1 << int(np.ceil(np.log2(len(x) + n)))
    return x + np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[:len(x)] * wet * 3


def soundtrack(cues, total, path):
    n = int(total * SR)
    fx = np.zeros(n + SR * 3)
    for ev in cues:
        opts = {k: v for k, v in ev.items() if k not in ('t', 'name', 'vol')}
        put(fx, EFFECTS[ev['name']](**opts) * ev.get('vol', 1), ev['t'])
    fx = reverb(fx, 1.0, .12)[:n]
    mus = reverb(music(total), .9, .08)[:n]
    mus /= np.abs(mus).max() + 1e-9
    mix = fx * .85 + mus * .5
    mix = np.tanh(mix * 1.2) / np.tanh(1.2)
    mix /= np.abs(mix).max() / .89
    k = int(.01 * SR)
    mix[:k] *= np.linspace(0, 1, k)
    mix[-k:] *= np.linspace(1, 0, k)
    pcm = (np.stack([mix, mix], axis=1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main():
    with open(CUES, encoding='utf8') as f:
        data = json.load(f)
    wav = os.path.join(tempfile.gettempdir(), "yeti-score.wav")
    soundtrack(data['sfx'], data['duration'], wav)
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", VIDEO, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", OUT], check=True)
    os.remove(wav)
    print(OUT)


if __name__ == "__main__":
    main()
