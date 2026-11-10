"""Regenerate the PWA icons. Run from the web/ directory: python tools/make-icons.py"""

import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")
BG = (15, 23, 42, 255)
ACCENT = (56, 189, 248, 255)
FG = (241, 245, 249, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_icon(size, rounded=True, safe_ratio=1.0):
    scale = 4
    canvas = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    radius = int(size * scale * 0.22) if rounded else 0
    draw.rounded_rectangle(
        [0, 0, size * scale - 1, size * scale - 1], radius=radius, fill=BG
    )

    glyph_box = int(size * scale * 0.52 * safe_ratio)
    font = load_font(glyph_box)
    text = "A"
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    cx = (size * scale - tw) / 2 - box[0]
    cy = (size * scale - th) / 2 - box[1] - int(size * scale * 0.06 * safe_ratio)
    draw.text((cx, cy), text, font=font, fill=FG)

    bar_w = int(size * scale * 0.30 * safe_ratio)
    bar_h = int(size * scale * 0.045 * safe_ratio)
    bar_x = (size * scale - bar_w) / 2
    bar_y = cy + box[1] + th + int(size * scale * 0.10 * safe_ratio)
    draw.rounded_rectangle(
        [bar_x, bar_y, bar_x + bar_w, bar_y + bar_h], radius=bar_h // 2, fill=ACCENT
    )

    return canvas.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    draw_icon(192).save(os.path.join(OUT, "icon-192.png"))
    draw_icon(512).save(os.path.join(OUT, "icon-512.png"))
    draw_icon(512, rounded=False, safe_ratio=0.72).save(
        os.path.join(OUT, "icon-maskable-512.png")
    )
    draw_icon(180).save(os.path.join(OUT, "apple-touch-icon.png"))
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
