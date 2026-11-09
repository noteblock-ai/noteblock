import CodeEditor from "./CodeEditor.jsx";
import SqliteView from "./SqliteView.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { words } from "./platform.js";
import { vaultUrl } from "./webBridge.js";

const SAVE_DELAY = 800;

function formatSize(n) {
  if (n < 1024) return n + " bytes";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

/**
 * One file of a page in a plain monospace editor, opened from the sidebar's source view.
 * Saves 800 ms after typing stops and on ⌘S. Binary and oversized files are shown, not edited.
 */
const DB_FILE = /\.(sqlite3?|db)$/i;
const MEDIA = {
  image: /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i,
  pdf: /\.pdf$/i,
  video: /\.(mp4|webm|mov)$/i,
  audio: /\.(mp3|wav|m4a|ogg)$/i,
};

/** URL of a file in a page (or, for a plain file, in a folder; "" = the top): quire://vault/… or, on the web host, /v/…. */
function fileUrl(page, file) {
  return vaultUrl([...(page ? page.split("/") : []), ...file.split("/")].join("/"));
}

export default function FileView(props) {
  if (DB_FILE.test(props.file)) return <SqliteView key={props.page + "/" + props.file} api={props.api} page={props.page} file={props.file} />;
  const media = Object.keys(MEDIA).find((k) => MEDIA[k].test(props.file));
  if (media) return <MediaView key={props.page + "/" + props.file} {...props} kind={media} />;
  return <TextFileView {...props} />;
}

function FileActions({ api, page, file }) {
  return (
    <span className="file-actions">
      <button type="button" className="settings-button" onClick={() => api.openFileExternally(page, file).catch(() => {})}>
        Open in default app
      </button>
      <button type="button" className="settings-button" onClick={() => api.reveal(page ? page + "/" + file : file)}>
        {words.reveal}
      </button>
    </span>
  );
}

/** Images, PDFs, video and audio, shown as themselves. */
function MediaView({ api, page, file, kind, filesTick }) {
  const src = fileUrl(page, file) + (filesTick ? "?v=" + filesTick : "");
  return (
    <div className="source">
      <section className="source-editor file-editor" aria-label={file}>
        <div className="source-file">
          <span>{file}</span>
          <FileActions api={api} page={page} file={file} />
        </div>
        <div className={"file-media is-" + kind}>
          {kind === "image" ? <img src={src} alt={file} /> : null}
          {kind === "pdf" ? <iframe src={src} title={file} /> : null}
          {kind === "video" ? <video src={src} controls /> : null}
          {kind === "audio" ? <audio src={src} controls /> : null}
        </div>
      </section>
    </div>
  );
}

function TextFileView({ api, page, file, locked, onSaved, onStatus, filesTick }) {
  const [info, setInfo] = useState(null); // {size, binary, tooLarge}
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const dirty = useRef(false);
  const latest = useRef("");
  const timer = useRef(null);
  const target = useRef({ page, file });

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current || locked) return;
    const { page: p, file: f } = target.current;
    const text = latest.current;
    dirty.current = false;
    onStatus("saving");
    try {
      await api.writeFile(p, f, text);
      onStatus("saved");
      onSaved(f);
    } catch (e) {
      dirty.current = true;
      onStatus("error");
      setError(String(e?.message || e));
    }
  }, [api, locked, onSaved, onStatus]);

  const load = useCallback(async () => {
    try {
      const res = await api.readFile(page, file);
      if (target.current.page !== page || target.current.file !== file) return;
      setInfo(res);
      setContent(res?.content ?? "");
      latest.current = res?.content ?? "";
      dirty.current = false;
      setError("");
    } catch (e) {
      setInfo(null);
      setError(String(e?.message || e));
    } finally {
      setLoaded(true);
    }
  }, [api, page, file]);

  // New file: flush the old one, then load.
  useEffect(() => {
    target.current = { page, file };
    setLoaded(false);
    load();
    return () => {
      if (dirty.current && timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        const text = latest.current;
        dirty.current = false;
        api.writeFile(page, file, text).then(() => onSaved(file), () => {});
      }
    };
  }, [page, file, api, load, onSaved]);

  // Files changed on disk or the lock came or went: re-read unless there's unsaved typing.
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


  const unreadable = info && (info.binary || info.tooLarge);

  return (
    <div className="source">
      <section className="source-editor file-editor" aria-label={file}>
        <div className="source-file">
          <span>{file}</span>
          {locked ? <span className="source-ro">Read-only while Claude edits</span> : null}
          {error ? <span className="source-err" role="alert">{error}</span> : null}
        </div>
        {unreadable ? (
          <div className="file-note">
            <span>
              {info.binary ? "No preview for this kind of file" : "Too large to edit here"} · {formatSize(info.size)}
            </span>
            <FileActions api={api} page={page} file={file} />
          </div>
        ) : (
          <CodeEditor
            key={page + "/" + file}
            label={"Source of " + file}
            filename={file}
            readOnly={locked || !loaded || !info}
            value={content}
            onChange={change}
          />
        )}
      </section>
    </div>
  );
}
