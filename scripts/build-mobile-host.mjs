#!/usr/bin/env node
// Builds what the phone apps bundle. For iOS, into ios/Generated/ (gitignored):
//   runtime/            a copy of app/runtime (theme.css, runtime.js, fonts/, vendor/)
//   host.js             mobile/host.mjs as one IIFE for JavaScriptCore (globalThis.QuireHost)
//   Seed/My First Vault/   examples/My First Vault, copied into Documents on first launch
// It also renders the iOS app icon from build/icon-ios.svg when the PNG is missing.
// For Android, the same three into android/app/build/generated/quire/assets/ (the APK's
// assets), with runtime/ rewritten from quire:// to ANDROID_ORIGIN: Android System WebView
// can't load ES modules, fonts or fetch() from a custom scheme, so the app serves pages and
// the runtime on https://quire.local/ from WebViewClient.shouldInterceptRequest instead
// (android/…/web/PageRequestHandler.kt; docs/decisions/android.md).
//   --platform=ios | android | all   (default all; the Xcode phase passes nothing → all)
// Run by `pnpm build:mobile`, ios/run-ios.sh, the Xcode target's pre-build phase and the
// Android app's preBuild (android/scripts/build-mobile-host.sh). Offline.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "../core/brand.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");
const log = (...a) => quiet || console.log(...a);
const platformArg = (process.argv.find((a) => a.startsWith("--platform=")) || "--platform=all").slice("--platform=".length);
if (!["ios", "android", "all"].includes(platformArg)) throw new Error(`--platform must be ios, android or all, not "${platformArg}"`);
const wantIos = platformArg !== "android";
const wantAndroid = platformArg !== "ios";

/** Where the Android app serves the runtime (/runtime/) and the vault (/vault/<page>/). */
const ANDROID_ORIGIN = "https://quire.local";

// 0. The launcher name is BRAND.name: CFBundleDisplayName on iOS (Swift reads it back as
// Brand.name), app_name in strings.xml on Android (Kotlin reads it back as Brand.name).
const nameChecks = [];
if (wantIos) nameChecks.push(
  [join(root, "ios", "project.yml"), /CFBundleDisplayName: (.+)/g, "CFBundleDisplayName"],
  [join(root, "ios", "Quire", "Info.plist"), /<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/g, "CFBundleDisplayName"],
);
if (wantAndroid) nameChecks.push([join(root, "android", "app", "src", "main", "res", "values", "strings.xml"), /<string name="app_name">([^<]*)<\/string>/g, "app_name"]);
for (const [file, re, key] of nameChecks) {
  let found = 0;
  for (const m of readFileSync(file, "utf8").matchAll(re)) {
    found++;
    if (m[1].trim() !== BRAND.name) throw new Error(`${file}: ${key} is "${m[1].trim()}", core/brand.mjs says "${BRAND.name}"`);
  }
  if (!found) throw new Error(`${file}: no ${key}`);
}

// 1. runtime/ (vendor/ is built by build-vendor.mjs; esbuild is local, so no network)
const runtimeSrc = join(root, "app", "runtime");
if (!existsSync(join(runtimeSrc, "vendor", "react.mjs"))) {
  log("app/runtime/vendor missing, running build-vendor");
  execFileSync(process.execPath, [join(root, "scripts", "build-vendor.mjs")], { cwd: root, stdio: quiet ? "ignore" : "inherit" });
}

// 2. host.js, built once for both apps
const hostJs = (await build({
  entryPoints: [join(root, "mobile", "host.mjs")],
  write: false,
  bundle: true,
  format: "iife",
  // neutral + module/main: turndown's node build, which parses with domino instead of a DOM.
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "es2020",
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  absWorkingDir: root,
  logLevel: "warning",
})).outputFiles[0].contents;

const SKIP = new Set([".DS_Store", "node_modules", "data"]);
const seedSrc = join(root, "examples", "My First Vault");

/** runtime/, host.js and Seed/ into `out`; `rewrite` edits each runtime text file. */
function emit(out, rewrite) {
  mkdirSync(out, { recursive: true });
  rmSync(join(out, "runtime"), { recursive: true, force: true });
  cpSync(runtimeSrc, join(out, "runtime"), { recursive: true, filter: (src) => basename(src) !== ".DS_Store" });
  if (rewrite) rewriteTree(join(out, "runtime"), rewrite);
  writeFileSync(join(out, "host.js"), hostJs);
  rmSync(join(out, "Seed"), { recursive: true, force: true });
  cpSync(seedSrc, join(out, "Seed", "My First Vault"), { recursive: true, filter: (src) => !SKIP.has(basename(src)) });
}

function rewriteTree(dir, rewrite) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) rewriteTree(p, rewrite);
    else if (/\.(m?js|css|html)$/.test(name)) {
      const before = readFileSync(p, "utf8");
      const after = rewrite(before, p);
      if (after !== before) writeFileSync(p, after);
    }
  }
}

if (wantIos) {
  const out = join(root, "ios", "Generated");
  emit(out);
  // 4. App icon (committed; only rendered when missing)
  const iconOut = join(root, "ios", "Quire", "Assets.xcassets", "AppIcon.appiconset", "icon-1024.png");
  const iconSvg = join(root, "build", "icon-ios.svg");
  if (!existsSync(iconOut) && existsSync(iconSvg)) {
    // An App Store icon must be opaque: render to JPEG (no alpha) and back to PNG.
    const tmp = join(out, "icon-1024.jpg");
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "100", iconSvg, "--out", tmp], { stdio: "ignore" });
    execFileSync("sips", ["-s", "format", "png", tmp, "--out", iconOut], { stdio: "ignore" });
    rmSync(tmp, { force: true });
    log("rendered", iconOut);
  }
  log(`ios/Generated: runtime/, host.js (${Math.round(hostJs.length / 1024)} KB), Seed/My First Vault/`);
}

if (wantAndroid) {
  const out = join(root, "android", "app", "build", "generated", "quire", "assets");
  // quire://runtime/… (theme.css fonts) and the runtime's own quire://vault/ page URLs (embeds)
  // → https://quire.local/runtime/…, https://quire.local/vault/…. The served page HTML (import
  // map, theme link, runtime script) is rewritten the same way by the app as it serves it.
  // Links: vault URLs are https here, so the runtime's link handler must treat
  // https://quire.local/vault/… like quire://vault/… (open the page in the app, also from an
  // embed) instead of following it inside the frame. A patch that no longer applies fails the build.
  const LINK_IF = 'if (url.protocol === "quire:" && url.host !== "runtime") {';
  const LINK_SEGS = 'try { segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch (err) { return; }';
  emit(out, (text, file) => {
    let t = text.replaceAll("quire://runtime/", `${ANDROID_ORIGIN}/runtime/`).replaceAll('"quire://vault/"', `"${ANDROID_ORIGIN}/vault/"`);
    if (basename(file) === "runtime.js") {
      if (!t.includes(LINK_IF) || !t.includes(LINK_SEGS)) throw new Error("runtime.js link handler changed: update the Android patch in build-mobile-host.mjs");
      const vaultHttps = `url.origin === "${ANDROID_ORIGIN}" && /^\\/vault\\//.test(url.pathname)`;
      t = t.replace(LINK_IF, `if ((url.protocol === "quire:" && url.host !== "runtime") || (${vaultHttps})) {`);
      t = t.replace(LINK_SEGS, `try { segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); if (${vaultHttps}) segs.shift(); } catch (err) { return; }`);
    }
    return t;
  });
  log(`android/app/build/generated/quire/assets: runtime/, host.js, Seed/My First Vault/`);
}
