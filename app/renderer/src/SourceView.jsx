import CodeEditor from "./CodeEditor.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { pageSrc } from "./tree.js";

const SAVE_DELAY = 800;

/**
 * Source mode: the entry file in a plain monospace editor on the left, a live preview of
 * the page on the right. Saves 800 ms after typing stops and on ⌘S.
 */
export default function SourceView({ api, path, id, locked, previewRef, previewKey, onPreviewLoad, onSaved, onStatus, filesTick }) {
  const [file, setFile] = useState("index.html");
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const dirty = useRef(false);
  const latest = useRef("");
  const timer = useRef(null);
  const pathRef = useRef(path);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current || locked) return;
    const p = pathRef.current;
    const text = latest.current;
    dirty.current = false;
    onStatus("saving");
    try {
      await api.writeEntry(p, text);
      onStatus("saved");
      onSaved();
    } catch (e) {
      dirty.current = true;
      onStatus("error");
      setError(String(e?.message || e));
    }
  }, [api, locked, onSaved, onStatus]);

  const load = useCallback(async () => {
    try {
      const entry = await api.readEntry(path);
      if (pathRef.current !== path) return;
      setFile(entry?.file || "index.html");
      setContent(entry?.content ?? "");
      latest.current = entry?.content ?? "";
      dirty.current = false;
      setError("");
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoaded(true);
    }
  }, [api, path]);

  // New page: flush the old one, then load.
  useEffect(() => {
    pathRef.current = path;
    setLoaded(false);
    load();
    return () => {
      if (dirty.current && timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        const text = latest.current;
        dirty.current = false;
        api.writeEntry(path, text).then(() => onSaved(), () => {});
      }
    };
  }, [path, api, load, onSaved]);

  // Files changed on disk (an agent, another editor) or the lock came or went: re-read
  // unless the person has unsaved typing.
  useEffect(() => {
    if (filesTick && !dirty.current) load();
  }, [filesTick, load]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const change = (text) => {
    setContent(text);
    latest.current = text;
    dirty.current = true;
    onStatus("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(save, SAVE_DELAY);
  };


  return (
    <div className="source">
      <section className="source-editor" aria-label={file}>
        <div className="source-file">
          <span>{file}</span>
          {locked ? <span className="source-ro">Read-only while Claude edits</span> : null}
          {error ? <span className="source-err" role="alert">{error}</span> : null}
        </div>
        <CodeEditor
            key={path}
            label={"Source of " + file}
            filename={file}
            readOnly={locked || !loaded}
            value={content}
            onChange={change}
          />
      </section>
      <section className="source-preview" aria-label="Live preview">
        <div className="source-preview-head">
          <span className="live-dot" aria-hidden="true" />
          Live preview
        </div>
        <iframe
          key={previewKey}
          ref={previewRef}
          className="page-frame"
          title="Live preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
          allow="fullscreen; autoplay"
          src={pageSrc(path, id)}
          onLoad={onPreviewLoad}
        />
      </section>
    </div>
  );
}
