import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// base "./" keeps asset URLs relative, so Noteblock can serve dist/ from inside the page folder.
// Rapier is bundled from node_modules. Models, textures, audio and fonts load from the hosted game,
// and only after the player clicks Play (see App.tsx).
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@blastside/shared": fileURLToPath(new URL("./src/shared/index.ts", import.meta.url)) } },
  define: { "import.meta.env.VITE_ASSET_BASE": JSON.stringify("https://play.noteblock.ai/g/"), "import.meta.env.VITE_CLIENT_SHA": JSON.stringify("cd30d5c") },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
});
