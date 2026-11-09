// Globals a browser has and a bare JavaScriptCore context (JSContext) doesn't, for the
// libraries host.mjs bundles. Imported first, so it runs before them.
const g = globalThis;

// domino only names the timers (for its Window object); nothing the host calls schedules one.
for (const k of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"]) {
  if (typeof g[k] !== "function") g[k] = () => 0;
}

// entities (via node-html-parser) decodes its tables with atob at load.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
if (typeof g.atob !== "function") {
  g.atob = (input) => {
    const s = String(input).replace(/[\t\n\f\r =]/g, "");
    let out = "";
    let buf = 0;
    let bits = 0;
    for (let i = 0; i < s.length; i++) {
      const v = B64.indexOf(s[i]);
      if (v < 0) throw new Error("atob: invalid character");
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buf >> bits) & 0xff);
      }
    }
    return out;
  };
}
if (typeof g.btoa !== "function") {
  g.btoa = (input) => {
    const s = String(input);
    let out = "";
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error("btoa: character out of range");
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < s.length ? B64[n & 63] : "=");
    }
    return out;
  };
}
