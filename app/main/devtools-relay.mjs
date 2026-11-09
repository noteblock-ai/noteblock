// A one-connection WebSocket server on 127.0.0.1 for one page inspector (page-devtools.mjs).
// The DevTools frontend connects to ws://127.0.0.1:<random port>/<token>; anything else (another
// path, a second connection while one is open, a request with an Origin other than devtools://)
// is refused. Plain RFC 6455, text frames only, no extensions: what the DevTools frontend speaks.
//
// No electron import, so scripts/smoke-devtools.mjs can test it in plain node.
import http from "node:http";
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One frame: opcode + payload (server → client frames are never masked). */
function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Parse as many whole frames as `buf` holds: {frames: [{fin, opcode, payload}], rest}. */
export function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    const maskAt = p;
    if (masked) p += 4;
    if (buf.length - p < len) break;
    let payload = buf.subarray(p, p + len);
    if (masked) {
      const mask = buf.subarray(maskAt, maskAt + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * Start a relay. onMessage(text) for every message from the frontend; onOpen() when it
 * connects; onClose() when it goes. Resolves to {port, token, url, send(text), close(), connected}.
 * allowOrigin(origin) decides which Origin headers may connect (default: devtools:// only, or
 * none, which a non-browser client sends).
 */
export function startRelay({ onMessage, onOpen = () => {}, onClose = () => {}, allowOrigin = (o) => !o || o.startsWith("devtools://") } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  let sock = null;
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    const refuse = (code) => {
      socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
    };
    const key = req.headers["sec-websocket-key"];
    if (req.url !== "/" + token || !key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") return refuse("404 Not Found");
    if (!allowOrigin(req.headers.origin || "")) return refuse("403 Forbidden");
    if (sock) return refuse("409 Conflict");
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let parts = [];
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      if (sock && sock.socket === socket) sock = null;
      onClose();
    };
    sock = { socket, done };
    socket.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const { frames, rest } = parseFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 0x8) {
          try {
            socket.end(frame(0x8, Buffer.alloc(0)));
          } catch {}
          done();
          return;
        }
        if (f.opcode === 0x9) {
          socket.write(frame(0xa, f.payload));
          continue;
        }
        if (f.opcode === 0xa) continue;
        if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
          parts.push(f.payload);
          if (!f.fin) continue;
          const text = Buffer.concat(parts).toString("utf8");
          parts = [];
          try {
            onMessage(text);
          } catch (err) {
            console.error("[quire] devtools relay:", err);
          }
        }
      }
    });
    socket.on("close", done);
    socket.on("error", done);
    onOpen();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        token,
        /** The `ws=` value for the DevTools frontend: host:port/path, no scheme. */
        wsParam: `127.0.0.1:${port}/${token}`,
        get connected() {
          return !!sock;
        },
        send(text) {
          if (sock && !sock.socket.destroyed) sock.socket.write(frame(0x1, Buffer.from(text, "utf8")));
        },
        /** Drop the current connection (onClose runs now, before any new connection). */
        drop() {
          const cur = sock;
          if (!cur) return;
          try {
            cur.socket.end(frame(0x8, Buffer.alloc(0)));
          } catch {}
          cur.socket.destroy();
          cur.done();
        },
        close() {
          this.drop();
          server.close();
        },
      });
    });
  });
}
