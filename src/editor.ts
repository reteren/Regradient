// Photoshop-style gradient editor: a stop ramp with draggable color/opacity
// stops and midpoint diamonds, plus an HSV color picker (square + hue rail +
// hex/RGB fields + a base palette) below it. Built once into #editorOverlay
// and reused for every open() call.

import { ColorStop, GradientDef, OpacityStop, getGradient, saveGradient } from "./api";
import {
  RGB,
  applyLumaRemap,
  buildColorLut,
  buildOpacityLut,
  clamp01,
  colorAt,
  hexToRgb,
  hsvToRgb,
  opacityAt,
  rgbToHex,
  rgbToHsv,
} from "./colormath";
import { getPreviewSubject } from "./previewSubject";

// Shown when no photo is loaded in the main app yet, so the editor's live
// preview always has something to render the gradient onto.
const FALLBACK_PREVIEW_URL = "/ckud.png";

const BASE_PALETTE: RGB[] = [
  [0, 0, 0], [26, 26, 26], [64, 64, 64], [128, 128, 128], [191, 191, 191], [255, 255, 255],
  [60, 152, 152], [122, 219, 219], [237, 28, 36], [255, 127, 39], [255, 242, 0], [57, 181, 74],
  [0, 168, 89], [0, 174, 239], [63, 72, 204], [163, 73, 164], [255, 174, 201], [136, 0, 21],
];

function defaultDef(): GradientDef {
  return {
    name: "New gradient",
    stops: [
      { pos: 0, color: [0, 0, 0], midpoint: 0.5 },
      { pos: 1, color: [255, 255, 255], midpoint: 0.5 },
    ],
    opacityStops: [],
  };
}

let overlay: HTMLDivElement;
let nameInput: HTMLInputElement;
let bar: HTMLDivElement;
let barCanvas: HTMLCanvasElement;
let opacityLane: HTMLDivElement;
let stopLayer: HTMLDivElement;
let midpointLayer: HTMLDivElement;
let opacityLayer: HTMLDivElement;
let stopFields: HTMLDivElement;
let previewCanvas: HTMLCanvasElement;
let colorPicker: HTMLDivElement;
let opacityFields: HTMLDivElement;
let svCanvas: HTMLCanvasElement;
let svCursor: HTMLDivElement;
let hueRail: HTMLDivElement;
let hueCursor: HTMLDivElement;
let hexInput: HTMLInputElement;
let rInput: HTMLInputElement, gInput: HTMLInputElement, bInput: HTMLInputElement;
let paletteEl: HTMLDivElement;
let statusEl: HTMLSpanElement;
let deleteStopBtn: HTMLButtonElement;
let saveBtn: HTMLButtonElement;

