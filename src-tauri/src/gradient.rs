//! The gradient model shared by `.grd`-parsed and user-saved gradients, the
//! 256-entry LUT builder that stands in for Photoshop's Gradient Map, and
//! on-disk storage of custom gradients (JSON, saved next to the `.grd`
//! presets in `gradients/`).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::grd;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ColorStop {
    /// 0.0-1.0 position along the gradient.
    pub pos: f64,
    pub color: [u8; 3],
    /// 0.0-1.0 bias of the transition toward the *next* stop (Photoshop's
    /// midpoint diamond). 0.5 = linear. Ignored on the last stop.
    #[serde(default = "default_midpoint")]
    pub midpoint: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct OpacityStop {
    pub pos: f64,
    /// 0.0-1.0
    pub opacity: f64,
    #[serde(default = "default_midpoint")]
    pub midpoint: f64,
}

fn default_midpoint() -> f64 {
    0.5
}

// Without rename_all, this field crosses the IPC boundary as `opacity_stops`
// while the frontend (api.ts) reads `opacityStops` - it silently comes back
// `undefined` on load (crashing the editor's render pass, which needs
// `.length` on it) and silently drops to empty on save.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientDef {
    pub name: String,
    pub stops: Vec<ColorStop>,
    #[serde(default)]
    pub opacity_stops: Vec<OpacityStop>,
}

/// One entry in the gradient list the frontend renders: metadata plus enough
/// to identify the backing file, but not the full stop list (fetched on
/// demand when the editor opens one).
#[derive(Debug, Clone, Serialize)]
pub struct GradientMeta {
    pub id: String,
    pub name: String,
    /// "grd" (read-only reference preset) or "custom" (editable, JSON).
    pub source: &'static str,
    pub editable: bool,
    /// data: URL of a small preview strip PNG.
    pub preview: String,
}

struct GradientEntry {
    id: String,
    source: &'static str,
    editable: bool,
    def: GradientDef,
}

fn normalize_grd_stop(s: grd::GrdColorStop) -> ColorStop {
    ColorStop { pos: s.pos, color: s.color, midpoint: s.midpoint }
}

fn normalize_grd_opacity(s: grd::GrdOpacityStop) -> OpacityStop {
    OpacityStop { pos: s.pos, opacity: s.opacity, midpoint: s.midpoint }
}

fn scan(dir: &Path) -> Vec<GradientEntry> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();

        match ext.to_lowercase().as_str() {
            "grd" => {
                let Ok(bytes) = std::fs::read(&path) else { continue };
                let Ok(parsed) = grd::parse_grd(&bytes) else { continue };
                // A .grd's own preset-list wrapper shows up as an extra, empty
                // `Grdn` descriptor alongside the real one (see grd.rs); index
                // ids by how many gradients this file has actually *kept* so
                // far, not by their raw position, or a single-gradient file's
                // real entry ends up suffixed instead of getting the plain stem.
                let mut kept = 0usize;
                for g in parsed.into_iter() {
                    if g.noise || g.stops.len() < 2 {
                        continue;
                    }
                    let id = if kept == 0 { stem.clone() } else { format!("{stem}__{kept}") };
                    kept += 1;
                    // The name baked into the .grd (Photoshop's "Nm  " field) is
                    // whatever placeholder or junk text the preset happened to
                    // carry (default "Заказная", stray profanity, emoji…), not
                    // anything the user meant as a label. The filename - e.g.
                    // "lava.grd" - is the name they actually gave it.
                    let def = GradientDef {
                        name: stem.clone(),
                        stops: g.stops.into_iter().map(normalize_grd_stop).collect(),
                        opacity_stops: g.opacity_stops.into_iter().map(normalize_grd_opacity).collect(),
                    };
                    out.push(GradientEntry { id, source: "grd", editable: false, def });
                }
            }
            "json" => {
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                let Ok(def) = serde_json::from_str::<GradientDef>(&text) else { continue };
                out.push(GradientEntry { id: stem, source: "custom", editable: true, def });
            }
            _ => {}
        }
    }
    out.sort_by(|a, b| a.def.name.to_lowercase().cmp(&b.def.name.to_lowercase()));
    out
}

pub fn list_meta(dir: &Path) -> Vec<GradientMeta> {
    scan(dir)
        .into_iter()
        .map(|e| GradientMeta {
            id: e.id,
            name: e.def.name.clone(),
            source: e.source,
            editable: e.editable,
            preview: render_preview_data_url(&e.def, 240, 28),
        })
        .collect()
}

