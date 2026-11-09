// Noteblock AI smoke (app/main/ai.mjs, docs/ai.md): plain Node, no Electron. A temp vault and
// config dir, a fake Anthropic-compatible SSE server standing in for the hosting pass-through
// (/api/ai/v1/messages and /api/ai/status), and a stored desktop token. Covers: the history
// helpers; signed out; a ⌘J conversation over three turns (create a folder and move a page into
// it; edit a file and write one, with turn 1 sent along; a setting behind Ask), its saved file,
// turn changes, undo of the move turn and of the others; a concurrent edit before apply → that
// op skipped, the other applied; a tool set to off; vault_stats; Ask + Stop and the closed
// history; a block job replacing its marker; a missing marker → stopped; an old newpage marker
// built as a block; a hosting refusal mapped to an error code.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quire-ai-"));
// Before core is imported: config writes must never reach ~/.noteblock.
process.env.QUIRE_CONFIG_DIR = path.join(tmp, "config");

/* ------------------------------------------------------------------ the fake server */

const TOKEN = "desktop-token-123";
/** Each POST takes the next responder: (body, req) → {blocks, stop} | {status, error}. */
const queue = [];
const requests = [];

function sse(res, { blocks = [], stop = "end_turn" }) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", {
    message: { id: "msg_" + Math.random().toString(36).slice(2), type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      ev("content_block_start", { index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      for (let i = 0; i < json.length; i += 7) ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 7) } });
    }
    ev("content_block_stop", { index });
  });
  ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  ev("message_stop", {});
  res.end();
}

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || "";
  if (req.method === "GET" && req.url === "/api/ai/status") {
    if (auth !== `Bearer ${TOKEN}`) return res.writeHead(401).end("{}");
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ enabled: true, model: "claude-haiku-5-5", buildModel: null, spentTodayCents: 12, limitCents: 100 }));
  }
  if (req.method !== "POST" || req.url !== "/api/ai/v1/messages") return res.writeHead(404).end();
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    requests.push({ headers: req.headers, body });
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json", "x-should-retry": "false" });
      return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "No token" } }));
    }
    const next = queue.shift();
    if (!next) {
      res.writeHead(500, { "content-type": "application/json", "x-should-retry": "false" });
      return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "no scripted response" } }));
    }
    const out = next(body);
    if (out.status) {
      res.writeHead(out.status, { "content-type": "application/json", "x-should-retry": "false" });
      return res.end(JSON.stringify({ type: "error", error: out.error }));
    }
    sse(res, out);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.QUIRE_HOSTING_URL = `http://127.0.0.1:${server.address().port}`;

const { createVault, createPage, findPage, gitLog } = await import("../core/index.mjs");
const hosting = await import("../app/main/hosting.mjs");
const { createAi, findMarker, changedIndexes, shortPrompt, isApplying, pastTense } = await import("../app/main/ai.mjs");
const { vaultKey, trimHistory, sealTurn } = await import("../app/main/ai-chats.mjs");
const { runRpc, AI_RELOADING_MSG, appPrefs, setAppPref, setAppShortcut } = await import("../app/main/ipc.mjs");
const { shortcutList } = await import("../app/main/shortcuts.mjs");

const cipher = {
  encrypt: (s) => Buffer.from(s, "utf8").map((b) => b ^ 0x5a),
  decrypt: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString("utf8"),
};
hosting.setTokenCipher(cipher);
const storeToken = () => {
  fs.mkdirSync(process.env.QUIRE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.QUIRE_CONFIG_DIR, "hosting.json"),
    JSON.stringify({ base: hosting.hostingBase(), token: Buffer.from(cipher.encrypt(TOKEN)).toString("base64"), user: { email: "ada@example.com" } }),
  );
};

/* ------------------------------------------------------------------ the vault */

