// The whole check for Quire: syntax of every .mjs/.js we own, the smoke scripts, the renderer build.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["node_modules", "dist", ".git", "vendor", "designs", "Generated", "DerivedData"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(mjs|cjs)$/.test(name) || (name.endsWith(".js") && !p.includes("renderer"))) files.push(p);
  }
})(root);

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
for (const f of files) {
  const esm = f.endsWith(".mjs") || f.includes(`${path.sep}examples${path.sep}`);
  run(process.execPath, esm && f.endsWith(".js") ? ["--experimental-default-type=module", "--check", f] : ["--check", f]);
}
console.log(`syntax ok: ${files.length} files`);
for (const s of ["scripts/smoke-core.mjs", "scripts/smoke-relink.mjs", "scripts/smoke-html.mjs", "scripts/smoke-obsidian.mjs", "scripts/smoke-backend.mjs", "scripts/smoke-cli.mjs", "scripts/smoke-mcp.mjs", "scripts/smoke-sync.mjs", "scripts/smoke-artifacts.mjs", "scripts/smoke-editor.mjs", "scripts/smoke-templates.mjs", "scripts/smoke-floating.mjs", "scripts/smoke-keys.mjs", "scripts/smoke-origins.mjs", "scripts/smoke-devtools.mjs", "scripts/smoke-hosting.mjs", "scripts/smoke-publish-folder.mjs", "scripts/smoke-ai.mjs", "scripts/smoke-billing.mjs", "scripts/smoke-mobile-host.mjs", "scripts/smoke-tools.mjs"]) {
  if (existsSync(path.join(root, s))) run(process.execPath, [s]);
}
run("pnpm", ["build"]);
console.log("check ok");