pub fn get_def(dir: &Path, id: &str) -> Result<GradientDef, String> {
    scan(dir)
        .into_iter()
        .find(|e| e.id == id)
        .map(|e| e.def)
        .ok_or_else(|| format!("gradient '{id}' not found"))
}

fn slugify(name: &str) -> String {
    let s: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        "gradient".to_string()
    } else {
        s
    }
}

fn unique_slug(dir: &Path, name: &str) -> String {
    let base = slugify(name);
    let mut candidate = base.clone();
    let mut n = 2;
    loop {
        let taken = dir.join(format!("{candidate}.grd")).exists() || dir.join(format!("{candidate}.json")).exists();
        if !taken {
            return candidate;
        }
        candidate = format!("{base}-{n}");
        n += 1;
    }
}

/// Saves `def` as a custom gradient. `id` names an existing *custom* gradient
/// to overwrite in place; `None` always creates a new file with a name-derived
/// slug. Returns the id (filename stem) it was saved under.
pub fn save(dir: &Path, id: Option<&str>, def: &GradientDef) -> Result<String, String> {
    if def.stops.len() < 2 {
        return Err("a gradient needs at least two color stops".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let slug = match id {
        Some(existing) if dir.join(format!("{existing}.json")).exists() => existing.to_string(),
        _ => unique_slug(dir, &def.name),
    };
    let path = dir.join(format!("{slug}.json"));
    let text = serde_json::to_string_pretty(def).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(slug)
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    let path = dir.join(format!("{id}.json"));
    if !path.is_file() {
        return Err("only custom gradients can be deleted".to_string());
    }
    std::fs::remove_file(&path).map_err(|e| format!("delete {}: {e}", path.display()))
}

// ---------------------------------------------------------------- LUT math

/// Piecewise power-curve reparametrisation pivoting the 50% point of a
/// segment at the stop's midpoint, the same shape (though not the identical
/// spline) as Photoshop's midpoint diamond.
fn bias(t: f64, midpoint: f64) -> f64 {
    let m = midpoint.clamp(0.0001, 0.9999);
    if (m - 0.5).abs() < 1e-9 {
        return t;
    }
    t.clamp(0.0, 1.0).powf(0.5f64.ln() / m.ln())
}

fn lerp_u8(a: u8, b: u8, t: f64) -> u8 {
    (a as f64 + (b as f64 - a as f64) * t).round().clamp(0.0, 255.0) as u8
}

fn color_at(stops: &[ColorStop], t: f64) -> [u8; 3] {
    if stops.is_empty() {
        return [0, 0, 0];
    }
    if stops.len() == 1 || t <= stops[0].pos {
        return stops[0].color;
    }
    let last = stops.len() - 1;
    if t >= stops[last].pos {
        return stops[last].color;
    }
    for w in stops.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t >= a.pos && t <= b.pos {
            let span = b.pos - a.pos;
            let local = if span <= 0.0 { 1.0 } else { (t - a.pos) / span };
            let biased = bias(local, a.midpoint);
            return [
                lerp_u8(a.color[0], b.color[0], biased),
                lerp_u8(a.color[1], b.color[1], biased),
                lerp_u8(a.color[2], b.color[2], biased),
            ];
        }
    }
    stops[last].color
}

fn opacity_at(stops: &[OpacityStop], t: f64) -> f64 {
    if stops.is_empty() {
        return 1.0;
    }
    if stops.len() == 1 || t <= stops[0].pos {
        return stops[0].opacity;
    }
    let last = stops.len() - 1;
    if t >= stops[last].pos {
        return stops[last].opacity;
    }
    for w in stops.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t >= a.pos && t <= b.pos {
            let span = b.pos - a.pos;
            let local = if span <= 0.0 { 1.0 } else { (t - a.pos) / span };
            let biased = bias(local, a.midpoint);
            return a.opacity + (b.opacity - a.opacity) * biased;
        }
    }
    stops[last].opacity
}

pub type ColorLut = [[u8; 3]; 256];
pub type OpacityLut = [f64; 256];

pub fn build_lut(def: &GradientDef) -> ColorLut {
    let mut lut = [[0u8; 3]; 256];
    let mut stops = def.stops.clone();
    stops.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap());
    for (i, slot) in lut.iter_mut().enumerate() {
        *slot = color_at(&stops, i as f64 / 255.0);
    }
    lut
}

