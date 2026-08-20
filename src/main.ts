import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/700.css";
import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";

import {
  deleteGradient,
  ExportRequest,
  GradientLut,
  GradientMeta,
  ImageInfo,
  listGradients,
  loadImageClipboard,
  loadImagePath,
  loadSettings,
  removeImage,
  runExport,
  saveSettings,
  getGradientLut,
} from "./api";
import { openEditor } from "./editor";
import { applyLumaRemap } from "./colormath";
import { setPreviewSubject } from "./previewSubject";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const photoStrip = $<HTMLDivElement>("photoStrip");
const addPhotoBtn = $<HTMLButtonElement>("addPhotoBtn");

const dropzone = $<HTMLDivElement>("dropzone");
const dropzoneEmpty = $<HTMLDivElement>("dropzoneEmpty");
const previewStage = $<HTMLDivElement>("previewStage");
const previewCanvas = $<HTMLCanvasElement>("previewCanvas");
const previewMeta = $<HTMLSpanElement>("previewMeta");
const clearImageBtn = $<HTMLButtonElement>("clearImageBtn");
const browseImageBtn = $<HTMLButtonElement>("browseImageBtn");

const exportPathInput = $<HTMLInputElement>("exportPath");
const browsePathBtn = $<HTMLButtonElement>("browsePathBtn");
const wrapCheckbox = $<HTMLInputElement>("wrapInGradientedImages");
const perGradientCheckbox = $<HTMLInputElement>("perGradientFolders");
const exportDefaultCheckbox = $<HTMLInputElement>("exportDefault");
const exportStatus = $<HTMLSpanElement>("exportStatus");
const exportBtn = $<HTMLButtonElement>("exportBtn");

const gradientSearch = $<HTMLInputElement>("gradientSearch");
const gradientList = $<HTMLDivElement>("gradientList");
const gradientCount = $<HTMLSpanElement>("gradientCount");
const newGradientBtn = $<HTMLButtonElement>("newGradientBtn");

// ---------------------------------------------------------------- photo state

let photos: ImageInfo[] = [];
let activePhotoId: string | null = null;
const photoImages = new Map<string, HTMLImageElement>();

let allGradients: GradientMeta[] = [];
const selected = new Set<string>();
let searchTerm = "";

/// The gradient whose live preview is currently shown - always the most
/// recently *checked-on* gradient, per the user's request.
let previewGradientId: string | null = null;
const lutCache = new Map<string, GradientLut>();

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp", "gif", "tiff"];

function lastOrNull<T>(items: T[]): T | null {
  return items.length > 0 ? items[items.length - 1] : null;
}

// ---------------------------------------------------------------- window chrome

$<HTMLButtonElement>("minimizeBtn").addEventListener("click", () => {
  void getCurrentWindow().minimize();
});
$<HTMLButtonElement>("closeBtn").addEventListener("click", () => {
  void getCurrentWindow().close();
});

// ---------------------------------------------------------------- zoom & pan

let zoom = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let dragPointerId = -1;
let dragStart = { x: 0, y: 0 };
let panStart = { x: 0, y: 0 };

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.12;

function resetView() {
  zoom = 1;
  panX = 0;
  panY = 0;
  applyTransform();
}

