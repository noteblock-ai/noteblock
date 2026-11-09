import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" keeps asset URLs relative, so Noteblock can serve dist/ from inside the page folder.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
