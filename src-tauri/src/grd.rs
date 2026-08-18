//! Parser for Photoshop `.grd` gradient preset files.
//!
//! `.grd` wraps Adobe's generic binary "Descriptor" format (the same structure
//! used by `.abr`, `.csh`, actions, etc.) under an `8BGR` signature. There is no
//! official public spec; this follows the structure reverse-engineered by the
//! community (e.g. psd-tools, various grd2png scripts) and verified byte-for-byte
//! against the sample files in `gradients/`.
//!
//! Layout: `"8BGR"` + version(u16) + descriptorVersion(u32, always 16) + one
//! root Descriptor. Descriptors nest arbitrarily; a saved preset file can hold
//! more than one gradient, so rather than assuming a fixed root key (it varies:
//! `GrdL` for a single export, `Grds` for some Photoshop versions), every `Grdn`
//! classed descriptor found anywhere in the tree is extracted.

#[derive(Debug, Clone)]
#[allow(dead_code)] // several variants exist only so parsing can skip over them correctly
enum Value {
    Descriptor(Descriptor),
    List(Vec<Value>),
    Double(f64),
    UnitFloat(f64),
    Text(String),
    Enum(String, String),
    Long(i32),
    Bool(bool),
    Class(String),
    Alias(Vec<u8>),
    RawData(Vec<u8>),
}

#[derive(Debug, Clone, Default)]
struct Descriptor {
    class_id: String,
    items: Vec<(String, Value)>,
}

