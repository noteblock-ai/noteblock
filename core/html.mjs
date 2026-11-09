// The ONE place top-level body children are numbered, plus markdown conversion.
// Everything here works by splicing the raw string at node ranges, so bytes we did not
// mean to touch (head, scripts, app blocks, whitespace) stay exactly as they were.
import { parse } from 'node-html-parser';
import { Marked } from 'marked';
import TurndownService from 'turndown';

export const TEXT_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'FIGURE', 'IMG'];

const PARSE_OPTS = {
  comment: true,
  lowerCaseTagName: false,
  blockTextElements: { script: true, noscript: true, style: true, pre: true },
};

// A start tag, tolerant of quoted attribute values containing ">".
const START_TAG = /^<[^\s/>]+(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?|\s*\/)*\s*>/;

/**
 * Parse html and locate the body: its top-level element children (in document order),
 * and the string offset where content appended "at the end of body" goes.
 * Shared by indexBody and applyRegions so both number children identically.
 * @param {string} html
 */
function bodyLayout(html) {
  const root = parse(html, PARSE_OPTS);
  const body = root.querySelector('body');
  let container, endPos, openEnd;
  if (body) {
    container = body;
    const [s, e] = body.range;
    const slice = html.slice(s, e);
    endPos = /<\/body\s*>$/i.test(slice) ? s + slice.search(/<\/body\s*>$/i) : e;
    const m = START_TAG.exec(slice);
    openEnd = m ? s + m[0].length : s;
  } else {
    const htmlEl = root.querySelector('html');
    container = htmlEl || root;
    if (htmlEl) {
      const [s, e] = htmlEl.range;
      const slice = html.slice(s, e);
      endPos = /<\/html\s*>$/i.test(slice) ? s + slice.search(/<\/html\s*>$/i) : e;
    } else {
      endPos = html.length;
    }
    openEnd = null;
  }
  const children = container.childNodes.filter((n) => {
    if (n.nodeType !== 1) return false;
    if (body) return true;
    const t = (n.rawTagName || '').toUpperCase();
    return t !== 'HEAD' && t !== 'HTML' && t !== 'BODY';
  });
  return { children, endPos, openEnd };
}

function startTagOf(html, node) {
  const m = START_TAG.exec(html.slice(node.range[0], node.range[1]));
  return m ? m[0] : null;
}

// Elements a browser never leaves inside a <p>: it closes the paragraph before them.
const CLOSES_P = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'MAIN', 'MENU', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL']);

/**
 * `<p><ul>…</ul></p>` is one body child here but three in the browser (it closes the <p>
 * early), so the numbering would drift and saves would land on the wrong elements. Split
 * such paragraphs in the source the way the browser does, before numbering.
 * @param {string} html
 */
export function unnestParagraphs(html) {
  const { children } = bodyLayout(html);
  let out = html;
  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i];
    if ((node.rawTagName || '').toUpperCase() !== 'P') continue;
    const isBlock = (c) => c.nodeType === 1 && CLOSES_P.has((c.rawTagName || '').toUpperCase());
    if (!node.childNodes.some(isBlock)) continue;
    const tag = startTagOf(html, node);
    if (!tag) continue;
    const parts = [];
    let run = '';
    const flush = () => {
      if (run.trim()) parts.push(tag + run + '</p>');
      run = '';
    };
    for (const c of node.childNodes) {
      const src = html.slice(c.range[0], c.range[1]);
      if (isBlock(c)) {
        flush();
        parts.push(src);
      } else run += src;
    }
    flush();
    out = out.slice(0, node.range[0]) + parts.join('\n') + out.slice(node.range[1]);
  }
  return out;
}

/**
 * Add data-q-i="0..n-1" to every top-level element child of <body>. Nothing else changes
 * (beyond unnestParagraphs).
 * @param {string} html
 * @returns {string}
 */
export function indexBody(html) {
  html = unnestParagraphs(html);
  const { children } = bodyLayout(html);
  let out = html;
  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i];
    const tag = startTagOf(html, node);
    if (!tag) continue;
    const name = /^<[^\s/>]+/.exec(tag)[0];
    let rest = tag.slice(name.length).replace(/\s+data-q-i(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
    const newTag = `${name} data-q-i="${i}"${rest}`;
    const s = node.range[0];
    out = out.slice(0, s) + newTag + out.slice(s + tag.length);
  }
  return out;
}

/**
 * Remove data-q-* and contenteditable attributes from every start tag in an html fragment.
 * data-q-ai and data-q-ai-target stay: they mark a Noteblock AI placeholder block (docs/ai.md).
 */
export function stripEditorAttrs(fragment) {
  if (!fragment) return '';
  return fragment.replace(/<[a-zA-Z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?|\s*\/)*\s*>/g, (tag) =>
    tag.replace(/\s+(?:data-q-(?!ai(?:-target)?(?![\w-]))[\w-]*|contenteditable)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, ''),
  );
}

