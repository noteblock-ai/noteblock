// Runs inside a packaged Quire (QUIRE_TEST_SCRIPT) for scripts/verify-update.mjs: drives the
// updater through check → download → ready (or a failed check) and screenshots each toast.
// Prints one "[verify] {json}" line per check. QUIRE_VERIFY_MODE=fail expects a dead feed.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export default async function ({ app, win }) {
  const out = process.env.QUIRE_VERIFY_OUT;
  const report = (name, ok, detail = "") => console.log("[verify] " + JSON.stringify({ name, ok, detail: String(detail) }));
  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 700));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name), img.toPNG());
  };
  const toast = () => win.webContents.executeJavaScript(`document.querySelector(".update-toast")?.innerText || ""`);
  // Same module instance main.mjs imported (file URL of the real path).
  const upd = await import(pathToFileURL(fs.realpathSync(path.join(app.getAppPath(), "app", "main", "updater.mjs"))).href);
  const until = async (pred, ms, label) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = upd.updateStatus();
      if (pred(s)) return s;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timed out waiting for ${label}; last status ${JSON.stringify(upd.updateStatus())}`);
  };
  report("running version", true, upd.updateStatus().current?.version);

  if (process.env.QUIRE_VERIFY_MODE === "fail") {
    await upd.runUpdate();
    const s = await until((s) => s.state === "failed", 90000, "failed");
    await shot("upd-failed.png");
    report("dead feed → failed toast", /Update failed/.test(await toast()), `${s.error} | toast: ${await toast()}`);
    return;
  }

  const s1 = await upd.checkForUpdate();
  await shot("upd-available.png");
  const t1 = await toast();
  report("check finds the new version", s1.state === "available", `${s1.state} ${s1.version} | toast: ${t1}`);
  if (s1.state !== "available") return;

  const started = Date.now();
  upd.runUpdate();
  let mid = null;
  let ready = null;
  while (Date.now() - started < 10 * 60 * 1000) {
    const s = upd.updateStatus();
    if (!mid && s.state === "downloading" && s.percent >= 5 && s.percent <= 80) {
      mid = s;
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, "upd-downloading.png"), img.toPNG());
      report("download shows progress", true, `${s.percent}% | toast: ${await toast()}`);
    }
    if (s.state === "ready" || s.state === "failed") {
      ready = s;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!mid) report("download shows progress", false, "never saw a mid-download percent");
  if (!ready) return report("download → ready", false, "timed out: " + JSON.stringify(upd.updateStatus()));
  if (ready.state === "ready") {
    await shot("upd-ready.png");
    report("download → ready", true, `${((Date.now() - started) / 1000).toFixed(1)}s | toast: ${await toast()}`);
    // Restart to update, minus the relaunch (a relaunched copy would open without the test env).
    upd.installUpdate({ relaunch: false });
    await new Promise((r) => setTimeout(r, 300));
    await shot("upd-restarting.png");
    report("restart → quitting", true, `toast: ${await toast()}`);
    await new Promise(() => {}); // Squirrel quits the app; returning would app.exit() first

  } else {
    await shot("upd-failed-download.png");
    report("download → ready", false, ready.error);
  }
}
