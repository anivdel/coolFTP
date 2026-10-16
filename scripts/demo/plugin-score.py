"""Scores the plugin spot: a 128 BPM chiptune electro track plus the sound effects scripts/demo/plugin.html
cues in window.SFX.

    npm run plugin-video          renders site/plugin-4x5.mp4 and site/plugin-4x5.sfx.json (the cue list)
    npm run plugin-video:sound    -> site/plugin-4x5-sound.mp4 (this script; numpy only)

Its own sound, not the yeti spot's marimba groove or the social spot's lo-fi: square-wave arpeggios and a
pulse bass over a four-on-the-floor kick. The drums drop in when the panel slides open, a riser builds under
the upload, everything hits when the site is live, it cuts out on "oops", and comes back a tone higher after
the undo. The end card closes on a four-note "cool F T P" lead. The effects and the mixer come from
yeti-score.py; the music and three new effects (whoosh, rewind, tick) are here.
"""
import importlib.util
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
video = sys.argv[1] if len(sys.argv) > 1 else os.path.join("site", "plugin-4x5.mp4")
sys.argv = [sys.argv[0], video]
spec = importlib.util.spec_from_file_location("yeti_score", os.path.join(HERE, "yeti-score.py"))
Y = importlib.util.module_from_spec(spec)
spec.loader.exec_module(Y)
SR, tt, band, noise, adsr, expdecay, sweep, put, hz = Y.SR, Y.tt, Y.band, Y.noise, Y.adsr, Y.expdecay, Y.sweep, Y.put, Y.hz

BPM = 128
BEAT = 60 / BPM
SIXT = BEAT / 4
PANEL, DEPLOY, LIVE, OOPS, UNDO, BACK, END = 3.15, 6.0, 12.4, 16.15, 17.85, 19.7, 24.7


# ---------- new effects ----------

def whoosh(**_):
    sec = .55
    t = tt(sec)
    x = noise(sec, 300, 7000) * np.sin(np.pi * t / sec) ** 2
    return band(x, 600, 5000) * .5