let def: GradientDef = defaultDef();
let editingId: string | null = null;
let onSaved: (() => void) | null = null;
let selectedStop: number | null = 0;
let selectedOpacity: number | null = null;
let hue = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function build() {
  overlay = document.getElementById("editorOverlay") as HTMLDivElement;

  const header = el("div", "titlebar");
  const nameRow = el("div", "editorNameRow");
  nameInput = el("input", "textInput");
  nameInput.type = "text";
  const closeBtn = el("button", "iconButton");
  closeBtn.textContent = "✕";
  closeBtn.title = "Close without saving";
  closeBtn.addEventListener("click", () => close());
  nameRow.append(nameInput);
  header.append(nameRow, closeBtn);
  header.style.padding = "12px 14px 0";

  const body = el("div", "editorBody");
  const left = el("div", "editorLeft");
  const right = el("div", "editorRight");

  // ---- gradient bar ----
  const barWrap = el("div", "gradientBarWrap");
  opacityLane = el("div", "opacityLane");
  opacityLayer = el("div");
  opacityLane.appendChild(opacityLayer);
  bar = el("div", "gradientBar");
  barCanvas = el("canvas");
  stopLayer = el("div");
  midpointLayer = el("div");
  bar.append(barCanvas, midpointLayer, stopLayer);
  barWrap.append(opacityLane, bar);

  const hint = el("p", "editorHint");
  hint.textContent =
    "Click the bar for a new color stop, click the narrow lane above for an opacity stop. Right-click a stop to delete it.";

  stopFields = el("div");
  stopFields.style.display = "flex";
  stopFields.style.flexDirection = "column";
  stopFields.style.gap = "8px";

  const previewWrap = el("div", "editorPreviewWrap");
  previewCanvas = el("canvas");
  previewWrap.appendChild(previewCanvas);

  left.append(barWrap, hint, stopFields, previewWrap);

  // ---- color picker ----
  colorPicker = el("div", "colorPicker");
  const svWrap = el("div", "svSquareWrap");
  svCanvas = el("canvas");
  svCursor = el("div", "svCursor");
  svWrap.append(svCanvas, svCursor);

  hueRail = el("div", "hueRail");
  hueCursor = el("div", "hueCursor");
  hueRail.appendChild(hueCursor);

  const hexRow = el("div", "hexRow");
  const hexLabel = el("span");
  hexLabel.textContent = "HEX";
  hexLabel.style.width = "28px";
  hexInput = el("input", "textInput hexInput");
  hexInput.maxLength = 7;
  const swatchPreview = el("span", "swatch");
  swatchPreview.id = "editorSwatchPreview";
  hexRow.append(hexLabel, hexInput, swatchPreview);

  const rgbRow = el("div", "rgbRow");
  const mkRgbField = (label: string) => {
    const wrap = el("span", "rgbRow");
    const l = el("span", "rgbLabel");
    l.textContent = label;
    const input = el("input", "numberInput");
    input.type = "number";
    input.min = "0";
    input.max = "255";
    wrap.append(l, input);
    return { wrap, input };
  };
  const rField = mkRgbField("R");
  const gField = mkRgbField("G");
  const bField = mkRgbField("B");
  rInput = rField.input;
  gInput = gField.input;
  bInput = bField.input;
  rgbRow.append(rField.wrap, gField.wrap, bField.wrap);

  paletteEl = el("div", "palette inline");
  for (const rgb of BASE_PALETTE) {
    const swatch = el("button", "swatchBtn");
    swatch.type = "button";
    swatch.style.backgroundColor = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    swatch.addEventListener("click", () => applyColor(rgb));
    paletteEl.appendChild(swatch);
  }

  colorPicker.append(svWrap, hueRail, hexRow, rgbRow, paletteEl);

  opacityFields = el("div");
  opacityFields.style.display = "none";
  opacityFields.style.flexDirection = "column";
  opacityFields.style.gap = "8px";
  const opacityLabel = el("p", "panelLabel");
  opacityLabel.textContent = "Stop opacity";
  const opacityRow = el("div", "stopFieldsRow");
  const opacitySliderLabel = el("span", "label");
  opacitySliderLabel.textContent = "Value";
  const opacitySlider = el("input", "slider");
  opacitySlider.type = "range";
  opacitySlider.min = "0";
  opacitySlider.max = "100";
  opacitySlider.id = "opacitySlider";
  const opacityValue = el("span", "sliderValue");
  opacityValue.id = "opacitySliderValue";
  opacityRow.append(opacitySliderLabel, opacitySlider, opacityValue);
  opacityFields.append(opacityLabel, opacityRow);

  right.append(colorPicker, opacityFields);

  body.append(left, right);

  const footer = el("div", "editorFooter");
  statusEl = el("span", "status");
  deleteStopBtn = el("button", "button compact danger");
  deleteStopBtn.textContent = "Delete stop";
  deleteStopBtn.addEventListener("click", () => deleteSelected());
  const cancelBtn = el("button", "button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => close());
  saveBtn = el("button", "button primary");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => void save());
  footer.append(statusEl, deleteStopBtn, cancelBtn, saveBtn);

  overlay.append(header, body, footer);

  wireInteractions();
}

// ---------------------------------------------------------------- rendering

