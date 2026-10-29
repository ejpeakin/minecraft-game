# Builds fonts/blockcraft.ttf, the game's blocky pixel font, from the glyph drawings
# below. Each glyph is drawn on a pixel grid: rows 0-6 sit on the baseline (capitals
# are 7 pixels tall) and row 7 is for descenders. Every glyph advances by its width
# plus one pixel of spacing.
#
# Needs fontTools:  pip install fonttools  then  python3 scripts/build-font.py
#
# The font has 8 pixels per em, so it's sharpest at font sizes that are multiples of
# 8px (16px is "GUI scale 2", 24px is "GUI scale 3").

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

PX = 128  # font units per pixel
EM = 8 * PX
ASCENT = 8 * PX  # 7 pixels of capitals plus 1 of headroom
DESCENT = 1 * PX

GLYPHS = {
    'A': """
.###.
#...#
#...#
#####
#...#
#...#
#...#""",
    'B': """
####.
#...#
####.
#...#
#...#
#...#
####.""",
    'C': """
.###.
#...#
#....
#....
#....
#...#
.###.""",
    'D': """
####.
#...#
#...#
#...#
#...#
#...#
####.""",
    'E': """
#####
#....
###..
#....
#....
#....
#####""",
    'F': """
#####
#....
###..
#....
#....
#....
#....""",
    'G': """
.####
#....
#.###
#...#
#...#
#...#
.###.""",
    'H': """
#...#
#...#
#####
#...#
#...#
#...#
#...#""",
    'I': """
###
.#.
.#.
.#.
.#.
.#.
###""",
    'J': """
....#
....#
....#
....#
....#
#...#
.###.""",
    'K': """
#...#
#..#.
###..
#..#.
#...#
#...#
#...#""",
    'L': """
#....
#....
#....
#....
#....
#....
#####""",
    'M': """
#...#
##.##
#.#.#
#...#
#...#
#...#
#...#""",
    'N': """
#...#
##..#
#.#.#
#..##
#...#
#...#
#...#""",
    'O': """
.###.
#...#
#...#
#...#
#...#
#...#
.###.""",
    'P': """
####.
#...#
####.
#....
#....
#....
#....""",
    'Q': """
.###.
#...#
#...#
#...#
#...#
#..#.
.##.#""",
    'R': """
####.
#...#
####.
#...#
#...#
#...#
#...#""",
    'S': """
.####
#....
.###.
....#
....#
#...#
.###.""",
    'T': """
#####
..#..
..#..
..#..
..#..
..#..
..#..""",
    'U': """
#...#
#...#
#...#
#...#
#...#
#...#
.###.""",
    'V': """
#...#
#...#
#...#
#...#
#...#
.#.#.
..#..""",
    'W': """
#...#
#...#
#...#
#...#
#.#.#
##.##
#...#""",
    'X': """
#...#
#...#
.#.#.
..#..
.#.#.
#...#
#...#""",
    'Y': """
#...#
.#.#.
..#..
..#..
..#..
..#..
..#..""",
    'Z': """
#####
....#
...#.
..#..
.#...
#....
#####""",
    'a': """
.....
.....
.###.
....#
.####
#...#
.####""",
    'b': """
#....
#....
#.##.
##..#
#...#
#...#
####.""",
    'c': """
.....
.....
.###.
#...#
#....
#...#
.###.""",
    'd': """
....#
....#
.##.#
#..##
#...#
#...#
.####""",
    'e': """
.....
.....
.###.
#...#
#####
#....
.####""",
    'f': """
..##
.#..
####
.#..
.#..
.#..
.#..""",
    'g': """
.....
.....
.####
#...#
#...#
.####
....#
####.""",
    'h': """
#....
#....
#.##.
##..#
#...#
#...#
#...#""",
    'i': """
#
.
#
#
#
#
#""",
    'j': """
...#
....
...#
...#
...#
...#
#..#
.##.""",
    'k': """
#...
#...
#..#
#.#.
##..
#.#.
#..#""",
    'l': """
#.
#.
#.
#.
#.
#.
.#""",
    'm': """
.....
.....
##.#.
#.#.#
#.#.#
#...#
#...#""",
    'n': """
.....
.....
####.
#...#
#...#
#...#
#...#""",
    'o': """
.....
.....
.###.
#...#
#...#
#...#
.###.""",
    'p': """
.....
.....
#.##.
##..#
#...#
####.
#....
#....""",
    'q': """
.....
.....
.##.#
#..##
#...#
.####
....#
....#""",
    'r': """
.....
.....
#.##.
##..#
#....
#....
#....""",
    's': """
.....
.....
.####
#....
.###.
....#
####.""",
    't': """
.#.
.#.
###
.#.
.#.
.#.
..#""",
    'u': """
.....
.....
#...#
#...#
#...#
#...#
.####""",
    'v': """
.....
.....
#...#
#...#
#...#
.#.#.
..#..""",
    'w': """
.....
.....
#...#
#...#
#.#.#
#.#.#
.####""",
    'x': """
.....
.....
#...#
.#.#.
..#..
.#.#.
#...#""",
    'y': """
.....
.....
#...#
#...#
#...#
.####
....#
####.""",
    'z': """
.....
.....
#####
...#.
..#..
.#...
#####""",
    '0': """
.###.
#...#
#..##
#.#.#
##..#
#...#
.###.""",
    '1': """
..#..
.##..
..#..
..#..
..#..
..#..
#####""",
    '2': """
.###.
#...#
....#
..##.
.#...
#....
#####""",
    '3': """
.###.
#...#
....#
..##.
....#
#...#
.###.""",
    '4': """
...##
..#.#
.#..#
#...#
#####
....#
....#""",
    '5': """
#####
#....
####.
....#
....#
#...#
.###.""",
    '6': """
..##.
.#...
#....
####.
#...#
#...#
.###.""",
    '7': """
#####
#...#
....#
...#.
..#..
..#..
..#..""",
    '8': """
.###.
#...#
#...#
.###.
#...#
#...#
.###.""",
    '9': """
.###.
#...#
#...#
.####
....#
...#.
.##..""",
    '!': """
#
#
#
#
#
.
#""",
    '"': """
#.#
#.#""",
    '#': """
.#.#.
.#.#.
#####
.#.#.
#####
.#.#.
.#.#.""",
    '$': """
..#..
.####
#....
.###.
....#
####.
..#..""",
    '%': """
##..#
##..#
...#.
..#..
.#...
#..##
#..##""",
    '&': """
..#..
.#.#.
..#..
.##.#
#..#.
#..#.
.##.#""",
    "'": """
#
#""",
    '(': """
..#
.#.
#..
#..
#..
.#.
..#""",
    ')': """
#..
.#.
..#
..#
..#
.#.
#..""",
    '*': """
.....
..#..
#.#.#
.###.
#.#.#
..#..""",
    '+': """
.....
..#..
..#..
#####
..#..
..#..""",
    ',': """
.
.
.
.
.
.
#
#""",
    '-': """
.....
.....
.....
#####""",
    '.': """
.
.
.
.
.
.
#""",
    '/': """
....#
...#.
...#.
..#..
.#...
.#...
#....""",
    ':': """
.
.
#
.
.
.
#""",
    ';': """
.
.
#
.
.
.
#
#""",
    '<': """
...#
..#.
.#..
#...
.#..
..#.
...#""",
    '=': """
.....
.....
#####
.....
#####""",
    '>': """
#...
.#..
..#.
...#
..#.
.#..
#...""",
    '?': """
.###.
#...#
....#
...#.
..#..
.....
..#..""",
    '@': """
.####.
#....#
#.##.#
#.##.#
#.####
#.....
.####.""",
    '[': """
###
#..
#..
#..
#..
#..
###""",
    '\\': """
#....
.#...
.#...
..#..
...#.
...#.
....#""",
    ']': """
###
..#
..#
..#
..#
..#
###""",
    '^': """
..#..
.#.#.
#...#""",
    '_': """
.....
.....
.....
.....
.....
.....
.....
#####""",
    '`': """
#.
.#""",
    '{': """
..##
.#..
.#..
#...
.#..
.#..
..##""",
    '|': """
#
#
#
#
#
#
#
#""",
    '}': """
##..
..#.
..#.
...#
..#.
..#.
##..""",
    '~': """
......
......
.##..#
#..##.""",
    # Typographic extras the game's text uses.
    '’': """
#
#
.""",
    '‘': """
#
#""",
    '“': """
#.#
#.#""",
    '”': """
#.#
#.#""",
    '…': """
.....
.....
.....
.....
.....
.....
#.#.#""",
    '·': """
.
.
.
#""",
    '•': """
..
..
##
##""",
    '×': """
.....
.....
#...#
.#.#.
..#..
.#.#.
#...#""",
    '✕': """
#...#
.#.#.
..#..
.#.#.
#...#""",
    '−': """
.....
.....
.....
#####""",
    '–': """
....
....
....
####""",
    '—': """
.......
.......
.......
#######""",
    '→': """
.....#.
......#
#######
......#
.....#.""",
    '←': """
.#.....
#......
#######
#......
.#.....""",
    '°': """
.#.
#.#
.#.""",
    '±': """
.....
..#..
..#..
#####
..#..
..#..
#####""",
    'é': """
..#..
.#...
.###.
#...#
#####
#....
.####""",
}