/**
 * Apply WYSIWYG regions to the RAW file (no data-q-i). Indices refer to the original numbering.
 * @param {string} html
 * @param {{replace?: number[], before?: number|null, html?: string}[]} regions
 * @returns {string}
 */
export function applyRegions(html, regions) {
  html = unnestParagraphs(html);
  const { children, endPos, openEnd } = bodyLayout(html);
  const n = children.length;
  /** @type {{start: number, end: number, text: string, order: number}[]} */
  const edits = [];
  regions.forEach((region, order) => {
    const text = stripEditorAttrs(region.html || '');
    const replace = [...new Set((region.replace || []).map(Number))].sort((a, b) => a - b);
    for (const i of replace) if (!(i >= 0 && i < n)) throw new Error(`applyRegions: no body child ${i}`);
    if (replace.length) {
      // Contiguous runs are removed as one span (whitespace between them goes too);
      // the region html lands where the first replaced element started.
      let runStart = replace[0];
      let prev = replace[0];
      let first = true;
      const flush = (a, b) => {
        edits.push({ start: children[a].range[0], end: children[b].range[1], text: first ? text : '', order });
        first = false;
      };
      for (const i of replace.slice(1)) {
        if (i !== prev + 1) { flush(runStart, prev); runStart = i; }
        prev = i;
      }
      flush(runStart, prev);
    } else if (region.before != null) {
      const k = Number(region.before);
      if (!(k >= 0 && k < n)) throw new Error(`applyRegions: no body child ${k}`);
      if (text) edits.push({ start: children[k].range[0], end: children[k].range[0], text: text + '\n', order });
    } else if (text) {
      const prevChar = html[endPos - 1];
      const lead = endPos === openEnd || prevChar === '\n' ? '' : '\n';
      edits.push({ start: endPos, end: endPos, text: lead + text + '\n', order });
    }
  });
  // Splice from the end so earlier offsets stay valid. At the same offset, apply later
  // regions first so earlier regions end up earlier in the document.
  edits.sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order);
  let out = html;
  let floor = Infinity;
  for (const e of edits) {
    if (e.end > floor) throw new Error('applyRegions: overlapping regions');
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return out;
}

// ---------- markdown ----------

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const EMBED_LINE = /^ {0,3}!\[\[([^\]\n]+)\]\][ \t]*(?:\n+|$)/;