def rewind(**kw):
    """Tape spooling backwards: a falling, fluttering whine."""
    sec = kw.get("len", 1.6)
    t = tt(sec)
    f = 1400 * (1 - .6 * t / sec) * (1 + .08 * np.sin(2 * np.pi * 9 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sign(np.sin(ph)) * .25 + noise(sec, 1500, 8000) * .3
    return band(x, 500, 6000) * adsr(len(t), .05, .2) * .35


def tick(**_):
    t = tt(.05)
    return np.sin(2 * np.pi * 3200 * t) * expdecay(len(t), .006) * .5


Y.EFFECTS.update({"whoosh": whoosh, "rewind": rewind, "tick": tick})


# ---------- instruments ----------

def square(f, sec, duty=.5, amp=.12, rel=.03):
    t = tt(sec)
    ph = (f * t) % 1
    x = np.where(ph < duty, 1.0, -1.0)
    return band(x, 80, 7000) * adsr(len(t), .002, rel) * amp


def pulse_bass(f, sec):
    t = tt(sec)
    ph = (f * t) % 1
    x = np.where(ph < .25, 1.0, -1.0) * .6 + np.sin(2 * np.pi * f * t) * .6
    return band(x, 30, 1200) * adsr(len(t), .003, .04) * .32


def kick():
    sec = .3
    n = int(sec * SR)
    return (sweep(sec, 150, 42, .25) * expdecay(n, .12) + noise(sec, 1500, 6000) * expdecay(n, .002) * .3) * 1.0


def snare():
    sec = .2
    n = int(sec * SR)
    return (noise(sec, 1200, 9000) * expdecay(n, .05) * .5 + np.sin(2 * np.pi * 190 * tt(sec)) * expdecay(n, .03) * .3)


def hat(open_=False):
    sec = .14 if open_ else .04
    return noise(sec, 8000, 16000) * expdecay(int(sec * SR), .05 if open_ else .01) * .2


def crash():
    return noise(1.8, 3000, 14000) * expdecay(int(1.8 * SR), .55) * .25


def riser(sec):
    t = tt(sec)
    x = noise(sec, 400, 10000) * (t / sec) ** 2.2 * .35 + band(np.where((sweep(sec, 300, 2400, 2) > 0), 1.0, -1.0), 300, 6000) * (t / sec) ** 3 * .05
    return x


# Am - F - C - G, one chord per bar; arpeggio pattern in sixteenths (index into the chord, octave up after 3)
CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
ROOTS = [33, 29, 36, 31]
ARP = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 2, 3]
BASS = [0, None, 0, 12, None, 0, 12, None]  # eighths


def music(total):
    n = int(total * SR)
    out = np.zeros(n + SR * 3)
    bar = BEAT * 4

    def chord_at(t, shift):
        i = int(t // bar) % 4
        return [c + shift for c in CHORDS[i]], ROOTS[i] + shift

    def shift_at(t):
        return 2 if t >= BACK else 0

    # Intro: a soft arp alone until the panel opens.
    t = 0.0
    while t < END + 3.5:
        sh = shift_at(t)
        tones, _ = chord_at(t, sh)
        step = int(round(t / SIXT)) % 16
        k = ARP[step]
        note = tones[k % 3] + 12 * (k // 3) + 12
        loud = .5 if t < PANEL else (.75 if t < LIVE else 1.0)
        if OOPS <= t < UNDO:
            loud = 0
        if t >= END:
            loud *= max(0, 1 - (t - END) / 3.5)
        if loud > 0:
            put(out, square(hz(note), SIXT * .9, .25 if t < LIVE else .5, .07 * loud), t)
        t += SIXT

    # Drums and bass from the panel opening, except the "oops" gap; a fill into the drop.
    t = PANEL
    while t < END:
        beat = int(round((t - PANEL) / BEAT))
        gap = OOPS <= t < UNDO + .02
        undo_soft = UNDO <= t < BACK
        if not gap:
            if not undo_soft or beat % 2 == 0:
                put(out, kick() * (.8 if t < LIVE else 1), t)
            if beat % 2 == 1 and t >= DEPLOY and not undo_soft:
                put(out, snare() * .7, t)
            for h in range(2):
                put(out, hat(open_=(h == 1 and t >= LIVE)), t + h * BEAT / 2)
        t += BEAT
    for i in range(8):  # snare roll into the live hit
        put(out, snare() * (.3 + i * .08), LIVE - BEAT * 2 + i * BEAT / 4)

    t = PANEL
    while t < END:
        sh = shift_at(t)
        _, root = chord_at(t, sh)
        step = int(round((t - PANEL) / (BEAT / 2))) % 8
        if not (OOPS <= t < UNDO) and BASS[step] is not None:
            put(out, pulse_bass(hz(root + BASS[step] + 12), BEAT / 2 * .85), t)
        t += BEAT / 2

    put(out, riser(LIVE - DEPLOY - .2), DEPLOY + .2)
    put(out, crash(), LIVE)
    put(out, crash() * .8, BACK)
    put(out, riser(UNDO - OOPS + .9) * .5, OOPS + .4)

    # The end card: a hit, then "cool F T P" on the lead over a held chord.
    put(out, crash(), END + .35)
    put(out, kick() * 1.1, END + .35)
    for i, (note, at) in enumerate([(76, .9), (79, 1.15), (83, 1.4), (88, 1.75)]):
        put(out, square(hz(note), .7 if i == 3 else .22, .5, .14, .1), END + at)
    t = tt(4.5)
    held = sum(np.sin(2 * np.pi * hz(m) * t) for m in (59, 62, 66, 71)) * adsr(len(t), .2, 1.5) * .05
    put(out, held, END + .9)
    return out[:n]


Y.music = music


def main():
    Y.main()


if __name__ == "__main__":
    main()
