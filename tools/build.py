"""Build the distributable versions of the app.

  dist/JinglePlayer.html  ONE self-contained file (styles, scripts, fonts, artwork, audio inlined).
                          Copy it to a laptop and double-click it. No internet needed.
  dist/site/              The same page as index.html, plus the web-app manifest, icons and
                          offline service worker. This is what GitHub Pages serves.

Usage:  python tools/build.py
"""
import base64, hashlib, mimetypes, re, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
DIST = ROOT / "dist"
OUT = DIST / "JinglePlayer.html"
SITE = DIST / "site"
SITE_FILES = ["manifest.webmanifest", "img/icon-180.png", "img/icon-192.png", "img/icon-512.png"]
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

DIST.mkdir(exist_ok=True)
OUT.write_text(html, encoding="utf-8")
# JS-built src="' + x + '" and the manifest (only used when hosted) are fine
left = re.findall(r"""(?:src|href)="(?!data:|#|https?:|'|manifest\.webmanifest)[^"]+\"""", html)
print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB); unresolved refs: {left or 'none'}")

# hosted version
shutil.rmtree(SITE, ignore_errors=True)
(SITE / "img").mkdir(parents=True)
(SITE / "index.html").write_text(html, encoding="utf-8")
for f in SITE_FILES:
    shutil.copy(APP / f, SITE / f)
build = hashlib.sha256(html.encode()).hexdigest()[:12]
sw = (APP / "sw.js").read_text(encoding="utf-8").replace('var BUILD = "dev";', f'var BUILD = "{build}";')
(SITE / "sw.js").write_text(sw, encoding="utf-8")
(SITE / ".nojekyll").write_text("")
print(f"wrote {SITE} (build {build})")
