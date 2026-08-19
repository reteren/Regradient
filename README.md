# Regradient

A small Windows desktop app that applies Photoshop-style Gradient Maps to a photo — no Photoshop required.

Drop in a photo, pick as many gradients as you like from your collection, hit export, and get one image per gradient (`photo_gradientname.png`). Comes with a Photoshop-style gradient editor (draggable color and opacity stops, midpoint bias, HSV picker) so you can tweak the bundled presets or build your own, and it reads real Photoshop `.grd` preset files directly.

## Features

- **Import a photo** by drag & drop, `Ctrl+V` paste, or a file picker.
- **Gradient Map export**: every pixel's luminance is remapped through the gradient, exactly like Photoshop's own Gradient Map adjustment.
- **Batch export**: select multiple gradients, get one output file per gradient in a single pass.
- **Export layout options**: wrap everything in a `Gradiented Images` folder, put each gradient in its own subfolder, and/or export a copy of the original alongside the gradient maps.
- **Gradient editor**: a Photoshop-style stop ramp — click to add a color stop, drag to move it, right-click to delete, a separate lane above for opacity stops, and midpoint diamonds to bias the blend toward either side.
- **Color picker**: HSV square + hue rail, hex/RGB fields, and a base palette.
- **Reads `.grd` files** — drop Photoshop gradient presets into the `gradients/` folder next to the app and they show up in the list automatically.
- Edit any gradient, including the bundled `.grd` presets — editing a preset saves a new custom copy without touching the original file.

## Installing

Download the installer from [Releases](../../releases) and run it — no admin rights needed, it installs per-user. The bundled sample gradients are installed alongside the app.

## Building from source

Requires [Node.js](https://nodejs.org/) and the [Rust toolchain](https://www.rust-lang.org/tools/install) (plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for Windows).

```sh
npm install
npm run tauri dev     # run in development
npm run tauri build   # build the NSIS installer
```

The installer is written to `src-tauri/target/release/bundle/nsis/`.

## How it works

- **Frontend**: vanilla TypeScript + a hand-rolled UI (`src/`) styled after Half-Life 2's Source VGUI dialogs, ported from [reteren/Reshot](https://github.com/reteren/Reshot).
- **Backend**: Rust (`src-tauri/src/`) — a from-scratch parser for Photoshop's undocumented `.grd` binary format (`grd.rs`), the gradient LUT/interpolation math (`gradient.rs`), image loading and the gradient-map export pipeline (`imaging.rs`, `export.rs`).
- Custom gradients you create in the editor are stored as JSON next to the `.grd` presets in `gradients/`.

## License

MIT — see [LICENSE](LICENSE).
