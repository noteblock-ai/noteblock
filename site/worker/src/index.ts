// quire-site (the worker keeps its name): the Noteblock landing page on noteblock.ai, /download and
// the update feed from R2. This script runs first on every request (run_worker_first: true):
//   www.noteblock.ai/*            301 to the same path on noteblock.ai
//   quire.harborapps.org          /download, /download/*, /downloads/*, /updates/* served exactly as on
//                                 noteblock.ai (0.2.x apps poll /updates/latest-mac.yml there);
//                                 every other path 301s to noteblock.ai. (/api/*, /auth/* on both
//                                 hosts belong to quire-hosting, whose routes are more specific.)
//   noteblock.ai                  the release routes below, everything else from static assets
// The name and domains come from core/brand.mjs.
// Release contract: R2 keys updates/latest-mac.yml, updates/<zip|blockmap>, downloads/<dmg>,
// downloads/latest.json (written last by scripts/release.mjs); with a Windows release also
// updates/latest.yml, updates/<name>-<v>-setup.exe(.blockmap), downloads/<name>-<v>-setup.exe and
// latest.json "windows": {version, file, size}. File names are whatever latest.json says
// (Quire-0.2.x.dmg, Noteblock-0.3.x.dmg, ...); nothing here assumes one. Until the windows key
// exists every route answers as it did before Windows (and /download/windows is a "not yet" 404 page).
import { BRAND } from "../../../core/brand.mjs";

interface Env {
  ASSETS: Fetcher;
  RELEASES: R2Bucket;
}

interface Latest {
  version: string;
  date?: string;
  dmg?: string;
  dmgArm64?: string;
  dmgX64?: string;
  notes?: string;
  windows?: { version?: string; file?: string; size?: number };
}

const LATEST_KEY = "downloads/latest.json";

/** The release routes: served the same on noteblock.ai and on the old host. */
const isReleasePath = (path: string) =>
  path === "/download" || path.startsWith("/download/") || path.startsWith("/downloads/") || path.startsWith("/updates/");

// public/_headers, for asset responses that come back through this script.
const PAGE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Accept-CH": "Sec-CH-UA-Arch, Sec-CH-UA-Bitness",
};

const SECURITY: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const TYPES: Record<string, string> = {
  dmg: "application/x-apple-diskimage",
  exe: "application/vnd.microsoft.portable-executable",
  zip: "application/zip",
  yml: "text/yaml; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  blockmap: "application/octet-stream",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return withSecurity(notFound());
    }
    const host = url.hostname.toLowerCase();
    const apex = `https://${BRAND.domain}`;
    if (host === `www.${BRAND.domain}` || (host === BRAND.legacyDomain && !isReleasePath(path))) {
      const keepsMethod = request.method !== "GET" && request.method !== "HEAD";
      return new Response(null, {
        status: keepsMethod ? 308 : 301,
        headers: { Location: apex + url.pathname + url.search, "Cache-Control": "public, max-age=86400" },
      });
    }
    if (!isReleasePath(path)) {
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(PAGE_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
      return out;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withSecurity(new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" } }));
    }
    if (path === "/download" || path === "/download/") return withSecurity(await download(request, url, env));
    if (path === "/download/mac" || path === "/download/mac/") return withSecurity(await download(request, url, env, "mac"));
    if (path === "/download/windows" || path === "/download/windows/") return withSecurity(await download(request, url, env, "windows"));
    if (path === "/download/latest.json") return withSecurity(await serveObject(request, env, LATEST_KEY));
    if (path.startsWith("/downloads/") || path.startsWith("/updates/")) {
      const key = path.slice(1);
      if (!validKey(key)) return withSecurity(notFound());
      return withSecurity(await serveObject(request, env, key));
    }
    return withSecurity(notFound());
  },
} satisfies ExportedHandler<Env>;

function validKey(key: string): boolean {
  return /^(downloads|updates)\/[A-Za-z0-9._+-][A-Za-z0-9._+\/-]*$/.test(key) && !key.split("/").some((s) => s === ".." || s === ".");
}