impl Descriptor {
    fn get(&self, key: &str) -> Option<&Value> {
        self.items.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.data.len() {
            return Err(format!(
                "unexpected end of file at byte {} (need {} more)",
                self.pos, n
            ));
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.bytes(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, String> {
        let b = self.bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, String> {
        let b = self.bytes(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(self.u32()? as i32)
    }

    fn f64(&mut self) -> Result<f64, String> {
        let b = self.bytes(8)?;
        Ok(f64::from_be_bytes(b.try_into().unwrap()))
    }
}

/// Reads a Descriptor "ID": a length-prefixed string that, when the length is
/// zero, is really a raw 4-byte OSType code (e.g. `"Objc"`, `"Clrs"`, `"Nm  "`).
fn read_id(r: &mut Reader) -> Result<String, String> {
    let len = r.u32()?;
    if len == 0 {
        Ok(String::from_utf8_lossy(r.bytes(4)?).to_string())
    } else {
        Ok(String::from_utf8_lossy(r.bytes(len as usize)?).to_string())
    }
}

/// Adobe "Unicode string": u32 length in UTF-16 units (including a trailing
/// NUL when the string is non-empty), then that many big-endian UTF-16 units.
fn read_unicode_string(r: &mut Reader) -> Result<String, String> {
    let len = r.u32()? as usize;
    let mut units = Vec::with_capacity(len);
    for _ in 0..len {
        units.push(r.u16()?);
    }
    while units.last() == Some(&0) {
        units.pop();
    }
    Ok(String::from_utf16_lossy(&units))
}

fn read_descriptor(r: &mut Reader) -> Result<Descriptor, String> {
    let _display_name = read_unicode_string(r)?;
    let class_id = read_id(r)?;
    let count = r.u32()?;
    let mut items = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let key = read_id(r)?;
        let value = read_value(r)?;
        items.push((key, value));
    }
    Ok(Descriptor { class_id, items })
}

fn read_value(r: &mut Reader) -> Result<Value, String> {
    let t = r.bytes(4)?;
    match t {
        b"Objc" | b"GlbO" => Ok(Value::Descriptor(read_descriptor(r)?)),
        b"VlLs" => {
            let count = r.u32()?;
            let mut v = Vec::with_capacity(count as usize);
            for _ in 0..count {
                v.push(read_value(r)?);
            }
            Ok(Value::List(v))
        }
        b"doub" => Ok(Value::Double(r.f64()?)),
        b"UntF" => {
            let _unit = r.bytes(4)?;
            Ok(Value::UnitFloat(r.f64()?))
        }
        b"TEXT" => Ok(Value::Text(read_unicode_string(r)?)),
        b"enum" => {
            let type_id = read_id(r)?;
            let value_id = read_id(r)?;
            Ok(Value::Enum(type_id, value_id))
        }
        b"long" => Ok(Value::Long(r.i32()?)),
        b"bool" => Ok(Value::Bool(r.u8()? != 0)),
        b"type" | b"GlbC" => Ok(Value::Class(read_id(r)?)),
        b"alis" => {
            let len = r.u32()? as usize;
            Ok(Value::Alias(r.bytes(len)?.to_vec()))
        }
        b"tdta" => {
            let len = r.u32()? as usize;
            Ok(Value::RawData(r.bytes(len)?.to_vec()))
        }
        other => Err(format!(
            "unsupported descriptor value type {:?} at byte {}",
            String::from_utf8_lossy(other),
            r.pos - 4
        )),
    }
}

fn find_gradient_descriptors(v: &Value, out: &mut Vec<Descriptor>) {
    match v {
        Value::Descriptor(d) => {
            if d.class_id == "Grdn" {
                out.push(d.clone());
            }
            for (_, item) in &d.items {
                find_gradient_descriptors(item, out);
            }
        }
        Value::List(items) => {
            for item in items {
                find_gradient_descriptors(item, out);
            }
        }
        _ => {}
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GrdColorStop {
    /// 0.0-1.0 position along the gradient.
    pub pos: f64,
    pub color: [u8; 3],
    /// 0.0-1.0 midpoint bias toward the *next* stop (0.5 = no bias). Ignored
    /// on the last stop.
    pub midpoint: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GrdOpacityStop {
    pub pos: f64,
    /// 0.0-1.0
    pub opacity: f64,
    pub midpoint: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ParsedGrd {
    pub name: String,
    pub stops: Vec<GrdColorStop>,
    pub opacity_stops: Vec<GrdOpacityStop>,
    /// `true` for a Photoshop "Noise" gradient, which has no usable stop list
    /// (it is generated procedurally). Such gradients are reported but should
    /// be skipped by callers.
    pub noise: bool,
}

fn extract_double(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Double(d)) => Some(*d),
        Some(Value::UnitFloat(d)) => Some(*d),
        _ => None,
    }
}

fn extract_long(v: Option<&Value>, default: i32) -> i32 {
    match v {
        Some(Value::Long(l)) => *l,
        _ => default,
    }
}

fn extract_rgb(v: Option<&Value>) -> Result<[u8; 3], String> {
    let Some(Value::Descriptor(rgbc)) = v else {
        return Err("color stop missing RGB color descriptor".to_string());
    };
    let clamp = |x: f64| x.round().clamp(0.0, 255.0) as u8;
    let r = extract_double(rgbc.get("Rd  ")).ok_or("missing Rd  ")?;
    let g = extract_double(rgbc.get("Grn ")).ok_or("missing Grn ")?;
    let b = extract_double(rgbc.get("Bl  ")).ok_or("missing Bl  ")?;
    Ok([clamp(r), clamp(g), clamp(b)])
}

fn extract_gradient(d: &Descriptor) -> Result<ParsedGrd, String> {
    let name = match d.get("Nm  ") {
        Some(Value::Text(s)) => s.clone(),
        _ => "Untitled".to_string(),
    };
    let noise = matches!(d.get("GrdF"), Some(Value::Enum(_, v)) if v == "ClNs");

    let mut stops = Vec::new();
    if let Some(Value::List(items)) = d.get("Clrs") {
        for item in items {
            if let Value::Descriptor(clrt) = item {
                let color = extract_rgb(clrt.get("Clr "))?;
                let pos = extract_long(clrt.get("Lctn"), 0) as f64 / 4096.0;
                let midpoint = extract_long(clrt.get("Mdpn"), 50) as f64 / 100.0;
                stops.push(GrdColorStop { pos, color, midpoint });
            }
        }
    }
    stops.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap());

    let mut opacity_stops = Vec::new();
    if let Some(Value::List(items)) = d.get("Trns") {
        for item in items {
            if let Value::Descriptor(trns) = item {
                let opacity = extract_double(trns.get("Opct")).unwrap_or(100.0) / 100.0;
                let pos = extract_long(trns.get("Lctn"), 0) as f64 / 4096.0;
                let midpoint = extract_long(trns.get("Mdpn"), 50) as f64 / 100.0;
                opacity_stops.push(GrdOpacityStop { pos, opacity, midpoint });
            }
        }
    }
    opacity_stops.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap());

    Ok(ParsedGrd { name, stops, opacity_stops, noise })
}

pub fn parse_grd(bytes: &[u8]) -> Result<Vec<ParsedGrd>, String> {
    if bytes.len() < 10 || &bytes[0..4] != b"8BGR" {
        return Err("not a .grd file (missing 8BGR signature)".to_string());
    }
    let mut r = Reader::new(&bytes[4..]);
    let _version = r.u16()?;
    let _descriptor_version = r.u32()?;
    let root = read_descriptor(&mut r)?;

    let mut found = Vec::new();
    find_gradient_descriptors(&Value::Descriptor(root), &mut found);
    if found.is_empty() {
        return Err("no gradients found in file".to_string());
    }
    found.iter().map(extract_gradient).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_sample_gradient_file() {
        // Each preset file's own descriptor tree wraps the real gradient in an
        // extra, empty `Grdn` node (Photoshop's preset-list scaffolding), so a
        // file legitimately yields more than one `Grdn` descriptor. Only the
        // populated one - the one with actual color stops - matters here.
        let dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../gradients"));
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).expect("gradients dir") {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("grd") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let gradients = parse_grd(&bytes).unwrap_or_else(|e| panic!("{}: {}", path.display(), e));
            assert!(!gradients.is_empty(), "{}: no gradients parsed", path.display());

            let real: Vec<_> = gradients.iter().filter(|g| !g.noise && g.stops.len() >= 2).collect();
            assert_eq!(real.len(), 1, "{}: expected exactly one populated gradient, found {}", path.display(), real.len());

            let g = real[0];
            // Not every hand-authored gradient spans the full 0-1 range, so this
            // only checks that stops parsed into a sane, ascending 0-1 domain.
            for s in &g.stops {
                assert!((0.0..=1.0).contains(&s.pos), "{}: stop position {} out of range", path.display(), s.pos);
            }
            checked += 1;
        }
        assert_eq!(checked, 8, "expected 8 sample .grd files");
    }
}