# Spaces have no pixels, just width.
SPACES = {' ': 3, ' ': 3}


def rows_of(drawing):
    rows = drawing.strip('\n').split('\n')
    width = max(len(r) for r in rows)
    return [r.ljust(width, '.') for r in rows], width


def rectangles(rows):
    """Pixel runs merged into rectangles: (x, row, width, height)."""
    runs = []
    for r, row in enumerate(rows):
        x = 0
        while x < len(row):
            if row[x] == '#':
                start = x
                while x < len(row) and row[x] == '#':
                    x += 1
                runs.append([start, r, x - start, 1])
            else:
                x += 1
    # Stack identical runs in consecutive rows into one taller rectangle.
    merged = []
    for run in runs:
        for m in merged:
            if m[0] == run[0] and m[2] == run[2] and m[1] + m[3] == run[1]:
                m[3] += 1
                break
        else:
            merged.append(run)
    return merged


def draw(rows):
    pen = TTGlyphPen(None)
    for x, r, w, h in rectangles(rows):
        # Row r spans from (6 - r) to (7 - r) pixels above the baseline.
        x0, x1 = x * PX, (x + w) * PX
        y0, y1 = (7 - r - h) * PX, (7 - r) * PX
        # Clockwise, as TrueType wants for filled shapes.
        pen.moveTo((x0, y0))
        pen.lineTo((x0, y1))
        pen.lineTo((x1, y1))
        pen.lineTo((x1, y0))
        pen.closePath()
    return pen.glyph()


