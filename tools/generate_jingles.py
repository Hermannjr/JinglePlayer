"""Generate all JinglePlayer announcement clips.

Each clip = synthesized sting (fanfare / chime / air horn / whistle) + voice line,
compressed and loudness-normalised hot so it cuts through background music.

Voice: Kokoro TTS (local, free) with voice af_heart at speed 0.96, the same as the
"Ultimate in a Minute" explainer video.

Model files (not in the repo, ~350 MB) from
https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0 :
  kokoro-v1.0.onnx, voices-v1.0.bin
Put them in tools/models/ or point KOKORO_DIR at their folder.

Output:
  app/audio/voice/<event>_<field>.mp3       classic set (individual files, handy for checking)
  app/audio/halloween/<event>_<field>.mp3   Halloween theme set
  app/audio/jingles.js                  (everything base64-inlined, loaded by the app)

Usage:  pip install -r tools/requirements.txt && python tools/generate_jingles.py
Edit LINES below to change the wording, then re-run (and python tools/build.py).
"""
import base64, json, os, subprocess
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from kokoro_onnx import Kokoro
from scipy.signal import butter, resample_poly, sosfilt

SR = 44100
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "audio"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
MODELS = Path(os.environ.get("KOKORO_DIR", Path(__file__).resolve().parent / "models"))
VOICE, SPEED = "af_heart", 0.96

FIELDS = {"1": "field one", "2": "field two", "3": "field three", "4": "field four", "all": "all fields"}

# {f} = "field one" / "all fields", {F} = capitalised
LINES = {
    "start": "Attention, {f}! Time is running. Pull when ready, and have fun!",
    "five": "Five minutes left on {f}! Five minutes to go.",
    "two": "Two minutes left on {f}! Two minutes to go.",
    "halftime": "Halftime on {f}! Finish the point in play, then take your two-minute break.",
    "halftime_over": "{F}, halftime is over! Everybody back on the line.",
    "end": "Time is up on {f}! That's the cap. Finish the point in play, and don't forget your spirit circle.",
}
TEST_LINE = "Testing, one, two. The Disc Fiction jingle player is ready!"

# Halloween theme: same voice, spooky wording (and spooky stings, see spooky_sting)
HALLOWEEN_LINES = {
    "start": "Attention, {f}! Time is running... Pull when ready, if you dare. Have a spooktacular game!",
    "five": "Five minutes left on {f}! Five minutes to go... the end is near!",
    "two": "Two minutes left on {f}! Two minutes to go... the end is near!",
    "halftime": "Halftime on {f}! Finish the point in play, then rest your bones for two minutes.",
    "halftime_over": "{F}, halftime is over! Rise from the dead, and get back on the line.",
    "end": "Time is up on {f}! That's the cap. Finish the point in play, and don't forget your spirit circle. Boo!",
}
HALLOWEEN_TEST = "Testing, one, two. The Disc Fiction jingle player has risen from the grave!"

# ---------------------------------------------------------------- synthesis helpers

def t_axis(dur):
    return np.arange(int(dur * SR)) / SR


def adsr(n, a=0.01, d=0.08, s=0.7, r=0.12):
    e = np.full(n, s)
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    e[:na] = np.linspace(0, 1, na)
    e[na:na + nd] = np.linspace(1, s, nd)
    e[-nr:] *= np.linspace(1, 0, nr)
    return e


def lowpass(x, hz, order=2):
    return sosfilt(butter(order, hz, "low", fs=SR, output="sos"), x)


