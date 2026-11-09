// The iOS app's JavaScript: the same pure render/save functions the Mac uses, bundled by
// scripts/build-mobile-host.mjs into one IIFE (ios/Generated/host.js) that the app loads into
// a JavaScriptCore context (ios/Quire/Host/HostJS.swift). No DOM and no node here: turndown
// parses with domino (bundled), node-html-parser and marked are plain JS; shims.mjs fills in
// the few browser globals they reach for (atob, timers).
import "./shims.mjs";
import { indexBody, applyRegions, renderMarkdown, htmlToMarkdown, splitFrontmatter, stripEditorAttrs, TEXT_TAGS } from "../core/html.mjs";
import { contentType, editorPrefs, editorCss, headInjection, injectHead, transformEntry } from "../app/main/transform.mjs";
import { RENDERERS } from "../core/renderers.mjs";

globalThis.QuireHost = {
  version: 1,
  TEXT_TAGS,
  RENDERERS,
  indexBody,
  applyRegions,
  renderMarkdown,
  htmlToMarkdown,
  splitFrontmatter,
  stripEditorAttrs,
  contentType,
  editorPrefs,
  editorCss,
  headInjection,
  injectHead,
  transformEntry,
};
