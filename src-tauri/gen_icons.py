from PIL import Image, ImageDraw

# Simple placeholder app icon: dark VGUI panel square with a diagonal teal->white
# gradient bar, echoing the app's own gradient-map subject and the stolen theme's
# accent colour. Not meant to be final branding, just a valid bundle icon.
SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

bg = (26, 26, 26, 255)
draw.rounded_rectangle([0, 0, SIZE, SIZE], radius=180, fill=bg)

stops = [
    (0.0, (60, 152, 152)),
    (0.5, (255, 255, 255)),
    (1.0, (60, 152, 152)),
]


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def color_at(t):
    for i in range(len(stops) - 1):
        p0, c0 = stops[i]
        p1, c1 = stops[i + 1]
        if p0 <= t <= p1:
            local = 0 if p1 == p0 else (t - p0) / (p1 - p0)
            return lerp(c0, c1, local)
    return stops[-1][1]


bar_top = int(SIZE * 0.40)
bar_bottom = int(SIZE * 0.60)
margin = int(SIZE * 0.12)
for x in range(margin, SIZE - margin):
    t = (x - margin) / (SIZE - 2 * margin)
    draw.line([(x, bar_top), (x, bar_bottom)], fill=color_at(t) + (255,))

img.save("icons/icon_source.png")

sizes = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}
for name, s in sizes.items():
    img.resize((s, s), Image.LANCZOS).save(f"icons/{name}")

ico_sizes = [16, 24, 32, 48, 64, 128, 256]
img.save("icons/icon.ico", sizes=[(s, s) for s in ico_sizes])

print("icons written")