def bandpass(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def brass(freq, dur):
    t = t_axis(dur)
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.clip(t / 0.25, 0, 1)
    ph = 2 * np.pi * freq * np.cumsum(vib) / SR
    x = sum(np.sin(k * ph) / k ** 0.9 for k in range(1, 14))
    x = np.tanh(1.4 * x)
    bright = 1800 + 2500 * np.exp(-t / 0.15)
    x = lowpass(x, float(np.mean(bright)), 2)
    return x * adsr(len(t), 0.025, 0.1, 0.75, min(0.15, dur / 3))


def bell(freq, dur):
    t = t_axis(dur)
    parts = [(1, 1.0, 1.3), (2.0, 0.5, 0.8), (2.76, 0.35, 0.5), (5.4, 0.18, 0.25), (8.93, 0.08, 0.12)]
    x = sum(a * np.sin(2 * np.pi * freq * r * t) * np.exp(-t / d) for r, a, d in parts)
    att = np.clip(t / 0.003, 0, 1)
    return x * att


def airhorn(dur):
    t = t_axis(dur)
    x = np.zeros_like(t)
    for f in (415.0, 523.0, 622.0):  # slightly dissonant chord like a real horn
        ph = 2 * np.pi * f * t * (1 + 0.002 * np.sin(2 * np.pi * 3 * t))
        x += (2 * ((ph / (2 * np.pi)) % 1) - 1)  # saw
    x = np.tanh(2.5 * x)
    x = bandpass(x, 250, 4500)
    return x * adsr(len(t), 0.02, 0.05, 0.9, 0.06)


def whistle(dur, seed=0):
    rng = np.random.default_rng(seed)
    t = t_axis(dur)
    trill = np.sin(2 * np.pi * 27 * t)  # the pea rattling
    f = 2950 + 140 * trill
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * (0.75 + 0.25 * trill)
    breath = bandpass(rng.standard_normal(len(t)), 2400, 3800) * 0.25
    return (x + breath) * adsr(len(t), 0.015, 0.03, 0.9, 0.04)


def place(parts, total=None):
    """parts: list of (start_sec, signal)."""
    end = max(s + len(x) / SR for s, x in parts)
    out = np.zeros(int((total or end) * SR) + 1)
    for s, x in parts:
        i = int(s * SR)
        out[i:i + len(x)] += x[: len(out) - i]
    return out


def norm(x, peak=0.9):
    return x * (peak / (np.max(np.abs(x)) + 1e-9))


def sting(event):
    n = lambda m: 440 * 2 ** ((m - 69) / 12)
    if event == "start":  # "da-da-da-daaaa" fanfare (G4 C5 E5 G5)
        notes = [(0.00, 67, 0.16), (0.18, 72, 0.16), (0.36, 76, 0.16), (0.54, 79, 0.75)]
        parts = [(s, brass(n(m), d)) for s, m, d in notes]
        parts += [(0.54, 0.6 * brass(n(72), 0.75)), (0.54, 0.5 * brass(n(76), 0.75))]
        return norm(place(parts))
    if event in ("five", "two"):  # attention chime C5 E5 G5 C6
        parts = [(i * 0.28, bell(n(m), 1.4)) for i, m in enumerate([72, 76, 79, 84])]
        return norm(place(parts, 1.9))
    if event == "end":  # two air-horn blasts
        return norm(place([(0, airhorn(0.55)), (0.75, airhorn(1.1))]))
    if event == "halftime":  # one long whistle
        return norm(place([(0, whistle(0.9))]), 0.75)
    if event == "halftime_over":  # tweet-tweet-tweeeet
        return norm(place([(0, whistle(0.16, 1)), (0.24, whistle(0.16, 2)), (0.48, whistle(0.7, 3))]), 0.75)
    if event == "test":
        parts = [(i * 0.2, bell(n(m), 1.0)) for i, m in enumerate([79, 84])]
        return norm(place(parts, 1.2))
    raise ValueError(event)

# ---------------------------------------------------------------- spooky stings (Halloween theme)

def organ(freq, dur):
    t = t_axis(dur)
    x = sum(a * np.sin(2 * np.pi * freq * m * t) for m, a in [(0.5, .5), (1, 1), (2, .6), (3, .3), (4, .35), (6, .15), (8, .12)])
    x *= 1 + 0.06 * np.sin(2 * np.pi * 6 * t)  # tremulant
    return x * adsr(len(t), 0.02, 0.05, 0.85, min(0.25, dur / 3))


def toll(freq, dur):  # deep church bell
    t = t_axis(dur)
    parts = [(0.5, .6, 2.5), (1, 1.0, 1.8), (1.19, .45, 1.2), (1.5, .35, 1.0), (2.0, .4, .8), (2.74, .2, .5), (3.76, .1, .3)]
    return sum(a * np.sin(2 * np.pi * freq * r * t) * np.exp(-t / d) for r, a, d in parts) * np.clip(t / 0.004, 0, 1)


def thunder(dur, seed=7):
    rng = np.random.default_rng(seed)
    t = t_axis(dur)
    crack = bandpass(rng.standard_normal(len(t)), 800, 6000) * np.exp(-t / 0.08)
    rumble = lowpass(rng.standard_normal(len(t)), 180, 4) * 6
    rumble *= (np.clip(t / 0.05, 0, 1) * np.exp(-t / 0.9)) * (1 + 0.5 * np.sin(2 * np.pi * 2.3 * t) ** 2)
    return crack + rumble


def theremin(f0, f1, dur):  # ghostly "ooo-OOO" wail
    t = t_axis(dur)
    glide = f0 + (f1 - f0) * np.sin(np.pi * t / dur * 0.85)
    f = glide * (1 + 0.025 * np.sin(2 * np.pi * 5.5 * t))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.2 * np.sin(4 * np.pi * np.cumsum(f) / SR)
    return x * adsr(len(t), 0.15, 0.1, 0.85, 0.3)


def spooky_sting(event):
    n = lambda m: 440 * 2 ** ((m - 69) / 12)
    if event == "start":  # organ mordent + D-minor chord ("dun-dun-dunnn")
        parts = [(0.00, organ(n(81), 0.12)), (0.12, organ(n(79), 0.12)), (0.24, organ(n(81), 0.5))]
        parts += [(0.85, organ(n(m), 1.1) * .7) for m in (50, 62, 65, 69)]
        return norm(place(parts))
    if event in ("five", "two"):  # two tolls of a deep bell
        return norm(place([(0, toll(n(57), 1.6)), (0.8, toll(n(57), 1.6))], 2.0))
    if event == "end":  # thunderclap under a low organ chord
        return norm(place([(0, thunder(2.0))] + [(0.15, organ(n(m), 1.3) * .35) for m in (38, 50, 53, 57)]))
    if event == "halftime":  # ghost wail
        return norm(place([(0, theremin(n(64), n(76), 1.4))]), 0.8)
    if event == "halftime_over":  # rising organ arpeggio
        return norm(place([(i * 0.16, organ(n(m), 0.5 if i < 3 else 0.8)) for i, m in enumerate([62, 65, 69, 74])]))
    if event == "test":
        return norm(place([(0, theremin(n(69), n(74), 0.9))]), 0.8)
    raise ValueError(event)

# ---------------------------------------------------------------- voice

def decode(path):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def trim(x, thr=0.02):
    idx = np.where(np.abs(x) > thr * np.max(np.abs(x)))[0]
    return x[max(0, idx[0] - int(0.02 * SR)): idx[-1] + int(0.1 * SR)]


def tts(kokoro, text):
    a, sr = kokoro.create(text, voice=VOICE, speed=SPEED, lang="en-us")
    return resample_poly(np.asarray(a, dtype=np.float64), SR, sr)


def master(x, out_mp3):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    af = ("highpass=f=90,acompressor=threshold=-20dB:ratio=3:attack=5:release=90:makeup=2,"
          "loudnorm=I=-11:TP=-1.0:LRA=8,alimiter=limit=0.89:level=false")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-",
                    "-af", af, "-ar", str(SR), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", str(out_mp3)],
                   input=pcm, check=True)