// Just the pixel data - safe to call on every pointermove during a drag. The
// handle-rendering functions below rebuild their DOM subtree from scratch
// (innerHTML = ""), which destroys whichever handle currently holds pointer
// capture; calling them mid-drag silently kills the drag after the first
// move event. Only renderBar() (the full rebuild) may call them - drag
// handlers update their own handle's position directly instead.
function renderBarPixels() {
  const w = barCanvas.clientWidth || 400;
  const h = barCanvas.clientHeight || 36;
  barCanvas.width = w;
  barCanvas.height = h;
  const ctx = barCanvas.getContext("2d")!;
  const image = ctx.createImageData(w, 1);
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1);
    const [r, g, b] = colorAt(def.stops, t);
    const a = def.opacityStops.length ? opacityAt(def.opacityStops, t) : 1;
    image.data[x * 4] = r;
    image.data[x * 4 + 1] = g;
    image.data[x * 4 + 2] = b;
    image.data[x * 4 + 3] = Math.round(a * 255);
  }
  ctx.putImageData(image, 0, 0);
  ctx.drawImage(barCanvas, 0, 0, w, 1, 0, 0, w, h);
  void renderPreview();
}

function renderBar() {
  renderBarPixels();
  renderOpacityLane();
  renderStopHandles();
  renderMidpointHandles();
  renderOpacityHandles();
}

// Cached by URL so switching gradients (or the main app's active photo)
// mid-session doesn't redecode the same image every frame of a drag.
const previewImages = new Map<string, HTMLImageElement>();

function loadPreviewImage(url: string): Promise<HTMLImageElement> {
  const cached = previewImages.get(url);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      previewImages.set(url, img);
      resolve(img);
    };
    img.src = url;
  });
}

// Renders the gradient currently being edited (unsaved - built straight from
// `def`, not a round trip through the backend) onto whatever photo is active
// in the main app, or the bundled duck placeholder if none is loaded yet.
let previewToken = 0;
async function renderPreview() {
  const token = ++previewToken;
  const url = getPreviewSubject() ?? FALLBACK_PREVIEW_URL;
  const img = await loadPreviewImage(url);
  if (token !== previewToken) return;

  previewCanvas.width = img.naturalWidth;
  previewCanvas.height = img.naturalHeight;
  const ctx = previewCanvas.getContext("2d")!;
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  ctx.drawImage(img, 0, 0);

  const frame = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
  applyLumaRemap(frame, buildColorLut(def.stops), buildOpacityLut(def.opacityStops));
  ctx.putImageData(frame, 0, 0);
}

function renderOpacityLane() {
  opacityLayer.innerHTML = "";
  const steps = 64;
  const bg = el("div");
  bg.style.position = "absolute";
  bg.style.inset = "0";
  let gradientStops = "";
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = def.opacityStops.length ? opacityAt(def.opacityStops, t) : 1;
    gradientStops += `${i > 0 ? "," : ""} rgba(255,255,255,${a}) ${(t * 100).toFixed(2)}%`;
  }
  bg.style.background = `linear-gradient(to right,${gradientStops})`;
  opacityLayer.appendChild(bg);
}

function renderStopHandles() {
  stopLayer.innerHTML = "";
  def.stops.forEach((stop, i) => {
    const handle = el("div", "stopHandle" + (selectedStop === i ? " active" : ""));
    handle.style.left = `${stop.pos * 100}%`;
    const colorBox = el("span", "stopColor");
    colorBox.style.backgroundColor = `rgb(${stop.color[0]},${stop.color[1]},${stop.color[2]})`;
    handle.appendChild(colorBox);
    handle.addEventListener("pointerdown", (e) => startDragStop(e, i));
    handle.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      selectedStop = i;
      selectedOpacity = null;
      deleteSelected();
    });
    stopLayer.appendChild(handle);
  });
}

function renderMidpointHandles() {
  midpointLayer.innerHTML = "";
  const sorted = [...def.stops].sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    const pos = a.pos + (b.pos - a.pos) * a.midpoint;
    const handle = el("div", "midpointHandle");
    handle.style.left = `${pos * 100}%`;
    handle.addEventListener("pointerdown", (e) => startDragMidpoint(e, a, b));
    midpointLayer.appendChild(handle);
  }
}

