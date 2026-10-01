"""Bundle app/ into ONE self-contained file: dist/JinglePlayer.html

Everything (styles, scripts, fonts, artwork, audio) is inlined, so organisers only need
to copy a single file to the laptop and double-click it. No internet needed.

Usage:  python tools/build.py
"""
import base64, mimetypes, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
OUT = ROOT / "dist" / "JinglePlayer.html"
MIME = {".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".woff2": "font/woff2"}


def data_uri(rel):
    p = APP / rel
    return f"data:{MIME.get(p.suffix) or mimetypes.guess_type(p.name)[0]};base64," + base64.b64encode(p.read_bytes()).decode()


def inline_assets(text):
    return re.sub(r"(?:img|fonts)/[\w.-]+\.(?:webp|jpg|png|woff2)", lambda m: data_uri(m.group(0)), text)


html = (APP / "index.html").read_text(encoding="utf-8")
css = (APP / "styles.css").read_text(encoding="utf-8")
html = html.replace('<link rel="stylesheet" href="styles.css">', "<style>\n" + css + "\n</style>")
for src in re.findall(r'<script src="([^"]+)"></script>', html):
    js = (APP / src).read_text(encoding="utf-8")
    assert "</script" not in js, src
    html = html.replace(f'<script src="{src}"></script>', "<script>\n" + js + "\n</script>")
html = inline_assets(html)

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(html, encoding="utf-8")
left = re.findall(r"""(?:src|href)="(?!data:|#|https?:|')[^"]+\"""", html)  # JS-built src="' + x + '" are fine
print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB); unresolved refs: {left or 'none'}")
