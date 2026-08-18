//! The export pipeline: applies every selected gradient to the loaded image
//! and writes the results out, following the three checkbox rules described
//! in the UI (wrapper folder, per-gradient subfolders, plus-the-original).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::gradient;
use crate::imaging::{self, LoadedImage};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub output_dir: String,
    pub gradient_ids: Vec<String>,
    pub wrap_in_gradiented_images: bool,
    pub per_gradient_folders: bool,
    pub export_default: bool,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub written: Vec<String>,
    pub errors: Vec<String>,
}

const WRAPPER_FOLDER_NAME: &str = "Gradiented Images";
const DEFAULT_FOLDER_NAME: &str = "default";

fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "gradient".to_string()
    } else {
        cleaned
    }
}

/// The wrapper checkbox is a no-op when the chosen folder is already named
/// "Gradiented Images" (case-insensitive) - exporting *into* that folder
/// again would otherwise nest it inside itself.
fn effective_base(selected: &Path, wrap: bool) -> PathBuf {
    let already_wrapped = selected
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case(WRAPPER_FOLDER_NAME))
        .unwrap_or(false);
    if wrap && !already_wrapped {
        selected.join(WRAPPER_FOLDER_NAME)
    } else {
        selected.to_path_buf()
    }
}

pub fn run(gradients_dir: &Path, image: &LoadedImage, req: &ExportRequest) -> ExportResult {
    let mut result = ExportResult::default();
    let base = effective_base(Path::new(&req.output_dir), req.wrap_in_gradiented_images);

    for id in &req.gradient_ids {
        let def = match gradient::get_def(gradients_dir, id) {
            Ok(d) => d,
            Err(e) => {
                result.errors.push(format!("{id}: {e}"));
                continue;
            }
        };
        let lut = gradient::build_lut(&def);
        let opacity_lut = gradient::build_opacity_lut(&def);
        let mapped = imaging::apply_gradient_map(&image.decoded, &lut, &opacity_lut);

        let out_dir = if req.per_gradient_folders {
            base.join(sanitize_component(&def.name))
        } else {
            base.clone()
        };
        let filename = format!("{}_{}.{}", image.stem, sanitize_component(&def.name), image.ext);
        let path = out_dir.join(filename);

        match imaging::save_image(&mapped, &path, image.ext) {
            Ok(()) => result.written.push(path.to_string_lossy().to_string()),
            Err(e) => result.errors.push(e),
        }
    }

    if req.export_default {
        let out_dir = if req.per_gradient_folders { base.join(DEFAULT_FOLDER_NAME) } else { base.clone() };
        let filename = format!("{}_default.{}", image.stem, image.ext);
        let path = out_dir.join(filename);
        match imaging::save_image(&image.decoded, &path, image.ext) {
            Ok(()) => result.written.push(path.to_string_lossy().to_string()),
            Err(e) => result.errors.push(e),
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_image() -> LoadedImage {
        let mut img = image::RgbaImage::new(2, 2);
        for p in img.pixels_mut() {
            *p = image::Rgba([10, 20, 30, 255]);
        }
        LoadedImage { decoded: image::DynamicImage::ImageRgba8(img), stem: "photo".to_string(), ext: "png" }
    }

    fn gradients_dir() -> PathBuf {
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../gradients"))
    }

    #[test]
    fn flat_export_names_files_gradient_and_default() {
        let tmp = std::env::temp_dir().join("regradient-export-test-flat");
        let _ = std::fs::remove_dir_all(&tmp);

        let req = ExportRequest {
            output_dir: tmp.to_string_lossy().to_string(),
            gradient_ids: vec!["lava".to_string()],
            wrap_in_gradiented_images: false,
            per_gradient_folders: false,
            export_default: true,
        };
        let result = run(&gradients_dir(), &tiny_image(), &req);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(tmp.join("photo_lava.png").is_file());
        assert!(tmp.join("photo_default.png").is_file());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn wrapper_and_per_gradient_folders_nest_correctly() {
        let tmp = std::env::temp_dir().join("regradient-export-test-nested");
        let _ = std::fs::remove_dir_all(&tmp);

        let req = ExportRequest {
            output_dir: tmp.to_string_lossy().to_string(),
            gradient_ids: vec!["lava".to_string(), "rock".to_string()],
            wrap_in_gradiented_images: true,
            per_gradient_folders: true,
            export_default: true,
        };
        let result = run(&gradients_dir(), &tiny_image(), &req);
        assert!(result.errors.is_empty(), "{:?}", result.errors);

        let wrapped = tmp.join("Gradiented Images");
        assert!(wrapped.join("lava").join("photo_lava.png").is_file());
        assert!(wrapped.join("rock").join("photo_rock.png").is_file());
        assert!(wrapped.join("default").join("photo_default.png").is_file());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn wrapper_checkbox_is_noop_when_already_inside_that_folder() {
        let tmp = std::env::temp_dir().join("regradient-export-test-already-wrapped");
        let target = tmp.join("Gradiented Images");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&target).unwrap();

        let req = ExportRequest {
            output_dir: target.to_string_lossy().to_string(),
            gradient_ids: vec!["lava".to_string()],
            wrap_in_gradiented_images: true,
            per_gradient_folders: false,
            export_default: false,
        };
        let result = run(&gradients_dir(), &tiny_image(), &req);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(target.join("photo_lava.png").is_file());
        assert!(!target.join("Gradiented Images").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn reusing_an_existing_folder_named_like_a_gradient_does_not_error() {
        let tmp = std::env::temp_dir().join("regradient-export-test-existing-folder");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("lava")).unwrap();
        std::fs::write(tmp.join("lava").join("keep.txt"), "x").unwrap();

        let req = ExportRequest {
            output_dir: tmp.to_string_lossy().to_string(),
            gradient_ids: vec!["lava".to_string()],
            wrap_in_gradiented_images: false,
            per_gradient_folders: true,
            export_default: false,
        };
        let result = run(&gradients_dir(), &tiny_image(), &req);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(tmp.join("lava").join("photo_lava.png").is_file());
        assert!(tmp.join("lava").join("keep.txt").is_file());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
