"""Make the Halloween character art from the existing club artwork with an image-editing model.

Each source sticker is sent to Gemini 3 Pro Image (via OpenRouter) with a costume prompt and
comes back on a flat magenta background, which is keyed out to a transparent sticker.

  OPENROUTER_API_KEY=... python tools/halloween_art.py            # all pieces
  OPENROUTER_API_KEY=... python tools/halloween_art.py vampire    # just one

Raw model output: tools/art-raw/ (git-ignored). Final stickers: app/img/halloween/*.webp
"""
import base64, io, os, sys
from pathlib import Path

import numpy as np
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "app" / "img"
OUT = IMG / "halloween"
RAW = ROOT / "tools" / "art-raw"
MODEL = "google/gemini-3-pro-image"

STYLE = ("Keep the exact same flat cartoon sticker style as the input: identical thick black outlines, flat colours, "
         "the same white sticker border around the whole figure, the same proportions, face and pose. "
         "Do not add text. Do not add a drop shadow. Place the sticker on a plain, perfectly flat solid magenta "
         "(#FF00FF) background that fills the whole image.")

PIECES = {
    "vampire": ("img/sp/jthrow_g.webp",
                "Dress this character up as a classic vampire for Halloween: keep his big afro, beard and lime-green suit, "
                "add a black high-collared vampire cape with a deep red lining flowing behind him, and two small white fangs "
                "in his open mouth."),
    "ghost": ("img/vwalk_a_g.webp",
              "Dress this character up as a ghost for Halloween: a white bedsheet ghost costume draped over his body like a "
              "poncho with a wavy hem, his face and his black slicked hairstyle still visible above it, his lime-green "
              "trousers and black shoes visible below the sheet. Keep him holding the white disc."),
    "ghost_dive": ("img/vlay_b_o.webp",
                   "Dress this diving character up as a ghost for Halloween: replace the orange suit with a flowing white "
                   "bedsheet ghost costume trailing behind him with a wavy, tattered tail, keep his face, hairstyle and white "
                   "gloves, keep the diving pose."),
    "head_vampire": ("img/head_jules.webp",
                     "Turn this head into a vampire: keep the afro, beard and expression, add a black high vampire cape collar "
                     "with red lining behind the head and two small white fangs."),
    "head_ghost": ("img/head_vincent.webp",
                   "Turn this head into a ghost costume: a white bedsheet hood draped around the face like a ghost, the face "
                   "and black hair fringe still visible, wavy sheet edges below the chin."),
    "logo": ("img/logo.webp",
             "Make a Halloween edition of this logo. Keep every letter of the text DISC FICTION and ULTIMATE exactly as it "
             "is, in the same position and lettering style. Change the lime-green colour of the word DISC to pumpkin orange "
             "with a subtle dripping edge. The afro character wears a black vampire cape with red lining and has small fangs; "
             "the other character wears a white ghost bedsheet hood. Add two small black bats near the disc."),
}

# where the original art lives (sprites from the explainer source aren't all in app/img)
SRC_DIRS = [IMG, ROOT / "tools" / "art-src"]


def find_src(rel):
    for d in SRC_DIRS:
        p = d / Path(rel).name
        if p.exists():
            return p
    raise FileNotFoundError(rel)


def generate(name, src_rel, prompt):
    src = find_src(src_rel)
    png = io.BytesIO()
    Image.open(src).convert("RGBA").save(png, "PNG")
    data_url = "data:image/png;base64," + base64.b64encode(png.getvalue()).decode()
    r = requests.post("https://openrouter.ai/api/v1/chat/completions", timeout=300, headers={
        "Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"],
        "HTTP-Referer": "https://hermannjr.github.io/JinglePlayer/", "X-Title": "Disc Fiction Jingle Player"},
        json={"model": MODEL, "modalities": ["image", "text"], "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": data_url}},
            {"type": "text", "text": prompt + " " + STYLE}]}]})
    r.raise_for_status()
    msg = r.json()["choices"][0]["message"]
    imgs = msg.get("images") or []
    if not imgs:
        raise RuntimeError(f"{name}: no image returned: {msg.get('content')!r}")
    raw = base64.b64decode(imgs[0]["image_url"]["url"].split(",", 1)[1])
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / f"{name}.png").write_bytes(raw)
    return Image.open(io.BytesIO(raw)).convert("RGB")


def key_out(img, max_side=900):
    """Magenta background -> transparency, with a soft edge, then trim and downscale."""
    a = np.asarray(img).astype(np.float32)
    corners = np.concatenate([a[:8, :8].reshape(-1, 3), a[:8, -8:].reshape(-1, 3), a[-8:, :8].reshape(-1, 3), a[-8:, -8:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    dist = np.sqrt(((a - bg) ** 2).sum(-1))
    alpha = np.clip((dist - 40) / 60, 0, 1)
    # remove magenta spill on the soft edge
    rgb = a.copy()
    spill = np.minimum(rgb[..., 0], rgb[..., 2]) - rgb[..., 1]
    edge = (alpha < 1) & (spill > 0)
    rgb[edge, 0] -= spill[edge] * (1 - alpha[edge])
    rgb[edge, 2] -= spill[edge] * (1 - alpha[edge])
    out = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), alpha * 255]).astype(np.uint8), "RGBA")
    out = out.crop(out.getbbox())
    out.thumbnail((max_side, max_side), Image.LANCZOS)
    return out


def main():
    names = sys.argv[1:] or list(PIECES)
    OUT.mkdir(parents=True, exist_ok=True)
    for n in names:
        src, prompt = PIECES[n]
        raw_path = RAW / f"{n}.png"
        img = Image.open(raw_path).convert("RGB") if os.environ.get("REUSE_RAW") and raw_path.exists() else generate(n, src, prompt)
        st = key_out(img, 1200 if n == "logo" else 900)
        st.save(OUT / f"{n}.webp", "WEBP", quality=88, method=6)
        print(f"{n:14s} -> app/img/halloween/{n}.webp {st.size}")


if __name__ == "__main__":
    main()
