// Right-click in anything editable (page text, the AI box, inputs): spelling suggestions and
// Add to Dictionary for a misspelled word, then Cut / Copy / Paste. Pages and the renderer that
// draw their own menu call preventDefault, and then Electron sends no context-menu at all.
// The dictionary is Electron's (session-wide, global; on macOS and Windows it also goes to the
// OS's custom dictionary). Settings › Editor lists and removes words through dictionary*().
import { Menu } from "electron";

const MAX_SUGGESTIONS = 5;

/** Show the edit menu for `wc` (a window's webContents; its iframes' right-clicks arrive here too). */
export function attachEditMenu(wc) {
  wc.on("context-menu", (_event, params) => {
    const word = params.misspelledWord;
    const items = [];
    if (word) {
      for (const s of (params.dictionarySuggestions || []).slice(0, MAX_SUGGESTIONS)) {
        items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      }
      if (!items.length) items.push({ label: "No guesses", enabled: false });
      items.push({ type: "separator" });
      items.push({ label: `Add “${word}” to Dictionary`, click: () => wc.session.addWordToSpellCheckerDictionary(word) });
      items.push({ type: "separator" });
    }
    if (params.isEditable) {
      const f = params.editFlags || {};
      items.push(
        { role: "cut", enabled: !!f.canCut },
        { role: "copy", enabled: !!f.canCopy },
        { role: "paste", enabled: !!f.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: f.canSelectAll !== false },
      );
    } else if (params.selectionText) {
      items.push({ role: "copy" });
    }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: undefined });
  });
}

/** The words added to the dictionary, sorted. */
export async function dictionaryWords(session) {
  const words = await session.listWordsInSpellCheckerDictionary();
  return [...new Set(words)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function addDictionaryWord(session, word) {
  const w = String(word || "").trim();
  if (!w || /\s/.test(w) || w.length > 100) throw new Error("One word, no spaces.");
  if (!session.addWordToSpellCheckerDictionary(w)) throw new Error(`Couldn't add “${w}”.`);
  return null;
}

export function removeDictionaryWord(session, word) {
  session.removeWordFromSpellCheckerDictionary(String(word || ""));
  return null;
}
