"""Bundle the ROW Haus build into one self-contained HTML file.

Everything is inlined: both stylesheets, Lenis, the sequence engine, the boot
layer, and every JPEG frame found on disk as a base64 data URI. Every
substitution is asserted, and the result is scanned for surviving external
references, so a silent miss can't ship a file that half-loads.

The frame set is discovered at runtime (never hardcoded) and validated to be a
contiguous 1..N run, so a regenerated sequence of any length is picked up whole
instead of being silently truncated.
"""
import base64, glob, io, os, re

SRC = r'C:\Users\user\OneDrive\Desktop\CC-Folder\websites\projects\row-haus'
OUT = r'C:\Users\user\OneDrive\Desktop\user interface\rowing.html'

# Asset URLs carry a cache-busting query in index.html. Keep it in one place so
# bumping the version doesn't silently break every substitution below.
V = '?v=3'

def read(*p):
    return io.open(os.path.join(SRC, *p), encoding='utf-8').read()

def sub(text, old, new, what):
    assert old in text, 'not found: ' + what
    return text.replace(old, new, 1)

html = read('index.html')

# ---- stylesheets -------------------------------------------------------
css = ('/* ===== css/styles.css ===== */\n' + read('css', 'styles.css') +
       '\n/* ===== css/sections.css ===== */\n' + read('css', 'sections.css'))
html = sub(html,
    '<link rel="stylesheet" href="css/styles.css%s">\n'
    '<link rel="stylesheet" href="css/sections.css%s">' % (V, V),
    '<style>\n' + css + '\n</style>', 'stylesheet links')

# ---- frames ------------------------------------------------------------
# Discovered from disk, never hardcoded: the sequence gets regenerated at
# different lengths and a stale count would silently drop the tail.
FRAME_RE = re.compile(r'^ezgif-frame-(\d+)\.jpg$')

def frame_index(path):
    """Sort key: the numeric index, so frame-9 precedes frame-10 regardless of
    zero-padding (lexicographic order would scramble the animation)."""
    m = FRAME_RE.match(os.path.basename(path))
    assert m, 'unparsable frame name: ' + path
    return int(m.group(1))

paths = [p for p in glob.glob(os.path.join(SRC, 'frames', 'ezgif-frame-*.jpg'))
         if FRAME_RE.match(os.path.basename(p))]
paths.sort(key=frame_index)            # ascending == animation order

indices = [frame_index(p) for p in paths]
assert len(paths) >= 2, 'need at least 2 frames, found %d in %s' % (
    len(paths), os.path.join(SRC, 'frames'))
assert indices == list(range(1, len(indices) + 1)), (
    'frame indices are not a contiguous 1..%d run (gaps or duplicates): %r'
    % (len(indices), indices))

# The browser can't enumerate a directory, so js/main.js has to pin the count
# when it constructs the sequence. That's the one place still coupled to the
# frame set — if the sequence is regenerated at a new length, main.js would keep
# addressing frames that don't exist. Catch the mismatch here rather than
# shipping a broken bundle.
_main_probe = read('js', 'main.js')
_m = re.search(r'frameCount\s*:\s*(\d+)', _main_probe)
assert _m, 'frameCount not found in js/main.js'
assert int(_m.group(1)) == len(paths), (
    'js/main.js declares frameCount = %s but frames/ holds %d frames — '
    'update the constant to match before bundling'
    % (_m.group(1), len(paths)))

uris = []
for p in paths:
    with open(p, 'rb') as f:
        data = f.read()
    # a half-written frame encodes to an empty data URI, which renders nothing
    # and would slip past every check downstream
    assert data, 'empty frame file: ' + p
    uris.append('data:image/jpeg;base64,' + base64.b64encode(data).decode('ascii'))
frames_js = 'window.__ROWHAUS_FRAMES=[\n' + ',\n'.join('"%s"' % u for u in uris) + '\n];'

# ---- js ----------------------------------------------------------------
# sequence.js's default pathFn takes a *1-based* frame number, while the
# embedded array is a plain 0-based JS array of every file in ascending order —
# without the `- 1` every frame is off by one and frame 1 comes back undefined.
SEQ_EMBEDDED = (
    "      return 'frames/ezgif-frame-' + String(i).padStart(3, '0') + '.jpg';")

seq = read('js', 'sequence.js')
seq = sub(seq, SEQ_EMBEDDED,
          '      return (window.__ROWHAUS_FRAMES || [])[i - 1];  // single-file build',
          'sequence.js default pathFn')

html = sub(html,
    '<script src="lib/lenis.min.js"></script>\n'
    '<script src="js/sequence.js%s"></script>\n'
    '<script src="js/main.js%s"></script>' % (V, V),
    '<script>' + frames_js + '</script>\n'
    '<script>' + read('lib', 'lenis.min.js') + '</script>\n'
    '<script>' + seq + '</script>\n'
    '<script>' + read('js', 'main.js') + '</script>', 'script tags')

# ---- guard -------------------------------------------------------------
left = [m.group(0).strip() for m in re.finditer(
    r'.{0,70}(href="css/|src="js/|src="lib/|frames/ezgif-frame-).{0,70}', html)]
assert not left, 'external refs remain:\n' + '\n'.join('  ' + repr(x) for x in left[:10])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
io.open(OUT, 'w', encoding='utf-8').write(html)
print('wrote %s\n%.2f MB, %d frames embedded' % (OUT, os.path.getsize(OUT) / 1e6, len(uris)))