# ---------------------------------------------------------------- main

def main():
    kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
    sets = {  # name inside jingles.js -> (lines, test line, sting maker)
        "voice": (LINES, TEST_LINE, sting),
        "halloween": (HALLOWEEN_LINES, HALLOWEEN_TEST, spooky_sting),
    }
    bundle = {"voices": {}, "text": {}, "duration": {}}
    for name, (lines, test_line, make_sting) in sets.items():
        jobs = []  # (key, text, event)
        for ev, line in lines.items():
            for fk, fname in FIELDS.items():
                jobs.append((f"{ev}_{fk}", line.replace("{f}", fname).replace("{F}", fname[0].upper() + fname[1:]), ev))
        jobs.append(("test", test_line, "test"))
        stings = {ev: make_sting(ev) for ev in set(j[2] for j in jobs)}
        for k in bundle:
            bundle[k][name] = {}
        (OUT / name).mkdir(parents=True, exist_ok=True)
        for key, text, ev in jobs:
            v = norm(trim(tts(kokoro, text)), 0.9)
            s = stings[ev] * (0.7 if ev == "end" else 0.85)
            clip = place([(0, s), (len(s) / SR + 0.12, v)])
            clip = np.concatenate([np.zeros(int(0.05 * SR)), clip, np.zeros(int(0.25 * SR))])
            mp3 = OUT / name / f"{key}.mp3"
            master(clip, mp3)
            bundle["voices"][name][key] = "data:audio/mpeg;base64," + base64.b64encode(mp3.read_bytes()).decode()
            bundle["text"][name][key] = text
            bundle["duration"][name][key] = round(len(clip) / SR, 2)
            print(f"{name:9s} {key:18s} {len(clip) / SR:5.2f}s  {text}")

    js = "// Generated by tools/generate_jingles.py - do not edit by hand.\nwindow.JINGLES = " + json.dumps(bundle) + ";\n"
    (OUT / "jingles.js").write_text(js, encoding="utf-8")
    print("wrote", OUT / "jingles.js", f"{len(js) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
