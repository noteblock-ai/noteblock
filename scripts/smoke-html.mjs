// Smoke test for core/html.mjs and core/store.mjs. Run: node scripts/smoke-html.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexBody, applyRegions, renderMarkdown, htmlToMarkdown, TEXT_TAGS } from '../core/html.mjs';
import { openStore, closeAllStores } from '../core/store.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}

const HEAD = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Trip budget</title>
  <style>  body   { color: red }  </style>
  <script>if (a < b && "</p>") { go() }</script>
</head>`;
const APP = `<div data-app id="budget">
    <script type="module">
      import { html } from 'htm/react';   const x = "<p>not a p</p>";
    </script>
  </div>`;
const RAW = `${HEAD}
<body class="page"   data-theme='x'>
  stray text
  <h1>Trip budget</h1>
  <!-- a comment -->
  <p>First <b>para</b></p>
  <p>Second</p>
  ${APP}
  <ul><li>one<li>two</ul>
  <section data-app>chart</section>
  <script>window.done = 1</script>
</body>
</html>
`;

test('TEXT_TAGS matches the contract', () => {
  assert.deepEqual(TEXT_TAGS, ['P', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'FIGURE', 'IMG']);
});

test('indexBody numbers top-level elements only, nothing else changes', () => {
  const out = indexBody(RAW);
  assert.ok(out.includes('<h1 data-q-i="0">Trip budget</h1>'));
  assert.ok(out.includes('<p data-q-i="1">First <b>para</b></p>'));
  assert.ok(out.includes('<p data-q-i="2">Second</p>'));
  assert.ok(out.includes('<div data-q-i="3" data-app id="budget">'));
  assert.ok(out.includes('<ul data-q-i="4"><li>one<li>two</ul>'));
  assert.ok(out.includes('<section data-q-i="5" data-app>chart</section>'));
  assert.ok(out.includes('<script data-q-i="6">window.done = 1</script>'));
  assert.equal((out.match(/data-q-i/g) || []).length, 7);
  assert.equal(out.replace(/ data-q-i="\d+"/g, ''), RAW);
  // idempotent: re-indexing replaces rather than duplicates
  assert.equal(indexBody(out), out);
});

test('indexBody leaves a doc with no body elements alone', () => {
  const empty = '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body></body></html>';
  assert.equal(indexBody(empty), empty);
});

test('indexBody on a fragment without <body>', () => {
  assert.equal(indexBody('<p>a</p>\n<div>b</div>'), '<p data-q-i="0">a</p>\n<div data-q-i="1">b</div>');
});

test('applyRegions: replace a run (head, scripts, app blocks byte-identical)', () => {
  const out = applyRegions(RAW, [{ replace: [0, 1, 2], before: 3, html: '<h1 data-q-i="0" contenteditable="true">Budget</h1><p>Only para</p>' }]);
  const expected = RAW.replace(
    '<h1>Trip budget</h1>\n  <!-- a comment -->\n  <p>First <b>para</b></p>\n  <p>Second</p>',
    '<h1>Budget</h1><p>Only para</p>',
  );
  assert.equal(out, expected);
  assert.ok(out.startsWith(HEAD));
  assert.ok(out.includes(APP));
  assert.ok(out.includes('<section data-app>chart</section>'));
  assert.ok(out.includes('<script>window.done = 1</script>'));
  assert.ok(!out.includes('data-q-'));
  assert.ok(!out.includes('contenteditable'));
});

test('applyRegions: several regions keep original numbering', () => {
  const out = applyRegions(RAW, [
    { replace: [0, 1, 2], before: 3, html: '<p>A</p>' },
    { replace: [4], before: 5, html: '<ol><li>x</li></ol>' },
  ]);
  assert.ok(out.includes('<p>A</p>\n  ' + APP + '\n  <ol><li>x</li></ol>\n  <section data-app>'));
  assert.ok(out.startsWith(HEAD));
  assert.ok(!out.includes('<ul>'));
});

test('applyRegions: region emptied out removes its elements', () => {
  const out = applyRegions(RAW, [{ replace: [4], before: 5, html: '' }]);
  assert.ok(!out.includes('<ul>'));
  assert.ok(out.includes(APP + '\n  \n  <section data-app>'));
});

test('applyRegions: insert into an empty body', () => {
  const empty = '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body></body></html>';
  const out = applyRegions(empty, [{ replace: [], before: null, html: '<p data-q-region="1">Hello</p>' }]);
  assert.equal(out, '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body><p>Hello</p>\n</body></html>');
  assert.equal(indexBody(out), out.replace('<p>', '<p data-q-i="0">'));
});

test('a list saved inside a <p> is split the way the browser splits it', () => {
  const raw = '<html><body><h2>T</h2>\n<p><ul><li>a</li></ul></p>\n<p class="x">b<ul><li>c</li></ul></p>\n<p>end</p>\n</body></html>';
  assert.equal(
    indexBody(raw),
    '<html><body><h2 data-q-i="0">T</h2>\n<ul data-q-i="1"><li>a</li></ul>\n<p data-q-i="2" class="x">b</p>\n<ul data-q-i="3"><li>c</li></ul>\n<p data-q-i="4">end</p>\n</body></html>',
  );
  // Indices from the page (which saw the split copy) land on the right elements.
  const out = applyRegions(raw, [{ replace: [3, 4], html: '<ul><li>c</li><li>d</li></ul>' }]);
  assert.equal(out, '<html><body><h2>T</h2>\n<ul><li>a</li></ul>\n<p class="x">b</p>\n<ul><li>c</li><li>d</li></ul>\n</body></html>');
});

test('applyRegions: insert before an app block', () => {
  const out = applyRegions(RAW, [{ replace: [], before: 3, html: '<p>Intro</p>' }]);
  assert.equal(out, RAW.replace(APP, '<p>Intro</p>\n' + APP));
});

test('applyRegions: append at end of body', () => {
  const out = applyRegions(RAW, [{ replace: [], before: null, html: '<p>The end</p>' }]);
  assert.equal(out, RAW.replace('</body>', '<p>The end</p>\n</body>'));
});

test('applyRegions: non-contiguous replace and bad index', () => {
  const out = applyRegions(RAW, [{ replace: [1, 4], before: null, html: '<p>Merged</p>' }]);
  assert.ok(out.includes('<h1>Trip budget</h1>\n  <!-- a comment -->\n  <p>Merged</p>\n  <p>Second</p>'));
  assert.ok(!out.includes('<ul>'));
  assert.throws(() => applyRegions(RAW, [{ replace: [99], before: null, html: '' }]));
});

test('renderMarkdown: full doc, title, embeds, task lists', () => {
  const md = '# Kyoto trip\n\nSome *text*.\n\n![[Kyoto trip/Trip budget]]\n\n- [ ] book ryokan\n- [x] flights\n';
  const html = renderMarkdown(md, { title: 'Kyoto trip' });
  assert.ok(html.startsWith('<!doctype html><html><head><meta charset="utf-8"><title>Kyoto trip</title></head><body data-q-format="md">'));
  assert.ok(html.endsWith('</body></html>'));
  assert.ok(html.includes('<quire-embed src="Kyoto trip/Trip budget"></quire-embed>'));
  assert.ok(!html.includes('<p><quire-embed'));
  assert.ok(html.includes('type="checkbox"'));
  // embed directly after a paragraph line still becomes a block
  const tight = renderMarkdown('Intro line\n![[Child]]\nAfter', { title: 'x' });
  assert.ok(tight.includes('<quire-embed src="Child"></quire-embed>'), tight);
  assert.ok(!/<p>[^<]*<quire-embed/.test(tight), tight);
  // title falls back to the first heading
  assert.ok(renderMarkdown('# Hello\n').includes('<title>Hello</title>'));
});

test('markdown round trip', () => {
  const md = [
    '# Kyoto trip',
    '',
    'Some **bold** and *em* and `code`.',
    '',
    '![[Some/Page]]',
    '',
    '## Todo',
    '',
    '- [ ] book ryokan',
    '- [x] flights',
    '',
    '- plain bullet',
    '- another',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '> quoted',
    '',
  ].join('\n');
  const html = renderMarkdown(md, { title: 'Kyoto trip' });
  const body = html.slice(html.indexOf('<body data-q-format="md">') + 25, html.lastIndexOf('</body>'));
  const back = htmlToMarkdown(indexBody(`<body>${body}</body>`).replace(/^<body>|<\/body>$/g, ''));
  assert.ok(back.includes('# Kyoto trip'), back);
  assert.ok(back.includes('![[Some/Page]]'), back);
  assert.ok(back.includes('- [ ] book ryokan'), back);
  assert.ok(back.includes('- [x] flights'), back);
  assert.ok(back.includes('- plain bullet'), back);
  assert.ok(back.includes('```js\nconst x = 1;\n```'), back);
  assert.ok(back.includes('**bold**'), back);
  assert.ok(!back.includes('data-q'), back);
  // and back again is stable
  const html2 = renderMarkdown(back, { title: 'Kyoto trip' });
  assert.ok(html2.includes('<quire-embed src="Some/Page"></quire-embed>'));
  assert.equal(htmlToMarkdown(html2.slice(html2.indexOf('>', html2.indexOf('<body')) + 1, html2.lastIndexOf('</body>'))), back);
});

test('htmlToMarkdown: embed element ↔ ![[src]]', () => {
  assert.equal(htmlToMarkdown('<p>Hi</p><quire-embed src="Some/Page"></quire-embed>'), 'Hi\n\n![[Some/Page]]\n');
  assert.equal(htmlToMarkdown('<div data-q-region contenteditable="true"><h2 data-q-i="3">X</h2></div>'), '## X\n');
});

test('store: insert/all/get/update/remove/kv/tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quire-store-'));
  try {
    const s = openStore(dir, 'tester');
    assert.ok(existsSync(join(dir, 'data', 'tester.sqlite')));
    assert.equal(openStore(dir, 'tester'), s, 'handle is cached');
    assert.equal(s.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');

    const a = s.insert('expenses', { label: 'Ryokan', amount: 300 });
    assert.match(a.id, /^[a-z0-9]{10}$/);
    assert.equal(a.label, 'Ryokan');
    assert.equal(typeof a._created, 'number');
    assert.equal(a._created, a._updated);
    const b = s.insert('expenses', { id: 'fixed', label: 'Rail pass', amount: 200 });
    assert.equal(b.id, 'fixed');
    s.insert('notes', { text: 'hi' });

    assert.deepEqual(s.all('expenses').map((r) => r.label), ['Ryokan', 'Rail pass']);
    assert.deepEqual(s.get('expenses', 'fixed'), b);
    assert.equal(s.get('expenses', 'nope'), null);

    const u = s.update('expenses', a.id, { amount: 320, paid: true, id: 'ignored' });
    assert.equal(u.id, a.id);
    assert.equal(u.label, 'Ryokan');
    assert.equal(u.amount, 320);
    assert.equal(u.paid, true);
    assert.equal(u._created, a._created);
    assert.ok(u._updated >= a._updated);
    assert.throws(() => s.update('expenses', 'nope', {}));

    assert.equal(s.remove('expenses', 'fixed'), true);
    assert.equal(s.all('expenses').length, 1);

    assert.equal(s.kvGet('missing'), null);
    assert.equal(s.kvSet('currency', { code: 'JPY' }), true);
    assert.deepEqual(s.kvGet('currency'), { code: 'JPY' });
    s.kvSet('currency', 'USD');
    assert.equal(s.kvGet('currency'), 'USD');

    assert.deepEqual(s.tables(), ['expenses', 'notes']);

    // survives reopening
    closeAllStores();
    const s2 = openStore(dir, 'tester');
    assert.notEqual(s2, s);
    assert.equal(s2.all('expenses')[0].amount, 320);
    closeAllStores();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
