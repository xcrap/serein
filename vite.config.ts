import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  build: {
    target: "es2022",
    // dist/ also holds the native Serein.app, and Vite empties its outDir.
    outDir: "dist/web",
  },
});
