// Thin, typed wrappers around the Rust commands (see src-tauri/src/lib.rs).
// Shared between main.ts (shell) and editor.ts (gradient editor) so both
// speak the exact same request/response shapes.

import { invoke } from "@tauri-apps/api/core";

export interface ColorStop {
  pos: number;
  color: [number, number, number];
  midpoint: number;
}

export interface OpacityStop {
  pos: number;
  opacity: number;
  midpoint: number;
}

export interface GradientDef {
  name: string;
  stops: ColorStop[];
  opacityStops: OpacityStop[];
}

export interface GradientMeta {
  id: string;
  name: string;
  source: "grd" | "custom";
  editable: boolean;
  preview: string;
}

export interface ImageInfo {
  id: string;
  stem: string;
  width: number;
  height: number;
  preview: string;
}

export interface GradientLut {
  colorLut: [number, number, number][];
  opacityLut: number[];
}

export interface ExportRequest {
  outputDir: string;
  gradientIds: string[];
  wrapInGradientedImages: boolean;
  perGradientFolders: boolean;
  exportDefault: boolean;
}

export interface ExportResult {
  written: string[];
  errors: string[];
}

export const listGradients = () => invoke<GradientMeta[]>("list_gradients");

export const getGradient = (id: string) => invoke<GradientDef>("get_gradient", { id });

export const getGradientLut = (id: string) => invoke<GradientLut>("get_gradient_lut", { id });

export const saveGradient = (id: string | null, def: GradientDef) => invoke<string>("save_gradient", { id, def });

export const deleteGradient = (id: string) => invoke<void>("delete_gradient", { id });

export const loadImagePath = (path: string) => invoke<ImageInfo>("load_image_path", { path });

export const loadImageClipboard = () => invoke<ImageInfo>("load_image_clipboard");

export const removeImage = (id: string) => invoke<void>("remove_image", { id });

export const runExport = (request: ExportRequest) => invoke<ExportResult>("run_export", { request });

export const loadSettings = () => invoke<Record<string, unknown>>("load_settings");

export const saveSettings = (patch: Record<string, unknown>) => invoke<void>("save_settings", { patch });
