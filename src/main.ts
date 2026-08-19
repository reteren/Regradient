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
  GradientMeta,
  ImageInfo,
  listGradients,
  loadImageClipboard,
  loadImagePath,
  loadSettings,
  runExport,
  saveSettings,
} from "./api";
import { openEditor } from "./editor";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dropzone = $<HTMLDivElement>("dropzone");
const dropzoneEmpty = $<HTMLDivElement>("dropzoneEmpty");
const previewImg = $<HTMLImageElement>("previewImg");
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

let currentImage: ImageInfo | null = null;
let allGradients: GradientMeta[] = [];
const selected = new Set<string>();
let searchTerm = "";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp", "gif", "tiff"];

// ---------------------------------------------------------------- window chrome

$<HTMLButtonElement>("minimizeBtn").addEventListener("click", () => {
  void getCurrentWindow().minimize();
});
$<HTMLButtonElement>("closeBtn").addEventListener("click", () => {
  void getCurrentWindow().close();
});

// ---------------------------------------------------------------- image loading

function showImage(info: ImageInfo) {
  currentImage = info;
  dropzoneEmpty.style.display = "none";
  previewImg.src = info.preview;
  previewImg.style.display = "block";
  previewMeta.textContent = `${info.stem} · ${info.width}×${info.height}`;
  previewMeta.style.display = "block";
  clearImageBtn.style.display = "flex";
  updateExportButtonState();
}

function clearImage() {
  currentImage = null;
  previewImg.style.display = "none";
  previewImg.src = "";
  previewMeta.style.display = "none";
  clearImageBtn.style.display = "none";
  dropzoneEmpty.style.display = "flex";
  updateExportButtonState();
}

async function loadFromPath(path: string) {
  try {
    const info = await loadImagePath(path);
    showImage(info);
    setExportStatus("");
  } catch (e) {
    setExportStatus(String(e));
  }
}

clearImageBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  clearImage();
});

browseImageBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const path = await open({
    multiple: false,
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
  });
  if (typeof path === "string") await loadFromPath(path);
});

dropzone.addEventListener("click", async (e) => {
  if (currentImage || e.target !== dropzone) return;
  const path = await open({
    multiple: false,
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
  });
  if (typeof path === "string") await loadFromPath(path);
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
    if (paths && paths.length > 0) void loadFromPath(paths[0]);
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
      showImage(info);
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
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderGradientList();
  updateExportButtonState();
}

async function refreshGradients() {
  allGradients = await listGradients();
  const validIds = new Set(allGradients.map((g) => g.id));
  for (const id of [...selected]) if (!validIds.has(id)) selected.delete(id);
  renderGradientList();
  updateExportButtonState();
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
  exportBtn.disabled = !currentImage || !exportPathInput.value.trim() || !hasWork;
}

exportBtn.addEventListener("click", async () => {
  if (!currentImage) return;
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
  updateExportButtonState();
})();
