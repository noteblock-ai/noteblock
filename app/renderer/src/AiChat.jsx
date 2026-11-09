// The ⌘J assistant (docs/ai.md "0.3.3", designs/canvas/build-ai2.mjs boards 1–10): one
// conversation at a time about the whole vault, as a card floating bottom centre over the main
// column or docked to the right. App.jsx owns the jobs and the conversations (from `chat`
// events) and passes in the open one; this draws it: the empty bar, the
// thread (prompt, steps, changes with one Undo, reply), the working and Ask states, and history.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AiIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  ClockIcon,
  CloseIcon,
  DockIcon,
  FileIcon,
  FolderIcon,
  GearIcon,
  MoveIcon,
  PageIcon,
  PlusIcon,
  SearchIcon,
  Spinner,
  TrashIcon,
  UndoIcon,
  WarnIcon,
} from "./icons.jsx";

const MESSAGES = {
  limit: "Noteblock AI is paused until tomorrow",
  credits: "Out of credits",
  off: "Noteblock AI isn't on for this account",
  "signed-out": "Sign in to use Noteblock AI",
};
const BUSY = new Set(["working", "ask"]);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const cleanError = (e) => String(e?.message || e || "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** An error from a rejected ai.* call: its code when it has one, else read off the message. */
export function errorOf(e) {
  const message = cleanError(e);
  let code = e?.code;
  if (!code) {
    if (/paused until tomorrow|noteblock_ai_limit/i.test(message)) code = "limit";
    else if (/out of .*credits|noteblock_ai_credits/i.test(message)) code = "credits";
    else if (/isn.t on for this account|noteblock_ai_off/i.test(message)) code = "off";
    else if (/sign(ed)? in|signed.out|authentication_error/i.test(message)) code = "signed-out";
    else if (/is editing this page/i.test(message)) code = "locked";
    else code = "failed";
  }
  return { code, message };
}

/* ---------------------------------------------------------------- text */

// Markdown-lite for replies: **bold**, `code`, "- " lists and line breaks. Built as React
// elements from the text, so nothing the model writes is ever parsed as HTML.
function inline(text, key) {
  const out = [];
  const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let at = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1] != null) out.push(<strong key={key + ":" + i++}>{m[1]}</strong>);
    else out.push(<code key={key + ":" + i++}>{m[2]}</code>);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function Markdown({ text }) {
  const blocks = String(text || "").trim().split(/\n{2,}/);
  return blocks.map((block, b) => {
    const lines = block.split("\n");
    const parts = [];
    let list = null;
    let para = null;
    const flush = () => {
      if (list) parts.push(<ul key={"u" + parts.length}>{list}</ul>);
      if (para) parts.push(<p key={"p" + parts.length}>{para}</p>);
      list = null;
      para = null;
    };
    lines.forEach((line, l) => {
      const item = line.match(/^\s*[-*•]\s+(.*)$/);
      if (item) {
        if (para) flush();
        (list ||= []).push(<li key={l}>{inline(item[1], b + ":" + l)}</li>);
      } else {
        if (list) flush();
        if (para) para.push(<br key={"br" + l} />);
        (para ||= []).push(...inline(line, b + ":" + l));
      }
    });
    flush();
    return <Fragment key={b}>{parts}</Fragment>;
  });
}