function applyTransform() {
  previewCanvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

previewStage.addEventListener(
  "wheel",
  (e) => {
    if (!activePhotoId) return;
    e.preventDefault();
    const rect = previewStage.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const contentX = (cx - panX) / zoom;
    const contentY = (cy - panY) / zoom;
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
    panX = cx - contentX * newZoom;
    panY = cy - contentY * newZoom;
    zoom = newZoom;
    applyTransform();
  },
  { passive: false },
);

previewStage.addEventListener("pointerdown", (e) => {
  if (!activePhotoId || e.button !== 0) return;
  dragging = true;
  dragPointerId = e.pointerId;
  dragStart = { x: e.clientX, y: e.clientY };
  panStart = { x: panX, y: panY };
  previewStage.setPointerCapture(e.pointerId);
  previewStage.classList.add("grabbing");
});

previewStage.addEventListener("pointermove", (e) => {
  if (!dragging || e.pointerId !== dragPointerId) return;
  panX = panStart.x + (e.clientX - dragStart.x);
  panY = panStart.y + (e.clientY - dragStart.y);
  applyTransform();
});

function endDrag() {
  dragging = false;
  previewStage.classList.remove("grabbing");
}
previewStage.addEventListener("pointerup", endDrag);
previewStage.addEventListener("pointercancel", endDrag);
previewStage.addEventListener("dblclick", resetView);

// ---------------------------------------------------------------- preview rendering

function getPhotoImage(photo: ImageInfo): Promise<HTMLImageElement> {
  const cached = photoImages.get(photo.id);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      photoImages.set(photo.id, img);
      resolve(img);
    };
    img.src = photo.preview;
  });
}

async function loadLut(id: string): Promise<GradientLut | null> {
  const cached = lutCache.get(id);
  if (cached) return cached;
  try {
    const lut = await getGradientLut(id);
    lutCache.set(id, lut);
    return lut;
  } catch {
    return null;
  }
}

let renderToken = 0;

async function renderPreview() {
  const token = ++renderToken;
  const photo = photos.find((p) => p.id === activePhotoId);
  setPreviewSubject(photo ? photo.preview : null);
  if (!photo) {
    previewStage.style.display = "none";
    dropzoneEmpty.style.display = "flex";
    previewMeta.style.display = "none";
    clearImageBtn.style.display = "none";
    return;
  }

  dropzoneEmpty.style.display = "none";
  previewStage.style.display = "flex";
  previewMeta.style.display = "block";
  clearImageBtn.style.display = "flex";
  previewMeta.textContent = `${photo.stem} · ${photo.width}×${photo.height}`;

  const img = await getPhotoImage(photo);
  if (token !== renderToken) return;

  previewCanvas.width = img.naturalWidth;
  previewCanvas.height = img.naturalHeight;
  const ctx = previewCanvas.getContext("2d")!;
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  ctx.drawImage(img, 0, 0);

  if (previewGradientId) {
    const lut = await loadLut(previewGradientId);
    if (token !== renderToken) return;
    if (lut) {
      const frame = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
      applyLumaRemap(frame, lut.colorLut, lut.opacityLut);
      ctx.putImageData(frame, 0, 0);
    }
  }
}

// ---------------------------------------------------------------- photo strip

function renderPhotoStrip() {
  photoStrip.innerHTML = "";
  for (const photo of photos) {
    const thumb = document.createElement("div");
    thumb.className = "photoThumb" + (photo.id === activePhotoId ? " active" : "");
    thumb.style.backgroundImage = `url("${photo.preview}")`;
    thumb.title = photo.stem;
    thumb.addEventListener("click", () => setActivePhoto(photo.id));

    const removeBtn = document.createElement("button");
    removeBtn.className = "photoThumbRemove";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void removePhoto(photo.id);
    });

    thumb.append(removeBtn);
    photoStrip.appendChild(thumb);
  }
}

function setActivePhoto(id: string | null) {
  activePhotoId = id;
  resetView();
  renderPhotoStrip();
  void renderPreview();
  updateExportButtonState();
}

async function removePhoto(id: string) {
  try {
    await removeImage(id);
  } catch (e) {
    setExportStatus(String(e));
    return;
  }
  photos = photos.filter((p) => p.id !== id);
  photoImages.delete(id);
  if (activePhotoId === id) {
    const next = photos[photos.length - 1] ?? null;
    setActivePhoto(next ? next.id : null);
  } else {
    renderPhotoStrip();
    updateExportButtonState();
  }
}

async function addPhotos(paths: string[]) {
  let lastId: string | null = null;
  const errors: string[] = [];
  for (const path of paths) {
    try {
      const info = await loadImagePath(path);
      photos.push(info);
      lastId = info.id;
    } catch (e) {
      errors.push(String(e));
    }
  }
  if (errors.length > 0) setExportStatus(errors.join("; "));
  else setExportStatus("");
  if (lastId) setActivePhoto(lastId);
  else {
    renderPhotoStrip();
    updateExportButtonState();
  }
}

