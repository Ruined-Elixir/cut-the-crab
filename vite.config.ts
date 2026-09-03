import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a Node.js global provided by the Tauri/Vite environment.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],

  // libass-wasm should be loaded directly rather than pre-bundled by Vite.
  optimizeDeps: {
    exclude: ["@biliblitz/libass-wasm"],
  },

  // Keep Rust errors visible in the terminal.
  clearScreen: false,

  server: {
    // Tauri expects a fixed development port.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Rust changes are handled by Tauri/Cargo rather than Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
}));