function renderOpacityHandles() {
  const existing = opacityLane.querySelectorAll(".opacityHandle");
  existing.forEach((n) => n.remove());
  def.opacityStops.forEach((stop, i) => {
    const handle = el("div", "opacityHandle" + (selectedOpacity === i ? " active" : ""));
    handle.style.left = `${stop.pos * 100}%`;
    handle.addEventListener("pointerdown", (e) => startDragOpacity(e, i));
    handle.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      selectedOpacity = i;
      selectedStop = null;
      deleteSelected();
    });
    opacityLane.appendChild(handle);
  });
}

function renderStopFields() {
  stopFields.innerHTML = "";
  if (selectedStop !== null && def.stops[selectedStop]) {
    const row = el("div", "stopFieldsRow");
    const label = el("span", "label");
    label.textContent = `Stop ${selectedStop + 1}/${def.stops.length}`;
    const posInput = el("input", "numberInput");
    posInput.type = "number";
    posInput.min = "0";
    posInput.max = "100";
    posInput.value = String(Math.round(def.stops[selectedStop].pos * 100));
    posInput.addEventListener("change", () => {
      if (selectedStop === null) return;
      def.stops[selectedStop].pos = clamp01(Number(posInput.value) / 100);
      renderBar();
    });
    const posSuffix = el("span");
    posSuffix.textContent = "%";
    row.append(label, posInput, posSuffix);
    stopFields.appendChild(row);
    deleteStopBtn.disabled = def.stops.length <= 2;
    deleteStopBtn.style.display = "flex";
  } else if (selectedOpacity !== null) {
    deleteStopBtn.disabled = false;
    deleteStopBtn.style.display = "flex";
  } else {
    deleteStopBtn.style.display = "none";
  }
}

function syncColorPickerFromSelection() {
  colorPicker.style.display = selectedStop !== null ? "flex" : "none";
  opacityFields.style.display = selectedOpacity !== null ? "flex" : "none";

  if (selectedStop !== null && def.stops[selectedStop]) {
    const [r, g, b] = def.stops[selectedStop].color;
    const hsv = rgbToHsv([r, g, b]);
    hue = hsv.h;
    rInput.value = String(r);
    gInput.value = String(g);
    bInput.value = String(b);
    hexInput.value = rgbToHex([r, g, b]);
    (document.getElementById("editorSwatchPreview") as HTMLElement).style.backgroundColor = `rgb(${r},${g},${b})`;
    renderSvSquare();
    positionPickerCursors(hsv.s, hsv.v);
  } else if (selectedOpacity !== null && def.opacityStops[selectedOpacity]) {
    const slider = document.getElementById("opacitySlider") as HTMLInputElement;
    const value = document.getElementById("opacitySliderValue") as HTMLElement;
    const pct = Math.round(def.opacityStops[selectedOpacity].opacity * 100);
    slider.value = String(pct);
    value.textContent = `${pct}%`;
  }
}

function renderSvSquare() {
  const w = 200, h = 150;
  svCanvas.width = w;
  svCanvas.height = h;
  const ctx = svCanvas.getContext("2d")!;
  const hueRgb = hsvToRgb({ h: hue, s: 1, v: 1 });
  const grdWhite = ctx.createLinearGradient(0, 0, w, 0);
  grdWhite.addColorStop(0, "rgba(255,255,255,1)");
  grdWhite.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = `rgb(${hueRgb[0]},${hueRgb[1]},${hueRgb[2]})`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = grdWhite;
  ctx.fillRect(0, 0, w, h);
  const grdBlack = ctx.createLinearGradient(0, 0, 0, h);
  grdBlack.addColorStop(0, "rgba(0,0,0,0)");
  grdBlack.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = grdBlack;
  ctx.fillRect(0, 0, w, h);
}

function positionPickerCursors(s: number, v: number) {
  svCursor.style.left = `${s * 100}%`;
  svCursor.style.top = `${(1 - v) * 100}%`;
  hueCursor.style.left = `${(hue / 360) * 100}%`;
}

// ---------------------------------------------------------------- color application

function applyColor(rgb: RGB) {
  if (selectedStop === null) return;
  def.stops[selectedStop].color = rgb;
  syncColorPickerFromSelection();
  renderBar();
}

