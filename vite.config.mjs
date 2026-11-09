import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { BRAND } from "./core/brand.mjs";

const root = fileURLToPath(new URL("./app/renderer", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  // %BRAND_NAME% in the HTML files is the public name (core/brand.mjs).
  plugins: [react(), { name: "brand", transformIndexHtml: (html) => html.replaceAll("%BRAND_NAME%", BRAND.name) }],
  build: {
    outDir: fileURLToPath(new URL("./app/renderer/dist", import.meta.url)),
    emptyOutDir: true,
    // Two windows: the app (index.html) and the floating note (floating.html).
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./app/renderer/index.html", import.meta.url)),
        floating: fileURLToPath(new URL("./app/renderer/floating.html", import.meta.url)),
      },
    },
  },
});