const vault = createVault(path.join(tmp, "Vault"), { name: "Vault", seed: false });
createPage(vault, "Notes", { content: `<!doctype html><html><head><meta charset="utf-8"><title>Notes</title></head><body>\n<h1>Notes</h1>\n<p>Hello world</p>\n<p>Second line</p>\n</body></html>\n` });
createPage(vault, "Kyoto trip");
execFileSync("git", ["-C", vault, "add", "-A"]);
execFileSync("git", ["-C", vault, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pages"]);
const notes = () => fs.readFileSync(path.join(findPage(vault, "Notes").dir, "index.html"), "utf8");
const writeNotes = (s) => fs.writeFileSync(path.join(findPage(vault, "Notes").dir, "index.html"), s);
const exists = (rel) => fs.existsSync(path.join(vault, ...rel.split("/")));
const lastCommit = () => execFileSync("git", ["-C", vault, "show", "--name-status", "--format=%s", "HEAD"], { encoding: "utf8" });

const events = [];
const written = [];
// The app's Trash, standing in: a folder outside the vault (commit: false, as the chat asks).
const trashDir = path.join(tmp, "Trash");
const trashed = [];
const trash = async (rel, { commit = true } = {}) => {
  fs.mkdirSync(trashDir, { recursive: true });
  fs.renameSync(path.join(vault, ...rel.split("/")), path.join(trashDir, `${trashed.length}-${rel.split("/").pop()}`));
  trashed.push({ rel, commit });
};
// Settings through the same code as the IPC handlers (no window, no menu here).
const settingsDeps = {
  getPrefs: () => appPrefs(),
  setPref: (k, v) => setAppPref({ getWindow: () => null }, k, v),
  getShortcuts: () => shortcutList(),
  setShortcut: (id, acc) => setAppShortcut({ rebuildMenu: () => {} }, id, acc),
};
const deps = { getVault: () => vault, send: (e) => events.push(e), onWritten: (p) => written.push(p), trash, ...settingsDeps };
const ai = createAi(deps);

async function waitFor(pred, what, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}; events: ${JSON.stringify(events.map((e) => [e.jobId, e.type, e.code || e.text || ""]))}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const ended = (jobId) => waitFor((e) => e.jobId === jobId && ["ready", "error", "stopped"].includes(e.type), `job ${jobId} to end`);

const tool = (name, input, id = "toolu_" + Math.random().toString(36).slice(2)) => ({ type: "tool_use", id, name, input });
const say = (text) => ({ blocks: [{ type: "text", text }] });
const lastResults = () => requests.at(-1).body.messages.at(-1).content;
const chatFile = (id) => path.join(process.env.QUIRE_CONFIG_DIR, "ai", vaultKey(vault), `${id}.json`);
const turnOf = (conversationId, jobId) => ai.chat(conversationId).turns.find((t) => t.jobId === jobId);
const textOf = (content) => (typeof content === "string" ? content : content.map((b) => b.text || "").join("\n"));

try {
  // Helpers.
  const mk = `<p>a</p><div data-q-ai-target="block" class="x" data-q-ai="ai_1">make it</div><p>b</p>`;
  assert.deepEqual(findMarker(mk, "ai_1"), { start: 8, end: mk.length - "<p>b</p>".length });
  assert.equal(findMarker(`<div data-q-ai="ai_2">x</div>`, "ai_1"), null);
  assert.equal(shortPrompt("x".repeat(80)).length, 60);
  assert.deepEqual(changedIndexes("<body><p>a</p><p>b</p></body>", "<body><p>a</p><p>c</p><p>d</p></body>"), [1, 2]);
  assert.equal(pastTense("Reading Trip budget"), "Read Trip budget");
  assert.equal(pastTense("Thinking"), null);
  {
    // Three turns: the oldest one's tool output and context are stubbed, the last two kept.
    const turn = (n) => [
      { role: "user", content: [{ type: "text", text: `<request>\n${n}\n</request>` }, { type: "text", text: `<context>\nbig ${n}\n</context>` }] },
      { role: "assistant", content: [tool("read_file", { path: "index.html" }, `t${n}`)] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: `file ${n}` }] },
      { role: "assistant", content: [{ type: "text", text: `done ${n}` }] },
    ];
    const h = trimHistory([...turn(1), ...turn(2), ...turn(3)]);
    assert.equal(h.length, 12);
    assert.equal(h[2].content[0].content, "(old output omitted)");
    assert.equal(h[0].content[1].text, "<context>(old context omitted)</context>");
    assert.equal(h[6].content[0].content, "file 2");
    assert.equal(trimHistory([...turn(1), ...turn(2), ...turn(3)], { keepTurns: 2 })[0].content[0].text, "<request>\n2\n</request>");
    // A turn cut off after a tool_use: answered, then closed with an assistant note.
    const sealed = sealTurn(turn(1).slice(0, 2), "(stopped)");
    assert.deepEqual(sealed.slice(2).map((m) => m.role), ["user", "assistant"]);
    assert.equal(sealed[2].content[0].tool_use_id, "t1");
  }

  /* ---- signed out: no token, no network; the turn is saved as an error */
  assert.deepEqual((await ai.status()).signedIn, false);
  const so = await ai.start({ target: "chat", page: "Notes", prompt: "anything" });
  assert.equal(so.error.code, "signed-out");
  assert.ok(so.conversationId);
  const soEv = await waitFor((e) => e.jobId === so.jobId && e.type === "error", "signed-out error");
  assert.equal(soEv.code, "signed-out");
  assert.equal(soEv.conversationId, so.conversationId);
  assert.equal(requests.length, 0);
  assert.equal(turnOf(so.conversationId, so.jobId).state, "error");
  ai.deleteChat(so.conversationId);
  assert.equal(ai.chat(so.conversationId), null);
  assert.ok(!fs.existsSync(chatFile(so.conversationId)));

  storeToken();
  const st = await ai.status();
  assert.deepEqual(st, { signedIn: true, enabled: true, limitReached: false, model: "claude-haiku-5-5", buildModel: null, spentTodayCents: 12, limitCents: 100 });
  assert.equal(ai.permissions().editOtherPages, "ask");
  assert.equal(ai.permissions().movePages, "allow");
  assert.equal(ai.permissions().changeSettings, "ask");

  /* ---- chat turn 1: create a folder and move a page into it → ready; apply commits both */
  queue.push((body) => {
    assert.equal(body.model, "claude-haiku-5-5");
    assert.equal(body.max_tokens, 32000);
    assert.equal(body.thinking, undefined);
    assert.equal(body.tool_choice, undefined);
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.ok(!/claude|anthropic/i.test(body.system[0].text), "the system prompt names the model or company");
    assert.match(body.system[0].text, /Noteblock AI/);
    for (const name of ["move_page", "vault_stats", "get_settings", "change_setting", "edit_file", "trash_page"]) assert.ok(body.tools.some((t) => t.name === name), name);
    assert.ok(!body.tools.some((t) => t.name === "insert_block"));
    assert.equal(body.messages.length, 1);
    const first = body.messages[0].content;
    assert.match(first[0].text, /<request>\nPut Kyoto trip in a Travel folder\n<\/request>/);
    assert.match(first[0].text, /"Notes"/);
    assert.match(first[1].text, /^<context>/);
    assert.match(first[1].text, /Hello world/);
    assert.match(first[1].text, /Kyoto trip \(page\)/);
    assert.deepEqual(first.at(-1).cache_control, { type: "ephemeral" }, "the history's tail is a cache breakpoint");
    return { blocks: [tool("create_folder", { path: "Travel" }), tool("move_page", { from: "Kyoto trip", to: "Travel/Kyoto trip" })], stop: "tool_use" };
  });
  queue.push((body) => {
    const [r1, r2] = body.messages.at(-1).content;
    assert.ok(!r1.is_error && !r2.is_error, JSON.stringify([r1, r2]));
    return say("Moved **Kyoto trip** into a new Travel folder.");
  });
  const t1 = await ai.start({ target: "chat", page: "Notes", prompt: "Put Kyoto trip in a Travel folder" });
  const cid = t1.conversationId;
  assert.ok(t1.jobId && cid && !t1.error);
  await assert.rejects(() => ai.start({ target: "chat", conversationId: "aic_nope00", prompt: "x" }), /conversation is gone/);
  const r1 = await ended(t1.jobId);
  assert.equal(r1.type, "ready", JSON.stringify(r1));
  assert.equal(r1.target, "chat");
  assert.equal(r1.conversationId, cid);
  assert.ok(r1.turnId);
  assert.equal(requests.at(-1).headers["x-noteblock-purpose"], "chat");
  assert.ok(exists("Travel/Kyoto trip") && !exists("Kyoto trip"), "a move happens at once");
  const mv = events.find((e) => e.jobId === t1.jobId && e.type === "moved");
  assert.deepEqual([mv.from, mv.to], ["Kyoto trip", "Travel/Kyoto trip"]);
  assert.ok(events.filter((e) => e.jobId === t1.jobId).every((e) => e.conversationId === cid && e.turnId === r1.turnId && e.target === "chat"));
  const chatEv = events.filter((e) => e.type === "chat" && e.conversationId === cid).at(-1);
  assert.equal(chatEv.conversation.messages, undefined);
  assert.equal(chatEv.conversation.turns[0].jobId, t1.jobId);
  const a1 = await ai.apply(t1.jobId);
  assert.equal(a1.applied, 0);
  assert.ok(a1.commit, "the move and the folder are committed");
  assert.equal(gitLog(vault, 1)[0].message, "Noteblock AI: Put Kyoto trip in a Travel folder");
  assert.match(lastCommit(), /Travel\/Kyoto trip/);
  assert.match(lastCommit(), /Travel\/\.gitkeep/);
  const turn1 = turnOf(cid, t1.jobId);
  assert.equal(turn1.state, "done");
  assert.equal(turn1.reply, "Moved **Kyoto trip** into a new Travel folder.");
  assert.deepEqual(
    turn1.changes.map((c) => [c.kind, c.text, c.page]),
    [
      ["folder", "Created folder Travel", undefined],
      ["move", "Moved Kyoto trip into Travel", "Travel/Kyoto trip"],
    ],
  );
  assert.deepEqual(turn1.steps, ["Read Notes", "Created Travel", "Moved Kyoto trip into Travel"]);
  assert.equal(turn1.undoable, true);
  assert.ok(turn1.endedAt >= turn1.at);
  // Saved outside the vault, the full history with it.
  const saved1 = JSON.parse(fs.readFileSync(chatFile(cid), "utf8"));
  assert.equal(saved1.title, "Put Kyoto trip in a Travel folder");
  assert.deepEqual(saved1.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.ok(!fs.readdirSync(vault).includes("ai"));

  /* ---- chat turn 2: the history goes along; edit a file and write a new one; a busy start throws */
  queue.push((body) => {
    assert.equal(body.messages.length, 5, "turn 1's four messages, then the new prompt");
    assert.match(textOf(body.messages[0].content), /Put Kyoto trip in a Travel folder/);
    assert.match(textOf(body.messages[4].content), /<request>\nSay hello there and add a style\n<\/request>/);
    assert.equal(body.messages[0].content.at(-1).cache_control, undefined, "the breakpoint is only on the tail");
    return {
      blocks: [
        { type: "text", text: "I'll edit it." },
        tool("edit_file", { path: "index.html", old_str: "<p>Hello world</p>", new_str: "<p>Hello there</p>" }),
        tool("write_file", { path: "style.css", content: "p{color:red}" }),
      ],
      stop: "tool_use",
    };
  });
  queue.push(() => say("Changed the greeting and added a style."));
  const before = notes();
  const t2 = await ai.start({ target: "chat", conversationId: cid, page: "Notes", prompt: "Say hello there and add a style" });
  assert.equal(t2.conversationId, cid);
  await assert.rejects(() => ai.start({ target: "chat", conversationId: cid, prompt: "again" }), /still working on the last one/);
  const r2 = await ended(t2.jobId);
  assert.equal(r2.type, "ready", JSON.stringify(r2));
  assert.equal(notes(), before, "nothing reaches disk before apply");
  const a2 = await ai.apply(t2.jobId);
  assert.equal(a2.applied, 2);
  assert.deepEqual(a2.changed, [1]);
  assert.match(notes(), /<p>Hello there<\/p>/);
  assert.equal(gitLog(vault, 1)[0].message, "Noteblock AI: Say hello there and add a style");
  assert.match(gitLog(vault, 1)[0].author, /^Noteblock AI </);
  assert.deepEqual(await ai.apply(t2.jobId), a2, "a second apply returns the first result");
  // A stale save from the frame (old numbering) right after apply is refused.
  assert.equal(isApplying(vault, "Notes"), true);
  assert.throws(() => runRpc(vault, "Notes", "save", { regions: [{ replace: [1], html: "<p>stale</p>" }] }), new RegExp(AI_RELOADING_MSG));
  assert.equal(isApplying(vault, "Other page"), false);
  assert.ok(written.includes("Notes"));
  assert.deepEqual(
    turnOf(cid, t2.jobId).changes.map((c) => c.text),
    ["Edited Notes", "Created Notes/style.css"],
  );
  assert.equal(ai.chat(cid).turns.length, 2);

  /* ---- undo of turn 1: the move goes back, the folder it made goes to the Trash */
  const u1 = await ai.undo(t1.jobId);
  assert.deepEqual(u1, { restored: 2, skipped: [] });
  assert.ok(exists("Kyoto trip") && !exists("Travel"));
  assert.deepEqual(trashed.at(-1), { rel: "Travel", commit: false });
  assert.ok(events.some((e) => e.jobId === t1.jobId && e.type === "moved" && e.from === "Travel/Kyoto trip" && e.to === "Kyoto trip"));
  assert.equal(gitLog(vault, 1)[0].message, "Undo Noteblock AI: Put Kyoto trip in a Travel folder");
  assert.match(lastCommit(), /Kyoto trip\/\.noteblock/);
  assert.match(lastCommit(), /D\s+Travel\/\.gitkeep/);
  assert.equal(turnOf(cid, t1.jobId).state, "undone");
  assert.equal(turnOf(cid, t1.jobId).undoable, false);
  // And turn 2's edit undoes on its own.
  assert.deepEqual(await ai.undo(t2.jobId), { restored: 2, skipped: [] });
  assert.equal(notes(), before);

  /* ---- chat turn 3: a setting, behind Ask; undo puts it back */
  queue.push(() => ({ blocks: [tool("change_setting", { key: "editor.textSize", value: 18 })], stop: "tool_use" }));
  queue.push((body) => {
    assert.ok(!body.messages.at(-1).content[0].is_error, body.messages.at(-1).content[0].content);
    return say("Text is bigger now.");
  });
  const t3 = await ai.start({ target: "chat", conversationId: cid, prompt: "Make the text bigger" });
  const ask3 = await waitFor((e) => e.jobId === t3.jobId && e.type === "ask", "settings ask");
  assert.equal(ask3.permission, "changeSettings");
  assert.equal(turnOf(cid, t3.jobId).state, "ask");
  assert.equal(turnOf(cid, t3.jobId).ask.askId, ask3.askId);
  ai.answer(t3.jobId, ask3.askId, true);
  assert.equal((await ended(t3.jobId)).type, "ready");
  assert.ok(events.some((e) => e.jobId === t3.jobId && e.type === "settings" && e.keys[0] === "editor.textSize"));
  assert.equal(appPrefs().editor.textSize, 18);
  const a3 = await ai.apply(t3.jobId);
  assert.equal(a3.commit, null);
  assert.deepEqual(turnOf(cid, t3.jobId).changes.map((c) => c.text), ["Settings › Editor: Text size, 16 → 18"]);
  assert.equal(turnOf(cid, t3.jobId).page, null);
  await ai.undo(t3.jobId);
  assert.equal(appPrefs().editor.textSize, 16);

  /* ---- the history list; a fresh run of the app has no undo data */
  const list = ai.chats();
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].id, list[0].turnCount, list[0].last], [cid, 3, "Settings › Editor: Text size, 16 → 18"]);
  const ai2 = createAi({ ...deps, send: () => {} });
  assert.ok(ai2.chat(cid).turns.every((t) => t.undoable === false));
  assert.equal(ai2.chat(cid).messages, undefined);

  /* ---- a user edit to the same text before apply: that op is skipped, the other lands */
  queue.push(() => ({
    blocks: [tool("edit_file", { path: "index.html", old_str: "<p>Hello world</p>", new_str: "<p>Hi world</p>" }), tool("edit_file", { path: "index.html", old_str: "<p>Second line</p>", new_str: "<p>Second line, edited</p>" })],
    stop: "tool_use",
  }));
  queue.push(() => say("Edited both lines."));
  const j2 = await ai.start({ target: "chat", page: "Notes", prompt: "Edit both lines" });
  assert.equal((await ended(j2.jobId)).type, "ready");
  writeNotes(notes().replace("<p>Hello world</p>", "<p>Hello world, typed by the person</p>"));
  const b2 = await ai.apply(j2.jobId);
  assert.equal(b2.applied, 1);
  assert.equal(b2.skipped.length, 1);
  assert.equal(b2.skipped[0].file, "index.html");
  assert.match(notes(), /Hello world, typed by the person/);
  assert.match(notes(), /Second line, edited/);
  assert.equal(gitLog(vault, 1)[0].message, "Noteblock AI: Edit both lines");
  assert.deepEqual(turnOf(j2.conversationId, j2.jobId).skipped, b2.skipped);

  /* ---- a tool set to off: a tool error, the job carries on */
  ai.setPermissions({ fetchWeb: "off" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "config", "config.json"), "utf8")).ai.permissions.fetchWeb, "off");
  queue.push(() => ({ blocks: [tool("fetch_url", { url: "https://api.frankfurter.app/latest" })], stop: "tool_use" }));
  queue.push(() => {
    const r = lastResults()[0];
    assert.equal(r.is_error, true);
    assert.equal(r.content, "Turned off in Settings");
    return say("Couldn't fetch the rate, so nothing changed.");
  });
  const j3 = await ai.start({ target: "chat", page: "Notes", prompt: "Add today's yen rate" });
  const r3 = await ended(j3.jobId);
  assert.equal(r3.type, "ready");
  assert.equal(r3.summary, "Couldn't fetch the rate, so nothing changed.");
  const b3 = await ai.apply(j3.jobId);
  assert.equal(b3.applied, 0);
  assert.equal(b3.commit, null);
  assert.equal(turnOf(j3.conversationId, j3.jobId).undoable, false, "nothing to undo");
  ai.setPermissions({ fetchWeb: "allow" });

  /* ---- invalid tool input is an error result, not a run; vault_stats answers a question */
  createPage(vault, "Other");
  queue.push(() => ({ blocks: [tool("edit_file", { path: "index.html", old_str: 5 }), tool("vault_stats", {})], stop: "tool_use" }));
  queue.push(() => {
    const [bad, stats] = lastResults();
    assert.equal(bad.is_error, true);
    assert.match(bad.content, /Invalid input for edit_file/);
    const s = JSON.parse(stats.content);
    assert.equal(s.pages, 3);
    assert.ok(s.biggestPages.length === 3 && s.totalBytes > 0);
    return say("You have **3** pages.");
  });
  const j4 = await ai.start({ target: "chat", prompt: "How many pages do I have?" });
  assert.equal((await ended(j4.jobId)).type, "ready");
  ai.stop(j4.jobId); // a ready job still holds the conversation until it is applied or stopped

  /* ---- Ask, then a second start in that conversation is refused, then Stop while asking */
  queue.push(() => ({ blocks: [tool("edit_file", { page: "Other", path: "index.html", old_str: "<h1>Other</h1>", new_str: "<h1>Other!</h1>" })], stop: "tool_use" }));
  const j5 = await ai.start({ target: "chat", page: "Notes", prompt: "Touch the other page" });
  const ask = await waitFor((e) => e.jobId === j5.jobId && e.type === "ask", "ask");
  assert.equal(ask.permission, "editOtherPages");
  await assert.rejects(() => ai.start({ target: "chat", conversationId: j5.conversationId, prompt: "Another one" }), /still working/);
  ai.stop(j5.jobId);
  await waitFor((e) => e.jobId === j5.jobId && e.type === "stopped", "stopped");
  const job5 = ai.jobs().find((j) => j.jobId === j5.jobId);
  assert.deepEqual([job5.state, job5.target, job5.conversationId], ["stopped", "chat", j5.conversationId]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(turnOf(j5.conversationId, j5.jobId).state, "stopped");
  // The cut-off turn is closed in the saved history: the tool_use answered, an assistant note last.
  const saved5 = JSON.parse(fs.readFileSync(chatFile(j5.conversationId), "utf8")).messages;
  assert.deepEqual(saved5.map((m) => m.role), ["user", "assistant", "user", "assistant"]);

  /* ---- a block job replaces its marker */
  writeNotes(notes().replace("</body>", `<div data-q-ai-target="block" data-q-ai="ai_k3j9x2">a counter</div>\n</body>`));
  const blockHtml = `<div data-app id="ai_k3j9x2"></div>\n<script type="module">\nimport React from "react";\ndocument.getElementById("ai_k3j9x2").textContent = "0";\n</script>`;
  queue.push((body) => {
    assert.ok(body.tools.find((t) => t.name === "insert_block").eager_input_streaming);
    assert.ok(!body.tools.some((t) => t.name === "edit_file"));
    assert.match(body.messages[0].content, /ai_k3j9x2_/);
    return { blocks: [tool("insert_block", { html: blockHtml, files: { "counter.css": "#ai_k3j9x2{color:red}" } })], stop: "tool_use" };
  });
  queue.push(() => say("Built a counter."));
  const j6 = await ai.start({ page: "Notes", prompt: "a counter", target: "block", blockId: "ai_k3j9x2" });
  const r6 = await ended(j6.jobId);
  assert.equal(r6.type, "ready", JSON.stringify(r6));
  assert.equal(requests.at(-1).headers["x-noteblock-purpose"], "build");
  assert.ok(events.some((e) => e.jobId === j6.jobId && e.type === "progress" && typeof e.preview === "string" && e.preview.includes("data-app")), "a code preview");
  const a6 = await ai.apply(j6.jobId);
  assert.equal(a6.applied, 2);
  assert.ok(!notes().includes("data-q-ai"));
  assert.ok(notes().includes(blockHtml));
  assert.equal(fs.readFileSync(path.join(findPage(vault, "Notes").dir, "counter.css"), "utf8"), "#ai_k3j9x2{color:red}");
  assert.equal(gitLog(vault, 1)[0].message, "Noteblock AI: a counter");
  assert.ok(a6.changed.length >= 1);

  /* ---- a block job whose marker the person deleted ends stopped */
  writeNotes(notes().replace("</body>", `<div data-q-ai="ai_gone" data-q-ai-target="block">x</div>\n</body>`));
  queue.push(() => ({ blocks: [tool("insert_block", { html: `<div data-app id="ai_gone"></div>` })], stop: "tool_use" }));
  queue.push(() => say("Built it."));
  const j7 = await ai.start({ page: "Notes", prompt: "x", target: "block", blockId: "ai_gone" });
  assert.equal((await ended(j7.jobId)).type, "ready");
  writeNotes(notes().replace(/<div data-q-ai="ai_gone"[^>]*>x<\/div>\n/, ""));
  const a7 = await ai.apply(j7.jobId);
  assert.equal(a7.stopped, true);
  assert.ok(events.some((e) => e.jobId === j7.jobId && e.type === "stopped"));

  /* ---- an old newpage marker is built in place, as a block */
  writeNotes(notes().replace("</body>", `<div data-q-ai="ai_np" data-q-ai-target="newpage">a packing list</div>\n</body>`));
  queue.push((body) => {
    assert.ok(body.tools.some((t) => t.name === "insert_block"));
    return { blocks: [tool("insert_block", { html: `<div data-app id="ai_np"></div>` })], stop: "tool_use" };
  });
  queue.push(() => say("Built a packing list."));
  const j8 = await ai.start({ page: "Notes", prompt: "a packing list", target: "newpage", blockId: "ai_np" });
  assert.equal((await ended(j8.jobId)).type, "ready");
  assert.equal(ai.jobs().find((j) => j.jobId === j8.jobId).target, "block");
  await ai.apply(j8.jobId);
  assert.match(notes(), /<div data-app id="ai_np"><\/div>/);
  assert.ok(!notes().includes("data-q-ai="));

  /* ---- hosting refusals map to error codes */
  queue.push(() => ({ status: 429, error: { type: "noteblock_ai_limit", message: "Noteblock AI is paused until tomorrow." } }));
  const j9 = await ai.start({ target: "chat", page: "Notes", prompt: "more" });
  const r9 = await ended(j9.jobId);
  assert.equal(r9.type, "error");
  assert.equal(r9.code, "limit");
  assert.equal(r9.message, "Noteblock AI is paused until tomorrow.");
  queue.push(() => ({ status: 403, error: { type: "noteblock_ai_off", message: "Noteblock AI isn't on for this account." } }));
  const j10 = await ai.start({ target: "chat", conversationId: j9.conversationId, prompt: "more" });
  assert.equal((await ended(j10.jobId)).code, "off");
  assert.deepEqual(ai.chat(j9.conversationId).turns.map((t) => t.state), ["error", "error"]);

  console.log("smoke-ai ok");
} finally {
  server.close();
  server.closeAllConnections?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