function applyHsv(s: number, v: number) {
  applyColor(hsvToRgb({ h: hue, s, v }));
}

// ---------------------------------------------------------------- drag handling

function clampToBar(clientX: number, track: HTMLElement): number {
  const rect = track.getBoundingClientRect();
  return clamp01((clientX - rect.left) / rect.width);
}

function startDragStop(e: PointerEvent, index: number) {
  e.preventDefault();
  // Capture first: a full renderBar() (as this used to do before capturing)
  // rebuilds stopLayer from scratch, detaching `target` from the document -
  // per the Pointer Events spec that implicitly releases any capture already
  // taken on it, so the drag would never actually start. Highlight the
  // selection by toggling classes on the existing handles instead of
  // rebuilding them.
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  stopLayer.querySelector(".stopHandle.active")?.classList.remove("active");
  opacityLane.querySelector(".opacityHandle.active")?.classList.remove("active");
  target.classList.add("active");

  selectedStop = index;
  selectedOpacity = null;
  renderStopFields();
  syncColorPickerFromSelection();

  const onMove = (ev: PointerEvent) => {
    def.stops[index].pos = clampToBar(ev.clientX, bar);
    target.style.left = `${def.stops[index].pos * 100}%`;
    renderBarPixels();
    renderMidpointHandles();
    renderStopFields();
  };
  const onUp = () => {
    target.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startDragMidpoint(e: PointerEvent, a: ColorStop, b: ColorStop) {
  e.preventDefault();
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => {
    const t = clampToBar(ev.clientX, bar);
    const span = b.pos - a.pos;
    const local = span <= 0 ? 0.5 : (t - a.pos) / span;
    a.midpoint = Math.min(0.95, Math.max(0.05, local));
    target.style.left = `${(a.pos + (b.pos - a.pos) * a.midpoint) * 100}%`;
    renderBarPixels();
  };
  const onUp = () => {
    target.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startDragOpacity(e: PointerEvent, index: number) {
  e.preventDefault();
  // Same ordering fix as startDragStop: capture before any DOM rebuild.
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  opacityLane.querySelectorAll(".opacityHandle.active").forEach((n) => n.classList.remove("active"));
  stopLayer.querySelector(".stopHandle.active")?.classList.remove("active");
  target.classList.add("active");

  selectedOpacity = index;
  selectedStop = null;
  renderStopFields();
  syncColorPickerFromSelection();

  const onMove = (ev: PointerEvent) => {
    def.opacityStops[index].pos = clampToBar(ev.clientX, opacityLane);
    target.style.left = `${def.opacityStops[index].pos * 100}%`;
    renderBarPixels();
    renderOpacityLane();
  };
  const onUp = () => {
    target.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function deleteSelected() {
  if (selectedStop !== null) {
    if (def.stops.length <= 2) return;
    def.stops.splice(selectedStop, 1);
    selectedStop = Math.max(0, selectedStop - 1);
  } else if (selectedOpacity !== null) {
    def.opacityStops.splice(selectedOpacity, 1);
    selectedOpacity = null;
  }
  renderBar();
  renderStopFields();
  syncColorPickerFromSelection();
}

// ---------------------------------------------------------------- static interactions (bound once)

function wireInteractions() {
  bar.addEventListener("pointerdown", (e) => {
    if (e.target !== barCanvas) return; // handles have their own listeners
    const t = clampToBar(e.clientX, bar);
    const color = colorAt(def.stops, t);
    const newStop: ColorStop = { pos: t, color, midpoint: 0.5 };
    def.stops.push(newStop);
    def.stops.sort((a, b) => a.pos - b.pos);
    selectedStop = def.stops.indexOf(newStop);
    selectedOpacity = null;
    renderBar();
    renderStopFields();
    syncColorPickerFromSelection();
  });

  opacityLane.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).classList.contains("opacityHandle")) return;
    const t = clampToBar(e.clientX, opacityLane);
    const opacity = opacityAt(def.opacityStops, t);
    const newStop: OpacityStop = { pos: t, opacity, midpoint: 0.5 };
    def.opacityStops.push(newStop);
    def.opacityStops.sort((a, b) => a.pos - b.pos);
    selectedOpacity = def.opacityStops.indexOf(newStop);
    selectedStop = null;
    renderBar();
    renderStopFields();
    syncColorPickerFromSelection();
  });

  const svWrap = svCanvas.parentElement!;
  const dragSv = (e: PointerEvent) => {
    const rect = svWrap.getBoundingClientRect();
    const s = clamp01((e.clientX - rect.left) / rect.width);
    const v = 1 - clamp01((e.clientY - rect.top) / rect.height);
    positionPickerCursors(s, v);
    applyHsv(s, v);
  };
  svWrap.addEventListener("pointerdown", (e) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragSv(e);
    const onMove = (ev: PointerEvent) => dragSv(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  const dragHue = (e: PointerEvent) => {
    const rect = hueRail.getBoundingClientRect();
    hue = clamp01((e.clientX - rect.left) / rect.width) * 360;
    hueCursor.style.left = `${(hue / 360) * 100}%`;
    renderSvSquare();
    if (selectedStop !== null) {
      const current = rgbToHsv(def.stops[selectedStop].color);
      applyHsv(current.s, current.v);
    }
  };
  hueRail.addEventListener("pointerdown", (e) => {
    hueRail.setPointerCapture(e.pointerId);
    dragHue(e);
    const onMove = (ev: PointerEvent) => dragHue(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  hexInput.addEventListener("change", () => {
    const rgb = hexToRgb(hexInput.value);
    if (rgb) applyColor(rgb);
  });
  const rgbInputs: Array<[HTMLInputElement, number]> = [
    [rInput, 0],
    [gInput, 1],
    [bInput, 2],
  ];
  for (const [input, idx] of rgbInputs) {
    input.addEventListener("change", () => {
      if (selectedStop === null) return;
      const color = [...def.stops[selectedStop].color] as RGB;
      color[idx] = Math.min(255, Math.max(0, Number(input.value) || 0));
      applyColor(color);
    });
  }

  const opacitySlider = () => document.getElementById("opacitySlider") as HTMLInputElement;
  overlay.addEventListener("input", (e) => {
    if ((e.target as HTMLElement)?.id === "opacitySlider" && selectedOpacity !== null) {
      const pct = Number(opacitySlider().value);
      def.opacityStops[selectedOpacity].opacity = pct / 100;
      (document.getElementById("opacitySliderValue") as HTMLElement).textContent = `${pct}%`;
      renderBar();
    }
  });
}

// ---------------------------------------------------------------- lifecycle

// isPreset: editing a built-in .grd rather than a custom gradient. Saving
// always writes a fresh copy in that case (the backend never overwrites a
// .grd), so the name field is pre-filled with a "(copy)" suffix - otherwise
// the new entry would sit in the list under the exact same name as the
// original with nothing but the edit/delete icons to tell them apart.
export async function openEditor(id: string | null, onSavedCallback: () => void, isPreset = false) {
  if (!overlay) build();
  editingId = id;
  onSaved = onSavedCallback;
  statusEl.textContent = "";

  if (id) {
    try {
      def = await getGradient(id);
      if (isPreset) def = { ...def, name: `${def.name} (copy)` };
    } catch (e) {
      def = defaultDef();
      statusEl.textContent = String(e);
    }
  } else {
    def = defaultDef();
  }

  nameInput.value = def.name;
  selectedStop = def.stops.length > 0 ? 0 : null;
  selectedOpacity = null;

  overlay.classList.add("open");
  requestAnimationFrame(() => {
    renderBar();
    renderStopFields();
    syncColorPickerFromSelection();
  });
}

function close() {
  overlay.classList.remove("open");
}

async function save() {
  def.name = nameInput.value.trim() || "Untitled";
  if (def.stops.length < 2) {
    statusEl.textContent = "Need at least 2 color stops";
    return;
  }
  saveBtn.disabled = true;
  try {
    await saveGradient(editingId, def);
    close();
    onSaved?.();
  } catch (e) {
    statusEl.textContent = String(e);
  } finally {
    saveBtn.disabled = false;
  }
}
