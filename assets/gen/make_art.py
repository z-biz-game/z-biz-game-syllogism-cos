#!/usr/bin/env python3
"""仓内美术资产生成器：把「夜审房 · 烛下蜡印」这一套母题现成可复现地画到盘上。

为什么在仓里自己画，而不是跑组合级 make_icons.py：那支脚本把母图写进
`z-biz-game-lead/007_美术资产/icons`（跨仓资产库），本派工单只许碰本仓；且它的 MOTIF
表里没有本仓。这里因此自带一份同风格的生成器，产物全部落在仓内，任何一台装了 PIL
的机器重跑都能逐字节复现（噪声用固定种子的 LCG，不用 Math.random / random 默认种子）。

母题来源不是凭空编，是从 js/theme.js 的实测调色板里长出来的：
  夜紫房 bgTop #0A0611 → bgBottom #1A1027 → surface #130D1E
  骑士 = 烛金实心蜡印 seal #F0B13C / sealEdge #FFD98F
  无赖 = 冷灰空心框 ash #87A8CB / ashDeep #2F4763
  未定 = 静默紫 unknown #6A588C
形状母题：一张立着的口供卡 + 卡上一枚蜡印 + 印里那个「⇔」（说话人是骑士，当且仅当
那句为真）。它是玩法本身，不是装饰；小尺寸下先丢细节也还认得出「暗房里一枚金印」。

用法:
  python3 assets/gen/make_art.py            # 全量重写
  python3 assets/gen/make_art.py --verify   # 只回读盘上资产的实测宽高
"""
import os
import struct
import sys
import zlib

from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ICONS = os.path.join(REPO, 'icons')
IMG = os.path.join(REPO, 'assets', 'img')

# --- palette mirror of js/theme.js (kept in one place on purpose; see header) -------------
BG_TOP = (10, 6, 17)
BG_BOTTOM = (26, 16, 39)
SURFACE = (19, 13, 30)
CARD = (25, 18, 39)
CARD_LIT = (36, 26, 54)
LINE = (44, 32, 66)
LINE_HEAVY = (74, 55, 102)
INK = (245, 239, 232)
SEAL = (240, 177, 60)
SEAL_EDGE = (255, 217, 143)
SEAL_DEEP = (139, 90, 17)
ASH = (135, 168, 203)
ASH_EDGE = (185, 210, 236)
ASH_DEEP = (47, 71, 99)
UNKNOWN = (106, 88, 140)
UNKNOWN_EDGE = (142, 123, 176)
SUCCESS = (62, 189, 143)

MASTER = 1024
# App/store sizes. 168+192 are the two the PWA manifest asks Chrome for; 180 is the iOS
# home-screen tile; a 1024 master keeps the asset re-derivable at any future size.
ICON_SIZES = [16, 32, 48, 64, 96, 180, 192, 512]


# --- deterministic noise -----------------------------------------------------------------
class LCG:
    """Numerical-Recipes LCG: same seed ⇒ same pixel, on every machine, in every language."""

    def __init__(self, seed=20261002):
        self.s = seed & 0xFFFFFFFF

    def next(self):
        self.s = (self.s * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.s / 0xFFFFFFFF

    def uniform(self, a, b):
        return a + (b - a) * self.next()


def lerp(c1, c2, t):
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * t)) for i in range(3))


def vgrad(size, stops):
    """stops: [(pos0..1, rgb), ...] top→bottom, linear interpolation between them."""
    w, h = size
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        i = 0
        while i < len(stops) - 2 and stops[i + 1][0] < t:
            i += 1
        p0, c0 = stops[i]
        p1, c1 = stops[min(i + 1, len(stops) - 1)]
        f = 0 if p1 == p0 else max(0.0, min(1.0, (t - p0) / (p1 - p0)))
        d.line([(0, y), (w, y)], fill=lerp(c0, c1, f))
    return img


