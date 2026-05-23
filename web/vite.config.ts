import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config — outputs static files to ../dist/ (sibling of web/) so the
// deploy script can copy them straight to the Caddy site root without
// nesting a "dist" folder under web/.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // During local dev, proxy /api/plugins/telegram-app/* to the running
    // dashboard so we don't need Caddy in the dev loop.
    proxy: {
      "/api": "http://127.0.0.1:9119",
    },
  },
});
