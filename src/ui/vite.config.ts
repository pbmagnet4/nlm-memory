import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { DEFAULT_NLM_PORT } from "../shared/net.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: __dirname,
  base: "/ui/",
  build: {
    outDir: fileURLToPath(new URL("../../dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${DEFAULT_NLM_PORT}`,
    },
  },
  plugins: [react()],
});
