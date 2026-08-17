/* Notas — annotations UI.

   `n` = nota (stays in the file), `c` = claude (an instruction a later Claude
   session applies to the quoted passage and then removes), `h` = marca (a
   highlighter, no comment at all; `1`–`4` pick the colour directly). Any of
   them with text selected acts on it; without a selection the key arms the
   page and the next selection is what it acts on.

   The two comment kinds open a popover to type in. A highlight has nothing to
   type, so it writes immediately — its popover only appears when you click one
   that already exists, to recolour or delete it.

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
    mode: 'idle', // idle | armed | editor | view | hl
    type: null,
    color: null, // only meaningful while type === 'hl'
    quote: '',
    ctx: null,
    // The file the passage came from, pinned when the editor opens. The reader
    // may navigate away mid-comment; the annotation still belongs where it was
    // made, and must never land on whatever file happens to be open at save time.
    project: null,
    path: null,
    // Bumped whenever an editor session ends. An in-flight save compares it and
    // gives up, so Esc during the mic's final wait really does cancel.
    session: 0,
    // Every entry on the page, anchored or not. The rail only holds a subset
    // (an anchored highlight has no card), so it cannot be the lookup table.
    entries: [],
    cards: [],
    viewId: null,
    confirm: null,
    confirmBtn: null,
    confirmLabel: '',
    confirmTimer: 0,
    saving: false,
  };

  const mdRoot = () => els.page.querySelector('.md');
  const elemOf = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
  const railVisible = () => rail && !rail.hidden && getComputedStyle(rail).display !== 'none';
  const entryOf = (id) => st.entries.find((e) => e.id === id) || null;
  const colorOf = (e) => Ann.normColor(e && e.attrs && e.attrs.color);

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

  // The annotations section renders like any other markdown at the foot of the
  // page; tagging it keeps it out of matching, selection and the text index.
  //
  // A heading only counts once an entry marker follows it, and then the *first*
  // such heading wins. That way a stray duplicate heading (hand-edited in) still
  // shields every entry below it, while a document that happens to have its own
  // unrelated "## Annotations" section is left alone.
  function markSection(md) {
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
    h.classList.add('ann-section');
    for (let n = h.nextElementSibling; n; n = n.nextElementSibling) n.classList.add('ann-section');
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
      // A highlight and a note can cover the same passage; the second wrap
      // simply nests inside the first, and `closest` resolves clicks inward.
      const cls =
        e.type === 'hl' ? `ann ann-hl ann-c-${colorOf(e)}` : `ann ann-${e.type}`;
      const marks = wrapRange(md, index.map[at], index.map[at + q.length - 1] + 1, cls, e.id);
      if (marks.length) e.state = 'ok';
    }
  }

  /* ---------- rail ---------- */

  const LOST = { orphan: 'trecho não encontrado', ambiguous: 'trecho ambíguo' };
  const KIND = { note: 'nota', claude: 'claude', hl: 'marca' };

  // An anchored highlight carries no comment, so a card would be an empty box
  // next to a mark that already says everything. A *lost* one is the opposite
  // case: the card is the only handle left on it, so it has to be there.
  const railWorthy = (e) => e.type !== 'hl' || e.state !== 'ok';

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
      el.className = `ann-card ann-card-${e.type}${e.state === 'ok' ? '' : ' ann-card-lost'}`;
      if (e.type === 'hl') el.classList.add(`ann-c-${colorOf(e)}`);
      el.dataset.annId = e.id;

      const top = document.createElement('div');
      top.className = 'ann-card-top';
      const kind = document.createElement('span');
      kind.className = 'ann-card-kind';
      kind.textContent = KIND[e.type] || e.type;
      const date = document.createElement('span');
      date.className = 'ann-card-date';
      date.textContent = e.date;
      const del = document.createElement('button');
      del.className = 'ann-card-del';
      del.type = 'button';
      del.title = 'apagar anotação';
      del.textContent = '×';
      top.append(kind, date, del);
      el.appendChild(top);

      if (e.state !== 'ok') {
        const lost = document.createElement('div');
        lost.className = 'ann-card-status';
        lost.textContent = LOST[e.state];
        el.appendChild(lost);
      }

      const body = document.createElement('div');
      // A highlight has no comment of its own, so the card shows the passage
      // it lost — that is what you need to find it again in the file.
      const isQuote = e.type === 'hl';
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
      '<textarea class="ann-pop-text" rows="3" spellcheck="false" ' +
      'placeholder="comentário&hellip;  ( enter salva &middot; esc cancela )"></textarea>' +
      '<div class="ann-pop-view" hidden></div>' +
      '<div class="ann-pop-colors" hidden></div>' +
      '<div class="ann-pop-actions">' +
      '<button class="ann-pop-del" type="button" hidden>apagar</button>' +
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
    ui.colors.addEventListener('click', (e) => {
      const b = e.target.closest('.ann-swatch');
      if (b && st.viewId) recolor(st.viewId, b.dataset.color);
    });
    ui.save.addEventListener('click', save);
    ui.cancel.addEventListener('click', () => closePopover());
    ui.mic.addEventListener('click', () => (mic.state === 'off' ? micStart() : micPause()));
    ui.del.addEventListener('click', () => {
      if (st.viewId) confirmDelete(st.viewId, ui.del);
    });
    ui.text.addEventListener('input', () => {
      if (mic.state === 'off') mic.committed = ui.text.value;
    });
  }

  function placePopover(rect) {
    const margin = 10;
    pop.hidden = false;
    pop.style.visibility = 'hidden';
    pop.style.left = '0px';
    pop.style.top = '0px';
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - w - margin);
    left = Math.max(margin, left);
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - margin) top = Math.max(margin, rect.top - h - 8);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.visibility = '';
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
        // AAI revises turns instead of appending, so the handler always gets the
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

  // Bounded: a final formatted revision usually lands in a few hundred ms, but a
  // dead socket must never hold the save hostage.
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
      final = await s.stop(800);
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

  function openEditor(type, sel) {
    const md = mdRoot();
    if (!md) return;
    ensurePopover();
    // Index built before wrapping: markPending splits the very nodes it maps.
    const index = buildIndex(md);
    st.ctx = captureContext(index, sel);
    st.mode = 'editor';
    st.type = type;
    st.quote = sel.text;
    st.project = state.current;
    st.path = state.file.path;
    st.session++;
    markPending(sel.range);
    window.getSelection().removeAllRanges();

    ui.kind.textContent = type === 'claude' ? 'claude' : 'nota';
    ui.kind.className = `ann-pop-kind ann-kind-${type}`;
    ui.text.hidden = false;
    ui.text.value = '';
    ui.view.hidden = true;
    ui.colors.hidden = true;
    ui.del.hidden = true;
    ui.save.hidden = false;
    ui.save.disabled = false;
    ui.cancel.textContent = 'cancelar';
    mic.committed = '';
    mic.live = '';
    mic.state = 'off';

    const D = window.NotasDictation;
    const canDictate = Boolean(D && D.available());
    ui.mic.hidden = !canDictate;
    micButton('● ditar');
    micStatus(canDictate ? '' : 'ditado indisponível — digite');

    placePopover(sel.rect);
    ui.text.focus();
    if (canDictate) micStart();
  }

  const FALLBACK_RECT = { left: 16, top: 80, bottom: 88 };

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
    ui.save.hidden = true;
    ui.cancel.textContent = 'fechar';
    const m = marksOf(id)[0];
    placePopover(m ? m.getBoundingClientRect() : FALLBACK_RECT);
  }

  // A highlight has no text to show, so its popover is the two things you can
  // still do to one: change the colour, or take it off.
  function openHl(id) {
    const e = entryOf(id);
    if (!e) return;
    ensurePopover();
    micTeardown();
    st.mode = 'hl';
    st.viewId = id;
    const color = colorOf(e);
    ui.kind.textContent = KIND.hl;
    ui.kind.className = `ann-pop-kind ann-kind-hl ann-c-${color}`;
    ui.mic.hidden = true;
    micStatus(e.date);
    ui.text.hidden = true;
    ui.view.hidden = true;
    ui.colors.hidden = false;
    for (const b of ui.colors.children) {
      b.classList.toggle('is-on', b.dataset.color === color);
    }
    resetConfirm();
    ui.del.hidden = false;
    ui.del.textContent = 'apagar';
    ui.del.classList.remove('ann-confirm');
    ui.save.hidden = true;
    ui.cancel.textContent = 'fechar';
    const m = marksOf(id)[0];
    placePopover(m ? m.getBoundingClientRect() : FALLBACK_RECT);
  }

  /* ---------- write ---------- */

  // A save can land after the reader has moved on (the mic wait alone is up to
  // 800 ms). The write still belongs to the file it was made on, but nothing
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
  async function commit(project, relPath, request, okMsg, opts = {}) {
    const { mtime } = await request;
    if (stillOn(project, relPath)) state.file.mtime = Math.max(state.file.mtime, mtime);
    if (!opts.keepPopover) closePopover();
    await reload(project, relPath);
    // Say where, when "where" is no longer what the reader is looking at.
    toast(stillOn(project, relPath) ? okMsg : `${okMsg} em ${relPath.split('/').pop()}`);
  }

  async function save() {
    if (st.mode !== 'editor' || st.saving) return;
    st.saving = true;
    ui.save.disabled = true;
    const session = st.session;
    const project = st.project;
    const relPath = st.path;
    const kind = st.type;
    const quote = st.quote;
    const ctx = st.ctx;
    try {
      await micStopForSave();
      // Esc (or anything else that closed the editor) during the mic's final
      // wait means cancelled — the placeholder promises "esc cancela".
      if (session !== st.session) return;
      const comment = ui.text.value.trim();
      // Nothing said, nothing typed — write nothing, say nothing.
      if (!comment || !relPath) {
        closePopover();
        return;
      }
      const body = { project, path: relPath, type: kind, quote, comment };
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

  // No popover, no editor: there is nothing to type, so the key press *is* the
  // whole interaction and the write goes out immediately.
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
    try {
      await commit(project, relPath, apiPost('/api/annotate', body), 'trecho marcado');
    } catch (err) {
      toast(err && err.message ? err.message : 'erro ao marcar');
    } finally {
      st.saving = false;
    }
  }

  // The popover stays put and re-reads the entry afterwards, so the swatch row
  // shows the new colour and the next number key still lands on this highlight.
  async function recolor(id, color) {
    const project = state.current;
    const relPath = state.file && state.file.path;
    if (!relPath || st.saving) return;
    const open = st.mode === 'hl' && st.viewId === id;
    st.saving = true;
    try {
      const req = apiPost('/api/annotate/color', { project, path: relPath, id, color });
      await commit(project, relPath, req, 'cor alterada', { keepPopover: open });
      // stillOn as well as entryOf: the reader may have left mid-request, and a
      // matching id in whatever file is open now is a coincidence, not this one.
      if (open && stillOn(project, relPath) && entryOf(id)) openHl(id);
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
    const what = e && e.type === 'hl' ? 'marca apagada' : 'anotação apagada';
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
    if (type === 'hl') saveHighlight(sel, Ann.normColor(color));
    else openEditor(type, sel);
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
    if (st.mode === 'hl') {
      const c = colorKey(e);
      if (c) {
        e.preventDefault();
        recolor(st.viewId, c);
      }
      return;
    }
    if (st.mode !== 'editor') return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
      return;
    }
    if (e.target === ui.text && mic.state !== 'off' && isTyping(e)) micPause();
  }

  function onKey(e) {
    if (pop && !pop.hidden) {
      if (pop.contains(e.target)) return popKey(e);
      if (e.key === 'Escape') {
        closePopover();
        return;
      }
      // The highlight popover has no field to focus, so its number keys have to
      // work from wherever the click left the caret. Only those keys are taken —
      // everything else still reaches app.js, as it does for the view popover.
      if (st.mode === 'hl') {
        const c = colorKey(e);
        if (c) {
          e.preventDefault();
          e.stopPropagation();
          recolor(st.viewId, c);
        }
      }
      return; // a popover is open — n/c/h stay inert until it is dealt with
    }
    if (e.key === 'Escape' && st.mode === 'armed') {
      e.preventDefault();
      disarm();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : '';
    const digit = colorKey(e);
    const type = k === 'n' ? 'note' : k === 'c' ? 'claude' : k === 'h' || digit ? 'hl' : null;
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
    // A highlight has no card to jump to at any width — clicking one is the only
    // way to recolour or remove it, so the popover opens either way. `closest`
    // gave us the innermost mark, which is the right one when a note and a
    // highlight cover the same passage.
    if (entry && entry.type === 'hl') {
      openHl(id);
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

  // A view or highlight popover is transient; the editor holds a half-typed
  // comment and stays.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!pop || pop.hidden || (st.mode !== 'view' && st.mode !== 'hl')) return;
      if (pop.contains(e.target) || e.target.closest('mark.ann')) return;
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
    markSection(md);
    const entries = Ann.parse(state.file.content || '').entries;
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
