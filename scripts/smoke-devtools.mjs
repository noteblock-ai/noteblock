// The page inspector's WebSocket relay (app/main/devtools-relay.mjs) in plain node: frames
// both ways (small, 16-bit and 64-bit lengths), one connection at a time, refused origins and
// tokens, and the shortcut table's two DevTools entries.
import assert from "node:assert/strict";
import http from "node:http";
import { startRelay, parseFrames } from "../app/main/devtools-relay.mjs";
import { SHORTCUTS } from "../app/main/shortcuts.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// parseFrames: a masked client frame split across two chunks.
const payload = Buffer.from("hello");
const mask = Buffer.from([1, 2, 3, 4]);
const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
const whole = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
assert.equal(parseFrames(whole.subarray(0, 4)).frames.length, 0);
const parsed = parseFrames(whole);
assert.equal(parsed.frames.length, 1);
assert.equal(parsed.frames[0].payload.toString(), "hello");
assert.equal(parsed.rest.length, 0);

const got = [];
let opened = 0;
let closed = 0;
const relay = await startRelay({ onMessage: (t) => got.push(t), onOpen: () => opened++, onClose: () => closed++ });
assert.match(relay.wsParam, /^127\.0\.0\.1:\d+\/[0-9a-f]{48}$/);

function upgrade(path, origin) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: relay.port, path, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...(origin ? { Origin: origin } : {}) } }); // gitleaks:allow (RFC 6455 sample key)
    req.on("upgrade", (res, sock) => {
      sock.destroy();
      resolve(res.statusCode);
    });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("error", (e) => resolve(e.message));
    req.end();
  });
}
assert.equal(await upgrade("/wrong", ""), 404);
assert.equal(await upgrade("/" + relay.token, "quire://p-abcdefghij"), 403);
assert.equal(await upgrade("/" + relay.token, "http://evil.example"), 403);

const ws = new WebSocket("ws://" + relay.wsParam);
const fromRelay = [];
ws.onmessage = (e) => fromRelay.push(e.data);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
await sleep(50);
assert.equal(opened, 1);
assert.equal(await upgrade("/" + relay.token, "devtools://devtools"), 409, "a second connection is refused");
const big = "x".repeat(70000);
const mid = "y".repeat(300);
ws.send("small");
ws.send(mid);
ws.send(big);
for (let i = 0; i < 40 && got.length < 3; i++) await sleep(25);
assert.deepEqual(got.map((s) => s.length), [5, 300, 70000]);
relay.send("back");
relay.send(big);
for (let i = 0; i < 40 && fromRelay.length < 2; i++) await sleep(25);
assert.deepEqual(fromRelay.map((s) => s.length), [4, 70000]);
relay.drop();
assert.equal(closed, 1, "drop() runs onClose right away");
await sleep(50);
assert.equal(relay.connected, false);
relay.close();

const ids = SHORTCUTS.map((s) => s.id);
assert.ok(ids.includes("developer-tools") && ids.includes("app-developer-tools"));
assert.equal(SHORTCUTS.find((s) => s.id === "developer-tools").label, "Inspect page");
assert.equal(SHORTCUTS.find((s) => s.id === "app-developer-tools").default, "Alt+CmdOrCtrl+I");
console.log("smoke-devtools ok");
