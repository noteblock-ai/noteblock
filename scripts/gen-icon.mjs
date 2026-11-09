// build/icon.svg → build/icon.png (1024; electron-builder derives the .icns from it), and
// build/icon-dev.svg → build/icon-dev.png (Quire Dev's Dock icon), build/icon-next.svg → build/icon-next.png
// (Noteblock Next's app icon).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["icon", "icon-dev", "icon-next"]) {
  execFileSync("sips", ["-s", "format", "png", `build/${name}.svg`, "--out", `build/${name}.png`], { cwd: root, stdio: "ignore" });
  console.log(`build/${name}.png`);
}
