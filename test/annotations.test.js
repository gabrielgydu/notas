'use strict';
// The annotation grammar's in-place comment rewrite: everything outside the
// body comes back byte for byte, and the entry keeps its id, date and place.
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

test('rewrites only the body, keeping marker, quote and every other entry', () => {
  const out = Ann.setComment(DOC, 'k3f9', 'New comment.');
  assert.equal(out.error, undefined);
  assert.equal(out.text, DOC.replace('Old comment.', 'New comment.'));
  const e = entry(out.text, 'k3f9');
  assert.equal(e.body, 'New comment.');
  assert.equal(e.quote, 'the quoted passage\nsecond line');
  assert.equal(e.date, '2026-08-10');
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
  assert.equal(out.text, '## Annotations\n\n<!-- ann:note id=ab12 2026-08-10 -->\n\nreworded\n<!-- /ann -->\n');
  assert.equal(entry(out.text, 'ab12').body, 'reworded');
});

test('refuses highlights, unknown ids and unterminated entries', () => {
  assert.equal(Ann.setComment(DOC, 'm4t8', 'x').error, 'not a comment');
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
