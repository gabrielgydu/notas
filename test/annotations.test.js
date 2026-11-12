'use strict';
// The annotation grammar's in-place rewrites: everything outside the part
// being changed comes back byte for byte, and the entry keeps its id, date and
// place. A mark (`ann:hl`) may carry a comment; `ann:note` is the old way one
// was stored, read as a green mark and rewritten as `ann:hl` when touched.
//
//   node --test          (from the repo root)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ann = require('../public/annotations.js');

const DOC = `# Title

Some text.

## Annotations

<!-- ann:note id=k3f9 2026-08-10 -->
> the quoted passage
> second line

Old comment.
<!-- /ann -->

<!-- ann:claude id=x7q2 2026-08-11 before="ctx" after="ctx" -->
> another passage

First line.

Second paragraph.
<!-- /ann -->

<!-- ann:hl id=m4t8 2026-08-12 -->
> a highlight
<!-- /ann -->
`;

const entry = (text, id) => Ann.parse(text).entries.find((e) => e.id === id);

const LEGACY_MARKER = '<!-- ann:note id=k3f9 2026-08-10 -->';
const UPGRADED_MARKER = '<!-- ann:hl id=k3f9 2026-08-10 color="green" -->';

test('rewrites only the body of a claude entry, keeping its marker byte for byte', () => {
  const out = Ann.setComment(DOC, 'x7q2', 'Shorter.');
  assert.equal(out.error, undefined);
  assert.equal(out.text, DOC.replace('First line.\n\nSecond paragraph.', 'Shorter.'));
});

test('rewording a legacy note rewrites its marker as the green mark it reads as', () => {
  const out = Ann.setComment(DOC, 'k3f9', 'New comment.');
  assert.equal(out.error, undefined);
  assert.equal(out.text, DOC.replace('Old comment.', 'New comment.').replace(LEGACY_MARKER, UPGRADED_MARKER));
  const e = entry(out.text, 'k3f9');
  assert.equal(e.type, 'hl');
  assert.equal(Ann.entryColor(e), 'green');
  assert.equal(e.body, 'New comment.');
  assert.equal(e.quote, 'the quoted passage\nsecond line');
  assert.equal(e.date, '2026-08-10');
});

test('a legacy note reads as a green mark, a bare highlight as a yellow one', () => {
  const [note, claude, hl] = Ann.parse(DOC).entries;
  assert.equal(Ann.isMark(note), true);
  assert.equal(Ann.isMark(claude), false);
  assert.equal(Ann.isMark(hl), true);
  assert.equal(Ann.entryColor(note), 'green');
  assert.equal(Ann.entryColor(hl), 'yellow');
});

test('a highlight takes a comment, and its marker and quote stay as they were', () => {
  const out = Ann.setComment(DOC, 'm4t8', 'Why this matters.');
  assert.equal(
    out.text,
    DOC.replace('> a highlight\n<!-- /ann -->', '> a highlight\n\nWhy this matters.\n<!-- /ann -->')
  );
  const e = entry(out.text, 'm4t8');
  assert.equal(e.type, 'hl');
  assert.equal(e.body, 'Why this matters.');
  assert.equal(Ann.parse(out.text).entries.length, 3);
});

test('emptying a mark\'s comment takes it back to the bare highlight it was', () => {
  const withComment = Ann.setComment(DOC, 'm4t8', 'one\n\ntwo').text;
  assert.equal(Ann.setComment(withComment, 'm4t8', '').text, DOC);
  assert.equal(Ann.setComment(withComment, 'm4t8', '  \n ').text, DOC);
});

test('emptying a legacy note leaves a green highlight and nothing else', () => {
  const out = Ann.setComment(DOC, 'k3f9', '');
  assert.equal(
    out.text,
    DOC.replace(`${LEGACY_MARKER}\n> the quoted passage\n> second line\n\nOld comment.\n`, `${UPGRADED_MARKER}\n> the quoted passage\n> second line\n`)
  );
  const e = entry(out.text, 'k3f9');
  assert.equal(e.body, '');
  assert.equal(Ann.entryColor(e), 'green');
});

test('a claude entry cannot be emptied — removing one is a delete', () => {
  assert.equal(Ann.setComment(DOC, 'x7q2', '').error, 'empty');
  assert.equal(Ann.setComment(DOC, 'x7q2', '   ').error, 'empty');
});