const marked = new Marked({ gfm: true });
marked.use({
  extensions: [
    {
      name: 'quireEmbed',
      level: 'block',
      start(src) {
        const m = /(?:^|\n) {0,3}!\[\[/.exec(src);
        return m ? m.index + (m[0].startsWith('\n') ? 1 : 0) : undefined;
      },
      tokenizer(src) {
        const m = EMBED_LINE.exec(src);
        if (m) return { type: 'quireEmbed', raw: m[0], src: m[1].trim() };
      },
      renderer(token) {
        return `<quire-embed src="${escapeHtml(token.src)}"></quire-embed>\n`;
      },
    },
  ],
});

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

/**
 * A leading YAML frontmatter block (Obsidian "properties"), kept verbatim, and the rest.
 * @param {string} md
 * @returns {{frontmatter: string, body: string}} frontmatter is "" or the whole `---…---\n` block
 */
export function splitFrontmatter(md) {
  const src = String(md ?? '').replace(/\r\n?/g, '\n');
  const m = FRONTMATTER.exec(src);
  if (!m) return { frontmatter: '', body: src };
  return { frontmatter: m[0].endsWith('\n') ? m[0] : m[0] + '\n', body: src.slice(m[0].length) };
}

/**
 * Markdown → full HTML document, body marked data-q-format="md". Frontmatter isn't shown.
 * @param {string} md
 * @param {{title?: string}} [opts]
 */
export function renderMarkdown(md, { title } = {}) {
  const src = splitFrontmatter(md).body;
  if (title == null) {
    const h = /^#[ \t]+(.+?)[ \t#]*$/m.exec(src);
    title = h ? h[1] : '';
  }
  const body = marked.parse(src, { async: false });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body data-q-format="md">${body}</body></html>`;
}

/** The page name a header's text gives: `/` can't be in a name. runtime.js has the same function. */
export function headerName(text) {
  return String(text ?? '').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim().replace(/\//g, '-');
}

/** The first `# ` line of a markdown source, as [start, end] of its text, or null. Skips frontmatter and code. */
function firstMarkdownHeader(md) {
  let at = 0;
  let fence = null;
  let front = /^---[ \t]*\r?\n/.test(md);
  let first = true;
  let prevText = false;
  while (at < md.length) {
    let nl = md.indexOf('\n', at);
    if (nl < 0) nl = md.length;
    const line = md.slice(at, nl).replace(/\r$/, '');
    if (front) {
      if (!first && /^(---|\.\.\.)[ \t]*$/.test(line)) front = false;
    } else if (fence) {
      if (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim())) fence = null;
    } else {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      const h = /^ {0,3}#[ \t]+/.exec(line);
      if (f) fence = f[1];
      else if (h) {
        // The closing #s of `# Title #` aren't text.
        const text = line.slice(h[0].length).replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '');
        return [at + h[0].length, at + h[0].length + text.length];
      } else if (prevText && /^ {0,3}=+[ \t]*$/.test(line)) return null; // an underlined h1 comes first
      prevText = !f && line.trim() !== '';
    }
    first = false;
    at = nl + 1;
  }
  return null;
}

/**
 * A page was renamed: its header follows when it said the old name. The first h1 of the first text
 * region in html (the one the editor treats as the header), the first `# ` line in markdown. Only
 * that text changes; the rest of the file stays byte for byte. Returns `source` when it doesn't apply.
 * @param {string} source
 * @param {"html" | "md"} format
 * @param {string} oldName
 * @param {string} newName
 */
export function renameHeader(source, format, oldName, newName) {
  const want = headerName(oldName);
  if (!want) return source;
  if (format === 'md') {
    const at = firstMarkdownHeader(source);
    if (!at) return source;
    const text = source.slice(at[0], at[1]);
    if (headerName(text.replace(/\\([!-/:-@[-`{-~])/g, '$1')) !== want) return source;
    const clean = String(newName).replace(/[\\*_`[\]<]/g, '\\$&').replace(/ (#+)$/, ' \\$1');
    return source.slice(0, at[0]) + clean + source.slice(at[1]);
  }
  let seen = false;
  for (const node of bodyLayout(source).children) {
    const tag = (node.rawTagName || '').toUpperCase();
    const isText = TEXT_TAGS.includes(tag) && !node.hasAttribute('data-app');
    if (!isText) {
      if (seen) return source; // the first region ended before any h1
      continue;
    }
    seen = true;
    if (tag !== 'H1') continue;
    if (headerName(node.text) !== want) return source;
    const open = startTagOf(source, node);
    if (!open) return source;
    const whole = source.slice(node.range[0], node.range[1]);
    const close = /<\/h1\s*>$/i.exec(whole);
    const start = node.range[0] + open.length;
    const end = close ? node.range[0] + close.index : node.range[1];
    return source.slice(0, start) + escapeHtml(String(newName)) + source.slice(end);
  }
  return source;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  hr: '---',
  emDelimiter: '*',
  blankReplacement(content, node) {
    if (node.nodeName === 'QUIRE-EMBED') return embedMd(node);
    return node.isBlock ? '\n\n' : '';
  },
});

function embedMd(node) {
  const src = node.getAttribute('src') || '';
  return src ? `\n\n![[${src}]]\n\n` : '';
}

turndown.addRule('quireEmbed', {
  filter: (node) => node.nodeName === 'QUIRE-EMBED',
  replacement: (_content, node) => embedMd(node),
});
turndown.addRule('taskCheckbox', {
  filter: (node) => node.nodeName === 'INPUT' && (node.getAttribute('type') || '').toLowerCase() === 'checkbox',
  replacement: (_content, node) => (node.hasAttribute('checked') ? '[x] ' : '[ ] '),
});
// Tight "- item" lists (turndown's default pads markers to 4 columns).
turndown.addRule('listItem', {
  filter: 'li',
  replacement(content, node, options) {
    const parent = node.parentNode;
    let prefix = options.bulletListMarker + ' ';
    if (parent && parent.nodeName === 'OL') {
      const start = parent.getAttribute('start');
      const idx = Array.prototype.indexOf.call(parent.children, node);
      prefix = (start ? Number(start) + idx : idx + 1) + '. ';
    }
    content = content
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
      .replace(/^\[( |x)\]\s*/, '[$1] ')
      .replace(/\n/gm, '\n' + ' '.repeat(prefix.length));
    return prefix + content + (node.nextSibling ? '\n' : '');
  },
});
turndown.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: (content) => `~~${content}~~`,
});
// A resized image keeps its width: markdown has no syntax for it, so it stays an <img> tag.
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
turndown.addRule('sizedImage', {
  filter: (node) => node.nodeName === 'IMG' && /^\d+$/.test(node.getAttribute('width') || ''),
  replacement: (_content, node) =>
    `<img src="${escAttr(node.getAttribute('src') || '')}" alt="${escAttr(node.getAttribute('alt') || '')}" width="${node.getAttribute('width')}">`,
});
// Tables have no core markdown form; keep them as raw HTML, which markdown allows.
turndown.keep(['table']);

/**
 * Body innerHTML → markdown. data-q-* / contenteditable are stripped first.
 * @param {string} bodyHtml
 */
export function htmlToMarkdown(bodyHtml) {
  const clean = stripEditorAttrs(String(bodyHtml ?? ''));
  const md = turndown.turndown(clean).replace(/[ \t]+$/gm, '');
  return md.trim() + '\n';
}