def glow(size, radius_frac, color, power=1.0):
    """Soft radial light on a transparent layer — the candle, and every sprite that needs
    to fall off without a visible ring. The falloff is analytic, not blurred: an
    ellipse+Gaussian mask still carries alpha where its bounding box ends, and that box is
    exactly what reads as a bright square once the light is pasted onto a wider field."""
    w, h = size
    r = max(2, int(min(w, h) * radius_frac))
    side = r * 2
    inv = 1.0 / (r * r)
    data = bytearray(side * side)
    for y in range(side):
        dy2 = (y - r) ** 2
        row = y * side
        for x in range(side):
            d2 = ((x - r) ** 2 + dy2) * inv
            data[row + x] = 0 if d2 >= 1.0 else int(255 * (1.0 - d2) ** 2.2)
    mask = Image.frombytes('L', (side, side), bytes(data))
    if power != 1.0:
        mask = mask.point(lambda v: int(255 * pow(v / 255.0, power)))
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    solid = Image.new('RGBA', (side, side), color + (255,))
    # a radius past half the canvas is what the vignette asks for; paste clips it for us
    layer.paste(solid, (w // 2 - r, h // 2 - r), mask)
    return layer


def round_square_alpha(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def chip_filled(d, cx, cy, r, ring=SEAL_EDGE, body=SEAL, deep=SEAL_DEEP):
    """骑士: a wax seal — filled, warm, with a bitten edge and a highlight arc so it reads
    as pressed matter rather than a flat yellow disc."""
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=body, outline=deep, width=max(2, int(r) // 14))
    d.pieslice([cx - r, cy - r, cx + r, cy + r], 200, 340, fill=ring)
    d.ellipse([cx - r * 0.52, cy - r * 0.52, cx + r * 0.52, cy + r * 0.52],
              outline=deep, width=max(2, int(r) // 16))


def chip_hollow(d, cx, cy, r, edge=ASH_EDGE, deep=ASH_DEEP):
    """无赖: a hollow frame, colder and thinner — the shape alone says "nothing is asserted"."""
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=edge, width=max(3, int(r) // 8))


def chip_unknown(d, cx, cy, r, edge=UNKNOWN_EDGE):
    s = r * 0.86
    d.rounded_rectangle([cx - s, cy - s, cx + s, cy + s], radius=s * 0.3,
                        outline=edge, width=max(2, int(r) // 10))


def iff_glyph(d, cx, cy, w, color, weight=None):
    """The biconditional ⇔, drawn as geometry (two bars, two chevrons) so it survives both
    a missing font and a 16 px raster — the whole game is that one symbol."""
    weight = weight or max(2, int(w * 0.085))
    bar_h = w * 0.42
    d.line([cx - w / 2, cy - bar_h, cx + w / 2, cy - bar_h], fill=color, width=weight)
    d.line([cx - w / 2, cy + bar_h, cx + w / 2, cy + bar_h], fill=color, width=weight)
    ch = w * 0.30
    for tip in (-1, 1):
        x = cx + tip * w * 0.44
        d.line([x - tip * ch, cy - ch, x, cy], fill=color, width=weight)
        d.line([x, cy, x - tip * ch, cy + ch], fill=color, width=weight)


def flame(d, cx, top_y, h, w):
    """Candle flame: outer gold teardrop, warm core. Two ellipses and a join — enough at
    16 px to read as "the one thing in the room casting light"."""
    d.ellipse([cx - w / 2, top_y + h * 0.22, cx + w / 2, top_y + h], fill=SEAL)
    d.polygon([(cx - w / 2, top_y + h * 0.55), (cx + w / 2, top_y + h * 0.55), (cx, top_y)], fill=SEAL)
    d.ellipse([cx - w * 0.26, top_y + h * 0.5, cx + w * 0.26, top_y + h * 0.94], fill=SEAL_EDGE)


def card_layer(size, rot, tint, edge, glow_amt):
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w, h = size
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=int(min(w, h) * 0.11),
                        fill=tint, outline=edge, width=max(2, int(w * 0.014)))
    if glow_amt:
        layer = Image.alpha_composite(layer, glow((w, h), 0.5, SEAL, 1.4).copy())
    return layer.rotate(rot, resample=Image.BICUBIC, expand=True,
                        fillcolor=(0, 0, 0, 0))


def build_master(S=MASTER):
    """One lit testimony card, its seal carrying ⇔, under one candle. Everything else in the
    composition exists to point at that card."""
    base = vgrad((S, S), [(0.0, BG_TOP), (0.55, BG_BOTTOM), (1.0, SURFACE)]).convert('RGBA')
    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    canvas.paste(base, (0, 0))

    # the candle over the table
    canvas = Image.alpha_composite(canvas, glow((S, S), 0.34, SEAL))
    d = ImageDraw.Draw(canvas)
    flame(d, S * 0.5, S * 0.105, S * 0.085, S * 0.048)
    d.rounded_rectangle([S * 0.487, S * 0.19, S * 0.513, S * 0.235], radius=S * 0.006, fill=INK)

    # two cards face down behind: the cold ones (无赖 / 未定) — they set depth, not meaning
    for (cx, cy, cw, ch, rot) in [(S * 0.335, S * 0.615, S * 0.34, S * 0.44, -11),
                                  (S * 0.675, S * 0.635, S * 0.34, S * 0.44, 9)]:
        lay = card_layer((int(cw), int(ch)), rot, CARD, LINE_HEAVY, 0)
        canvas.alpha_composite(lay, (int(cx - lay.width / 2), int(cy - lay.height / 2)))
    d = ImageDraw.Draw(canvas)
    chip_hollow(d, S * 0.335, S * 0.53, S * 0.033)
    chip_unknown(d, S * 0.675, S * 0.545, S * 0.03)

    # the lit card
    cw, ch = int(S * 0.44), int(S * 0.56)
    lit = card_layer((cw, ch), 0, CARD_LIT, SEAL_DEEP, 0).convert('RGBA')
    lx, ly = int(S * 0.5 - cw / 2), int(S * 0.585 - ch / 2)
    canvas.alpha_composite(lit, (lx, ly))
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([lx, ly, lx + cw - 1, ly + ch - 1], radius=int(cw * 0.11),
                        outline=SEAL_DEEP, width=max(3, int(S * 0.005)))

    # the wax seal, and the one symbol inside it
    chip_filled(d, S * 0.5, S * 0.545, S * 0.078)
    iff_glyph(d, S * 0.5, S * 0.545, S * 0.072, SEAL_DEEP)

    # testimony lines — what the sentence looks like once it is settled
    for i, frac in enumerate((0.74, 0.80, 0.66)):
        y = S * (0.655 + i * 0.045)
        d.rounded_rectangle([S * 0.5 - cw * 0.33, y, S * 0.5 - cw * 0.33 + cw * 0.66 * frac,
                             y + S * 0.014], radius=S * 0.007,
                            fill=INK + (int(150 - i * 34),))

    # vignette: the room ends where the candle light ends
    dark = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dark)
    dd.rectangle([0, 0, S, S], fill=(0, 0, 0, 150))
    hole = glow((S, S), 0.52, (0, 0, 0), 0.75)
    inv = hole.split()[3].point(lambda v: 255 - v)
    dark.putalpha(inv)
    canvas = Image.alpha_composite(canvas, dark)

    # rounded-square mask (the shape app stores want) — the full-bleed version is maskable
    return canvas.rotate(0, resample=Image.BICUBIC, expand=False, fillcolor=(0, 0, 0, 0))


def compose_on_round(master, size, radius_frac=0.185, margin_frac=0.0):
    S = size
    art = master.resize((S, S), Image.LANCZOS) if master.size != (S, S) else master.copy()
    if margin_frac:
        inner = int(S * (1 - margin_frac * 2))
        body = art.resize((inner, inner), Image.LANCZOS)
        pad = S - inner
        base = Image.new('RGBA', (S, S), BG_TOP + (255,))
        base.alpha_composite(body, (pad // 2, pad // 2))
        art = base
    art.putalpha(round_square_alpha((S, S), int(S * radius_frac)))
    return art


def build_maskable(master, size=512):
    """Android/iOS adaptive icons crop the outer 18% ring, so the motif must live inside the
    66% safe zone with a full-bleed background — otherwise a Chrome install shows a cropped seal."""
    S = size
    base = vgrad((S, S), [(0.0, BG_TOP), (0.55, BG_BOTTOM), (1.0, SURFACE)]).convert('RGBA')
    inner = int(S * 0.62)
    art = master.resize((inner, inner), Image.LANCZOS)
    base.alpha_composite(art, ((S - inner) // 2, (S - inner) // 2))
    return base


def build_grain(size=256, seed=7717):
    """Tileable paper grain for the testimony cards: white and black specks at low alpha,
    seamless because the noise is generated on a 3x wrap-around field and cropped from it.
    Committed as a texture rather than procedurally per frame so a 60-card redraw costs one
    drawImage instead of 65k pixel writes."""
    rng = LCG(seed)
    field = size * 3
    noise = Image.new('L', (field, field))
    px = noise.load()
    for y in range(field):
        for x in range(field):
            px[x, y] = int(rng.next() * 255)
    # tiling-safe blur: the crop window sees the wrap on all sides
    smooth = noise.filter(ImageFilter.GaussianBlur(0.9))
    crop = smooth.crop([size, size, size * 2, size * 2])
    speck = noise.crop([size, size, size * 2, size * 2])
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    op, sp, cp = out.load(), speck.load(), crop.load()
    for y in range(size):
        for x in range(size):
            hi = sp[x, y] / 255.0
            lo = 1.0 - cp[x, y] / 255.0
            if hi > 0.80:
                v = int((hi - 0.80) * 5 * 44)
                op[x, y] = (245, 239, 232, min(44, v))
            elif lo > 0.82:
                v = int((lo - 0.82) * 5.5 * 52)
                op[x, y] = (10, 6, 17, min(52, v))
    return out


def build_candle_sprite(size=256):
    return glow((size, size), 0.5, SEAL, 1.15)


def build_mote(size=32):
    s = glow((size, size), 0.5, SEAL_EDGE, 0.7)
    m = s.split()[3].point(lambda v: int(v * 0.85))
    s.putalpha(m)
    return s


def find_font(px):
    """Social-card type only. Anything with CJK coverage will do; the shapes above never
    depend on a font, so a machine without these files still produces every icon."""
    for path in ('/System/Library/Fonts/Hiragino Sans GB.ttc',
                 '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
                 '/System/Library/Fonts/PingFang.ttc',
                 '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'):
        try:
            return ImageFont.truetype(path, px)
        except Exception:
            continue
    return None


def build_og(master):
    """1200x630 social card. Composed natively on the wide field rather than pasting the
    square master: the master carries its own vignette, so a square of it inside a 16:9 card
    shows up on a feed as a bright box with a card drawn in it."""
    W, H = 2400, 1260
    base = vgrad((W, H), [(0.0, BG_TOP), (0.52, BG_BOTTOM), (1.0, SURFACE)]).convert('RGBA')
    cx, cy = int(W * 0.70), int(H * 0.50)
    cw, ch = int(H * 0.44), int(H * 0.64)

    # one candle over the table, centred on the cards rather than on the canvas
    r = int(H * 0.46)
    light = glow((r * 2, r * 2), 0.5, SEAL)
    base.paste(light, (cx - r, cy - r), light)

    d = ImageDraw.Draw(base)
    for (ox, oy, rot) in [(-cw * 0.60, ch * 0.05, -8), (cw * 0.60, ch * 0.07, 7)]:
        lay = card_layer((int(cw * 0.84), int(ch * 0.88)), rot, CARD, LINE_HEAVY, 0)
        base.alpha_composite(lay, (int(cx + ox - lay.width / 2), int(cy + oy - lay.height / 2)))
    lit = card_layer((cw, ch), 0, CARD_LIT, SEAL_DEEP, 0)
    base.alpha_composite(lit, (int(cx - lit.width / 2), int(cy - lit.height / 2)))
    d = ImageDraw.Draw(base)
    d.rounded_rectangle([cx - cw // 2, cy - ch // 2, cx + cw // 2, cy + ch // 2],
                        radius=int(cw * 0.11), outline=SEAL_DEEP, width=8)
    flame(d, cx, cy - int(ch * 0.70), int(ch * 0.12), int(ch * 0.065))
    d.rounded_rectangle([cx - int(ch * 0.021), cy - int(ch * 0.60),
                         cx + int(ch * 0.021), cy - int(ch * 0.535)],
                        radius=int(ch * 0.008), fill=INK)
    chip_filled(d, cx, cy - int(ch * 0.17), int(cw * 0.19))
    iff_glyph(d, cx, cy - int(ch * 0.17), int(cw * 0.17), SEAL_DEEP)
    for i, frac in enumerate((0.62, 0.72, 0.5)):
        y = cy + int(ch * 0.13) + i * 56
        d.rounded_rectangle([cx - int(cw * 0.30), y, cx - int(cw * 0.30) + int(cw * 0.60 * frac),
                             y + 16], radius=8, fill=INK + (int(196 - i * 42),))

    # left column: the name, the house line, and the three identity shapes the board uses
    f_big, f_mid, f_small, f_tiny = find_font(220), find_font(92), find_font(60), find_font(52)
    x0 = 190
    if f_big:
        d.text((x0, 180), '证词', font=f_big, fill=INK + (255,))
        d.text((x0, 450), 'Syllogism · 骑士与无赖', font=f_mid, fill=SEAL + (255,))
        d.text((x0, 600), '每句证词都是一个方程：', font=f_small, fill=INK + (215,))
        d.text((x0, 690), '他是骑士，当且仅当那句为真', font=f_small, fill=INK + (215,))
    for i, fn in enumerate((chip_filled, chip_hollow, chip_unknown)):
        fn(d, x0 + 44 + i * 148, 880, 50)
    if f_tiny:
        d.text((x0, 960), '骑士 · 无赖 · 未定', font=f_tiny, fill=(245, 239, 232, 200))
        d.text((x0, 1040), '每局唯一解 · 铅笔规则推到底', font=f_tiny,
               fill=(245, 239, 232, 150))
    d.rectangle([0, H - 12, W, H], fill=SEAL + (255,))
    return base.resize((1200, 630), Image.LANCZOS)


def save(img, path):
    img.save(path, 'PNG', optimize=True)
    return path


def png_size(path):
    """Read the IHDR straight off the bytes — what the checker sees, not what PIL believes."""
    with open(path, 'rb') as fh:
        head = fh.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>II', head[16:24])


def main():
    verify_only = '--verify' in sys.argv
    os.makedirs(ICONS, exist_ok=True)
    os.makedirs(IMG, exist_ok=True)
    written = []
    if not verify_only:
        master = build_master()
        # the master keeps the square field; the app-icon family takes the rounded cut
        save(compose_on_round(master, MASTER), os.path.join(ICONS, 'icon-1024.png'))
        for s in ICON_SIZES:
            save(compose_on_round(master, s), os.path.join(ICONS, f'icon-{s}.png'))
        save(compose_on_round(master, 180), os.path.join(ICONS, 'apple-touch-icon.png'))
        save(compose_on_round(master, 32), os.path.join(ICONS, 'favicon-32.png'))
        save(compose_on_round(master, 16), os.path.join(ICONS, 'favicon-16.png'))
        save(build_maskable(master), os.path.join(ICONS, 'icon-maskable-512.png'))
        save(build_grain(256), os.path.join(IMG, 'paper-grain.png'))
        save(build_candle_sprite(256), os.path.join(IMG, 'candle-glow.png'))
        save(build_mote(32), os.path.join(IMG, 'mote.png'))
        save(build_og(master), os.path.join(IMG, 'og-cover.png'))

    wanted = [
        ('icons/icon-1024.png', (1024, 1024)), ('icons/icon-512.png', (512, 512)),
        ('icons/icon-192.png', (192, 192)), ('icons/icon-maskable-512.png', (512, 512)),
        ('icons/apple-touch-icon.png', (180, 180)), ('icons/icon-180.png', (180, 180)),
        ('icons/favicon-32.png', (32, 32)), ('icons/favicon-16.png', (16, 16)),
        ('icons/icon-48.png', (48, 48)), ('icons/icon-64.png', (64, 64)),
        ('icons/icon-96.png', (96, 96)),
        ('assets/img/paper-grain.png', (256, 256)), ('assets/img/candle-glow.png', (256, 256)),
        ('assets/img/mote.png', (32, 32)), ('assets/img/og-cover.png', (1200, 630)),
    ]
    bad = 0
    for rel, want in wanted:
        p = os.path.join(REPO, rel)
        if not os.path.exists(p):
            print(f'MISSING  {rel}')
            bad += 1
            continue
        got = png_size(p)
        bytes_ = os.path.getsize(p)
        flag = 'ok' if got == want and bytes_ > 512 else 'BAD'
        if flag != 'ok':
            bad += 1
        print(f'{flag:4} {rel:38} {got[0]}x{got[1]}  {bytes_}B')
    print(f'checked={len(wanted)} problems={bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