test('recolouring a legacy note rewrites only its marker, as ann:hl', () => {
  const out = Ann.setColor(DOC, 'k3f9', 'blue');
  assert.equal(out.text, DOC.replace(LEGACY_MARKER, '<!-- ann:hl id=k3f9 2026-08-10 color="blue" -->'));
  assert.equal(entry(out.text, 'k3f9').body, 'Old comment.');
  // Yellow is the default, so it is never written out.
  const yellow = Ann.setColor(DOC, 'k3f9', 'yellow');
  assert.equal(yellow.text, DOC.replace(LEGACY_MARKER, '<!-- ann:hl id=k3f9 2026-08-10 -->'));
});

test('a claude entry has no colour', () => {
  assert.equal(Ann.setColor(DOC, 'x7q2', 'blue').error, 'not a highlight');
});

test('serializeEntry writes a mark bare without a comment and with a body when it has one', () => {
  const base = { type: 'hl', id: 'm4t8', date: '2026-08-12', quote: 'q' };
  assert.equal(Ann.serializeEntry(base), '<!-- ann:hl id=m4t8 2026-08-12 -->\n> q\n<!-- /ann -->\n');
  assert.equal(Ann.serializeEntry({ ...base, comment: '  ' }), '<!-- ann:hl id=m4t8 2026-08-12 -->\n> q\n<!-- /ann -->\n');
  assert.equal(
    Ann.serializeEntry({ ...base, color: 'pink', comment: 'mine' }),
    '<!-- ann:hl id=m4t8 2026-08-12 color="pink" -->\n> q\n\nmine\n<!-- /ann -->\n'
  );
});

test('replaces a multi-paragraph body with a multi-line one', () => {
  const out = Ann.setComment(DOC, 'x7q2', 'One.\n\nTwo.\nThree.');
  const e = entry(out.text, 'x7q2');
  assert.equal(e.body, 'One.\n\nTwo.\nThree.');
  assert.equal(e.attrs.before, 'ctx');
  assert.equal(entry(out.text, 'k3f9').body, 'Old comment.');
  assert.equal(entry(out.text, 'm4t8').quote, 'a highlight');
  assert.equal(Ann.parse(out.text).entries.length, 3);
});

test('a body line that looks like structure is escaped, so the entry still ends where it did', () => {
  const out = Ann.setComment(DOC, 'k3f9', 'before\n<!-- /ann -->\nafter');
  const entries = Ann.parse(out.text).entries;
  assert.equal(entries.length, 3);
  assert.equal(entry(out.text, 'k3f9').body, 'before\n\\<!-- /ann -->\nafter');
  // Re-saving what the parser handed back must not stack escapes.
  const again = Ann.setComment(out.text, 'k3f9', entry(out.text, 'k3f9').body);
  assert.equal(again.text, out.text);
});

test('an entry with no quote gets a body without swallowing the marker', () => {
  const doc = '## Annotations\n\n<!-- ann:note id=ab12 2026-08-10 -->\n\n\nbare\n<!-- /ann -->\n';
  const out = Ann.setComment(doc, 'ab12', 'reworded');
  assert.equal(out.text, '## Annotations\n\n<!-- ann:hl id=ab12 2026-08-10 color="green" -->\n\nreworded\n<!-- /ann -->\n');
  assert.equal(entry(out.text, 'ab12').body, 'reworded');
});

test('refuses unknown ids and unterminated entries', () => {
  assert.equal(Ann.setComment(DOC, 'zzzz', 'x').error, 'not found');
  const broken = DOC.replace('Old comment.\n<!-- /ann -->', 'Old comment.');
  assert.equal(Ann.setComment(broken, 'k3f9', 'x').error, 'unterminated');
});

test('serializeEntry still writes the same bytes after the body helper was split out', () => {
  const text = Ann.serializeEntry({
    type: 'note', id: 'k3f9', date: '2026-08-10', quote: 'q', comment: 'a\r\n## Annotations',
  });
  assert.equal(text, '<!-- ann:note id=k3f9 2026-08-10 -->\n> q\n\na\n\\## Annotations\n<!-- /ann -->\n');
});
