from PIL import Image

# App icon generated from the user-supplied source artwork (regradient.png,
# 512x512 RGBA). All resizing uses nearest-neighbor per the user's request -
# no smoothing/blurring of the pixel edges at smaller sizes.
SOURCE = "../regradient.png"
src = Image.open(SOURCE).convert("RGBA")

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

resized_cache = {}


def nearest(size):
    if size not in resized_cache:
        if size == src.width:
            resized_cache[size] = src
        else:
            resized_cache[size] = src.resize((size, size), Image.NEAREST)
    return resized_cache[size]


for name, s in sizes.items():
    nearest(s).save(f"icons/{name}")

src.save("icons/icon_source.png")

# Build the multi-resolution .ico by embedding pre-resized nearest-neighbor
# frames directly (via append_images) rather than letting Pillow's ICO
# encoder re-resize from the source itself, which defaults to a smooth
# filter and would defeat the point. Pillow's ICO writer caps every frame
# size at the *base* image's own size (`im.size` in IcoImagePlugin._save),
# so the base has to be the largest frame - saving on the smallest one
# silently drops everything bigger than it.
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [nearest(s) for s in ico_sizes]
frames[-1].save(
    "icons/icon.ico",
    format="ICO",
    sizes=[(s, s) for s in ico_sizes],
    append_images=frames[:-1],
)

print("icons written")
