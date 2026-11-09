// The Guestbook's backend. Noteblock runs it with `node server.js` in this folder (see .noteblock),
// gives it $PORT, and sends the page's fetch("api/…") here. Entries live in data/, which
// git ignores; anything secret goes in .env (also ignored), e.g. GREETING=Welcome in.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "data", "entries.json");
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
};
const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    if (req.url === "/api/entries" && req.method === "GET") return send(res, 200, { greeting: process.env.GREETING || "Sign the guestbook", entries: read() });
    if (req.url === "/api/entries" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { name, note } = JSON.parse(body || "{}");
        if (!name || !note) return send(res, 400, { error: "name and note are required" });
        const entries = [{ name: String(name).slice(0, 60), note: String(note).slice(0, 280), at: new Date().toISOString() }, ...read()];
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entries, null, 2));
        send(res, 201, entries[0]);
      });
      return;
    }
    send(res, 404, { error: "not found" });
  })
  .listen(process.env.PORT, "127.0.0.1", () => console.log(`guestbook api on :${process.env.PORT}`));