pub fn build_opacity_lut(def: &GradientDef) -> OpacityLut {
    let mut lut = [1.0f64; 256];
    if def.opacity_stops.is_empty() {
        return lut;
    }
    let mut stops = def.opacity_stops.clone();
    stops.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap());
    for (i, slot) in lut.iter_mut().enumerate() {
        *slot = opacity_at(&stops, i as f64 / 255.0);
    }
    lut
}

pub fn render_preview_png(def: &GradientDef, width: u32, height: u32) -> Vec<u8> {
    let lut = build_lut(def);
    let mut img = image::RgbImage::new(width.max(1), height.max(1));
    let denom = (width.max(2) - 1) as f64;
    for x in 0..img.width() {
        let idx = ((x as f64 / denom) * 255.0).round().clamp(0.0, 255.0) as usize;
        let c = lut[idx];
        for y in 0..img.height() {
            img.put_pixel(x, y, image::Rgb(c));
        }
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut buf, image::ImageFormat::Png)
        .expect("encoding an in-memory PNG cannot fail");
    buf.into_inner()
}

pub fn render_preview_data_url(def: &GradientDef, width: u32, height: u32) -> String {
    use base64::Engine;
    let png = render_preview_png(def, width, height);
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir() -> PathBuf {
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../gradients"))
    }

    #[test]
    fn lists_all_eight_reference_gradients() {
        let metas = list_meta(&dir());
        assert_eq!(metas.len(), 8, "{metas:?}");
        for m in &metas {
            assert_eq!(m.source, "grd");
            assert!(!m.editable);
            assert!(m.preview.starts_with("data:image/png;base64,"));
        }
    }

    #[test]
    fn lut_endpoints_match_first_and_last_stop() {
        let def = GradientDef {
            name: "t".into(),
            stops: vec![
                ColorStop { pos: 0.0, color: [10, 20, 30], midpoint: 0.5 },
                ColorStop { pos: 1.0, color: [200, 150, 100], midpoint: 0.5 },
            ],
            opacity_stops: vec![],
        };
        let lut = build_lut(&def);
        assert_eq!(lut[0], [10, 20, 30]);
        assert_eq!(lut[255], [200, 150, 100]);
    }

    #[test]
    fn save_then_get_round_trips_and_slugifies_name() {
        let tmp = std::env::temp_dir().join("regradient-gradient-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let def = GradientDef {
            name: "Тест Ромб".into(),
            stops: vec![
                ColorStop { pos: 0.0, color: [0, 0, 0], midpoint: 0.5 },
                ColorStop { pos: 1.0, color: [255, 255, 255], midpoint: 0.5 },
            ],
            opacity_stops: vec![],
        };
        let id = save(&tmp, None, &def).unwrap();
        let round_tripped = get_def(&tmp, &id).unwrap();
        assert_eq!(round_tripped.name, def.name);

        let metas = list_meta(&tmp);
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].source, "custom");
        assert!(metas[0].editable);

        delete(&tmp, &id).unwrap();
        assert!(list_meta(&tmp).is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Guards the exact bug that shipped: without `rename_all = "camelCase"`
    /// on `GradientDef`, this field crosses Tauri's IPC as `opacity_stops`
    /// while the frontend reads `opacityStops` - it comes back `undefined`,
    /// which crashes the editor's render pass on load and silently drops the
    /// stops to empty on save. Asserting the wire shape directly (not just
    /// that a Rust-to-Rust round trip works) is what actually catches that.
    #[test]
    fn gradient_def_serializes_opacity_stops_as_camel_case() {
        let def = GradientDef {
            name: "t".into(),
            stops: vec![
                ColorStop { pos: 0.0, color: [0, 0, 0], midpoint: 0.5 },
                ColorStop { pos: 1.0, color: [255, 255, 255], midpoint: 0.5 },
            ],
            opacity_stops: vec![OpacityStop { pos: 0.5, opacity: 0.5, midpoint: 0.5 }],
        };
        let value = serde_json::to_value(&def).unwrap();
        assert!(value.get("opacityStops").is_some(), "expected camelCase \"opacityStops\" key, got: {value}");
        assert!(value.get("opacity_stops").is_none(), "snake_case key leaked onto the wire: {value}");
    }
}