const firstLine = (t) => String(t || "").trim().split("\n")[0].replace(/\*\*|`/g, "");

function when(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = (new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000;
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function groupOf(ms) {
  const d = new Date(ms || 0).toDateString();
  const now = new Date();
  if (d === now.toDateString()) return "Today";
  if (d === new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString()) return "Yesterday";
  return "Earlier";
}
function seconds(turn) {
  if (!turn.at || !turn.endedAt || turn.endedAt < turn.at) return "";
  const s = (turn.endedAt - turn.at) / 1000;
  return s < 10 ? s.toFixed(1) + " s" : Math.round(s) + " s";
}

const CHANGE_ICONS = { edit: PageIcon, write: FileIcon, delete: FileIcon, create: PageIcon, folder: FolderIcon, move: MoveIcon, trash: TrashIcon, setting: GearIcon, open: PageIcon };

/* ---------------------------------------------------------------- pieces */

function IconButton({ label, onClick, on = false, children, disabled }) {
  return (
    <button
      type="button"
      className={"ai-chat-icon" + (on ? " is-on" : "")}
      aria-label={label}
      title={label}
      aria-pressed={on || undefined}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function Steps({ turn, open, onToggle }) {
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  if (!steps.length) return null;
  const time = seconds(turn);
  const head = steps.length === 1 ? steps[0] : plural(steps.length, "step", "steps");
  return (
    <div className="ai-chat-steps">
      <button type="button" className="ai-chat-steps-line" aria-expanded={open} onClick={onToggle}>
        <span className="ai-chat-steps-text">{[head, time].filter(Boolean).join(" · ")}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open ? (
        <ul className="ai-chat-steps-list">
          {steps.map((s, i) => (
            <li key={i}>
              <span className="ai-chat-tick" aria-hidden="true">
                <CheckIcon size={12} />
              </span>
              {s}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Ticks({ steps }) {
  return steps.map((s, i) => (
    <div className="ai-chat-done-step" key={i}>
      <span className="ai-chat-tick" aria-hidden="true">
        <CheckIcon size={13} />
      </span>
      <span>{s}</span>
    </div>
  ));
}

/** Out of credits: Buy credits, and Upgrade to Pro unless already on Pro. Both open Settings › Plan. */
function CreditsButtons({ plan, onOpenPlan }) {
  if (!onOpenPlan) return null;
  return (
    <>
      <button type="button" className="ai-chat-btn is-dark" onClick={onOpenPlan}>
        Buy credits
      </button>
      {plan !== "pro" ? (
        <button type="button" className="ai-chat-btn" onClick={onOpenPlan}>
          Upgrade to Pro
        </button>
      ) : null}
    </>
  );
}

function Turn({ turn, job, stepsOpen, onToggleSteps, undo, onUndo, onStop, onAnswer, onRetry, onOpenPage, onSignIn, signingIn, plan, onOpenPlan }) {
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  const changes = Array.isArray(turn.changes) ? turn.changes : [];
  const skipped = Array.isArray(turn.skipped) ? turn.skipped : [];
  const working = turn.state === "working";
  const asking = turn.state === "ask" && turn.ask;
  const applying = job && (job.state === "ready" || job.state === "applying");
  const err = turn.state === "error" ? turn.error || { code: "failed", message: "" } : null;
  const errText = err ? MESSAGES[err.code] || err.message || "Noteblock AI stopped with an error" : "";

  return (
    <div className="ai-chat-turn">
      <div className="ai-chat-you">{turn.prompt}</div>

      {working || asking ? <Ticks steps={(working ? steps.slice(0, -1) : steps).filter((s) => s !== "Thinking")} /> : <Steps turn={turn} open={stepsOpen} onToggle={onToggleSteps} />}

      {changes.length ? (
        <div className={"ai-chat-changes" + (turn.state === "undone" ? " is-undone" : "")}>
          {changes.map((c, i) => {
            const Icon = CHANGE_ICONS[c.kind] || FileIcon;
            return (
              <div className="ai-chat-change" key={i}>
                <span className="ai-chat-change-icon" aria-hidden="true">
                  <Icon size={15} />
                </span>
                <span className="ai-chat-change-text">{inline(String(c.text || ""), "c" + i)}</span>
                {c.page && turn.state !== "undone" ? (
                  <button type="button" className="ai-chat-link" onClick={() => onOpenPage(c.page)}>
                    Open
                  </button>
                ) : null}
              </div>
            );
          })}
          {skipped.length ? (
            <div className="ai-chat-skipped">
              {skipped.map((s, i) => (
                <div className="ai-chat-change is-skipped" key={i}>
                  <span className="ai-chat-change-icon is-warn" aria-hidden="true">
                    <WarnIcon size={15} />
                  </span>
                  <span className="ai-chat-change-text">
                    Skipped {s.file || "a change"}
                    {s.reason ? ": " + s.reason : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {turn.undoable || turn.state === "undone" || undo?.error ? (
            <div className="ai-chat-changes-foot">
              {undo?.error ? <span className="ai-chat-undo-error">{undo.error}</span> : null}
              {turn.state === "undone" ? (
                <span className="ai-chat-undone">Undone</span>
              ) : turn.undoable ? (
                <button type="button" className="ai-chat-btn" onClick={onUndo} disabled={!!undo?.busy}>
                  <UndoIcon size={13} />
                  {undo?.busy ? "Undoing…" : "Undo"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : skipped.length ? (
        <div className="ai-chat-changes">
          {skipped.map((s, i) => (
            <div className="ai-chat-change is-skipped" key={i}>
              <span className="ai-chat-change-icon is-warn" aria-hidden="true">
                <WarnIcon size={15} />
              </span>
              <span className="ai-chat-change-text">
                Skipped {s.file || "a change"}
                {s.reason ? ": " + s.reason : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {turn.reply ? (
        <div className="ai-chat-reply">
          <Markdown text={turn.reply} />
        </div>
      ) : null}

      {working ? (
        <div className="ai-chat-working" aria-live="polite">
          <Spinner size={13} label="Working" />
          <span className="ai-chat-working-text">{applying ? "Applying the changes" : steps[steps.length - 1] || "Thinking"}</span>
          <button type="button" className="ai-chat-stop" onClick={onStop} disabled={job?.state === "applying"}>
            <kbd>esc</kbd> stop
          </button>
        </div>
      ) : null}

      {asking ? (
        <div className="ai-chat-ask" role="group" aria-label="Noteblock AI is asking">
          <div className="ai-chat-ask-text">
            <div className="ai-chat-ask-title">{turn.ask.title || "Noteblock AI wants to take a step set to Ask"}</div>
            {turn.ask.detail ? <div className="ai-chat-ask-detail">{turn.ask.detail}</div> : null}
          </div>
          <button type="button" className="ai-chat-btn" onClick={() => onAnswer(false)}>
            Don’t <kbd>esc</kbd>
          </button>
          <button type="button" className="ai-chat-btn is-dark" onClick={() => onAnswer(true)}>
            Allow <kbd>↵</kbd>
          </button>
        </div>
      ) : null}

      {turn.state === "stopped" ? <div className="ai-chat-note">Stopped</div> : null}

      {err ? (
        <div className="ai-chat-error" role="alert">
          <span className="ai-chat-change-icon is-warn" aria-hidden="true">
            <WarnIcon size={15} />
          </span>
          <span className="ai-chat-error-text">{errText}</span>
          {err.code === "signed-out" ? (
            <button type="button" className="ai-chat-btn" onClick={onSignIn} disabled={signingIn}>
              {signingIn ? "Finish in your browser" : "Sign in"}
            </button>
          ) : err.code === "network" || err.code === "failed" ? (
            <button type="button" className="ai-chat-btn" onClick={onRetry}>
              Retry
            </button>
          ) : err.code === "credits" ? (
            <CreditsButtons plan={plan} onOpenPlan={onOpenPlan} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function History({ api, chats, current, onPick, onDeleted, inputRef }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = (chats || []).filter((c) => !q || String(c.title || "").toLowerCase().includes(q) || String(c.last || "").toLowerCase().includes(q));
  const groups = [];
  for (const c of list) {
    const g = groupOf(c.updated);
    if (!groups.length || groups[groups.length - 1].name !== g) groups.push({ name: g, items: [] });
    groups[groups.length - 1].items.push(c);
  }
  return (
    <>
      <div className="ai-chat-search">
        <SearchIcon size={15} />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Search conversations"
          aria-label="Search conversations"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && list[0]) {
              e.preventDefault();
              onPick(list[0].id);
            }
          }}
        />
      </div>
      <div className="ai-chat-history" role="list">
        {chats == null ? (
          <div className="ai-chat-history-empty">
            <Spinner size={14} />
          </div>
        ) : !list.length ? (
          <div className="ai-chat-history-empty">{q ? "No conversations match" : "No conversations yet"}</div>
        ) : (
          groups.map((g) => (
            <Fragment key={g.name}>
              <div className="ai-chat-history-group">{g.name}</div>
              {g.items.map((c) => (
                <div className={"ai-chat-history-row" + (c.id === current ? " is-on" : "")} role="listitem" key={c.id}>
                  <button type="button" className="ai-chat-history-pick" onClick={() => onPick(c.id)}>
                    <span className="ai-chat-history-text">
                      <span className="ai-chat-history-title">{c.title || "Untitled"}</span>
                      {c.last ? <span className="ai-chat-history-sub">{firstLine(c.last)}</span> : null}
                    </span>
                    <span className="ai-chat-history-when">{when(c.updated)}</span>
                  </button>
                  {api.ai?.deleteChat ? (
                    <button
                      type="button"
                      className="ai-chat-history-delete"
                      aria-label={"Delete " + (c.title || "conversation")}
                      title="Delete"
                      onClick={() => api.ai.deleteChat(c.id).then(() => onDeleted(c.id), () => {})}
                    >
                      <CloseIcon size={12} />
                    </button>
                  ) : null}
                </div>
              ))}
            </Fragment>
          ))
        )}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- the card */

export default function AiChat({
  api,
  conversation, // the open conversation (no `messages`), or null for a new one
  docked,
  focusSeq, // bumped on every ⌘J open: focus, read ai.status() and the list once
  context, // {path, title}: the selected page, sent along with each request (not shown)
  jobs, // jobId → the window's job record (for "Applying the changes")
  onSend, // (prompt, page|null) → Promise
  onStop, // (turn)
  onAnswer, // (turn, allow)
  onUndo, // (turn) → Promise
  onOpenPage, // (path)
  onOpenChat, // (id)
  onNewChat,
  onDock,
  onClose,
  onOpenPlan, // Settings › Plan (Buy credits, Upgrade to Pro)
}) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState(null); // ai.status(): {signedIn, enabled, limitReached, model}
  const [signingIn, setSigningIn] = useState(false);
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState(null); // {code, message} from a refused start
  const [view, setView] = useState("chat"); // "chat" | "history"
  const [chats, setChats] = useState(null); // ai.chats(), read on open and for history
  const [stepsOpen, setStepsOpen] = useState(() => new Set());
  const [undos, setUndos] = useState({}); // turnId → {busy, error}
  const input = useRef(null);
  const search = useRef(null);
  const root = useRef(null);
  const thread = useRef(null);
  const alive = useRef(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Floating: a click anywhere outside the card closes it. A click in the page frame never
  // reaches this document, so the window losing focus to the iframe counts too. Docked stays.
  useEffect(() => {
    if (docked) return undefined;
    const onDown = (e) => {
      if (root.current && !root.current.contains(e.target)) closeRef.current?.();
    };
    const onBlur = () => {
      setTimeout(() => {
        if (document.activeElement?.tagName === "IFRAME") closeRef.current?.();
      }, 0);
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [docked]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const last = turns[turns.length - 1] || null;
  const busyTurn = last && BUSY.has(last.state) ? last : null;
  const asking = busyTurn?.state === "ask" && busyTurn.ask ? busyTurn : null;

  const loadChats = () =>
    api.ai?.chats?.().then(
      (list) => alive.current && setChats(Array.isArray(list) ? list : []),
      () => alive.current && setChats([]),
    );
  // Once per open (⌘J), never polled: status goes to the Neon-backed hosting side.
  const loadStatus = () =>
    api.ai?.status?.().then(
      (s) => alive.current && setStatus(s || null),
      () => alive.current && setStatus(null),
    );
  useEffect(() => {
    loadStatus();
    loadChats();
    setLocalError(null);
    setView("chat");
  }, [focusSeq]); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => {
    if (!focusSeq) return;
    (input.current || root.current?.querySelector("button:not([disabled])"))?.focus();
  }, [focusSeq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (view === "history") search.current?.focus();
  }, [view]);

  // Autosize: one line to start, grows with the text up to the CSS max-height.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [text, view]);

  // Keep the newest turn in view while it grows, unless the person scrolled up to read.
  const pinned = useRef(true);
  const lastKey = last ? `${turns.length}:${last.state}:${(last.steps || []).length}:${(last.reply || "").length}:${(last.changes || []).length}` : "";
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, view, conversation?.id, focusSeq]);
  useEffect(() => {
    pinned.current = true;
  }, [conversation?.id, turns.length]);

  const ctxPage = context ? context.path : null;

  const send = async (prompt = text.trim(), page = ctxPage) => {
    if (!prompt || sending || busyTurn) return;
    setSending(true);
    setLocalError(null);
    try {
      await onSend(prompt, page);
      if (!alive.current) return;
      setText("");
      pinned.current = true;
    } catch (e) {
      if (alive.current) setLocalError(errorOf(e));
    } finally {
      if (alive.current) setSending(false);
    }
  };

  const signIn = () => {
    if (!api.hostingSignIn) return;
    setSigningIn(true);
    api.hostingSignIn().then(
      () => {
        if (!alive.current) return;
        setSigningIn(false);
        setLocalError(null);
        loadStatus();
      },
      () => alive.current && setSigningIn(false),
    );
  };
  const cancelSignIn = () => {
    api.hostingCancelSignIn?.().catch(() => {});
    setSigningIn(false);
  };

  const undo = (turn) => {
    setUndos((u) => ({ ...u, [turn.id]: { busy: true, error: "" } }));
    Promise.resolve(onUndo(turn)).then(
      () => alive.current && setUndos((u) => ({ ...u, [turn.id]: { busy: false, error: "" } })),
      (e) => alive.current && setUndos((u) => ({ ...u, [turn.id]: { busy: false, error: "Couldn't undo: " + (cleanError(e) || "something went wrong") } })),
    );
  };

  const openChat = (id) => {
    setView("chat");
    setText("");
    setLocalError(null);
    if (id !== conversation?.id) onOpenChat(id);
    requestAnimationFrame(() => input.current?.focus());
  };
  const newChat = () => {
    setView("chat");
    setText("");
    setLocalError(null);
    onNewChat();
    requestAnimationFrame(() => input.current?.focus());
  };
  const showHistory = () => {
    if (view === "history") {
      setView("chat");
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    loadChats();
    setView("history");
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (signingIn) return cancelSignIn();
      if (view === "history") {
        setView("chat");
        requestAnimationFrame(() => input.current?.focus());
        return;
      }
      if (asking && !text.trim()) return onAnswer(asking, false);
      if (busyTurn?.state === "working") return onStop(busyTurn);
      onClose();
      return;
    }
    // ↵ allows a step set to Ask while the input is empty (the textarea handles its own ↵).
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && asking && !text.trim()) {
      const tag = e.target?.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "A") return;
      e.preventDefault();
      onAnswer(asking, true);
    }
  };

  const outOfCredits = !!status?.credits && Number(status.credits.left) <= 0;
  const gate =
    status?.signedIn === false
      ? { code: "signed-out" }
      : outOfCredits
        ? { code: "credits" }
        : status?.enabled === false
        ? { code: "off" }
        : status?.limitReached
          ? { code: "limit" }
          : null;
  const shownError = localError || gate;
  const can = !!text.trim() && !sending && !busyTurn && !gate;
  const hasHead = docked || turns.length > 0 || view === "history" || !!conversation;
  const title = view === "history" ? "Conversations" : conversation?.title || "Noteblock AI";

  const head = hasHead ? (
    <div className="ai-chat-head">
      <span className="ai-chat-mark" aria-hidden="true">
        <AiIcon size={15} />
      </span>
      <span className="ai-chat-title" title={title}>
        {title}
      </span>
      <IconButton label="Conversations" on={view === "history"} onClick={showHistory}>
        <ClockIcon size={16} />
      </IconButton>
      <IconButton label="New conversation" onClick={newChat}>
        <PlusIcon size={16} />
      </IconButton>
      <IconButton label={docked ? "Undock" : "Dock to the side"} on={docked} onClick={onDock}>
        <DockIcon size={16} />
      </IconButton>
      <IconButton label="Close" onClick={onClose}>
        <CloseIcon size={16} />
      </IconButton>
    </div>
  ) : null;

  let body = null;
  if (view === "history") {
    body = (
      <History
        api={api}
        chats={chats}
        current={conversation?.id}
        inputRef={search}
        onPick={openChat}
        onDeleted={(id) => {
          setChats((list) => (list || []).filter((c) => c.id !== id));
          if (id === conversation?.id) onNewChat();
        }}
      />
    );
  } else if (turns.length) {
    body = (
      <div
        className="ai-chat-thread"
        ref={thread}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {turns.map((t) => (
          <Turn
            key={t.id || t.jobId}
            turn={t}
            job={t.jobId ? jobs?.[t.jobId] : null}
            stepsOpen={stepsOpen.has(t.id)}
            onToggleSteps={() =>
              setStepsOpen((s) => {
                const n = new Set(s);
                if (n.has(t.id)) n.delete(t.id);
                else n.add(t.id);
                return n;
              })
            }
            undo={undos[t.id]}
            onUndo={() => undo(t)}
            onStop={() => onStop(t)}
            onAnswer={(allow) => onAnswer(t, allow)}
            onRetry={() => send(t.prompt, t.page ?? null)}
            onOpenPage={onOpenPage}
            onSignIn={signIn}
            signingIn={signingIn}
            plan={status?.plan}
            onOpenPlan={onOpenPlan}
          />
        ))}
      </div>
    );
  }

  const notice = shownError ? (
    <div className="ai-chat-notice" role="alert">
      <span className="ai-chat-change-icon is-warn" aria-hidden="true">
        {signingIn ? <Spinner size={14} /> : <WarnIcon size={15} />}
      </span>
      <span className="ai-chat-error-text">
        {signingIn ? "Finish signing in in your browser" : MESSAGES[shownError.code] || shownError.message || "Something went wrong"}
      </span>
      {shownError.code === "signed-out" ? (
        signingIn ? (
          <button type="button" className="ai-chat-btn" onClick={cancelSignIn}>
            Cancel
          </button>
        ) : (
          <button type="button" className="ai-chat-btn is-dark" onClick={signIn} disabled={!api.hostingSignIn}>
            Sign in
          </button>
        )
      ) : shownError.code === "credits" ? (
        <CreditsButtons plan={status?.plan} onOpenPlan={onOpenPlan} />
      ) : localError ? (
        <IconButton label="Dismiss" onClick={() => setLocalError(null)}>
          <CloseIcon size={14} />
        </IconButton>
      ) : null}
    </div>
  ) : null;

  const foot =
    view === "history" ? null : (
      <div className={"ai-chat-foot" + (body || hasHead ? " has-line" : "")}>
        {notice}
        <textarea
          ref={input}
          className="ai-chat-input"
          rows={1}
          value={text}
          placeholder={turns.length ? "Reply, or ask something new" : "Ask Noteblock AI anything"}
          aria-label="Ask Noteblock AI"
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              if (asking && !text.trim()) onAnswer(asking, true);
              else if (can) send();
            } else if (e.key === "ArrowUp" && !text && !turns.length && api.ai?.chats) {
              e.preventDefault();
              showHistory();
            }
          }}
        />
        <div className="ai-chat-foot-row">
          <span className="ai-chat-grow" />
          {!hasHead && api.ai?.chats ? (
            <IconButton label="Past conversations" onClick={showHistory}>
              <ClockIcon size={16} />
            </IconButton>
          ) : null}
          <button type="button" className={"ai-chat-send" + (can ? " is-on" : "")} aria-label="Send" disabled={!can} onClick={() => send()}>
            {sending ? <Spinner size={14} /> : <ArrowUpIcon size={16} />}
          </button>
        </div>
      </div>
    );

  return (
    <div
      ref={root}
      className={"ai-chat" + (docked ? " is-docked" : " is-floating") + (view === "history" ? " is-history" : "")}
      role="region"
      aria-label="Noteblock AI"
      onKeyDown={onKeyDown}
    >
      {head}
      {body}
      {foot}
    </div>
  );
}
