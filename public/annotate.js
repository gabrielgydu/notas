/* Notas — annotations UI.

   There are two kinds of annotation. A *mark* is a passage in one of four
   colours, with a comment when something was written about it; it stays in the
   file. A *claude* entry is an instruction a later Claude session applies to
   the quoted passage and then removes.

   `h` or `g` (or `1`–`4` for a colour) marks the selection at once, then opens
   the mark's popover: swatches, the comment box (not focused, so the number
   keys still recolour) and `apagar`. `n` or `b` is the same mark with the box
   focused first, and nothing is written until it is saved. `c` opens the
   claude editor. Any of them with text selected acts on it; without a
   selection the key arms the page and the next selection is what it acts on.

   Clicking a mark opens that same popover, which is how a comment is added to
   a highlight later, or reworded, or emptied (the mark stays). `ann:note` is
   the old way a comment was stored, and reads as a green mark.

   A claude instruction is reworded in its editor: `✎` on its card, or
   `editar` in the popover its mark opens when there is no rail. Only the
   comment changes — the passage, id and date stay as they were.

   A phone has no keys to press: a selection made with a finger brings up a bar
   along the bottom of the screen with the same actions (see "touch" below).

   Quotes are re-found on every render by matching normalized text against the
   rendered page — the file stores the passage, not a position, so it survives
   edits above it. When it cannot be found (or found more than once with no way
   to tell which), the card says so and nothing is highlighted: a highlight on
   the wrong passage is worse than no highlight. */