// ---------------------------------------------------------------- image loading

clearImageBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (activePhotoId) void removePhoto(activePhotoId);
});

browseImageBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const paths = await open({
    multiple: true,
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
  });
  if (typeof paths === "string") await addPhotos([paths]);
  else if (Array.isArray(paths)) await addPhotos(paths);
});

addPhotoBtn.addEventListener("click", () => browseImageBtn.click());

dropzone.addEventListener("click", async (e) => {
  if (photos.length > 0 || e.target !== dropzone) return;
  const paths = await open({
    multiple: true,
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
  });
  if (typeof paths === "string") await addPhotos([paths]);
  else if (Array.isArray(paths)) await addPhotos(paths);
});

void getCurrentWebview().onDragDropEvent((event) => {
  const kind = event.payload.type;
  if (kind === "over") {
    dropzone.classList.add("dragOver");
  } else if (kind === "leave") {
    dropzone.classList.remove("dragOver");
  } else if (kind === "drop") {
    dropzone.classList.remove("dragOver");
    const paths = event.payload.paths;
    if (paths && paths.length > 0) void addPhotos(paths);
  }
});

window.addEventListener("keydown", (e) => {
  const isPaste = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v";
  if (!isPaste) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
  e.preventDefault();
  void (async () => {
    try {
      const info = await loadImageClipboard();
      photos.push(info);
      setActivePhoto(info.id);
      setExportStatus("");
    } catch (err) {
      setExportStatus(String(err));
    }
  })();
});

// ---------------------------------------------------------------- export path + checkboxes

browsePathBtn.addEventListener("click", async () => {
  const dir = await open({ directory: true });
  if (typeof dir === "string") {
    exportPathInput.value = dir;
    persistSettings();
    updateExportButtonState();
  }
});

exportPathInput.addEventListener("input", () => {
  persistSettings();
  updateExportButtonState();
});

for (const checkbox of [wrapCheckbox, perGradientCheckbox, exportDefaultCheckbox]) {
  checkbox.addEventListener("change", () => {
    persistSettings();
    updateExportButtonState();
  });
}

function persistSettings() {
  void saveSettings({
    exportPath: exportPathInput.value,
    wrapInGradientedImages: wrapCheckbox.checked,
    perGradientFolders: perGradientCheckbox.checked,
    exportDefault: exportDefaultCheckbox.checked,
  });
}

async function restoreSettings() {
  try {
    const s = await loadSettings();
    if (typeof s.exportPath === "string") exportPathInput.value = s.exportPath;
    if (typeof s.wrapInGradientedImages === "boolean") wrapCheckbox.checked = s.wrapInGradientedImages;
    if (typeof s.perGradientFolders === "boolean") perGradientCheckbox.checked = s.perGradientFolders;
    if (typeof s.exportDefault === "boolean") exportDefaultCheckbox.checked = s.exportDefault;
  } catch {
    // First run: no settings file yet, defaults from the markup stand.
  }
}

// ---------------------------------------------------------------- gradient list

function setExportStatus(text: string) {
  exportStatus.textContent = text;
}

function filteredGradients(): GradientMeta[] {
  const term = searchTerm.trim().toLowerCase();
  const list = term ? allGradients.filter((g) => g.name.toLowerCase().includes(term)) : allGradients;
  return list;
}

