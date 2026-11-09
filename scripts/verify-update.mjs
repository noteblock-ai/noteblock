// End-to-end check of in-app updates (app/main/updater.mjs) against a local feed, never touching
// /Applications. Copies an OLD packaged Quire.app into a temp folder, serves a NEW build's
// latest-mac.yml + zip + blockmap from a local http server (throttled so progress is visible,
// with Range support like the real Worker), launches the old app hidden (QUIRE_CAPTURE) with
// QUIRE_UPDATE_URL pointing at it, and checks: update found → download progress → ready, then
// quits and confirms Squirrel swapped the temp bundle for the new version. A second launch
// against a dead feed checks the failed toast. Screenshots: upd-*.png in the output folder.
//
//   node scripts/verify-update.mjs <old Quire.app> <new release dir> [screenshot dir] [--old-blockmap <file>]
//
// Not part of `pnpm check` (it launches the app). Both builds must be signed by the same team.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [oldApp, feedDir, shotDir] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--old-blockmap");
const oldBlockmap = process.argv.includes("--old-blockmap") ? process.argv[process.argv.indexOf("--old-blockmap") + 1] : null;
if (!oldApp || !feedDir) {
  console.error("usage: node scripts/verify-update.mjs <old Quire.app> <new release dir> [screenshot dir] [--old-blockmap <file>]");
  process.exit(2);
}
const out = path.resolve(shotDir || fs.mkdtempSync(path.join(os.tmpdir(), "quire-update-shots-")));
fs.mkdirSync(out, { recursive: true });
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quire-update-")));
const app = path.join(work, "Quire.app");
execFileSync("ditto", [oldApp, app]);
const plistVersion = () => execFileSync("defaults", ["read", path.join(app, "Contents", "Info.plist"), "CFBundleShortVersionString"], { encoding: "utf8" }).trim();
const oldVersion = plistVersion();
const results = [];
const report = (name, ok, detail = "") => results.push({ name, ok, detail });

// The feed: the new release's files, plus (optionally) the old zip's blockmap so a differential
// download is possible, like on R2 where every past release stays.
const files = new Map();
for (const f of fs.readdirSync(feedDir)) if (/\.(yml|zip|blockmap)$/.test(f)) files.set("/" + f, path.join(feedDir, f));
if (oldBlockmap) files.set("/" + path.basename(oldBlockmap), oldBlockmap);
const RATE = 25 * 1024 * 1024; // bytes per second
const served = [];
const server = http.createServer((req, res) => {
  const file = files.get(decodeURIComponent(new URL(req.url, "http://x").pathname));
  served.push(`${req.method} ${req.url} ${req.headers.range || ""}`.trim());
  if (!file) return res.writeHead(404).end();
  const size = fs.statSync(file).size;
  let start = 0;
  let end = size - 1;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  const headers = { "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream" };
  if (m) {
    start = m[1] ? Number(m[1]) : size - Number(m[2]);
    end = m[1] && m[2] ? Number(m[2]) : size - 1;
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  } else res.writeHead(200, { ...headers, "Content-Length": size });
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
  stream.on("data", (chunk) => {
    stream.pause();
    res.write(chunk, () => setTimeout(() => stream.resume(), (chunk.length / RATE) * 1000));
  });
  stream.on("end", () => res.end());
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const feedUrl = `http://127.0.0.1:${server.address().port}/`;

function launch(mode, url) {
  const home = fs.mkdtempSync(path.join(work, `home-${mode}-`));
  const vault = path.join(home, "Vault");
  return new Promise((resolve) => {
    // The executable is CFBundleExecutable: "Quire" in a 0.2.x bundle, BRAND.name after it updates.
    const exe = execFileSync("defaults", ["read", path.join(app, "Contents", "Info.plist"), "CFBundleExecutable"], { encoding: "utf8" }).trim();
    const child = spawn(path.join(app, "Contents", "MacOS", exe), [], {
      env: {
        ...process.env,
        QUIRE_CONFIG_DIR: path.join(home, ".noteblock"),
        QUIRE_VAULT: vault,
        QUIRE_USER_DATA: path.join(home, "userData"),
        QUIRE_CAPTURE: path.join(out, `upd-run-${mode}.png`),
        QUIRE_CAPTURE_DELAY: "1500",
        QUIRE_TEST_SCRIPT: path.join(ROOT, "scripts", "verify-update-main.mjs"),
        QUIRE_VERIFY_OUT: out,
        QUIRE_VERIFY_MODE: mode,
        QUIRE_UPDATE_URL: url,
      },
    });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    const kill = setTimeout(() => child.kill("SIGKILL"), 12 * 60 * 1000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      for (const l of text.split("\n")) if (l.startsWith("[verify] ")) results.push(JSON.parse(l.slice(9)));
      const log = path.join(home, ".noteblock", "update.log");
      resolve({ code, text, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" });
    });
  });
}

const ok = await launch("ok", feedUrl);
if (ok.code !== 0) report("update run exited cleanly", false, `exit ${ok.code}\n${ok.text.split("\n").slice(-20).join("\n")}`);
// "Restart to update" (without the relaunch) quit the app: Squirrel's ShipIt swaps the bundle
// once the process is gone.
let newVersion = oldVersion;
for (let i = 0; i < 120 && newVersion === oldVersion; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    newVersion = plistVersion();
  } catch {
    /* mid-swap */
  }
}
report("bundle replaced on quit", newVersion !== oldVersion, `${oldVersion} → ${newVersion}`);
if (newVersion !== oldVersion) {
  const v = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
  report("updated bundle passes codesign", v.status === 0, (v.stdout + v.stderr).trim());
}

const fail = await launch("fail", "http://127.0.0.1:59999/");
if (fail.code !== 0) report("fail run exited cleanly", false, `exit ${fail.code}`);
server.close();

let failed = 0;
for (const x of results) {
  if (!x.ok) failed++;
  console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}  ${x.detail}`);
}
console.log("\nfeed requests:\n  " + served.join("\n  "));
console.log("\nupdate.log (ok run):\n" + ok.log.replace(/^/gm, "  "));
console.log(`\n${failed ? failed + " failed" : "all passed"} · screenshots in ${out} · temp app ${app}`);
process.exit(failed ? 1 : 0);
