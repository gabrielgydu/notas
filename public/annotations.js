/* Notas — annotation grammar.

   Shared verbatim by the server (require) and the browser (<script>). Both ends
   must agree on what an entry looks like on disk: the browser parses the file it
   is rendering to place highlights, the server parses it to append and to excise.
   Two implementations would drift and rewrite files the other cannot read. */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotasAnn = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HEADING = '## Annotations';
  const HEADING_RE = /^ {0,3}##\s+Annotations\s*$/;
  const MARKER_RE =
    /^<!--\s*ann:(note|claude|hl)\s+id=([a-z0-9]{3,8})\s+(\d{4}-\d{2}-\d{2})((?:\s+[a-z]+="[^"]*")*)\s*-->\s*$/;
  const TERM_RE = /^<!--\s*\/ann\s*-->\s*$/;
  // Indent is captured, not bounded at 3: inside a list item CommonMark measures
  // a fence from the item's content column, so a perfectly legal closer can sit
  // at absolute column 5. Refusing it would leave the fence open to EOF and hide
  // every annotation below — which is exactly where annotations live.
  const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
  const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
  // Only present in the *expanded* text the browser renders — never on disk.
  const MDT_OPEN_RE = /^<!--\s*mdt:(embed|frozen)\b/;
  const MDT_CLOSE_RE = /^<!--\s*\/mdt:(embed|frozen)\s*-->\s*$/;
  const ATTR_RE = /([a-z]+)="([^"]*)"/g;

  const MAX_CTX = 32;

  // A highlight carries no comment, so its only variable is which of these it is.
  // Yellow is the default and is never written out: an unadorned `ann:hl` marker
  // is a yellow highlight, and that is what most of them are.
  const COLORS = ['yellow', 'green', 'blue', 'pink'];
  const DEFAULT_COLOR = 'yellow';
  const normColor = (c) => (COLORS.indexOf(String(c)) >= 0 ? String(c) : DEFAULT_COLOR);

  /* ---------- text helpers ---------- */

  // Whitespace runs collapse to one space: the same passage wrapped differently
  // in the file and in the DOM has to compare equal, or every quote orphans.
  const normSpace = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ');
  const normalize = (s) => normSpace(s).trim();

  // Attribute values ride inside an HTML comment, so a literal `-` could close
  // it early and a literal `"` could end the attribute. Both round-trip.
  const escAttr = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/-/g, '&#45;');
  const unescAttr = (s) =>
    String(s).replace(/&#45;/g, '-').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  // Context is compared with endsWith/startsWith against normalized document
  // text, so it must keep its edge spaces — normalize() would trim them off.
  function ctxAttr(s, keepEnd) {
    const n = normSpace(s);
    if (n.length <= MAX_CTX) return n;
    return keepEnd ? n.slice(-MAX_CTX) : n.slice(0, MAX_CTX);
  }

  function parseAttrs(s) {
    const out = {};
    if (!s) return out;
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(s))) out[m[1]] = unescAttr(m[2]);
    return out;
  }

  /* ---------- parse ---------- */

  // Quote = the first contiguous blockquote after the marker.
  // Body = everything from there to the terminator, blank edges trimmed — so a
  // body may itself contain blockquotes, headings, fences, anything.
  function finishEntry(e, lines) {
    const last = e.unterminated ? e.endLine : e.endLine - 1;
    let i = e.startLine + 1;
    while (i <= last && lines[i].trim() === '') i++;
    const quote = [];
    while (i <= last && QUOTE_RE.test(lines[i])) {
      quote.push(QUOTE_RE.exec(lines[i])[1]);
      i++;
    }
    e.quote = quote.join('\n').replace(/\s+$/, '');
    const body = lines.slice(i, last + 1);
    while (body.length && body[0].trim() === '') body.shift();
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    e.body = body.join('\n');
  }

  function parseOnce(text, mode) {
    const skipMdt = mode.skipMdt;
    const useFences = mode.useFences;
    const lines = String(text == null ? '' : text).split('\n');
    const entries = [];
    const headings = [];
    let fence = null;
    let mdt = 0;
    let cur = null;

    const close = (endLine, unterminated) => {
      cur.endLine = endLine;
      cur.unterminated = !!unterminated;
      finishEntry(cur, lines);
      entries.push(cur);
      cur = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Inside an entry the fence tracker is suspended: a stray ``` in a comment
      // body would otherwise swallow every entry below it. The serializer
      // guarantees no body line can look like a terminator, so this is safe.
      if (cur) {
        if (TERM_RE.test(line)) {
          close(i, false);
          continue;
        }
        if (!MARKER_RE.test(line)) continue;
        close(i - 1, true); // hand-edit damage: run the body to the next marker
      }

      const f = useFences ? FENCE_RE.exec(line) : null;
      if (fence) {
        if (
          f &&
          f[2][0] === fence.mark &&
          f[2].length >= fence.len &&
          f[1].length <= fence.indent + 3 &&
          /^\s*$/.test(f[3])
        ) {
          fence = null;
        }
        continue;
      }
      if (f) {
        fence = { mark: f[2][0], len: f[2].length, indent: f[1].length };
        continue;
      }

      if (skipMdt) {
        if (MDT_CLOSE_RE.test(line)) {
          if (mdt > 0) mdt--;
          continue;
        }
        if (MDT_OPEN_RE.test(line)) {
          mdt++;
          continue;
        }
        if (mdt > 0) continue;
      }

      if (HEADING_RE.test(line)) {
        headings.push(i);
        continue;
      }
      const m = MARKER_RE.exec(line);
      if (m) {
        cur = {
          type: m[1],
          id: m[2],
          date: m[3],
          attrs: parseAttrs(m[4]),
          startLine: i,
          endLine: -1,
        };
      }
    }
    if (cur) close(lines.length - 1, true);
    return { entries, headings, lines, mdtOpen: mdt, fenceOpen: Boolean(fence) };
  }

  // A tracker still "inside" something at EOF has swallowed the tail of the
  // document — and the tail is where annotations live. Rather than trust it,
  // drop the tracker that got stuck and parse again. Fail-safe beats clever:
  // the cost of a wrong skip is invisible, undeletable entries.
  const PARSE_MODES = [
    { skipMdt: true, useFences: true },
    { skipMdt: false, useFences: true },
    { skipMdt: true, useFences: false },
    { skipMdt: false, useFences: false },
  ];

  // Borrowed text can carry an annotations section of its own, and a fenced code
  // block can document this very format; skipping both keeps them out of the
  // rail. Whichever tracker fails to close is the one we stop trusting.
  function parse(text) {
    let out;
    for (const mode of PARSE_MODES) {
      out = parseOnce(text, mode);
      if (out.mdtOpen === 0 && !out.fenceOpen) break;
    }
    return out;
  }

  /* ---------- serialize ---------- */

  // Belt and suspenders: the terminator already bounds the entry, but a body
  // line that *looks* like structure would still confuse a later parse.
  function sanitizeBodyLine(l) {
    return MARKER_RE.test(l) || TERM_RE.test(l) || HEADING_RE.test(l) ? '\\' + l : l;
  }

  // Split out because setColor rewrites this one line and nothing else — the
  // rest of the entry has to come back byte for byte.
  function markerLine(e) {
    const attrs = [];
    const color = normColor(e.color);
    if (e.type === 'hl' && color !== DEFAULT_COLOR) attrs.push(`color="${color}"`);
    const before = e.before ? escAttr(e.before) : '';
    const after = e.after ? escAttr(e.after) : '';
    if (before) attrs.push(`before="${before}"`);
    if (after) attrs.push(`after="${after}"`);
    return `<!-- ann:${e.type} id=${e.id} ${e.date}${attrs.length ? ' ' + attrs.join(' ') : ''} -->`;
  }

  function serializeEntry(e) {
    const marker = markerLine(e);
    // A blank line inside a blockquote would split it in two; `>` keeps it one.
    const quote = String(e.quote)
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => (l.trim() === '' ? '>' : '> ' + l))
      .join('\n');
    // A highlight is the quote and nothing else — no blank line, no body. The
    // parser reads the empty remainder back as an empty body, which is exactly
    // what it is.
    if (e.type === 'hl') return `${marker}\n${quote}\n<!-- /ann -->\n`;
    const body = String(e.comment).replace(/\r/g, '').split('\n').map(sanitizeBodyLine).join('\n');
    return `${marker}\n${quote}\n\n${body}\n<!-- /ann -->\n`;
  }

  // What to hand fsp.appendFile. Appending (rather than rewriting the file from
  // content read a moment ago) is what makes a concurrent editor save survive.
  //
  // The separating blank line is always *ours*, even when the file already ended
  // with one. That is what lets removeEntry cut back to the exact original bytes:
  // reusing an existing blank line would consume it, and nothing left afterwards
  // could tell how many there had been.
  function composeAppend(raw, entryText, hasHeading) {
    let pre = '';
    if (raw.length) {
      if (!raw.endsWith('\n')) pre += '\n';
      pre += '\n';
    }
    if (!hasHeading) pre += `${HEADING}\n\n`;
    return pre + entryText;
  }

  /* ---------- remove ---------- */

  // Excises the entry's line range. The file is never re-serialized from parsed
  // state: everything outside those lines comes back byte for byte.
  function removeEntry(text, id) {
    const src = String(text == null ? '' : text);
    const parsed = parse(src);
    const e = parsed.entries.find((x) => x.id === id);
    if (!e) return { error: 'not found' };
    // Refusing beats guessing which span the missing terminator was meant to close.
    if (e.unterminated) return { error: 'unterminated' };

    let lines = parsed.lines.slice();
    const from = e.startLine;
    let to = e.endLine;
    // Swallow the blank line this entry was separated by — the one before it
    // stays and goes on separating whatever is now adjacent.
    while (to + 1 < lines.length && lines[to + 1].trim() === '') to++;
    lines = lines.slice(0, from).concat(lines.slice(to + 1));

    // A heading with nothing under it is litter — a file whose last annotation
    // is deleted should look untouched again. Cutting at the heading line is
    // exactly the inverse of composeAppend, so no tail tidying is needed.
    const heads = parse(lines.join('\n')).headings;
    for (let i = heads.length - 1; i >= 0; i--) {
      const h = heads[i];
      if (h < lines.length && lines.slice(h + 1).every((l) => l.trim() === '')) lines = lines.slice(0, h);
    }
    return { text: lines.join('\n'), entry: e };
  }

  /* ---------- recolour ---------- */

  // Rewrites the marker line and leaves every other byte of the file alone —
  // recolouring must not be a delete plus an append, which would move the entry
  // to the end of the section and hand it a new id.
  //
  // Unterminated entries are fine here, unlike removeEntry: the damage is in
  // where the entry *ends*, and this touches only where it begins.
  function setColor(text, id, color) {
    const src = String(text == null ? '' : text);
    const parsed = parse(src);
    const e = parsed.entries.find((x) => x.id === id);
    if (!e) return { error: 'not found' };
    if (e.type !== 'hl') return { error: 'not a highlight' };
    const lines = parsed.lines.slice();
    lines[e.startLine] = markerLine({
      type: e.type,
      id: e.id,
      date: e.date,
      color,
      before: e.attrs.before,
      after: e.attrs.after,
    });
    return { text: lines.join('\n'), entry: e };
  }

  /* ---------- ids ---------- */

  function newId(used) {
    for (let i = 0; i < 500; i++) {
      const id = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
      if (!used || !used.has(id)) return id;
    }
    return Date.now().toString(36).slice(-6);
  }

  return {
    HEADING,
    HEADING_RE,
    MARKER_RE,
    TERM_RE,
    MAX_CTX,
    COLORS,
    DEFAULT_COLOR,
    normColor,
    normalize,
    normSpace,
    escAttr,
    unescAttr,
    ctxAttr,
    parse,
    markerLine,
    serializeEntry,
    composeAppend,
    removeEntry,
    setColor,
    newId,
  };
});
