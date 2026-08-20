//! Loading a source photo (file, or the clipboard), and applying a gradient
//! map's LUT to it the same way Photoshop's Gradient Map adjustment does:
//! remap by per-pixel luminance, alpha untouched.

use std::path::Path;

use crate::gradient::{ColorLut, OpacityLut};

pub struct LoadedImage {
    pub decoded: image::DynamicImage,
    /// Filename without extension, used as the `{file name}` half of the
    /// exported `{file name}_{gradient name}` naming.
    pub stem: String,
    /// Output extension: one of "png", "jpg", "bmp". Whatever the source
    /// format, exports are always written as one of these three.
    pub ext: &'static str,
}

fn normalize_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg",
        "bmp" => "bmp",
        _ => "png",
    }
}

pub fn load_from_path(path: &Path) -> Result<LoadedImage, String> {
    let decoded = image::open(path).map_err(|e| format!("failed to open image: {e}"))?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    let ext = normalize_ext(path.extension().and_then(|e| e.to_str()).unwrap_or("png"));
    Ok(LoadedImage { decoded, stem, ext })
}

pub fn read_clipboard_image() -> Result<LoadedImage, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard unavailable: {e}"))?;
    let img = clipboard.get_image().map_err(|_| "no image on the clipboard".to_string())?;
    let width = img.width as u32;
    let height = img.height as u32;
    let buf = image::RgbaImage::from_raw(width, height, img.bytes.into_owned())
        .ok_or_else(|| "clipboard image had an unexpected buffer size".to_string())?;
    Ok(LoadedImage {
        decoded: image::DynamicImage::ImageRgba8(buf),
        stem: "clipboard".to_string(),
        ext: "png",
    })
}

/// Applies a gradient map: for every pixel, its Photoshop-weighted luminance
/// indexes the 256-entry LUT, and the opacity LUT (from the gradient's
/// transparency stops, if any) blends that result back over the original
/// pixel. Alpha is passed through unchanged.
pub fn apply_gradient_map(img: &image::DynamicImage, lut: &ColorLut, opacity_lut: &OpacityLut) -> image::DynamicImage {
    let src = img.to_rgba8();
    let mut out = image::RgbaImage::new(src.width(), src.height());
    for (x, y, px) in src.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        let luma = (0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64)
            .round()
            .clamp(0.0, 255.0) as usize;
        let gc = lut[luma];
        let op = opacity_lut[luma];
        let blend = |src: u8, dst: u8| (src as f64 + (dst as f64 - src as f64) * op).round().clamp(0.0, 255.0) as u8;
        out.put_pixel(x, y, image::Rgba([blend(r, gc[0]), blend(g, gc[1]), blend(b, gc[2]), a]));
    }
    image::DynamicImage::ImageRgba8(out)
}

/// Alpha-less formats (JPEG, BMP) need a background to flatten onto; white
/// matches what Photoshop's own "Flatten" does for a transparent canvas.
fn flatten_to_rgb(img: &image::DynamicImage) -> image::RgbImage {
    let src = img.to_rgba8();
    let mut out = image::RgbImage::new(src.width(), src.height());
    for (x, y, px) in src.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        let af = a as f64 / 255.0;
        let blend = |c: u8| (c as f64 * af + 255.0 * (1.0 - af)).round() as u8;
        out.put_pixel(x, y, image::Rgb([blend(r), blend(g), blend(b)]));
    }
    out
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub id: String,
    pub stem: String,
    pub width: u32,
    pub height: u32,
    /// data: URL of a downscaled (max 480px) preview for the drop zone.
    pub preview: String,
}

pub fn info_for(id: &str, image: &LoadedImage) -> ImageInfo {
    use base64::Engine;

    let (w, h) = (image.decoded.width(), image.decoded.height());
    let max_dim = 480u32;
    let scale = (max_dim as f64 / w.max(h).max(1) as f64).min(1.0);
    let (tw, th) = (((w as f64) * scale).round().max(1.0) as u32, ((h as f64) * scale).round().max(1.0) as u32);
    let thumb = image.decoded.resize(tw, th, image::imageops::FilterType::Triangle).to_rgba8();

    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(thumb)
        .write_to(&mut buf, image::ImageFormat::Png)
        .expect("encoding an in-memory PNG cannot fail");
    let preview = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf.into_inner()));

    ImageInfo { id: id.to_string(), stem: image.stem.clone(), width: w, height: h, preview }
}

pub fn save_image(img: &image::DynamicImage, path: &Path, ext: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let result = match ext {
        "jpg" => image::DynamicImage::ImageRgb8(flatten_to_rgb(img)).save_with_format(path, image::ImageFormat::Jpeg),
        "bmp" => image::DynamicImage::ImageRgb8(flatten_to_rgb(img)).save_with_format(path, image::ImageFormat::Bmp),
        _ => img.save_with_format(path, image::ImageFormat::Png),
    };
    result.map_err(|e| format!("failed to write {}: {e}", path.display()))
}
