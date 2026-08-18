// Color-space conversions for the HSV picker, plus the gradient LUT math
// used to render the editor's live preview without a round trip to Rust on
// every drag frame. The interpolation formula here must stay identical to
// `bias()`/`color_at()` in src-tauri/src/gradient.rs - it is the same
// published midpoint-bias curve, not project-specific logic, so the small
// duplication is safe.

export type RGB = [number, number, number];

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export interface HSV {
  h: number; // 0-360
  s: number; // 0-1
  v: number; // 0-1
}

export function rgbToHsv([r, g, b]: RGB): HSV {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rf) h = ((gf - bf) / d) % 6;
    else if (max === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Piecewise power-curve reparametrisation - must match gradient.rs::bias. */
export function bias(t: number, midpoint: number): number {
  const m = Math.min(0.9999, Math.max(0.0001, midpoint));
  if (Math.abs(m - 0.5) < 1e-9) return t;
  return Math.pow(clamp01(t), Math.log(0.5) / Math.log(m));
}

function lerpByte(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

export interface StopLike {
  pos: number;
  midpoint: number;
}

export function colorAt(stops: (StopLike & { color: RGB })[], t: number): RGB {
  if (stops.length === 0) return [0, 0, 0];
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  if (sorted.length === 1 || t <= sorted[0].pos) return sorted[0].color;
  const last = sorted[sorted.length - 1];
  if (t >= last.pos) return last.color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (t >= a.pos && t <= b.pos) {
      const span = b.pos - a.pos;
      const local = span <= 0 ? 1 : (t - a.pos) / span;
      const biased = bias(local, a.midpoint);
      return [
        lerpByte(a.color[0], b.color[0], biased),
        lerpByte(a.color[1], b.color[1], biased),
        lerpByte(a.color[2], b.color[2], biased),
      ];
    }
  }
  return last.color;
}

export function opacityAt(stops: (StopLike & { opacity: number })[], t: number): number {
  if (stops.length === 0) return 1;
  const sorted = [...stops].sort((a, b) => a.pos - b.pos);
  if (sorted.length === 1 || t <= sorted[0].pos) return sorted[0].opacity;
  const last = sorted[sorted.length - 1];
  if (t >= last.pos) return last.opacity;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (t >= a.pos && t <= b.pos) {
      const span = b.pos - a.pos;
      const local = span <= 0 ? 1 : (t - a.pos) / span;
      const biased = bias(local, a.midpoint);
      return a.opacity + (b.opacity - a.opacity) * biased;
    }
  }
  return last.opacity;
}
