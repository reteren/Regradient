import { defineConfig } from "vite";

// Mirrors reshot-tauri's vite config: fixed dev port the Rust side expects,
// and a build that never touches src-tauri.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    outDir: "dist",
    emptyOutDir: true,
  },
});