function withSecurity(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

// ---------- /download ----------

async function readLatest(env: Env): Promise<Latest | null> {
  const obj = await env.RELEASES.get(LATEST_KEY);
  if (!obj) return null;
  try {
    const data = (await obj.json()) as Latest;
    return data && typeof data.version === "string" ? data : null;
  } catch {
    return null;
  }
}

/** arm64 or x64, from ?arch=, then the Sec-CH-UA-Arch client hint (the landing page asks for it). */
function pickArch(request: Request, url: URL): "arm64" | "x64" {
  const q = (url.searchParams.get("arch") || "").toLowerCase();
  if (["x64", "x86", "x86_64", "intel", "amd64"].includes(q)) return "x64";
  if (["arm64", "arm", "apple", "aarch64"].includes(q)) return "arm64";
  const hint = (request.headers.get("Sec-CH-UA-Arch") || "").replace(/"/g, "").toLowerCase();
  if (hint === "x86") return "x64";
  // Safari and Firefox report "Intel Mac OS X" on every Mac, so the User-Agent cannot tell; default arm64.
  return "arm64";
}

/** The Windows installer's key in latest.json, or null before the first Windows release. */
function windowsKey(latest: Latest): string | null {
  const f = latest.windows && latest.windows.file;
  return typeof f === "string" && f.startsWith("downloads/") && validKey(f) ? f : null;
}

const redirectTo = (url: URL, key: string, vary: string): Response =>
  new Response(null, {
    status: 302,
    headers: { Location: new URL("/" + key.split("/").map(encodeURIComponent).join("/"), url.origin).toString(), "Cache-Control": "no-store", Vary: vary },
  });

/**
 * /download picks the visitor's OS from the User-Agent (Windows → the installer, anything else →
 * the DMG); /download/mac and /download/windows always give that one. Before latest.json has a
 * windows entry, /download is the Mac file for everyone, as it always was.
 */
async function download(request: Request, url: URL, env: Env, os?: "mac" | "windows"): Promise<Response> {
  const latest = await readLatest(env);
  if (os === "windows") {
    const key = latest && windowsKey(latest);
    return key ? redirectTo(url, key, "User-Agent") : windowsNotYet();
  }
  if (!latest) return comingSoon();
  if (!os && /Windows/.test(request.headers.get("User-Agent") || "")) {
    const key = windowsKey(latest);
    if (key) return redirectTo(url, key, "User-Agent, Sec-CH-UA-Arch");
  }
  const arch = pickArch(request, url);
  const candidates = arch === "x64" ? [latest.dmgX64, latest.dmg, latest.dmgArm64] : [latest.dmgArm64, latest.dmg, latest.dmgX64];
  const key = candidates.find((k): k is string => typeof k === "string" && k.startsWith("downloads/") && validKey(k));
  if (!key) return comingSoon();
  const target = new URL("/" + key.split("/").map(encodeURIComponent).join("/"), url.origin);
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store", Vary: windowsKey(latest) ? "User-Agent, Sec-CH-UA-Arch" : "Sec-CH-UA-Arch" } });
}

/** /download/windows before the first Windows release: a page, not a Mac file a PC can't open. */
function windowsNotYet(): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND.name} for Windows is on its way</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&display=swap">
<style>
:root{--ink:#15171c;--muted:#5b6270;--accent:#3451d1;color-scheme:light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:var(--ink);font-family:Geist,ui-sans-serif,system-ui,-apple-system,sans-serif;padding:0 16px}
main{max-width:460px;text-align:center}
img{width:56px;height:56px;margin:0 auto 20px;display:block}
h1{font-size:34px;letter-spacing:-0.035em;line-height:1.1;margin:0 0 12px;font-weight:600}
p{color:var(--muted);font-size:16px;line-height:1.5;margin:0 0 24px}
a{color:var(--accent);text-decoration:none;font-weight:600}
</style></head>
<body><main>
<img src="/favicon.svg" alt="">
<h1>${BRAND.name} for Windows is on its way.</h1>
<p>It isn't ready to download yet. ${BRAND.name} for Mac is.</p>
<a href="/">Back to ${BRAND.name}</a>
</main></body></html>`;
  return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function comingSoon(): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND.name}: the first build is on its way</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&display=swap">
<style>
:root{--ink:#15171c;--muted:#5b6270;--faint:#8a909c;--line:#e4e6ea;--accent:#3451d1;color-scheme:light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:var(--ink);font-family:Geist,ui-sans-serif,system-ui,-apple-system,sans-serif;padding:0 16px}
main{max-width:460px;text-align:center}
img{width:56px;height:56px;margin:0 auto 20px;display:block}
h1{font-size:34px;letter-spacing:-0.035em;line-height:1.1;margin:0 0 12px;font-weight:600}
p{color:var(--muted);font-size:16px;line-height:1.5;margin:0 0 24px}
a{color:var(--accent);text-decoration:none;font-weight:600}
</style></head>
<body><main>
<img src="/favicon.svg" alt="">
<h1>The first build is on its way.</h1>
<p>${BRAND.name} for Mac isn't ready to download yet. Check back soon.</p>
<a href="/">Back to ${BRAND.name}</a>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "3600" },
  });
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// ---------- R2 objects ----------

function contentType(key: string, obj: R2Object): string {
  const ext = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1).toLowerCase() : "";
  return TYPES[ext] || obj.httpMetadata?.contentType || "application/octet-stream";
}

function cacheControl(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  if (name === "latest-mac.yml" || name === "latest.json" || /^latest.*\.ya?ml$/.test(name)) return "no-cache";
  // Versioned build output (Quire-0.2.0-arm64-mac.zip, Noteblock-0.3.0.dmg, .blockmap) never changes once uploaded.
  if (/\d+\.\d+\.\d+/.test(name)) return "public, max-age=31536000, immutable";
  return "public, max-age=300";
}

function baseHeaders(key: string, obj: R2Object): Headers {
  const h = new Headers();
  h.set("Content-Type", contentType(key, obj));
  h.set("Cache-Control", cacheControl(key));
  h.set("ETag", obj.httpEtag);
  h.set("Last-Modified", obj.uploaded.toUTCString());
  h.set("Accept-Ranges", "bytes");
  if (key.endsWith(".dmg") || (key.startsWith("downloads/") && key.endsWith(".exe"))) h.set("Content-Disposition", `attachment; filename="${key.slice(key.lastIndexOf("/") + 1)}"`);
  if (key === LATEST_KEY) h.set("Access-Control-Allow-Origin", "*");
  return h;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === bare);
}

type Span = { start: number; end: number }; // inclusive

/** Parses a bytes Range header against size. null = ignore the header (serve 200), "unsatisfiable" = 416. */
function parseRange(header: string, size: number): Span[] | "unsatisfiable" | null {
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return null;
  const spans: Span[] = [];
  for (const part of m[1].split(",")) {
    const p = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(part);
    if (!p || (p[1] === "" && p[2] === "")) return null;
    let start: number, end: number;
    if (p[1] === "") {
      const n = Number(p[2]);
      if (n === 0) continue;
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(p[1]);
      if (p[2] !== "" && Number(p[2]) < start) return null;
      if (start >= size) continue;
      end = p[2] === "" ? size - 1 : Math.min(Number(p[2]), size - 1);
    }
    spans.push({ start, end });
  }
  if (!spans.length) return "unsatisfiable";
  if (spans.length > 2000) return null;
  // Multipart needs ascending, non-overlapping ranges (electron-updater sends them that way); otherwise serve the whole file.
  for (let i = 1; i < spans.length; i++) if (spans[i].start <= spans[i - 1].end) return null;
  return spans;
}

async function serveObject(request: Request, env: Env, key: string): Promise<Response> {
  const head = await env.RELEASES.head(key);
  if (!head) {
    if (key === LATEST_KEY) {
      return new Response(JSON.stringify({ error: "no release yet" }) + "\n", {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" },
      });
    }
    return notFound();
  }
  const headers = baseHeaders(key, head);
  const isHead = request.method === "HEAD";

  if (etagMatches(request.headers.get("If-None-Match"), head.httpEtag)) return new Response(null, { status: 304, headers });

  let spans: Span[] | "unsatisfiable" | null = null;
  const rangeHeader = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  if (rangeHeader && (!ifRange || etagMatches(ifRange, head.httpEtag) || ifRange === head.uploaded.toUTCString())) {
    spans = parseRange(rangeHeader, head.size);
  }

  if (spans === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${head.size}`);
    headers.delete("Content-Type");
    return new Response(null, { status: 416, headers });
  }

  const onlyIf = { etagMatches: head.etag };

  if (!spans) {
    headers.set("Content-Length", String(head.size));
    if (isHead) return new Response(null, { status: 200, headers });
    const obj = await env.RELEASES.get(key, { onlyIf });
    if (!obj || !("body" in obj)) return changed();
    return new Response(obj.body, { status: 200, headers });
  }

  if (spans.length === 1) {
    const { start, end } = spans[0];
    headers.set("Content-Range", `bytes ${start}-${end}/${head.size}`);
    headers.set("Content-Length", String(end - start + 1));
    if (isHead) return new Response(null, { status: 206, headers });
    const obj = await env.RELEASES.get(key, { onlyIf, range: { offset: start, length: end - start + 1 } });
    if (!obj || !("body" in obj)) return changed();
    return new Response(obj.body, { status: 206, headers });
  }

  return multipart(env, key, head, spans, headers, isHead);
}

