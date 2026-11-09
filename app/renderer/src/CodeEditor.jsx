import { useEffect, useRef } from "react";
import { EditorState, Compartment, Transaction } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  highlightSpecialChars,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, openSearchPanel, findNext, findPrevious } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";

/**
 * ⌘F / ⌘G / ⇧⌘G for a code editor: main takes those keys before CodeMirror sees them (Quire's
 * shortcuts come first), so the app hands them to CodeMirror's own search here. Uses the editor
 * with focus, else the one inside `within`. False when there is none (the page's find bar runs).
 */
export function codeEditorFind(action, within) {
  const active = document.activeElement;
  const dom = (active && active.closest && active.closest(".cm-editor")) || (within && within.querySelector(".cm-editor"));
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) return false;
  if (action === "find") openSearchPanel(view);
  else if (action === "find-next") findNext(view);
  else findPrevious(view);
  return true;
}

/** Language support for a file name, or [] for plain text. */
export function languageFor(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === ".noteblock" || lower.endsWith("/.noteblock") || lower === ".quire" || lower.endsWith("/.quire")) return json();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "html":
    case "htm":
      return html();
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "css":
      return css();
    case "json":
    case "webmanifest":
      return json();
    case "md":
    case "markdown":
      return markdown();
    case "py":
      return python();
    case "sql":
      return sql();
    case "xml":
    case "svg":
      return xml();
    case "yml":
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

// Light theme on the app's own tokens, GitHub-light syntax colors.
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg)", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 16px 0 8px" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 16px" },
  ".cm-activeLine": { backgroundColor: "#f6f8fb" },
  ".cm-activeLineGutter": { backgroundColor: "#f6f8fb", color: "var(--muted)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "#dbe3fb !important" },
  ".cm-matchingBracket": { backgroundColor: "#e6ebf7", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "#eef1f8" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", color: "var(--faint)" },
  ".cm-panels": { backgroundColor: "var(--side)", color: "var(--text)", fontFamily: "var(--font)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-searchMatch": { backgroundColor: "#fff1b8" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#ffd66b" },
  ".cm-textfield": { border: "1px solid var(--border)", borderRadius: "4px", padding: "2px 6px" },
  ".cm-button": { backgroundImage: "none", border: "1px solid var(--border)", borderRadius: "4px" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "#cf222e" },
  { tag: [t.tagName], color: "#116329" },
  { tag: [t.attributeName, t.propertyName], color: "#0550ae" },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue], color: "#0a3069" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#0550ae" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6e7781", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8250df" },
  { tag: [t.typeName, t.className, t.namespace], color: "#953800" },
  { tag: [t.definition(t.variableName)], color: "#953800" },
  { tag: [t.angleBracket, t.bracket, t.punctuation, t.separator], color: "#57606a" },
  { tag: t.heading, color: "#0550ae", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.link, color: "#0969da", textDecoration: "underline" },
  { tag: t.url, color: "#0a3069" },
  { tag: t.invalid, color: "#82071e" },
]);

/**
 * CodeMirror editor. `value` replaces the document when it differs from what's there (a load);
 * typing calls `onChange(text)`.
 */
export default function CodeEditor({ value, onChange, readOnly, filename, label }) {
  const host = useRef(null);
  const view = useRef(null);
  const lang = useRef(new Compartment());
  const ro = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const applying = useRef(false);

  useEffect(() => {
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value || "",
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorState.tabSize.of(2),
          indentUnit.of("  "),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          syntaxHighlighting(highlight),
          theme,
          lang.current.of(languageFor(filename)),
          ro.current.of([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.contentAttributes.of({ "aria-label": label || "Code editor", spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !applying.current) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if ((value || "") === cur) return;
    applying.current = true;
    // A load, not an edit: keep it out of undo.
    v.dispatch({ changes: { from: 0, to: cur.length, insert: value || "" }, annotations: Transaction.addToHistory.of(false) });
    applying.current = false;
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(languageFor(filename)) });
  }, [filename]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  return <div className="code-editor" ref={host} />;
}