function renderGradientList() {
  const list = filteredGradients();
  gradientCount.textContent = `${allGradients.length}`;
  gradientList.innerHTML = "";

  list.forEach((g, i) => {
    const row = document.createElement("div");
    row.className = "gradientRow" + (selected.has(g.id) ? " selected" : "");
    row.dataset.id = g.id;

    const num = document.createElement("span");
    num.className = "gradientNum";
    num.textContent = `${i + 1}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(g.id);
    checkbox.style.flex = "none";
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => toggleSelection(g.id));

    const swatch = document.createElement("span");
    swatch.className = "gradientSwatch";
    swatch.style.backgroundImage = `url("${g.preview}")`;

    const name = document.createElement("span");
    name.className = "gradientName";
    name.textContent = g.name;
    name.title = g.name;

    const actions = document.createElement("span");
    actions.className = "gradientRowActions";
    // Editing a built-in .grd preset is allowed too - saving it writes a new
    // custom copy alongside the original rather than touching the .grd file
    // (the backend can't write that format), so only custom gradients get a
    // delete button.
    const editBtn = document.createElement("button");
    editBtn.className = "rowIconButton";
    editBtn.textContent = "✎";
    editBtn.title = "Edit";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void openEditor(g.id, refreshGradients, !g.editable);
    });
    actions.append(editBtn);
    if (g.editable) {
      const delBtn = document.createElement("button");
      delBtn.className = "rowIconButton";
      delBtn.textContent = "🗑";
      delBtn.title = "Delete";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void (async () => {
          if (!confirm(`Delete gradient "${g.name}"?`)) return;
          await deleteGradient(g.id);
          selected.delete(g.id);
          if (previewGradientId === g.id) previewGradientId = null;
          await refreshGradients();
        })();
      });
      actions.append(delBtn);
    } else {
      const tag = document.createElement("span");
      tag.className = "gradientTag";
      tag.textContent = "grd";
      actions.append(tag);
    }

    row.addEventListener("click", () => toggleSelection(g.id));
    row.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      void openEditor(g.id, refreshGradients, !g.editable);
    });
    row.append(num, checkbox, swatch, name, actions);
    gradientList.appendChild(row);
  });
}

function toggleSelection(id: string) {
  if (selected.has(id)) {
    selected.delete(id);
    if (previewGradientId === id) {
      previewGradientId = lastOrNull([...selected]);
    }
  } else {
    selected.add(id);
    previewGradientId = id;
  }
  renderGradientList();
  updateExportButtonState();
  void renderPreview();
}

async function refreshGradients() {
  allGradients = await listGradients();
  const validIds = new Set(allGradients.map((g) => g.id));
  for (const id of [...selected]) if (!validIds.has(id)) selected.delete(id);
  if (previewGradientId && !validIds.has(previewGradientId)) previewGradientId = lastOrNull([...selected]);
  // A saved/deleted gradient may have changed shape - never trust a stale LUT.
  lutCache.clear();
  renderGradientList();
  updateExportButtonState();
  void renderPreview();
}

gradientSearch.addEventListener("input", () => {
  searchTerm = gradientSearch.value;
  renderGradientList();
});

newGradientBtn.addEventListener("click", () => {
  void openEditor(null, refreshGradients);
});

// ---------------------------------------------------------------- export

function updateExportButtonState() {
  const hasWork = selected.size > 0 || exportDefaultCheckbox.checked;
  exportBtn.disabled = photos.length === 0 || !exportPathInput.value.trim() || !hasWork;
}

exportBtn.addEventListener("click", async () => {
  if (photos.length === 0) return;
  const request: ExportRequest = {
    outputDir: exportPathInput.value.trim(),
    gradientIds: [...selected],
    wrapInGradientedImages: wrapCheckbox.checked,
    perGradientFolders: perGradientCheckbox.checked,
    exportDefault: exportDefaultCheckbox.checked,
  };
  exportBtn.disabled = true;
  setExportStatus("Exporting…");
  try {
    const result = await runExport(request);
    if (result.errors.length > 0) {
      setExportStatus(`Done: ${result.written.length}, errors: ${result.errors.length}`);
      console.error(result.errors);
    } else {
      setExportStatus(`Done: ${result.written.length} files`);
    }
  } catch (e) {
    setExportStatus(String(e));
  } finally {
    updateExportButtonState();
  }
});

// ---------------------------------------------------------------- boot

void (async () => {
  await restoreSettings();
  await refreshGradients();
  renderPhotoStrip();
  void renderPreview();
  updateExportButtonState();
})();