(function () {
  'use strict';

  const App = window.NotasApp;
  const Ann = window.NotasAnn;
  if (!App || !Ann) return;

  const { state, els, toast, apiPost, openFile } = App;
  const rail = document.getElementById('ann-rail');

  const st = {
    mode: 'idle', // idle | armed | editor | view | mark
    type: null,
    color: null, // the colour a highlight is armed with, or a new note will be saved in
    quote: '',
    ctx: null,
    // The file the passage came from, pinned when the editor opens. The reader
    // may navigate away mid-comment; the annotation still belongs where it was
    // made, and must never land on whatever file happens to be open at save time.
    project: null,
    path: null,
    // Set while the editor is rewording an existing entry rather than writing a
    // new one; `original` is its comment as it was when the editor opened.
    editId: null,
    original: '',
    // Bumped whenever an editor session ends. An in-flight save compares it and
    // gives up, so Esc during the mic's final wait really does cancel.
    session: 0,
    // Every entry on the page, anchored or not. The rail only holds a subset
    // (an anchored highlight has no card), so it cannot be the lookup table.
    entries: [],
    cards: [],
    viewId: null,
    // The annotations section is folded shut on every render. These remember
    // that the reader opened it, so a save — which re-renders the page — does
    // not slam it shut under them; a different file starts folded again.
    sectionKey: null,
    sectionOpen: false,
    confirm: null,
    confirmBtn: null,
    confirmLabel: '',
    confirmTimer: 0,
    saving: false,
  };

  const mdRoot = () => els.page.querySelector('.md');
  const fileKey = () => (state.file ? `${state.current}/${state.file.path}` : '');
  const elemOf = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
  const railVisible = () => rail && !rail.hidden && getComputedStyle(rail).display !== 'none';
  const entryOf = (id) => st.entries.find((e) => e.id === id) || null;
  const colorOf = (e) => Ann.entryColor(e);
  const isMark = (e) => Ann.isMark(e);

  /* ---------- text index over the rendered page ----------
     A raw string of every text node we are allowed to match in, plus the maps
     needed to go back from an offset in it to a DOM position. Rebuilt after each
     wrap, because splitting text nodes invalidates the node list (character
     offsets, however, never move — wrapping adds no text). */

  function collectTextNodes(md) {
    const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        for (let el = n.parentElement; el && el !== md; el = el.parentElement) {
          // The annotations section quotes the passage back at us, and
          // transcluded text belongs to another file. Neither may match.
          if (el.classList.contains('ann-section') || el.classList.contains('mdt-embed')) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    const starts = [];
    let raw = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      starts.push(raw.length);
      nodes.push(n);
      raw += n.nodeValue;
    }
    return { nodes, starts, raw };
  }

  function buildIndex(md) {
    const base = collectTextNodes(md);
    let norm = '';
    const map = [];
    let space = true; // leading whitespace collapses away, matching normalize()
    for (let i = 0; i < base.raw.length; i++) {
      const ch = base.raw[i];
      if (/\s/.test(ch)) {
        if (space) continue;
        space = true;
        norm += ' ';
      } else {
        space = false;
        norm += ch;
      }
      map.push(i);
    }
    if (norm.endsWith(' ')) {
      norm = norm.slice(0, -1);
      map.pop();
    }
    base.norm = norm;
    base.map = map;
    return base;
  }

  function occurrences(hay, needle) {
    const out = [];
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
    return out;
  }

  // Context decides between duplicates, and only when it decides *uniquely*.
  function disambiguate(index, hits, qlen, before, after) {
    if (!before && !after) return -1;
    let best = -1;
    let top = 0;
    let tied = false;
    for (const at of hits) {
      let s = 0;
      if (before && index.norm.slice(Math.max(0, at - before.length), at).endsWith(before)) s++;
      if (after && index.norm.slice(at + qlen, at + qlen + after.length).startsWith(after)) s++;
      if (s > top) {
        top = s;
        best = at;
        tied = false;
      } else if (s === top && s > 0) {
        tied = true;
      }
    }
    return top > 0 && !tied ? best : -1;
  }

  // One annotation becomes several sibling <mark>s when the passage crosses
  // element boundaries; CSS makes them read as one.
  function wrapRange(md, start, end, className, id) {
    const { nodes, starts } = collectTextNodes(md);
    const targets = [];
    for (let i = 0; i < nodes.length; i++) {
      const s = starts[i];
      const e = s + nodes[i].nodeValue.length;
      if (e <= start || s >= end) continue;
      targets.push({ node: nodes[i], from: Math.max(0, start - s), to: Math.min(e, end) - s });
    }
    const marks = [];
    for (const t of targets) {
      let n = t.node;
      if (t.to >= n.nodeValue.length && t.from <= 0) {
        // whole node
      } else {
        if (t.to < n.nodeValue.length) n.splitText(t.to);
        if (t.from > 0) n = n.splitText(t.from);
      }
      if (!n.nodeValue.length) continue;
      const m = document.createElement('mark');
      m.className = className;
      m.dataset.annId = id;
      n.parentNode.insertBefore(m, n);
      m.appendChild(n);
      marks.push(m);
    }
    return marks;
  }

  /* ---------- anchoring ---------- */

  // Every entry type, or the section it introduces goes unshielded: the quotes
  // it renders back would then compete with the passage, and every annotation
  // in the file would come out `trecho ambíguo`. Keep in step with MARKER_RE.
  const ANN_COMMENT = /^\s*ann:(note|claude|hl)\s/;
  const ANN_END = /^\s*\/ann\s*$/;

  // The annotations section renders like any other markdown at the foot of the
  // page; wrapping it keeps it out of matching, selection and the text index —
  // and folds it away, because it is storage. What the reader came for is the
  // marks in the text and the cards beside them; the section is the same thing
  // spelled out twice, and it grows without bound.
  //
  // A heading only counts once an entry marker follows it, and then the *first*
  // such heading wins. That way a stray duplicate heading (hand-edited in) still
  // shields every entry below it, while a document that happens to have its own
  // unrelated "## Annotations" section is left alone.
  function markSection(md, count) {
    let h = null;
    for (const el of md.children) {
      if (el.tagName !== 'H2' || el.textContent.trim() !== 'Annotations') continue;
      for (let n = el.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === Node.COMMENT_NODE && ANN_COMMENT.test(n.nodeValue)) {
          h = el;
          break;
        }
      }
      if (h) break;
    }
    if (!h) return;

    // The section ends where its entries do, not at the end of the document:
    // a file can have grown a section of its own *below* the annotations, and
    // folding that away (or shielding it from matching) would be wrong. The
    // entry markers bound it — the first heading reached outside an entry is
    // somebody else's.
    const body = [];
    let inEntry = false;
    for (let n = h.nextSibling; n; n = n.nextSibling) {
      if (n.nodeType === Node.COMMENT_NODE) {
        if (ANN_COMMENT.test(n.nodeValue)) inEntry = true;
        else if (ANN_END.test(n.nodeValue)) inEntry = false;
      } else if (!inEntry && (n.tagName === 'H1' || n.tagName === 'H2')) {
        break;
      }
      body.push(n);
    }

    // The heading becomes the lever. The class rides on the wrapper alone:
    // every lookup walks up from a text node or uses `closest`, so one tag on
    // the ancestor shields the whole subtree.
    const details = document.createElement('details');
    details.className = 'ann-section';
    details.open = st.sectionOpen;
    const summary = document.createElement('summary');
    md.insertBefore(details, h);
    details.appendChild(summary);
    summary.appendChild(h); // keeps the heading's id, so the ToC link still lands
    if (count) {
      const n = document.createElement('span');
      n.className = 'ann-count';
      n.textContent = String(count);
      h.appendChild(n);
    }
    for (const n of body) details.appendChild(n);
    details.addEventListener('toggle', () => {
      st.sectionOpen = details.open;
    });
  }

  function anchorAll(md, entries) {
    for (const e of entries) {
      e.state = 'orphan';
      const q = Ann.normalize(e.quote);
      if (!q) continue;
      const index = buildIndex(md);
      const hits = occurrences(index.norm, q);
      if (!hits.length) continue;
      const at = hits.length === 1
        ? hits[0]
        : disambiguate(index, hits, q.length, e.attrs.before, e.attrs.after);
      if (at < 0) {
        e.state = 'ambiguous';
        continue;
      }
      // A mark and a claude instruction can cover the same passage; the second
      // wrap simply nests inside the first, and `closest` resolves clicks inward.
      const cls = isMark(e)
        ? `ann ann-hl ann-c-${colorOf(e)}${e.body ? ' ann-has-note' : ''}`
        : `ann ann-${e.type}`;
      const marks = wrapRange(md, index.map[at], index.map[at + q.length - 1] + 1, cls, e.id);
      if (marks.length) e.state = 'ok';
    }
  }

  /* ---------- rail ---------- */

  const LOST = { orphan: 'trecho não encontrado', ambiguous: 'trecho ambíguo' };
  const KIND = { note: 'nota', claude: 'claude', hl: 'marca' };

  // What the reader sees on a mark's card or popover: `nota` once something is
  // written about it, `marca` while it is only a colour.
  const kindOf = (e) => (isMark(e) ? (e.body ? KIND.note : KIND.hl) : KIND[e.type] || e.type);

  // A mark with no comment would be an empty card next to a highlight that
  // already says everything. A *lost* one is the opposite case: the card is the
  // only handle left on it, so it has to be there.
  const railWorthy = (e) => !isMark(e) || Boolean(e.body) || e.state !== 'ok';

  function renderRail(all) {
    st.cards = [];
    resetConfirm();
    if (!rail) return;
    rail.textContent = '';
    const entries = all.filter(railWorthy);
    if (!entries.length) {
      rail.hidden = true;
      return;
    }
    for (const e of entries) {
      const el = document.createElement('div');
      const mark = isMark(e);
      el.className = `ann-card ann-card-${mark ? 'hl' : e.type}${e.state === 'ok' ? '' : ' ann-card-lost'}`;
      if (mark) el.classList.add(`ann-c-${colorOf(e)}`);
      el.dataset.annId = e.id;

      const top = document.createElement('div');
      top.className = 'ann-card-top';
      const kind = document.createElement('span');
      kind.className = 'ann-card-kind';
      kind.textContent = kindOf(e);
      const date = document.createElement('span');
      date.className = 'ann-card-date';
      date.textContent = e.date;
      top.append(kind, date);
      // Every card, a lost bare highlight's included: any mark can be given a
      // comment, and this is the only handle on one that lost its passage.
      const edit = document.createElement('button');
      edit.className = 'ann-card-btn ann-card-edit';
      edit.type = 'button';
      edit.title = 'editar anotação';
      edit.textContent = '✎';
      top.appendChild(edit);
      const del = document.createElement('button');
      del.className = 'ann-card-btn ann-card-del';
      del.type = 'button';
      del.title = 'apagar anotação';
      del.textContent = '×';
      top.appendChild(del);
      el.appendChild(top);

      if (e.state !== 'ok') {
        const lost = document.createElement('div');
        lost.className = 'ann-card-status';
        lost.textContent = LOST[e.state];
        el.appendChild(lost);
      }

      const body = document.createElement('div');
      // A mark with no comment has nothing of its own to show, so the card shows
      // the passage it lost — that is what you need to find it again.
      const isQuote = !e.body;
      body.className = `ann-card-body${isQuote ? ' ann-card-quote' : ''}`;
      body.textContent = isQuote ? e.quote : e.body;
      el.appendChild(body);

      rail.appendChild(el);
      st.cards.push({ id: e.id, el, entry: e });
    }
    rail.hidden = false;
  }

  // Desired position = the top of the first mark; then a single top-to-bottom
  // sweep pushes overlaps down. Orphans have no mark, so they queue at the end.
  function layoutCards() {
    if (!rail || rail.hidden || !st.cards.length || !railVisible()) return;
    const railTop = rail.getBoundingClientRect().top;
    const items = st.cards.map((c) => {
      const m = els.page.querySelector(`mark.ann[data-ann-id="${CSS.escape(c.id)}"]`);
      return { c, y: m ? m.getBoundingClientRect().top - railTop : null };
    });
    items.sort((a, b) => (a.y === null ? Infinity : a.y) - (b.y === null ? Infinity : b.y));
    let prev = 0;
    for (const it of items) {
      const y = Math.max(it.y === null ? prev : it.y, prev);
      it.c.el.style.top = `${Math.round(y)}px`;
      prev = y + it.c.el.offsetHeight + 8;
    }
  }

  let layoutFrame = 0;
  function scheduleLayout() {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(layoutCards);
  }

  let pageObserver = null;
  function observePage() {
    if (pageObserver || typeof ResizeObserver === 'undefined') return;
    // Images and mermaid render after us (app.js does not await either), and
    // every one of them moves the marks the cards are lined up with.
    pageObserver = new ResizeObserver(scheduleLayout);
    pageObserver.observe(els.page);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(scheduleLayout, 120);
  });

  function flash(nodes) {
    for (const n of nodes) {
      n.classList.remove('ann-flash');
      void n.offsetWidth;
      n.classList.add('ann-flash');
      setTimeout(() => n.classList.remove('ann-flash'), 900);
    }
  }

  const marksOf = (id) => [...els.page.querySelectorAll(`mark.ann[data-ann-id="${CSS.escape(id)}"]`)];

  /* ---------- popover ---------- */

  let pop = null;
  let ui = null;

  function ensurePopover() {
    if (pop) return;
    pop = document.createElement('div');
    pop.className = 'ann-popover';
    pop.hidden = true;
    pop.innerHTML =
      '<div class="ann-pop-head">' +
      '<span class="ann-pop-kind"></span>' +
      '<button class="ann-pop-mic" type="button" hidden>&#9679; ditar</button>' +
      '<span class="ann-pop-status"></span>' +
      '</div>' +
      '<div class="ann-pop-colors" hidden></div>' +
      '<textarea class="ann-pop-text" rows="3" spellcheck="false"></textarea>' +
      '<div class="ann-pop-view" hidden></div>' +
      '<div class="ann-pop-actions">' +
      '<button class="ann-pop-del" type="button" hidden>apagar</button>' +
      '<button class="ann-pop-edit" type="button" hidden>editar</button>' +
      '<button class="ann-pop-cancel" type="button">cancelar</button>' +
      '<button class="ann-pop-save" type="button">salvar</button>' +
      '</div>';
    document.body.appendChild(pop);
    ui = {
      kind: pop.querySelector('.ann-pop-kind'),
      mic: pop.querySelector('.ann-pop-mic'),
      status: pop.querySelector('.ann-pop-status'),
      text: pop.querySelector('.ann-pop-text'),
      view: pop.querySelector('.ann-pop-view'),
      colors: pop.querySelector('.ann-pop-colors'),
      del: pop.querySelector('.ann-pop-del'),
      edit: pop.querySelector('.ann-pop-edit'),
      cancel: pop.querySelector('.ann-pop-cancel'),
      save: pop.querySelector('.ann-pop-save'),
    };
    // The swatch order is the number-key order — the title says which is which
    // so the shortcut is discoverable from the thing it operates on.
    Ann.COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ann-swatch ann-c-${c}`;
      b.dataset.color = c;
      b.title = `${c}  ( ${i + 1} )`;
      ui.colors.appendChild(b);
    });
    // On a mark that exists, a swatch is a write. On a note still being typed
    // it only picks the colour the save will use.
    ui.colors.addEventListener('click', (e) => {
      const b = e.target.closest('.ann-swatch');
      if (!b) return;
      if (st.mode === 'mark' && st.viewId) {
        recolor(st.viewId, b.dataset.color);
      } else if (st.mode === 'editor' && st.type === 'note') {
        st.color = b.dataset.color;
        paintSwatches(st.color, KIND.note);
        ui.text.focus();
      }
    });
    ui.save.addEventListener('click', save);
    ui.cancel.addEventListener('click', () => closePopover());
    ui.mic.addEventListener('click', () => (mic.state === 'off' ? micStart() : micPause()));
    ui.del.addEventListener('click', () => {
      if (st.viewId) confirmDelete(st.viewId, ui.del);
    });
    ui.edit.addEventListener('click', () => {
      if (st.viewId) openEdit(st.viewId);
    });
    ui.text.addEventListener('input', () => {
      if (mic.state === 'off') mic.committed = ui.text.value;
    });
  }

  // A comment being reworded can be longer than the three rows a new one starts
  // with; showing all of it, up to a point, beats a scrollbar in a small box.
  // Needs the popover laid out (hidden by visibility, not display) to measure.
  function fitText() {
    const t = ui.text;
    t.style.height = '';
    if (t.hidden || t.scrollHeight <= t.clientHeight) return;
    const borders = t.offsetHeight - t.clientHeight; // border-box: height includes them
    t.style.height = `${Math.min(t.scrollHeight + borders, Math.round(window.innerHeight * 0.45))}px`;
  }

  // `over` lays the popover on top of `rect` instead of under it — the editor
  // opened from a card takes that card's place.
  function placePopover(rect, over) {
    const margin = 10;
    pop.hidden = false;
    pop.style.visibility = 'hidden';
    pop.style.left = '0px';
    pop.style.top = '0px';
    fitText();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - w - margin);
    left = Math.max(margin, left);
    let top = over ? rect.top : rect.bottom + 8;
    if (top + h > window.innerHeight - margin) {
      top = Math.max(margin, over ? window.innerHeight - margin - h : rect.top - h - 8);
    }
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.visibility = '';
    keepInView();
  }

  // iOS lays its keyboard over the page instead of shrinking it. `fixed` is
  // measured against the layout viewport, which keeps its full height, so an
  // editor placed under a passage low on the screen ends up behind the keys.
  // The visual viewport is the part actually on screen; the popover moves into
  // it, and stays put when it already fits.
  function keepInView() {
    const vv = window.visualViewport;
    if (!vv || !pop || pop.hidden) return;
    const margin = 10;
    const top = parseFloat(pop.style.top) || 0;
    const lo = vv.offsetTop + margin;
    const hi = vv.offsetTop + vv.height - margin;
    const h = pop.offsetHeight;
    if (top >= lo && top + h <= hi) return;
    pop.style.top = `${Math.round(Math.max(lo, Math.min(top, hi - h)))}px`;
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', keepInView);
    window.visualViewport.addEventListener('scroll', keepInView);
  }

  function closePopover() {
    st.session++; // any save still awaiting the mic sees this and gives up
    micTeardown();
    if (pop) pop.hidden = true;
    unwrapPending();
    st.mode = 'idle';
    st.color = null;
    st.quote = '';
    st.ctx = null;
    st.project = null;
    st.path = null;
    st.editId = null;
    st.original = '';
    st.viewId = null;
    resetConfirm();
  }

  /* ---------- selection ---------- */

  // Endpoints are not enough: a drag from above an embed to below it has both
  // ends in ordinary text while swallowing the borrowed blocks in between. That
  // quote would contain text the index deliberately excludes, so it could never
  // anchor — the annotation would be born orphaned.
  function inRegion(range, sel) {
    const a = elemOf(range.startContainer);
    const b = elemOf(range.endContainer);
    if ((a && a.closest(sel)) || (b && b.closest(sel))) return true;
    const md = mdRoot();
    if (!md) return false;
    for (const el of md.querySelectorAll(sel)) {
      if (range.intersectsNode(el)) return true;
    }
    return false;
  }

  function readSelection() {
    const md = mdRoot();
    if (!md) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!md.contains(range.startContainer) || !md.contains(range.endContainer)) return null;
    const text = sel.toString();
    if (!Ann.normalize(text)) return null;
    // README rule: edit the source, never the copy.
    if (inRegion(range, '.mdt-embed')) return { refuse: 'texto transcluído — anote na fonte' };
    if (inRegion(range, '.ann-section')) return { refuse: 'isso já é uma anotação' };
    return { text, range: range.cloneRange(), rect: range.getBoundingClientRect() };
  }

  function firstTextIn(el) {
    return document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
  }

  function rawOffsetOf(index, node, offset) {
    if (node.nodeType !== 3) {
      const child = node.childNodes[offset] || node;
      node = child.nodeType === 3 ? child : firstTextIn(child) || firstTextIn(node);
      offset = 0;
    }
    const i = node ? index.nodes.indexOf(node) : -1;
    return i < 0 ? 0 : index.starts[i] + offset;
  }

  // Only stored when the passage is not unique — otherwise the quote alone is
  // enough and the marker stays short.
  function captureContext(index, sel) {
    const q = Ann.normalize(sel.text);
    const hits = occurrences(index.norm, q);
    if (hits.length <= 1) return null;
    const rawStart = rawOffsetOf(index, sel.range.startContainer, sel.range.startOffset);
    let at = hits[0];
    let best = Infinity;
    for (const h of hits) {
      const d = Math.abs(index.map[h] - rawStart);
      if (d < best) {
        best = d;
        at = h;
      }
    }
    return {
      before: index.norm.slice(Math.max(0, at - Ann.MAX_CTX), at),
      after: index.norm.slice(at + q.length, at + q.length + Ann.MAX_CTX),
    };
  }

  // Keeps the passage visible while the comment is being typed.
  function markPending(range) {
    const md = mdRoot();
    if (!md) return;
    const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (range.intersectsNode(n)) hits.push(n);
    }
    for (const hit of hits) {
      let node = hit;
      const isStart = node === range.startContainer && range.startContainer.nodeType === 3;
      const isEnd = node === range.endContainer && range.endContainer.nodeType === 3;
      const from = isStart ? range.startOffset : 0;
      const to = isEnd ? range.endOffset : node.nodeValue.length;
      if (to <= from) continue;
      if (to < node.nodeValue.length) node.splitText(to);
      if (from > 0) node = node.splitText(from);
      const m = document.createElement('mark');
      m.className = 'ann-pending';
      node.parentNode.insertBefore(m, node);
      m.appendChild(node);
    }
  }

  function unwrapPending() {
    const md = mdRoot();
    if (!md) return;
    md.querySelectorAll('mark.ann-pending').forEach((m) => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    });
  }

  /* ---------- dictation ---------- */

  // `gen` is the ownership token. A start that fails late (dismissed permission
  // prompt, connect timeout) must not reset state that a newer, live session now
  // owns — that would strand a recording nothing can stop.
  const mic = { session: null, state: 'off', committed: '', live: '', gen: 0 };

  function micRender() {
    const parts = [mic.committed.trim(), mic.live.trim()].filter(Boolean);
    ui.text.value = parts.join(' ');
  }

  function micStatus(msg, cls) {
    ui.status.textContent = msg || '';
    ui.status.className = 'ann-pop-status' + (cls ? ` ${cls}` : '');
  }

  function micButton(label) {
    ui.mic.textContent = label;
  }

  async function micStart() {
    const D = window.NotasDictation;
    if (!D || !D.available()) {
      micStatus('ditado indisponível — digite');
      return;
    }
    mic.committed = ui.text.value;
    mic.live = '';
    mic.state = 'starting';
    const gen = ++mic.gen;
    micButton('■ parar');
    micStatus('conectando…', 'ann-connecting');
    let session;
    try {
      session = await D.start({
        // stt revises turns instead of appending, so the handler always gets the
        // whole transcript and always replaces.
        onText: (t) => {
          if (gen === mic.gen && (mic.state === 'starting' || mic.state === 'live')) {
            mic.live = t;
            micRender();
          }
        },
        onError: (msg) => {
          if (gen !== mic.gen) return;
          toast(msg);
          micPause();
        },
      });
    } catch (err) {
      if (gen !== mic.gen) return; // a newer session owns the UI now
      mic.state = 'off';
      micButton('● ditar');
      micStatus('');
      toast(err && err.message ? err.message : 'ditado indisponível');
      return;
    }
    if (gen !== mic.gen || mic.state !== 'starting') {
      // paused, saved or superseded while the token/mic was coming up
      session.cancel();
      return;
    }
    mic.session = session;
    mic.state = 'live';
    micStatus('ouvindo…', 'ann-live');
  }

  // Folds whatever is on screen into the typed text and drops the session — no
  // merge logic, so a late revision can never clobber what was typed.
  function micPause() {
    if (mic.state === 'off') return;
    mic.gen++;
    const s = mic.session;
    mic.session = null;
    mic.state = 'off';
    mic.committed = ui.text.value;
    mic.live = '';
    if (s) s.cancel();
    micButton('● ditar');
    micStatus('mic pausado (clique para retomar)');
  }

  function micTeardown() {
    mic.gen++;
    if (mic.session) mic.session.cancel();
    mic.session = null;
    mic.state = 'off';
    mic.committed = '';
    mic.live = '';
  }

  // Bounded: after the end of audio the provider finalizes the last turn in a
  // network round trip, but a dead socket must never hold the save hostage.
  async function micStopForSave() {
    if (!mic.session) {
      if (mic.state !== 'off') micPause();
      return;
    }
    mic.gen++;
    const s = mic.session;
    mic.session = null;
    mic.state = 'off';
    micStatus('salvando…');
    let final = null;
    try {
      final = await s.stop(2000);
    } catch { /* keep what we already have */ }
    if (final) {
      mic.live = final;
      micRender();
    }
    mic.committed = ui.text.value;
    mic.live = '';
    micButton('● ditar');
  }

  /* ---------- editor ---------- */

  // The kind label takes the colour, and the ring marks the swatch that has it.
  function paintSwatches(color, label) {
    ui.kind.textContent = label;
    ui.kind.className = `ann-pop-kind ann-kind-hl ann-c-${color}`;
    for (const b of ui.colors.children) {
      b.classList.toggle('is-on', b.dataset.color === color);
    }
  }

  // The popover as an editor: a new note or claude instruction, or a claude
  // instruction being reworded. Answers whether dictation is available.
  function showEditor(type, text) {
    ui.kind.textContent = KIND[type] || type;
    ui.kind.className = `ann-pop-kind ann-kind-${type}`;
    ui.text.hidden = false;
    ui.text.value = text;
    ui.text.placeholder = 'comentário…  ( enter salva · esc cancela )';
    ui.view.hidden = true;
    // A new note is a mark being made, so its colour can be picked first.
    ui.colors.hidden = type !== 'note';
    if (type === 'note') paintSwatches(st.color, KIND.note);
    ui.del.hidden = true;
    ui.edit.hidden = true;
    ui.save.hidden = false;
    ui.save.disabled = false;
    ui.cancel.textContent = 'cancelar';
    mic.committed = text;
    mic.live = '';
    mic.state = 'off';

    const D = window.NotasDictation;
    const canDictate = Boolean(D && D.available());
    ui.mic.hidden = !canDictate;
    micButton('● ditar');
    micStatus(canDictate ? '' : 'ditado indisponível — digite');
    return canDictate;
  }

  function openEditor(type, sel) {
    const md = mdRoot();
    if (!md) return;
    ensurePopover();
    // Index built before wrapping: markPending splits the very nodes it maps.
    const index = buildIndex(md);
    st.ctx = captureContext(index, sel);
    st.mode = 'editor';
    st.type = type;
    st.color = type === 'note' ? Ann.NOTE_COLOR : null;
    st.quote = sel.text;
    st.project = state.current;
    st.path = state.file.path;
    st.editId = null;
    st.original = '';
    st.session++;
    markPending(sel.range);
    window.getSelection().removeAllRanges();

    const canDictate = showEditor(type, '');
    placePopover(sel.rect);
    ui.text.focus();
    if (canDictate) micStart();
  }

  const FALLBACK_RECT = { left: 16, top: 80, bottom: 88 };

  // A popover holding something unsaved: a new comment with any text in it, or
  // a comment that has drifted from what the file says. Opening another one
  // over it would throw that away without a word.
  const editorBusy = () =>
    Boolean(pop) && !pop.hidden && (st.mode === 'editor' || st.mode === 'mark') &&
    ui.text.value.trim() !== st.original.trim();

  // Unlike a new comment, the mic waits to be asked: the text is already there,
  // and the likely job is fixing a word of it, not saying more. The passage is
  // already marked, so nothing is pended either — a flash says which one it is.
  function openEdit(id, rect, over) {
    const e = entryOf(id);
    if (!e || !state.file) return;
    if (isMark(e)) {
      openMark(id, { rect, over, focus: true });
      return;
    }
    if (pop && !pop.hidden && st.mode === 'editor' && st.editId === id) {
      ui.text.focus();
      return;
    }
    if (editorBusy()) {
      ui.text.focus();
      toast('termine ou cancele a anotação aberta');
      return;
    }
    if (!rect) {
      const m = marksOf(id)[0];
      rect = m ? m.getBoundingClientRect() : FALLBACK_RECT;
    }
    closePopover(); // whatever was open — a view, a highlight, an untouched editor
    ensurePopover();
    st.mode = 'editor';
    st.type = e.type;
    st.editId = id;
    st.original = e.body;
    st.project = state.current;
    st.path = state.file.path;
    st.session++;

    showEditor(e.type, e.body);
    placePopover(rect, over);
    ui.text.focus();
    ui.text.setSelectionRange(ui.text.value.length, ui.text.value.length);
    flash(marksOf(id));
  }

  function openView(id) {
    const e = entryOf(id);
    if (!e) return;
    ensurePopover();
    micTeardown();
    st.mode = 'view';
    st.viewId = id;
    ui.kind.textContent = KIND[e.type] || e.type;
    ui.kind.className = `ann-pop-kind ann-kind-${e.type}`;
    ui.mic.hidden = true;
    micStatus(e.date);
    ui.text.hidden = true;
    ui.view.hidden = false;
    ui.view.textContent = e.body;
    ui.colors.hidden = true;
    resetConfirm();
    ui.del.hidden = false;
    ui.del.textContent = 'apagar';
    ui.del.classList.remove('ann-confirm');
    ui.edit.hidden = false;
    ui.save.hidden = true;
    ui.cancel.textContent = 'fechar';
    const m = marksOf(id)[0];
    placePopover(m ? m.getBoundingClientRect() : FALLBACK_RECT);
  }

  // The one popover a mark has, comment or not: its colour, its comment, and
  // `apagar`. The box is focused only when asked (`✎`, `n` on a marked
  // passage): otherwise `1`–`4` keep recolouring, and on a phone the keyboard
  // stays down until the box is tapped. An emptied box saves as a plain
  // highlight — the mark stays, only what was written about it goes.
  function openMark(id, opts = {}) {
    const e = entryOf(id);
    if (!e || !isMark(e) || !state.file) return;
    if (pop && !pop.hidden && st.mode === 'mark' && st.viewId === id) {
      if (opts.focus) ui.text.focus();
      return;
    }
    if (editorBusy()) {
      ui.text.focus();
      toast('termine ou cancele a anotação aberta');
      return;
    }
    let rect = opts.rect;
    if (!rect) {
      const m = marksOf(id)[0];
      rect = m ? m.getBoundingClientRect() : FALLBACK_RECT;
    }
    closePopover(); // whatever was open — a view, an untouched editor
    ensurePopover();
    st.mode = 'mark';
    st.type = e.type;
    st.viewId = id;
    st.editId = id;
    st.original = e.body;
    st.project = state.current;
    st.path = state.file.path;
    st.session++;

    paintSwatches(colorOf(e), kindOf(e));
    ui.colors.hidden = false;
    ui.text.hidden = false;
    ui.text.value = e.body;
    ui.text.placeholder = 'escrever uma nota…';
    ui.view.hidden = true;
    resetConfirm();
    ui.del.hidden = false;
    ui.del.textContent = 'apagar';
    ui.del.classList.remove('ann-confirm');
    ui.edit.hidden = true;
    ui.save.hidden = false;
    ui.save.disabled = false;
    ui.cancel.textContent = 'fechar';
    mic.committed = e.body;
    mic.live = '';
    mic.state = 'off';
    const D = window.NotasDictation;
    ui.mic.hidden = !(D && D.available());
    micButton('● ditar');
    micStatus(e.date);

    placePopover(rect, opts.over);
    if (opts.focus) {
      ui.text.focus();
      ui.text.setSelectionRange(ui.text.value.length, ui.text.value.length);
      flash(marksOf(id));
    }
  }

  /* ---------- write ---------- */

  // A save can land after the reader has moved on (the mic wait alone is up to
  // 2 s). The write still belongs to the file it was made on, but nothing
  // after it may touch — or yank the reader back to — a file they left.
  const stillOn = (project, relPath) =>
    state.current === project && state.file && state.file.path === relPath;

  async function reload(project, relPath) {
    if (!stillOn(project, relPath)) return;
    const keep = els.scroll.scrollTop;
    await openFile(project, relPath, { silent: true });
    els.scroll.scrollTop = keep;
  }

  // Every write ends the same way. Pre-empting the 2 s poll with the returned
  // mtime is what stops a save from also announcing "arquivo recarregado";
  // max() because a dep-aware mtime must never go down.
  // Answers the server's reply, which for a new entry carries its id.
  async function commit(project, relPath, request, okMsg, opts = {}) {
    const out = await request;
    if (stillOn(project, relPath)) state.file.mtime = Math.max(state.file.mtime, out.mtime);
    if (!opts.keepPopover) closePopover();
    await reload(project, relPath);
    // Say where, when "where" is no longer what the reader is looking at.
    toast(stillOn(project, relPath) ? okMsg : `${okMsg} em ${relPath.split('/').pop()}`);
    return out;
  }

  async function save() {
    if ((st.mode !== 'editor' && st.mode !== 'mark') || st.saving) return;
    st.saving = true;
    ui.save.disabled = true;
    const session = st.session;
    const project = st.project;
    const relPath = st.path;
    const kind = st.type;
    const color = st.color;
    const quote = st.quote;
    const ctx = st.ctx;
    const editId = st.editId;
    const original = st.original.trim();
    try {
      await micStopForSave();
      // Esc (or anything else that closed the editor) during the mic's final
      // wait means cancelled — the placeholder promises "esc cancela".
      if (session !== st.session) return;
      const comment = ui.text.value.trim();
      if (editId) {
        // A claude entry is nothing but its instruction, so emptied is not
        // deleted: that is `apagar`, which asks first. The editor stays open
        // so nothing typed is lost to a slip. A mark just loses its comment.
        if (!comment && kind === 'claude') {
          toast('instrução vazia — para remover, use apagar');
          return;
        }
        if (comment === original) {
          closePopover();
          return;
        }
        const req = apiPost('/api/annotate/edit', { project, path: relPath, id: editId, comment });
        const what =
          kind === 'claude' ? 'instrução alterada'
            : !comment ? 'nota removida'
              : original ? 'nota alterada' : 'nota salva';
        await commit(project, relPath, req, what);
        return;
      }
      // Nothing said, nothing typed — write nothing, say nothing.
      if (!comment || !relPath) {
        closePopover();
        return;
      }
      // A note is a mark with something written about it.
      const body = { project, path: relPath, type: kind === 'note' ? 'hl' : kind, quote, comment };
      if (kind === 'note') body.color = color || Ann.NOTE_COLOR;
      if (ctx) {
        body.before = ctx.before;
        body.after = ctx.after;
      }
      const what = kind === 'claude' ? 'instrução salva' : 'nota salva';
      await commit(project, relPath, apiPost('/api/annotate', body), what);
    } catch (err) {
      toast(err && err.message ? err.message : 'erro ao salvar');
    } finally {
      st.saving = false;
      if (ui) ui.save.disabled = false;
    }
  }

  /* ---------- highlights ---------- */

  // Re-marking a passage that is already marked is a recolour, not a second
  // highlight. Matched against the mark element under the selection, never
  // against the quote text alone: two identical passages in one document would
  // otherwise let a highlight on the first swallow a request about the second.
  function existingHl(sel) {
    const a = elemOf(sel.range.startContainer);
    const m = a && a.closest('mark.ann-hl');
    if (!m) return null;
    const e = entryOf(m.dataset.annId);
    return e && Ann.normalize(e.quote) === Ann.normalize(sel.text) ? e : null;
  }

  // There is nothing to type first, so the key press writes the mark at once.
  // Its popover opens afterwards, box unfocused: ignore it and it goes at the
  // next click; tap the box and it becomes the mark's comment.
  async function saveHighlight(sel, color) {
    const md = mdRoot();
    if (!md || !state.file || st.saving) return;
    const prior = existingHl(sel);
    if (prior) {
      window.getSelection().removeAllRanges();
      if (colorOf(prior) === color) {
        toast('já marcado');
        return;
      }
      return recolor(prior.id, color);
    }
    const project = state.current;
    const relPath = state.file.path;
    const ctx = captureContext(buildIndex(md), sel);
    const body = { project, path: relPath, type: 'hl', quote: sel.text, color };
    if (ctx) {
      body.before = ctx.before;
      body.after = ctx.after;
    }
    window.getSelection().removeAllRanges();
    st.saving = true;
    let made = null;
    try {
      made = await commit(project, relPath, apiPost('/api/annotate', body), 'trecho marcado');
    } catch (err) {
      toast(err && err.message ? err.message : 'erro ao marcar');
    } finally {
      st.saving = false;
    }
    // stillOn as well as entryOf: the reader may have left mid-request, and a
    // matching id in whatever file is open now is a coincidence, not this one.
    if (made && made.id && stillOn(project, relPath) && entryOf(made.id)) openMark(made.id);
  }

  // The popover stays put and only its swatches and label are repainted, so a
  // comment half-typed in the box — or being dictated — survives the recolour,
  // and the next number key still lands on this mark.
  async function recolor(id, color) {
    const project = state.current;
    const relPath = state.file && state.file.path;
    if (!relPath || st.saving) return;
    const e = entryOf(id);
    if (e && colorOf(e) === color) return;
    const open = st.mode === 'mark' && st.viewId === id;
    st.saving = true;
    try {
      const req = apiPost('/api/annotate/color', { project, path: relPath, id, color });
      await commit(project, relPath, req, 'cor alterada', { keepPopover: open });
      const now = stillOn(project, relPath) && entryOf(id);
      if (open && now) paintSwatches(colorOf(now), kindOf(now));
      else if (open) closePopover();
    } catch (err) {
      toast(err && err.message ? err.message : 'erro ao recolorir');
    } finally {
      st.saving = false;
    }
  }

  // The armed button is tracked, not just the id: otherwise arming a second one
  // strands the first reading "apagar?" forever, and a re-opened popover shows an
  // innocent-looking button that deletes on the very next click.
  function resetConfirm() {
    clearTimeout(st.confirmTimer);
    if (st.confirmBtn && st.confirmBtn.isConnected) {
      st.confirmBtn.textContent = st.confirmLabel;
      st.confirmBtn.classList.remove('ann-confirm');
    }
    st.confirm = null;
    st.confirmBtn = null;
    st.confirmLabel = '';
  }

  function confirmDelete(id, btn) {
    if (st.confirm === id && st.confirmBtn === btn) {
      resetConfirm();
      doDelete(id);
      return;
    }
    resetConfirm();
    st.confirm = id;
    st.confirmBtn = btn;
    st.confirmLabel = btn.textContent;
    btn.textContent = 'apagar?';
    btn.classList.add('ann-confirm');
    st.confirmTimer = setTimeout(() => {
      if (st.confirm === id) resetConfirm();
    }, 2600);
  }

  async function doDelete(id) {
    const project = state.current;
    const relPath = state.file && state.file.path;
    if (!relPath) return;
    const e = entryOf(id);
    const what = isMark(e) && !e.body ? 'marca apagada' : 'anotação apagada';
    try {
      const req = apiPost('/api/annotate/delete', { project, path: relPath, id });
      await commit(project, relPath, req, what);
    } catch (err) {
      toast(err && err.message ? err.message : 'erro ao apagar');
    }
  }

  /* ---------- state machine ---------- */

  function arm(type, color) {
    st.mode = 'armed';
    st.type = type;
    st.color = color || null;
    els.page.classList.add('ann-arming');
    toast(type === 'hl' ? 'selecione o trecho a marcar  ( esc cancela )' : 'selecione o trecho  ( esc cancela )');
  }

  function disarm() {
    if (st.mode === 'armed') st.mode = 'idle';
    els.page.classList.remove('ann-arming');
  }

  // The only place that knows a highlight skips the editor. Everything upstream
  // just says "act on this selection with this type".
  function act(type, color, sel) {
    disarm();
    if (type === 'hl') {
      saveHighlight(sel, Ann.normColor(color));
      return;
    }
    // A note on a passage that is already marked belongs in that mark's own
    // comment, not in a second mark nested inside it.
    const prior = type === 'note' ? existingHl(sel) : null;
    if (prior) {
      window.getSelection().removeAllRanges();
      openMark(prior.id, { focus: true });
      return;
    }
    openEditor(type, sel);
  }

  function begin(type, color) {
    const sel = readSelection();
    if (sel && sel.refuse) {
      toast(sel.refuse);
      return;
    }
    if (sel) {
      act(type, color, sel);
      return;
    }
    arm(type, color);
  }

  els.page.addEventListener('mouseup', () => {
    if (st.mode !== 'armed') return;
    // The selection is not final until this tick ends.
    setTimeout(() => {
      if (st.mode !== 'armed') return;
      const sel = readSelection();
      if (!sel) return; // nothing selected yet — stay armed
      if (sel.refuse) {
        toast(sel.refuse);
        return;
      }
      act(st.type, st.color, sel);
    }, 0);
  });

  const isTyping = (e) =>
    !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete');

  // `1`–`4`, in swatch order. The same keys that create a highlight recolour one
  // that already exists, so there is nothing extra to learn.
  const colorKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return null;
    return Ann.COLORS[Number(e.key) - 1] || null;
  };

  function popKey(e) {
    // app.js listens on document too: "/" would steal focus into the search box
    // and ctrl+b would fold the sidebar mid-sentence.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopover();
      return;
    }
    // Outside the box — on a swatch, a button — the number keys recolour. In
    // the box they are digits like any other.
    if (st.mode === 'mark' && e.target !== ui.text) {
      const c = colorKey(e);
      if (c) {
        e.preventDefault();
        recolor(st.viewId, c);
      }
      return;
    }
    if (st.mode !== 'editor' && st.mode !== 'mark') return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
      return;
    }
    if (e.target === ui.text && mic.state !== 'off' && isTyping(e)) micPause();
  }

  const KEY_TYPE = { n: 'note', b: 'note', c: 'claude', h: 'hl', g: 'hl' };

  function onKey(e) {
    if (pop && !pop.hidden) {
      if (pop.contains(e.target)) return popKey(e);
      if (e.key === 'Escape') {
        closePopover();
        return;
      }
      // The mark popover opens with its box unfocused, so its number keys have
      // to work from wherever the click left the caret. Only those keys are
      // taken — everything else still reaches app.js, as for the view popover.
      if (st.mode === 'mark') {
        const c = colorKey(e);
        if (c) {
          e.preventDefault();
          e.stopPropagation();
          recolor(st.viewId, c);
        }
      }
      return; // a popover is open — the annotation keys stay inert until it is dealt with
    }
    if (e.key === 'Escape' && st.mode === 'armed') {
      e.preventDefault();
      disarm();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : '';
    const digit = colorKey(e);
    const type = digit ? 'hl' : KEY_TYPE[k];
    if (!type) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if (!state.file) return; // recentes / busca have no file to annotate
    if (state.current === '~') {
      toast('anotações indisponíveis em ~');
      return;
    }
    e.preventDefault();
    begin(type, digit || Ann.DEFAULT_COLOR);
  }

  document.addEventListener('keydown', onKey, true);

  /* ---------- touch ----------
     While a selection made with a finger sits in the page, a bar along the
     bottom of the screen offers what the keys do: nota, claude, and one swatch
     per highlight colour. Bottom, not beside the passage: iOS draws its own
     copy/look-up callout right next to the selection, and a page can neither
     move nor extend that one. A mouse never sees the bar — the keys are there. */

  let bar = null;
  // What the bar acts on, read while the selection was still there. A tap
  // outside the selection may collapse it before the button's click arrives.
  let barSel = null;
  // Set from the finger landing on the bar until its click: a selection that
  // collapses in between must not pull the button out from under the finger.
  let barPressed = false;
  let barFrame = 0;
  let pointer = 'mouse';

  function ensureBar() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'ann-bar';
    bar.hidden = true;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'anotar seleção');
    const add = (cls, text, label, type, color) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.setAttribute('aria-label', label);
      b.dataset.type = type;
      if (color) b.dataset.color = color;
      bar.appendChild(b);
    };
    add('ann-bar-kind ann-kind-note', KIND.note, 'nota', 'note');
    add('ann-bar-kind ann-kind-claude', KIND.claude, 'instrução para o claude', 'claude');
    const sep = document.createElement('span');
    sep.className = 'ann-bar-sep';
    bar.appendChild(sep);
    for (const c of Ann.COLORS) add(`ann-bar-swatch ann-c-${c}`, '', `marca ${c}`, 'hl', c);

    bar.addEventListener('pointerdown', () => {
      barPressed = true;
    });
    bar.addEventListener('pointercancel', () => {
      barPressed = false;
      scheduleBar();
    });
    // A press that ends without a click (the finger slid off the button) would
    // otherwise leave the bar pinned over a selection that is long gone.
    bar.addEventListener('pointerup', () => {
      setTimeout(() => {
        if (!barPressed) return;
        barPressed = false;
        scheduleBar();
      }, 500);
    });
    bar.addEventListener('click', onBarClick);
    document.body.appendChild(bar);
  }

  function onBarClick(e) {
    barPressed = false;
    const b = e.target.closest('button');
    if (!b) {
      scheduleBar();
      return;
    }
    const sel = barSel;
    hideBar();
    if (!sel) return;
    if (sel.refuse) {
      toast(sel.refuse);
      return;
    }
    // A save or the 2 s autoreload re-renders the page, and the range then
    // points into nodes that are gone.
    if (!sel.range.startContainer.isConnected) {
      toast('a página recarregou — selecione de novo');
      return;
    }
    sel.rect = sel.range.getBoundingClientRect(); // the page may have scrolled since
    act(b.dataset.type, b.dataset.color || Ann.DEFAULT_COLOR, sel);
  }

  // Same gates as the keys, minus the toasts: a bar that appears only to say
  // "not here" would get in the way of selecting text to copy it.
  const barWanted = () =>
    pointer !== 'mouse' && Boolean(state.file) && state.current !== '~' && (!pop || pop.hidden);

  function syncBar() {
    barFrame = 0;
    const sel = barWanted() ? readSelection() : null;
    if (sel) {
      ensureBar();
      barSel = sel;
      bar.hidden = false;
      document.documentElement.classList.add('ann-bar-on');
      return;
    }
    if (!barPressed) hideBar();
  }

  // selectionchange fires on every step of a handle being dragged.
  function scheduleBar() {
    if (!barFrame) barFrame = requestAnimationFrame(syncBar);
  }

  function hideBar() {
    barSel = null;
    if (!bar || bar.hidden) return;
    bar.hidden = true;
    document.documentElement.classList.remove('ann-bar-on');
  }

  document.addEventListener('selectionchange', scheduleBar);
  document.addEventListener(
    'pointerdown',
    (e) => {
      pointer = e.pointerType || 'mouse';
    },
    true
  );

  /* ---------- clicks ---------- */

  if (rail) {
    rail.addEventListener('click', (e) => {
      const card = e.target.closest('.ann-card');
      if (!card) return;
      const id = card.dataset.annId;
      if (e.target.closest('.ann-card-del')) {
        confirmDelete(id, e.target.closest('.ann-card-del'));
        return;
      }
      if (e.target.closest('.ann-card-edit')) {
        openEdit(id, card.getBoundingClientRect(), true);
        return;
      }
      const marks = marksOf(id);
      if (!marks.length) return;
      marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      flash(marks);
    });
  }

  els.page.addEventListener('click', (e) => {
    const m = e.target.closest('mark.ann');
    if (!m) return;
    const id = m.dataset.annId;
    const entry = entryOf(id);
    // A mark's popover is where its colour and comment are changed, so it opens
    // at every width; with the rail there, the card flashes too. `closest` gave
    // us the innermost mark, which is the right one when a claude instruction
    // and a mark cover the same passage.
    if (isMark(entry)) {
      openMark(id);
      const card = railVisible() && rail.querySelector(`.ann-card[data-ann-id="${CSS.escape(id)}"]`);
      if (card) flash([card]);
      return;
    }
    if (railVisible()) {
      const card = rail.querySelector(`.ann-card[data-ann-id="${CSS.escape(id)}"]`);
      if (card) {
        card.scrollIntoView({ block: 'nearest' });
        flash([card]);
      }
      flash(marksOf(id));
    } else {
      openView(id);
    }
  });

  // A view or mark popover is transient; the editor holds a half-typed comment
  // and stays, and so does a mark popover once something is typed in its box.
  // Pointer, not mouse: iOS sends mouse events for a tap only on what it
  // considers clickable, and the desk around the page is not.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!pop || pop.hidden || (st.mode !== 'view' && st.mode !== 'mark')) return;
      if (pop.contains(e.target) || e.target.closest('mark.ann')) return;
      if (editorBusy()) return;
      closePopover();
    },
    true
  );

  /* ---------- entry points used by app.js ---------- */

  function onFileRendered() {
    const md = mdRoot();
    if (!md || !state.file) {
      clear();
      return;
    }
    // Folded shut, unless this is the same file re-rendering under a reader who
    // opened it — a save, the 2 s autoreload and the theme re-route all land here.
    if (st.sectionKey !== fileKey()) {
      st.sectionKey = fileKey();
      st.sectionOpen = false;
    }
    const entries = Ann.parse(state.file.content || '').entries;
    markSection(md, entries.length);
    // Registered before anchoring so anything that looks an entry up by id —
    // including a click landing mid-render — sees the same list the marks
    // were built from.
    st.entries = entries;
    anchorAll(md, entries);
    renderRail(entries);
    observePage();
    scheduleLayout();
  }

  function clear() {
    closePopover();
    hideBar();
    disarm();
    st.entries = [];
    st.cards = [];
    if (rail) {
      rail.textContent = '';
      rail.hidden = true;
    }
  }

  window.NotasAnnUI = { onFileRendered, clear };
})();
