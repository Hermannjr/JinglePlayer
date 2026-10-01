"""Generate all JinglePlayer announcement clips.

Each clip = synthesized sting (fanfare / chime / air horn / whistle) + TTS voice line,
compressed and loudness-normalised hot (-11 LUFS) so it cuts through background music.

Two announcer sets are produced:
  grandpa - en-GB-ThomasNeural, slowed down, with a shaky "old man" tremor
  clear   - en-US-GuyNeural, plain and crisp

Output:
  app/audio/<voice>/<event>_<field>.mp3   (individual files, handy for checking)
  app/audio/jingles.js                    (everything base64-inlined, loaded by the app)

Usage:  pip install -r tools/requirements.txt && python tools/generate_jingles.py
Edit LINES below to change the wording, then re-run.
"""
import asyncio, base64, json, subprocess, sys
from pathlib import Path

import edge_tts
import imageio_ffmpeg
import numpy as np
from scipy.signal import butter, sosfilt

SR = 44100
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "audio"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

FIELDS = {"1": "field one", "2": "field two", "3": "field three", "4": "field four", "all": "all fields"}

# {f} = "field one" / "all fields", {F} = capitalised
LINES = {
    "grandpa": {
        "start": "Attention, {f}! Time is running. Pull when ready... and have fun out there, youngsters!",
        "five": "Five minutes left on {f}! Five more minutes... then you can rest those knees.",
        "halftime": "Halftime on {f}! Finish the point in play, then take your two minutes. Catch your breath!",
        "halftime_over": "{F}, halftime is over! Up you get, everybody back on the line.",
        "end": "Time is up on {f}! That's the cap. Finish the point in play... and don't forget your spirit circle.",
    },
    "clear": {
        "start": "Attention, {f}! Time is running. Pull when ready, and have fun!",
        "five": "Five minutes left on {f}! Five minutes to go.",
        "halftime": "Halftime on {f}! Finish the point in play, then take your two-minute break.",
        "halftime_over": "{F}, halftime is over! Everybody back on the line.",
        "end": "Time is up on {f}! That's the cap. Finish the point in play, and don't forget your spirit circle.",
    },
}
TEST_LINE = {
    "grandpa": "Testing, testing... one, two. Is this thing on? Ah, there we go. The Disc Fiction jingle player is ready!",
    "clear": "Testing, one, two. The Disc Fiction jingle player is ready!",
}
VOICES = {
    "grandpa": dict(voice="en-GB-ThomasNeural", rate="-12%", pitch="-4Hz"),
    "clear": dict(voice="en-US-GuyNeural", rate="+0%", pitch="+0Hz"),
}

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
    if event == "five":  # attention chime C5 E5 G5 C6
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

# ---------------------------------------------------------------- voice

def decode(path):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def trim(x, thr=0.02):
    idx = np.where(np.abs(x) > thr * np.max(np.abs(x)))[0]
    return x[max(0, idx[0] - int(0.02 * SR)): idx[-1] + int(0.1 * SR)]


def old_man(x, seed=0):
    """Shaky elderly voice: slow wobbling pitch (variable delay) + amplitude tremor."""
    rng = np.random.default_rng(seed)
    t = np.arange(len(x)) / SR
    rate = 5.3 + 0.4 * np.sin(2 * np.pi * 0.31 * t + rng.uniform(0, 6))
    wob = np.sin(2 * np.pi * np.cumsum(rate) / SR)
    depth = 0.00055 * (1 + 0.35 * np.sin(2 * np.pi * 0.7 * t))
    d = 0.002 + depth * wob  # seconds
    src = np.clip(np.arange(len(x)) - d * SR, 0, len(x) - 1)
    y = np.interp(src, np.arange(len(x)), x)
    y *= 1 - 0.12 * (0.5 + 0.5 * wob)
    # a touch of warmth: gentle high cut
    return lowpass(y, 7000, 1)


async def tts(text, cfg, path):
    await edge_tts.Communicate(text, cfg["voice"], rate=cfg["rate"], pitch=cfg["pitch"]).save(str(path))


def master(x, out_mp3):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    af = ("highpass=f=90,acompressor=threshold=-20dB:ratio=3:attack=5:release=90:makeup=2,"
          "loudnorm=I=-11:TP=-1.0:LRA=8,alimiter=limit=0.94:level=false")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-",
                    "-af", af, "-ar", str(SR), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", str(out_mp3)],
                   input=pcm, check=True)


# ---------------------------------------------------------------- main

async def main():
    tmp = OUT / "_tts"
    tmp.mkdir(parents=True, exist_ok=True)
    jobs = []  # (voice_set, key, text, event)
    for vs in VOICES:
        for ev, line in LINES[vs].items():
            for fk, fname in FIELDS.items():
                text = line.replace("{f}", fname).replace("{F}", fname[0].upper() + fname[1:])
                jobs.append((vs, f"{ev}_{fk}", text, ev))
        jobs.append((vs, "test", TEST_LINE[vs], "test"))

    sem = asyncio.Semaphore(6)

    async def run(job):
        vs, key, text, _ = job
        p = tmp / f"{vs}_{key}.mp3"
        async with sem:
            for attempt in range(4):
                try:
                    await tts(text, VOICES[vs], p)
                    return
                except Exception as e:  # network hiccups
                    print("retry", key, e, file=sys.stderr)
                    await asyncio.sleep(1 + attempt)
            raise RuntimeError(f"TTS failed for {vs}/{key}")

    await asyncio.gather(*(run(j) for j in jobs))

    stings = {ev: sting(ev) for ev in ["start", "five", "end", "halftime", "halftime_over", "test"]}
    bundle = {"voices": {}, "text": {}, "duration": {}}
    for i, (vs, key, text, ev) in enumerate(jobs):
        v = trim(decode(tmp / f"{vs}_{key}.mp3"))
        if vs == "grandpa":
            v = old_man(v, seed=i)
        v = norm(v, 0.9)
        s = stings[ev] * (0.7 if ev in ("end",) else 0.85)
        clip = place([(0, s), (len(s) / SR + 0.12, v)])
        clip = np.concatenate([np.zeros(int(0.05 * SR)), clip, np.zeros(int(0.25 * SR))])
        (OUT / vs).mkdir(exist_ok=True)
        mp3 = OUT / vs / f"{key}.mp3"
        master(clip, mp3)
        bundle["voices"].setdefault(vs, {})[key] = "data:audio/mpeg;base64," + base64.b64encode(mp3.read_bytes()).decode()
        bundle["text"].setdefault(vs, {})[key] = text
        bundle["duration"].setdefault(vs, {})[key] = round(len(clip) / SR, 2)
        print(f"{vs:8s} {key:18s} {len(clip) / SR:5.2f}s  {text}")

    js = "// Generated by tools/generate_jingles.py - do not edit by hand.\nwindow.JINGLES = " + json.dumps(bundle) + ";\n"
    (OUT / "jingles.js").write_text(js, encoding="utf-8")
    for f in tmp.iterdir():
        f.unlink()
    tmp.rmdir()
    print("wrote", OUT / "jingles.js", f"{len(js) / 1e6:.1f} MB")


if __name__ == "__main__":
    asyncio.run(main())
