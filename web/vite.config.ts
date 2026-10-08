import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Le build écrit directement dans ../public (servi par Workers Static Assets).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});