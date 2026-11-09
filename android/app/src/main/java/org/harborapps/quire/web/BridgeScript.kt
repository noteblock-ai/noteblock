package org.harborapps.quire.web

/**
 * The document-start script that gives a page the iOS bridge names (docs/decisions/android.md):
 * `window.webkit.messageHandlers.quire` (rpcs) and `.quireEditor` (editor state), both posting
 * `{ch, body}` as JSON to the `quireAndroid` WebMessageListener object. Replies come back on
 * `quireAndroid.onmessage` as `{type: "rpc-reply", id, ok, value}` and go to
 * `window.__quireRpcReply`, which runtime.js defines in native-host mode.
 *
 * `quireAndroid` is looked up at call time (the listener object and this script are injected in
 * no guaranteed order), and its onmessage is set at start and again lazily on the first post.
 * An existing `window.webkit` is extended, never replaced.
 */
const val SHIM: String = """
(function () {
  if (window.__quireAndroidShim) return;
  window.__quireAndroidShim = true;
  function onReply(event) {
    var data = event && event.data;
    var m;
    try { m = typeof data === "string" ? JSON.parse(data) : data; } catch (e) { return; }
    if (!m || m.type !== "rpc-reply") return;
    if (typeof window.__quireRpcReply === "function") window.__quireRpcReply(m.id, m.ok, m.value);
  }
  var hooked = null;
  function port() {
    var a = window.quireAndroid;
    if (a && hooked !== a) {
      try { a.onmessage = onReply; hooked = a; } catch (e) {}
    }
    return a;
  }
  function handler(ch) {
    return {
      postMessage: function (body) {
        var a = port();
        if (!a) throw new Error("The Noteblock bridge is not ready");
        a.postMessage(JSON.stringify({ ch: ch, body: body === undefined ? null : body }));
      }
    };
  }
  var w = window.webkit;
  if (!w || typeof w !== "object") { w = {}; try { window.webkit = w; } catch (e) {} }
  if (!w.messageHandlers || typeof w.messageHandlers !== "object") w.messageHandlers = {};
  if (!w.messageHandlers.quire) w.messageHandlers.quire = handler("quire");
  if (!w.messageHandlers.quireEditor) w.messageHandlers.quireEditor = handler("quireEditor");
  port();
})();
"""
