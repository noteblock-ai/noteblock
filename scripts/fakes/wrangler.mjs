#!/usr/bin/env node
// A fake wrangler for scripts/smoke-hosting.mjs and screenshots (QUIRE_WRANGLER=<this file>).
// FAKE_WRANGLER_LOGGED_IN=1 makes whoami answer logged in. Never touches a real Cloudflare login.
import fs from "node:fs";
const [cmd, ...args] = process.argv.slice(2);
const loggedIn = process.env.FAKE_WRANGLER_LOGGED_IN === "1";
if (cmd === "whoami") {
  console.log(
    JSON.stringify(
      loggedIn
        ? { loggedIn: true, authType: "OAuth Token", email: "ada@example.com", accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "Ada's Account" }] }
        : { loggedIn: false },
      null,
      2,
    ),
  );
} else if (cmd === "login") {
  console.log("Attempting to login via OAuth...");
  console.log("Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?fake");
  setTimeout(() => console.log("Successfully logged in."), 300);
} else if (cmd === "logout") {
  console.log("Successfully logged out.");
} else if (cmd === "deploy") {
  const name = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8")).name;
  console.log(`Uploaded ${name}\nhttps://${name}.ada.workers.dev`);
} else if (cmd === "delete") {
  console.log("Successfully deleted.");
} else {
  console.error("fake wrangler: unknown command " + cmd);
  process.exit(1);
}
