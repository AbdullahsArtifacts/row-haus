"""Bundle the ROW Haus build into one self-contained HTML file.

Everything is inlined: both stylesheets, Lenis, the sequence engine, the boot
layer, and every WebP frame found on disk as a base64 data URI. Every
substitution is asserted, and the result is scanned for surviving external
references, so a silent miss can't ship a file that half-loads.

The frame set is discovered at runtime (never hardcoded) and validated to be a
contiguous 1..N run, so a regenerated sequence of any length is picked up whole
instead of being silently truncated.
"""
import base64, glob, io, os, re

SRC = r'C:\Users\user\OneDrive\Desktop\CC-Folder\websites\projects\row-haus'
OUT = r'C:\Users\user\OneDrive\Desktop\user interface\rowing.html'

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
    '<link rel="stylesheet" href="css/styles.css">\n<link rel="stylesheet" href="css/sections.css">',
    '<style>\n' + css + '\n</style>', 'stylesheet links')

# a preload hint for a URL that no longer exists is dead weight
html = sub(html, '<link rel="preload" as="image" href="frames/frame-001.webp">\n', '', 'preload hint')

# ---- frames ------------------------------------------------------------
# Discovered from disk, never hardcoded: the sequence gets regenerated at
# different lengths and a stale count would silently drop the tail.
FRAME_RE = re.compile(r'^frame-(\d+)\.webp$')

def frame_index(path):
    """Sort key: the numeric index, so frame-9 precedes frame-10 regardless of
    zero-padding (lexicographic order would scramble the animation)."""
    m = FRAME_RE.match(os.path.basename(path))
    assert m, 'unparsable frame name: ' + path
    return int(m.group(1))

paths = [p for p in glob.glob(os.path.join(SRC, 'frames', 'frame-*.webp'))
         if FRAME_RE.match(os.path.basename(p))]
paths.sort(key=frame_index)            # ascending == animation order

indices = [frame_index(p) for p in paths]
assert len(paths) >= 2, 'need at least 2 frames, found %d in %s' % (
    len(paths), os.path.join(SRC, 'frames'))
assert indices == list(range(1, len(indices) + 1)), (
    'frame indices are not a contiguous 1..%d run (gaps or duplicates): %r'
    % (len(indices), indices))

# The browser can't enumerate a directory, so js/main.js has to pin the count in
# a constant. That makes it the one place still coupled to the frame set — if the
# sequence is regenerated at a new length, main.js would keep indexing as though
# it were the old one. Catch the mismatch here rather than shipping a build that
# addresses frames that don't exist.
_main_probe = read('js', 'main.js')
_m = re.search(r'var FRAME_COUNT_FULL\s*=\s*(\d+)\s*;', _main_probe)
assert _m, 'FRAME_COUNT_FULL not found in js/main.js'
assert int(_m.group(1)) == len(paths), (
    'js/main.js declares FRAME_COUNT_FULL = %s but frames/ holds %d frames — '
    'update the constant to match before bundling'
    % (_m.group(1), len(paths)))

uris = []
for p in paths:
    with open(p, 'rb') as f:
        data = f.read()
    # a half-written frame encodes to an empty data URI, which renders nothing
    # and would slip past every check downstream
    assert data, 'empty frame file: ' + p
    uris.append('data:image/webp;base64,' + base64.b64encode(data).decode('ascii'))
frames_js = 'window.__ROWHAUS_FRAMES=[\n' + ',\n'.join('"%s"' % u for u in uris) + '\n];'

# ---- js ----------------------------------------------------------------
# sequence.js's defaultGetSrc is indexed straight off the sequence position.
SEQ_EMBEDDED = "'frames/frame-' + String(i + 1).padStart(3, '0') + '.webp'"
# main.js's frameSrc goes through frameFileIndex(), which returns a *1-based
# file number* (narrow viewports walk a strided subset of the full set). The
# embedded array is a plain 0-based JS array of every file in ascending order,
# so the file number has to be decremented -- without the `- 1` every frame is
# off by one and frame 1 comes back undefined.
MAIN_EMBEDDED = "'frames/frame-' + String(frameFileIndex(i)).padStart(3, '0') + '.webp'"

seq = read('js', 'sequence.js')
seq = sub(seq, 'return ' + SEQ_EMBEDDED + ';',
          'return (global.__ROWHAUS_FRAMES || [])[i];  // single-file build', 'sequence.js defaultGetSrc')

main = read('js', 'main.js')
main = sub(main, 'return ' + MAIN_EMBEDDED + ';',
           'return window.__ROWHAUS_FRAMES[frameFileIndex(i) - 1];  // single-file build',
           'main.js frameSrc')

html = sub(html,
    '<script src="lib/lenis.min.js"></script>\n'
    '  <script src="js/sequence.js"></script>\n'
    '  <script src="js/main.js"></script>',
    '<script>' + frames_js + '</script>\n'
    '  <script>' + read('lib', 'lenis.min.js') + '</script>\n'
    '  <script>' + seq + '</script>\n'
    '  <script>' + main + '</script>', 'script tags')

# ---- guard -------------------------------------------------------------
left = [m.group(0).strip() for m in re.finditer(r'.{0,70}(href="css/|src="js/|src="lib/|frames/frame-).{0,70}', html)]
assert not left, 'external refs remain:\n' + '\n'.join('  ' + repr(x) for x in left[:10])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
io.open(OUT, 'w', encoding='utf-8').write(html)
print('wrote %s\n%.2f MB, %d frames embedded' % (OUT, os.path.getsize(OUT) / 1e6, len(uris)))