function changed(): Response {
  return new Response("The file changed while it was being served. Try again.\n", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "1" },
  });
}

// ---------- multipart/byteranges (electron-updater's differential download asks for many ranges at once) ----------

const MAX_FETCHES = 24; // R2 reads per request; nearby ranges are fetched together and trimmed while streaming.

function groupSpans(spans: Span[]): Span[][] {
  let groups = spans.map((s) => [s]);
  while (groups.length > MAX_FETCHES) {
    // Merge the pair of neighbouring groups with the smallest gap between them.
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < groups.length - 1; i++) {
      const gap = groups[i + 1][0].start - groups[i][groups[i].length - 1].end;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    groups.splice(best, 2, [...groups[best], ...groups[best + 1]]);
  }
  return groups;
}

function multipart(env: Env, key: string, head: R2Object, spans: Span[], headers: Headers, isHead: boolean): Response {
  const boundary = "quire" + crypto.randomUUID().replace(/-/g, "");
  const type = contentType(key, head);
  const enc = new TextEncoder();
  const partHead = (s: Span, first: boolean) =>
    enc.encode(`${first ? "" : "\r\n"}--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${s.start}-${s.end}/${head.size}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);

  let length = tail.length;
  spans.forEach((s, i) => (length += partHead(s, i === 0).length + (s.end - s.start + 1)));

  headers.set("Content-Type", `multipart/byteranges; boundary=${boundary}`);
  headers.set("Content-Length", String(length));
  if (isHead) return new Response(null, { status: 206, headers });

  const { readable, writable } = new FixedLengthStream(length);
  const writer = writable.getWriter();

  (async () => {
    try {
      let first = true;
      for (const group of groupSpans(spans)) {
        const from = group[0].start;
        const to = group[group.length - 1].end;
        const obj = await env.RELEASES.get(key, { onlyIf: { etagMatches: head.etag }, range: { offset: from, length: to - from + 1 } });
        if (!obj || !("body" in obj)) throw new Error("object changed mid-response");
        const reader = obj.body.getReader();
        let pos = from; // absolute offset of the first byte in `buf`
        let buf = new Uint8Array(0);
        const fill = async () => {
          const { done, value } = await reader.read();
          if (done) throw new Error("short read from R2");
          buf = value;
        };
        for (const s of group) {
          await writer.write(partHead(s, first));
          first = false;
          // Skip bytes between the previous range and this one.
          while (pos + buf.length <= s.start) {
            pos += buf.length;
            await fill();
          }
          buf = buf.subarray(s.start - pos);
          pos = s.start;
          let need = s.end - s.start + 1;
          while (need > 0) {
            if (!buf.length) await fill();
            const take = Math.min(need, buf.length);
            await writer.write(buf.subarray(0, take));
            buf = buf.subarray(take);
            pos += take;
            need -= take;
          }
        }
        reader.releaseLock();
        await obj.body.cancel().catch(() => {});
      }
      await writer.write(tail);
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();

  return new Response(readable, { status: 206, headers });
}