def left_edge(rows):
    """The left side bearing: where the glyph's leftmost pixel starts."""
    xs = [row.index('#') for row in rows if '#' in row]
    return min(xs) * PX if xs else 0


def name_of(ch):
    return f'uni{ord(ch):04X}'


def main():
    order = ['.notdef']
    glyphs = {}
    metrics = {}
    cmap = {}

    # .notdef: a hollow box.
    box = ['#####'] + ['#...#'] * 5 + ['#####']
    glyphs['.notdef'] = draw(box)
    metrics['.notdef'] = (6 * PX, left_edge(box))

    for ch, width in SPACES.items():
        name = name_of(ch)
        order.append(name)
        glyphs[name] = TTGlyphPen(None).glyph()
        metrics[name] = ((width + 1) * PX, 0)
        cmap[ord(ch)] = name

    for ch, drawing in GLYPHS.items():
        rows, width = rows_of(drawing)
        name = name_of(ch)
        order.append(name)
        glyphs[name] = draw(rows)
        metrics[name] = ((width + 1) * PX, left_edge(rows))
        cmap[ord(ch)] = name

    fb = FontBuilder(EM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=-DESCENT)
    fb.setupNameTable({
        'familyName': 'Blockcraft',
        'styleName': 'Regular',
        'uniqueFontIdentifier': 'Blockcraft Regular',
        'fullName': 'Blockcraft Regular',
        'psName': 'Blockcraft-Regular',
        'version': 'Version 1.000',
        'copyright': 'Blockcraft pixel font, made for the Blockcraft game (MIT license)',
    })
    fb.setupOS2(
        version=4, sTypoAscender=ASCENT, sTypoDescender=-DESCENT, sTypoLineGap=0,
        usWinAscent=ASCENT, usWinDescent=DESCENT,
        sxHeight=5 * PX, sCapHeight=7 * PX, achVendID='BLKC',
        fsSelection=0x40 | 0x80,  # regular, use typo metrics
    )
    fb.setupPost(isFixedPitch=0)
    fb.setupMaxp()
    fb.save('fonts/blockcraft.ttf')
    print(f'Wrote fonts/blockcraft.ttf with {len(order)} glyphs')


if __name__ == '__main__':
    main()
