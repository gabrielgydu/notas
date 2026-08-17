/* Notas — client. Vanilla JS, hash routing.
   Routes: #/recentes | #/p/<project>/<path...> */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    projects: $('projects'),
    tree: $('tree'),
    search: $('search'),
    crumbs: $('crumbs'),
    mtime: $('mtime'),
    copyPath: $('copy-path'),
    page: $('page'),
    toc: $('toc'),
    scroll: $('content-scroll'),
    themeToggle: $('theme-toggle'),
    menuBtn: $('menu-btn'),
    backdrop: $('backdrop'),
    metaTheme: $('meta-theme'),
    sortbar: $('sortbar'),
    sortOpts: $('sort-opts'),
  };

  const state = {
    projects: [],
    current: null, // project name
    file: null, // { path, mtime, absPath }
    pollTimer: null,
    mermaidLoaded: false,
    search: null, // { q, data } — kept so re-sorting doesn't refetch
  };

  /* ---------- helpers ---------- */

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, params) {
    const url = new URL(path, location.origin);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function humanTime(ms) {
    const diff = Date.now() - ms;
    const min = Math.round(diff / 60000);
    if (min < 2) return 'agora';
    if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `há ${h} h`;
    const d = new Date(ms);
    const days = Math.floor((startOfDay(Date.now()) - startOfDay(ms)) / 86400000);
    if (days === 1) return 'ontem';
    if (days < 7) return d.toLocaleDateString('pt-BR', { weekday: 'long' });
    return d.toLocaleDateString('pt-BR');
  }

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dayLabel(ms) {
    const days = Math.floor((startOfDay(Date.now()) - startOfDay(ms)) / 86400000);
    if (days === 0) return 'Hoje';
    if (days === 1) return 'Ontem';
    const d = new Date(ms);
    const wd = d.toLocaleDateString('pt-BR', { weekday: 'long' });
    return `${wd[0].toUpperCase()}${wd.slice(1)} — ${d.toLocaleDateString('pt-BR')}`;
  }

  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // Join a relative href against the directory of the current file.
  function resolveRel(baseDir, href) {
    const parts = (baseDir ? baseDir.split('/') : []).concat(href.split('/'));
    const out = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    return out.join('/');
  }

  const isExternal = (href) => /^([a-z]+:)?\/\//i.test(href) || /^(mailto:|tel:|#)/i.test(href);

  /* ---------- markdown setup ---------- */

  const wikilinkExt = {
    name: 'wikilink',
    level: 'inline',
    start(src) {
      const i = src.indexOf('[[');
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = /^\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/.exec(src);
      if (m) {
        return { type: 'wikilink', raw: m[0], target: m[1].trim(), label: (m[2] || m[1]).trim() };
      }
    },
    renderer(tok) {
      return `<a class="wikilink" href="#" data-wikilink="${esc(tok.target)}">${esc(tok.label)}</a>`;
    },
  };

  marked.use({ gfm: true, extensions: [wikilinkExt] });

  function renderMarkdown(text, project, fileDir) {
    const renderer = {
      link(href, title, body) {
        if (href && !isExternal(href)) {
          const resolved = resolveRel(fileDir, decodeURI(href));
          if (/\.(md|markdown)$/i.test(resolved)) {
            return `<a href="#/p/${encodeURIComponent(project)}/${resolved.split('/').map(encodeURIComponent).join('/')}"${title ? ` title="${esc(title)}"` : ''}>${body}</a>`;
          }
          const raw = `/api/raw?project=${encodeURIComponent(project)}&path=${encodeURIComponent(resolved)}`;
          return `<a href="${raw}" target="_blank"${title ? ` title="${esc(title)}"` : ''}>${body}</a>`;
        }
        return false; // default
      },
      image(href, title, alt) {
        if (href && !isExternal(href)) {
          const resolved = resolveRel(fileDir, decodeURI(href));
          const raw = `/api/raw?project=${encodeURIComponent(project)}&path=${encodeURIComponent(resolved)}`;
          return `<img src="${raw}" alt="${esc(alt || '')}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">`;
        }
        return false;
      },
    };
    marked.use({ renderer });
    return marked.parse(text);
  }

  /* ---------- mdt transclusion ---------- */

  // The server hands back markdown with the borrowed text already spliced in,
  // fenced by invisible sentinel comments. marked emits those as top-level
  // comment nodes with the borrowed blocks fully parsed between them, so the
  // pass below only has to walk the top level and wrap each pair.
  const MDT_OPEN = /^mdt:(embed|frozen)\s(.*)$/s;

  function mdtAttrs(s) {
    const out = {};
    const re = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(s))) {
      out[m[1]] = m[2]
        .replace(/&quot;/g, '"').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    return out;
  }

  // Marks borrowed text as borrowed, and points at where it actually lives.
  function markTransclusions(container, project) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT);
    const opens = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (MDT_OPEN.test(n.nodeValue.trim())) opens.push(n);
    }
    for (const open of opens) {
      const m = MDT_OPEN.exec(open.nodeValue.trim());
      if (!m) continue;
      const kind = m[1];
      const a = mdtAttrs(m[2]);
      const closer = `/mdt:${kind}`;

      // Collect siblings through to the matching closer. A frozen *value* is
      // inline, so its sentinels sit inside a <p> — the walk is the same either
      // way because both ends are siblings of each other.
      const between = [];
      let end = null;
      for (let n = open.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === Node.COMMENT_NODE && n.nodeValue.trim() === closer) { end = n; break; }
        between.push(n);
      }
      if (!end) continue;

      const src = a.src || a.name || '';
      const label = a.label || (a.sel ? `${src} · ${a.sel}` : src);
      const inline = between.every((n) => n.nodeType === Node.TEXT_NODE ||
        (n.nodeType === Node.ELEMENT_NODE && !/^(P|UL|OL|TABLE|PRE|BLOCKQUOTE|H[1-6]|DIV|HR)$/.test(n.tagName)));

      if (inline) {
        const span = document.createElement('span');
        span.className = kind === 'frozen' ? 'mdt-val mdt-frozen' : 'mdt-val';
        span.dataset.name = a.name || src;
        if (a.at) span.title = `frozen ${a.at} from ${a.ref || src}`;
        between.forEach((n) => span.appendChild(n));
        open.replaceWith(span);
        end.remove();
        continue;
      }

      const fig = document.createElement('figure');
      fig.className = kind === 'frozen' ? 'mdt-embed mdt-frozen' : 'mdt-embed';
      between.forEach((n) => fig.appendChild(n));

      const cap = document.createElement('figcaption');
      if (kind === 'frozen') {
        cap.textContent = `congelado ${a.at || ''} — ${label}`.trim();
      } else if (project && src) {
        const link = document.createElement('a');
        link.href = `#/p/${encodeURIComponent(project)}/${src.split('/').map(encodeURIComponent).join('/')}`;
        link.textContent = label;
        cap.appendChild(link);
      } else {
        cap.textContent = label;
      }
      fig.appendChild(cap);
      open.replaceWith(fig);
      end.remove();
    }
  }

  // Split YAML frontmatter from content; render it as a small card.
  function splitFrontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!m) return { fm: null, body: text };
    return { fm: m[1], body: text.slice(m[0].length) };
  }

  function frontmatterHTML(fm) {
    const rows = fm
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        const i = l.indexOf(':');
        if (i > 0 && !l.startsWith(' ') && !l.startsWith('-')) {
          return `<div class="fm-row"><span class="fm-key">${esc(l.slice(0, i))}</span><span>${esc(l.slice(i + 1).trim())}</span></div>`;
        }
        return `<div class="fm-row"><span></span><span>${esc(l)}</span></div>`;
      })
      .join('');
    return `<div class="frontmatter">${rows}</div>`;
  }

  /* ---------- sort controls ---------- */

  // Every mode renders its own direction into its label, so the button always
  // says what clicking it will do. 'relevance' is the server's ranking and has
  // no direction to flip.
  const SORT_MODES = {
    relevance: {
      fixed: true,
      label: () => 'relev&acirc;ncia',
      title: () => 'mais relevante primeiro',
    },
    date: {
      label: (dir) => `${dir === 'asc' ? '&uarr;' : '&darr;'} data`,
      title: (dir) => (dir === 'asc' ? 'mais antigo primeiro' : 'mais recente primeiro'),
    },
    alpha: {
      label: (dir) => (dir === 'asc' ? 'a&ndash;z' : 'z&ndash;a'),
      title: (dir) => (dir === 'asc' ? 'ordem alfab&eacute;tica' : 'ordem alfab&eacute;tica invertida'),
    },
  };

  // A sort control = a mode plus a direction *per* mode, persisted as one blob.
  // Clicking an inactive option selects it with its own remembered direction;
  // clicking the active one flips that direction. Same interaction in the
  // sidebar and in the search results.
  function makeSort(key, modes, fallback) {
    const cfg = { mode: fallback.mode, dir: { ...fallback.dir } };
    try {
      const raw = localStorage.getItem(key);
      // Pre-JSON values were the bare mode string ('date' | 'alpha').
      const saved = raw && raw[0] === '{' ? JSON.parse(raw) : { mode: raw };
      if (modes.includes(saved.mode)) cfg.mode = saved.mode;
      for (const m of modes) {
        const d = saved.dir?.[m];
        if (d === 'asc' || d === 'desc') cfg.dir[m] = d;
      }
    } catch { /* corrupt value — keep the defaults */ }

    return {
      get mode() { return cfg.mode; },
      // Comparators multiply by this instead of branching on the direction.
      get sign() { return cfg.dir[cfg.mode] === 'desc' ? -1 : 1; },
      // false when the click changes nothing (re-click on a fixed mode).
      pick(mode) {
        if (!modes.includes(mode)) return false;
        if (mode !== cfg.mode) cfg.mode = mode;
        else if (SORT_MODES[mode].fixed) return false;
        else cfg.dir[mode] = cfg.dir[mode] === 'asc' ? 'desc' : 'asc';
        localStorage.setItem(key, JSON.stringify(cfg));
        return true;
      },
      buttonsHTML() {
        return modes
          .map((m) => {
            const spec = SORT_MODES[m];
            const dir = cfg.dir[m];
            return `<button class="sort-opt${m === cfg.mode ? ' active' : ''}" data-sort="${m}" title="${spec.title(dir)}" aria-pressed="${m === cfg.mode}">${spec.label(dir)}</button>`;
          })
          .join('');
      },
    };
  }

  const treeSort = makeSort('notas-sort', ['date', 'alpha'], {
    mode: 'date',
    dir: { date: 'asc', alpha: 'asc' },
  });

  const searchSort = makeSort('notas-search-sort', ['relevance', 'date', 'alpha'], {
    mode: 'relevance',
    dir: { date: 'desc', alpha: 'asc' },
  });

  /* ---------- views ---------- */

  // File name leads so it survives truncation in a narrow tab.
  function setTitle(text) {
    document.title = text ? `${text} — Notas` : 'Notas';
  }

  function setCrumbs(parts, leaf) {
    els.crumbs.innerHTML =
      parts.map((p) => `<span>${esc(p)}</span>`).join('<span class="sep">›</span>') +
      (leaf ? `<span class="sep">›</span><span class="leaf">${esc(leaf)}</span>` : '');
  }

  function highlightCode(container) {
    container.querySelectorAll('pre code').forEach((block) => {
      if (block.classList.contains('language-mermaid')) return;
      try { hljs.highlightElement(block); } catch { /* ignore unknown langs */ }
    });
  }

  async function renderMermaid(container) {
    const blocks = container.querySelectorAll('pre code.language-mermaid');
    if (blocks.length === 0) return;
    if (!state.mermaidLoaded) {
      await new Promise((ok, err) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
        s.onload = ok;
        s.onerror = err;
        document.head.appendChild(s);
      }).catch(() => null);
      if (!window.mermaid) return; // offline — leave the code block as-is
      state.mermaidLoaded = true;
    }
    const dark = document.documentElement.dataset.theme === 'dark';
    window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral' });
    blocks.forEach((code) => {
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = code.textContent;
      code.closest('pre').replaceWith(div);
    });
    await window.mermaid.run({ querySelector: '.mermaid' }).catch(() => null);
  }

  function buildToc() {
    const headings = els.page.querySelectorAll('h2, h3');
    if (headings.length < 2) {
      els.toc.hidden = true;
      return;
    }
    let html = '<div class="toc-title">conteúdo</div>';
    headings.forEach((h, i) => {
      h.id = h.id || `h-${i}`;
      html += `<a class="lvl-${h.tagName === 'H3' ? 3 : 2}" href="#${h.id}" data-target="${h.id}">${esc(h.textContent)}</a>`;
    });
    els.toc.innerHTML = html;
    els.toc.hidden = false;

    // scroll-spy
    const links = els.toc.querySelectorAll('a');
    const spy = () => {
      let current = null;
      headings.forEach((h) => {
        if (h.getBoundingClientRect().top < 120) current = h.id;
      });
      links.forEach((a) => a.classList.toggle('current', a.dataset.target === current));
    };
    els.scroll.onscroll = spy;
    spy();

    els.toc.onclick = (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      document.getElementById(a.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  // Autoreload: poll mtime; re-render on change, keep scroll position.
  function startPolling(project, relPath) {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      try {
        const { mtime } = await api('/api/stat', { project, path: relPath });
        if (state.file && mtime > state.file.mtime) {
          const keep = els.scroll.scrollTop;
          await openFile(project, relPath, { silent: true });
          els.scroll.scrollTop = keep;
          toast('arquivo recarregado');
        }
      } catch { /* file may be temporarily gone mid-save */ }
    }, 2000);
  }

  async function openFile(project, relPath, opts = {}) {
    const data = await api('/api/file', { project, path: relPath });
    // content rides along so the annotation layer can parse the source it is
    // looking at without a second round-trip.
    state.file = { path: relPath, mtime: data.mtime, absPath: data.absPath, content: data.content };
    state.search = null;

    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const { fm, body } = splitFrontmatter(data.content);
    els.page.innerHTML =
      (fm ? frontmatterHTML(fm) : '') + `<div class="md">${renderMarkdown(body, project, dir)}</div>`;

    markTransclusions(els.page.querySelector('.md') || els.page, project);
    highlightCode(els.page);
    renderMermaid(els.page);
    buildToc();
    // Every path that shows a file lands here — first open, the 2 s autoreload,
    // the theme-toggle re-route — so one call covers all of them.
    window.NotasAnnUI?.onFileRendered();

    setCrumbs([project, ...relPath.split('/').slice(0, -1)], relPath.split('/').pop());
    setTitle(relPath.split('/').pop());
    els.mtime.textContent = `alterado ${humanTime(data.mtime)}`;
    els.copyPath.hidden = false;

    if (project === '~') await ensureVisible(relPath, project);
    markActiveInTree(relPath);
    if (!opts.silent) {
      els.scroll.scrollTop = 0;
      els.page.style.animation = 'none';
      void els.page.offsetWidth; // restart entry animation
      els.page.style.animation = '';
    }
    startPolling(project, relPath);
  }

  async function showRecentes() {
    stopPolling();
    state.file = null;
    state.search = null;
    window.NotasAnnUI?.clear(); // the rail lives outside #page, so innerHTML won't clear it
    els.copyPath.hidden = true;
    els.mtime.textContent = '';
    setCrumbs(['recentes'], null);
    setTitle('Recentes');

    const items = await api('/api/recent', { days: 7 });
    let html = `<h1 class="view-title">Recentes</h1>
      <div class="view-sub">arquivos alterados nos últimos 7 dias — todos os projetos</div>`;

    if (items.length === 0) {
      html += '<div class="empty">nada mudou esta semana</div>';
    } else {
      let lastDay = null;
      items.forEach((it, i) => {
        const label = dayLabel(it.mtime);
        if (label !== lastDay) {
          html += `<div class="day-label">${esc(label)}</div>`;
          lastDay = label;
        }
        const href = `#/p/${encodeURIComponent(it.project)}/${it.path.split('/').map(encodeURIComponent).join('/')}`;
        html += `<a class="recent-row" style="--i:${i}" href="${href}">
          <div class="recent-name">${esc(it.path.split('/').pop())}</div>
          <div class="recent-meta"><span class="badge">${esc(it.project)}</span><span>${esc(it.path)}</span><span>${esc(humanTime(it.mtime))}</span></div>
        </a>`;
      });
    }
    els.page.innerHTML = html;
    els.toc.hidden = true;
  }

  let searchToken = 0;
  async function showSearch(q) {
    if (!state.current) return;
    // Guard against out-of-order responses: when typing fast, an earlier
    // (slower) request must not overwrite the results of a later one.
    const token = ++searchToken;
    stopPolling();
    state.file = null;
    state.search = null;
    window.NotasAnnUI?.clear();
    els.copyPath.hidden = true;
    els.mtime.textContent = '';
    setCrumbs([state.current, 'busca'], q);
    setTitle(`busca: ${q}`);

    els.page.innerHTML = '<div class="empty">buscando…</div>';
    els.toc.hidden = true;
    let data;
    try {
      data = await api('/api/search', { project: state.current, q });
    } catch (e) {
      if (token !== searchToken) return;
      els.page.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    if (token !== searchToken) return; // superseded by a newer query

    state.search = { q, project: state.current, data };
    renderSearchResults();
  }

  // Server order is the relevance ranking; the other modes reorder client-side.
  function sortedResults(files) {
    const sign = searchSort.sign;
    const byPath = (a, b) => a.path.localeCompare(b.path, 'pt', { numeric: true });
    if (searchSort.mode === 'alpha') return [...files].sort((a, b) => sign * byPath(a, b));
    if (searchSort.mode === 'date') {
      return [...files].sort((a, b) => sign * ((a.mtime || 0) - (b.mtime || 0)) || byPath(a, b));
    }
    return files;
  }

  // Re-renders from state.search — sorting never refetches.
  function renderSearchResults() {
    const { q, project, data } = state.search;
    const sortbar = data.files.length
      ? `<div class="sortbar results-sort" role="group" aria-label="Ordenar resultados">
          <span class="sort-label">ordenar</span>
          <span class="sort-opts">${searchSort.buttonsHTML()}</span>
        </div>`
      : '';

    let html = `<h1 class="view-title">“${esc(q)}”</h1>
      <div class="view-sub${sortbar ? ' tight' : ''}">${data.total} ocorrência${data.total === 1 ? '' : 's'} em ${data.files.length} arquivo${data.files.length === 1 ? '' : 's'} — projeto ${esc(project)}${data.truncated ? ' (parcial)' : ''}</div>${sortbar}`;

    if (data.files.length === 0) html += '<div class="empty">nada encontrado</div>';

    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    for (const f of sortedResults(data.files)) {
      const href = `#/p/${encodeURIComponent(project)}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
      const name = f.nameMatch ? esc(f.path).replace(rx, (s) => `<mark>${s}</mark>`) : esc(f.path);
      const badge = f.nameMatch ? '<span class="badge">nome</span>' : '';
      const when = f.mtime ? `<span class="result-time">${esc(humanTime(f.mtime))}</span>` : '';
      html += `<a class="result-file" href="${href}"><div class="recent-name">${name}</div>${badge}${when}</a>`;
      for (const m of f.matches) {
        html += `<a class="result-line" href="${href}"><span class="ln">${m.line}</span>${esc(m.text).replace(rx, (s) => `<mark>${s}</mark>`)}</a>`;
      }
    }
    els.page.innerHTML = html;
  }

  /* ---------- sidebar ---------- */

  function renderProjects() {
    const pills = state.projects.map(
      (p) =>
        `<button class="project-pill${p.name === state.current ? ' active' : ''}" data-project="${esc(p.name)}">${esc(p.name)}</button>`
    );
    // "~" — browse the whole home dir (lazy)
    pills.push(
      `<button class="project-pill${state.current === '~' ? ' active' : ''}" data-project="~" title="navegar no sistema (home)">~</button>`
    );
    els.projects.innerHTML = pills.join('');
  }

  // data-* on each <li> lets sortTree() reorder levels in place (preserving
  // expanded folders and lazily-loaded children) without a refetch.
  const liData = (n) => `data-type="${n.type}" data-name="${esc(n.name)}" data-mtime="${n.mtime || 0}"`;

  function treeHTML(nodes, project) {
    let html = '<ul>';
    for (const n of nodes) {
      if (n.type === 'dir') {
        html += `<li ${liData(n)}><details data-dir="${esc(n.path)}"><summary>${esc(n.name)}</summary>${treeHTML(n.children, project)}</details></li>`;
      } else {
        const href = `#/p/${encodeURIComponent(project)}/${n.path.split('/').map(encodeURIComponent).join('/')}`;
        html += `<li ${liData(n)}><a class="file" data-path="${esc(n.path)}" href="${href}">${esc(n.name)}</a></li>`;
      }
    }
    return html + '</ul>';
  }

  /* lazy browser for "~": one directory level at a time */

  function lazyLevelHTML(nodes, project) {
    let html = '<ul>';
    for (const n of nodes) {
      if (n.type === 'dir') {
        html += `<li ${liData(n)}><details data-dir="${esc(n.path)}" data-loaded="0"><summary>${esc(n.name)}</summary></details></li>`;
      } else {
        const href = `#/p/${encodeURIComponent(project)}/${n.path.split('/').map(encodeURIComponent).join('/')}`;
        html += `<li ${liData(n)}><a class="file" data-path="${esc(n.path)}" href="${href}">${esc(n.name)}</a></li>`;
      }
    }
    return html + '</ul>';
  }

  /* ---------- sidebar sort ---------- */

  const byNameLocale = (a, b) =>
    a.dataset.name.localeCompare(b.dataset.name, 'pt', { numeric: true });

  // Dirs before files regardless of direction; within a group by mtime or name.
  function compareNodes(a, b) {
    const aDir = a.dataset.type === 'dir';
    if (aDir !== (b.dataset.type === 'dir')) return aDir ? -1 : 1;
    const sign = treeSort.sign;
    if (treeSort.mode === 'date') {
      const d = (Number(a.dataset.mtime) || 0) - (Number(b.dataset.mtime) || 0);
      if (d) return sign * d;
    }
    return sign * byNameLocale(a, b);
  }

  // Reorder every level in place. Only <li> carrying data-type move; loading/
  // empty placeholders stay put. Preserves open folders and lazy children.
  function sortTree() {
    els.tree.querySelectorAll('ul').forEach((ul) => {
      const lis = [...ul.children].filter((li) => li.dataset && li.dataset.type);
      lis.sort(compareNodes).forEach((li) => ul.appendChild(li));
    });
  }

  function renderSortbar() {
    els.sortOpts.innerHTML = treeSort.buttonsHTML();
  }

  async function loadDirChildren(detailsEl, project) {
    if (detailsEl.dataset.loaded === '1') return;
    detailsEl.dataset.loaded = '1';
    const nodes = await api('/api/ls', { project, path: detailsEl.dataset.dir });
    detailsEl.insertAdjacentHTML(
      'beforeend',
      nodes.length ? lazyLevelHTML(nodes, project) : '<ul><li style="padding:2px 8px;color:var(--term-dim)">vazio</li></ul>'
    );
    sortTree();
  }

  // Deep link into "~": load + open each ancestor dir so the file is visible.
  async function ensureVisible(relPath, project) {
    const segs = relPath.split('/');
    let prefix = '';
    for (let i = 0; i < segs.length - 1; i++) {
      prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];
      const d = els.tree.querySelector(`details[data-dir="${CSS.escape(prefix)}"]`);
      if (!d) return;
      await loadDirChildren(d, project);
      d.open = true;
    }
  }

  async function loadTree(project) {
    if (project === '~') {
      const nodes = await api('/api/ls', { project, path: '' });
      els.tree.innerHTML = lazyLevelHTML(nodes, project);
    } else {
      const tree = await api('/api/tree', { project });
      els.tree.innerHTML = treeHTML(tree, project);
    }
    sortTree();
  }

  function markActiveInTree(relPath) {
    els.tree.querySelectorAll('a.file').forEach((a) => {
      const active = a.dataset.path === relPath;
      a.classList.toggle('active', active);
      if (active) {
        // open ancestor folders
        let el = a.parentElement;
        while (el && el !== els.tree) {
          if (el.tagName === 'DETAILS') el.open = true;
          el = el.parentElement;
        }
        a.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  async function selectProject(name, { keepView = false } = {}) {
    if (state.current === name) return;
    state.current = name;
    localStorage.setItem('notas-project', name);
    renderProjects();
    els.tree.innerHTML = '<ul><li style="padding:6px 10px;color:var(--term-dim)">carregando…</li></ul>';
    await loadTree(name);
    if (state.file) markActiveInTree(state.file.path);
    if (!keepView && !state.file) location.hash = '#/recentes';
  }

  /* ---------- router ---------- */

  async function route() {
    closeSidebar();
    const hash = decodeURI(location.hash || '#/recentes');
    if (hash.startsWith('#/p/')) {
      const rest = location.hash.slice(4);
      const segs = rest.split('/').map(decodeURIComponent);
      const project = segs.shift();
      const relPath = segs.join('/');
      if (!getProjectByName(project)) return showRecentes();
      if (state.current !== project) {
        state.current = project;
        localStorage.setItem('notas-project', project);
        renderProjects();
        await loadTree(project);
      }
      try {
        await openFile(project, relPath);
      } catch (e) {
        els.page.innerHTML = `<div class="empty">não consegui abrir: ${esc(relPath)} — ${esc(e.message)}</div>`;
      }
    } else {
      await showRecentes();
    }
  }

  const getProjectByName = (n) =>
    n === '~' ? { name: '~' } : state.projects.find((p) => p.name === n);

  /* ---------- events ---------- */

  els.projects.addEventListener('click', (e) => {
    const btn = e.target.closest('.project-pill');
    if (btn) selectProject(btn.dataset.project);
  });

  els.sortbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.sort-opt');
    if (!btn || !treeSort.pick(btn.dataset.sort)) return;
    renderSortbar();
    sortTree();
  });

  // Search-results sortbar lives inside .page, re-rendered on every change.
  els.page.addEventListener('click', (e) => {
    const btn = e.target.closest('.results-sort .sort-opt');
    if (!btn || !state.search) return;
    if (searchSort.pick(btn.dataset.sort)) renderSearchResults();
  });

  /* sidebar — off-canvas drawer on phones, collapsible column on desktop */

  const root = document.documentElement;
  const mobileMQ = matchMedia('(max-width: 900px)');

  function syncMenuBtn() {
    const shown = mobileMQ.matches
      ? root.classList.contains('sidebar-open')
      : !root.classList.contains('sidebar-collapsed');
    els.menuBtn.setAttribute('aria-expanded', String(shown));
    els.menuBtn.title = shown ? 'ocultar painel  ( ctrl+b )' : 'mostrar painel  ( ctrl+b )';
  }

  const closeSidebar = () => {
    root.classList.remove('sidebar-open');
    syncMenuBtn();
  };

  // Only the desktop collapse is remembered — the phone drawer is always transient.
  const setCollapsed = (collapsed) => {
    root.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('notas-sidebar', collapsed ? 'collapsed' : 'open');
    syncMenuBtn();
  };

  function showSidebar() {
    if (mobileMQ.matches) {
      root.classList.add('sidebar-open');
      syncMenuBtn();
    } else {
      setCollapsed(false);
    }
  }

  function toggleSidebar() {
    if (!mobileMQ.matches) {
      setCollapsed(!root.classList.contains('sidebar-collapsed'));
    } else if (root.classList.contains('sidebar-open')) {
      closeSidebar();
    } else {
      showSidebar();
    }
  }

  syncMenuBtn();
  els.menuBtn.addEventListener('click', toggleSidebar);
  els.backdrop.addEventListener('click', closeSidebar);

  // Tapping a file closes the drawer even when the hash doesn't change
  // (re-opening the current file fires no hashchange).
  els.tree.addEventListener('click', (e) => {
    if (e.target.closest('a.file')) closeSidebar();
  });
  document.getElementById('recentes-link').addEventListener('click', closeSidebar);
  document.querySelector('.wordmark').addEventListener('click', closeSidebar);

  // Leaving the mobile breakpoint with the drawer open would strand the backdrop.
  // Either way ☰ swaps meaning across the breakpoint, so relabel it.
  mobileMQ.addEventListener('change', (e) => {
    if (!e.matches) root.classList.remove('sidebar-open');
    syncMenuBtn();
  });

  // Lazy-load "~" directories when expanded ('toggle' doesn't bubble — use capture).
  els.tree.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (state.current === '~' && d.tagName === 'DETAILS' && d.open && d.dataset.loaded === '0') {
        loadDirChildren(d, '~').catch(() => toast('erro ao listar pasta'));
      }
    },
    true
  );

  // Live search: fire as the user types, debounced so we don't hit the server
  // on every keystroke (searchProject reads every file in the project).
  let searchDebounce;
  els.search.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = els.search.value.trim();
    // Stay silent for too-short queries and the "~" browse pseudo-project
    // (Enter still shows an explanatory toast for the latter).
    if (q.length < 2 || state.current === '~') return;
    searchDebounce = setTimeout(() => showSearch(q), 200);
  });

  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && els.search.value.trim().length >= 2) {
      clearTimeout(searchDebounce);
      if (state.current === '~') {
        toast('busca disponível só em projetos');
        return;
      }
      closeSidebar(); // results render behind the drawer otherwise
      showSearch(els.search.value.trim());
    }
    if (e.key === 'Escape') {
      clearTimeout(searchDebounce);
      els.search.value = '';
      els.search.blur();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== els.search) {
      e.preventDefault();
      // The box lives in the sidebar — no point focusing it while that's away.
      showSidebar();
      requestAnimationFrame(() => els.search.focus());
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleSidebar();
    }
    if (e.key === 'Escape') closeSidebar();
  });

  els.copyPath.addEventListener('click', async () => {
    if (state.file?.absPath) {
      await navigator.clipboard.writeText(state.file.absPath);
      toast('caminho copiado');
    }
  });

  els.themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('notas-theme', next);
    if (els.metaTheme) els.metaTheme.content = next === 'dark' ? '#0d0d0e' : '#f6f8fa';
    // re-render mermaid diagrams with the matching theme
    if (state.file && document.querySelector('.mermaid')) route();
  });

  // wikilink clicks: resolve name -> path within current project
  els.page.addEventListener('click', async (e) => {
    const a = e.target.closest('a[data-wikilink]');
    if (!a) return;
    e.preventDefault();
    const name = a.dataset.wikilink;
    try {
      const { path } = await api('/api/resolve', { project: state.current, name });
      if (path) {
        location.hash = `#/p/${encodeURIComponent(state.current)}/${path.split('/').map(encodeURIComponent).join('/')}`;
      } else {
        toast(`sem arquivo para [[${name}]]`);
      }
    } catch {
      toast('erro ao resolver link');
    }
  });

  window.addEventListener('hashchange', route);

  // Offline, the SW may have served a cached (stale) recentes list; unlike an
  // open file it has no /api/stat poll to self-heal, so refresh it on reconnect.
  window.addEventListener('online', () => {
    if (!state.file) route();
  });

  /* ---------- boot ---------- */

  // The seam the annotation layer (annotate.js, loaded after this file) hangs
  // off. Kept to what it actually needs — this is a bridge, not an API.
  window.NotasApp = { state, els, toast, api, apiPost, openFile };

  // PWA: offline cache. Needs a secure context — active on the tailscale
  // https URL; skipped on plain http://notas/ (desktop doesn't need it).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  (async function boot() {
    renderSortbar();
    state.projects = await api('/api/projects');
    const saved = localStorage.getItem('notas-project');
    state.current =
      (saved && (saved === '~' || state.projects.some((p) => p.name === saved)) && saved) ||
      state.projects[0]?.name ||
      null;
    renderProjects();
    if (state.current) await loadTree(state.current);
    await route();
  })();
})();
