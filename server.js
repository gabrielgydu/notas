#!/usr/bin/env node
// Notas — tiny local markdown reading server. No dependencies.
// Projects are defined in projects.json next to this file.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// mdt — markdown transclusion (~/development/mdt). Optional on purpose: Notas
// must still boot if it is missing or broken, serving files literally.
let mdt = null;
let mdtIO = null;
try {
  mdt = require(path.join(os.homedir(), 'development', 'mdt', 'resolve.js'));
  ({ createNodeIO: mdtIO } = require(path.join(os.homedir(), 'development', 'mdt', 'io.js')));
} catch (e) {
  console.warn('[notas] mdt not loaded — files serve literally:', e.message);
}

// The annotation grammar lives in public/ because the browser needs the very
// same parser — see the header of that file.
const ann = require('./public/annotations.js');

const ROOT = __dirname;
// Port 80 lets "http://notas/" work without a port (needs the unprivileged-port
// sysctl, see README); 7777 stays for old bookmarks. Failures to bind are non-fatal.
const PORTS = (process.env.NOTAS_PORTS || process.env.NOTAS_PORT || '80,7777')
  .split(',')
  .map((p) => Number(p.trim()))
  .filter(Boolean);
const HOST = process.env.NOTAS_HOST || '127.0.0.1';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.obsidian', '.sync', '.claude']);
const MD_EXTS = new Set(['.md', '.markdown']);
// PDFs are listed and served, never parsed: Notas hands them to the browser's
// own viewer in a new tab. They match by *filename only* — reading text out of
// 3 GB of scans on every keystroke of a live search is not a trade worth making.
const PDF_EXTS = new Set(['.pdf']);

// The single answer to "does Notas show this file, and as what?".
function fileKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (MD_EXTS.has(ext)) return 'md';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
};

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function loadProjects() {
  // projects.json is personal config and is not tracked; a fresh clone falls
  // back to the committed example so the server still boots.
  let file = path.join(ROOT, 'projects.json');
  if (!fs.existsSync(file)) {
    const example = path.join(ROOT, 'projects.example.json');
    if (!fs.existsSync(example)) {
      console.warn('[notas] no projects.json — copy projects.example.json and edit it');
      return [];
    }
    console.warn('[notas] no projects.json — using projects.example.json');
    file = example;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const projects = [];
  for (const [name, dir] of Object.entries(raw)) {
    const abs = path.resolve(expandHome(dir));
    if (!fs.existsSync(abs)) {
      console.warn(`[notas] project "${name}" skipped — missing dir: ${abs}`);
      continue;
    }
    projects.push({ name, root: abs });
  }
  return projects;
}

let PROJECTS = loadProjects();
// Reload projects.json on change so edits apply without restart.
fs.watchFile(path.join(ROOT, 'projects.json'), { interval: 2000 }, () => {
  try {
    PROJECTS = loadProjects();
    console.log('[notas] projects.json reloaded');
  } catch (e) {
    console.warn('[notas] projects.json reload failed:', e.message);
  }
});

// "~" is a built-in pseudo-project: browse the whole home dir (lazy listing,
// excluded from recents/search since walking all of $HOME would be huge).
const BROWSE = { name: '~', root: os.homedir(), browse: true };

function getProject(name) {
  if (name === BROWSE.name) return BROWSE;
  return PROJECTS.find((p) => p.name === name) || null;
}

// One directory level: dirs first, then readable files. Each node carries its
// own mtime (ms) so the client can offer date sorting; dir mtime reflects when
// its listing last changed (add/remove/rename), not edits to files within.
// `kind` tells the client whether a row routes into the reader or opens a tab.
async function listDir(dir, rel) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const isDir = e.isDirectory();
    const kind = isDir ? null : fileKind(e.name);
    if (!isDir && !(e.isFile() && kind)) continue;
    let mtime = 0;
    try { mtime = (await fsp.stat(path.join(dir, e.name))).mtimeMs; } catch { /* ignore */ }
    (isDir ? dirs : files).push(
      isDir
        ? { type: 'dir', name: e.name, path: childRel, mtime }
        : { type: 'file', kind, name: e.name, path: childRel, mtime }
    );
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true });
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}

// Resolve a relative path inside a project root, refusing escapes.
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

async function buildTree(dir, rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    let mtime = 0;
    try { mtime = (await fsp.stat(abs)).mtimeMs; } catch { /* ignore */ }
    if (e.isDirectory()) {
      const children = await buildTree(abs, childRel);
      if (children.length > 0) dirs.push({ type: 'dir', name: e.name, path: childRel, mtime, children });
    } else if (e.isFile() && fileKind(e.name)) {
      files.push({ type: 'file', kind: fileKind(e.name), name: e.name, path: childRel, mtime });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true });
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}

async function walkFiles(dir, rel, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walkFiles(path.join(dir, e.name), childRel, out);
    } else if (e.isFile()) {
      // Both kinds ride in one walk; every caller filters on `kind` itself,
      // because "recent" and "search" want different things from a PDF.
      const kind = fileKind(e.name);
      if (kind) out.push({ abs: path.join(dir, e.name), rel: childRel, kind });
    }
  }
}

async function recentFiles(days) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  // Projects can nest (e.g. a child folder alongside its parent) — dedupe by absolute
  // path, keeping the entry from the most specific (deepest-rooted) project.
  const byAbs = new Map();
  for (const p of PROJECTS) {
    const files = [];
    await walkFiles(p.root, '', files);
    for (const f of files) {
      let st;
      try {
        st = await fsp.stat(f.abs);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      const prev = byAbs.get(f.abs);
      if (!prev || p.root.length > prev.rootLen) {
        byAbs.set(f.abs, { project: p.name, path: f.rel, kind: f.kind, mtime: st.mtimeMs, rootLen: p.root.length });
      }
    }
  }
  const result = [...byAbs.values()].map(({ rootLen, ...r }) => r);
  result.sort((a, b) => b.mtime - a.mtime);
  return result.slice(0, 150);
}

/* Two independent budgets, because the two kinds cost nothing alike.
 * MATCH_LIMIT counts markdown *occurrences* — the expensive thing, one whole
 * file read each. PDF_LIMIT counts filename hits, which cost a string compare;
 * they need a cap of their own only because a two-letter query matches 240 of
 * the 727 PDFs in ~/Downloads, and nobody reads 240 rows. */
const MATCH_LIMIT = 400;
const PDF_LIMIT = 100;

async function searchProject(project, query) {
  const files = [];
  await walkFiles(project.root, '', files);
  const q = query.toLowerCase();
  const out = [];
  let total = 0;
  let pdfHits = 0;
  let mdCapped = false;
  for (const f of files) {
    const nameMatch = f.rel.toLowerCase().includes(q);
    // A PDF is its filename here and nothing more — no text is ever read out of
    // one, so it can only ever be a name hit and never contributes to `total`.
    if (f.kind === 'pdf') {
      if (nameMatch && pdfHits++ < PDF_LIMIT) {
        out.push({ path: f.rel, kind: 'pdf', nameMatch: true, matches: [], mtime: await statMtime(f.abs) });
      }
      continue;
    }
    // Spending the *content* budget must not stop us finding PDFs: it is the
    // markdown reads that have to stop, not the walk. Breaking out here instead
    // would drop every PDF the walk had not reached yet — hundreds of them in a
    // project whose handful of notes exhausts the counter on their own.
    if (mdCapped) continue;
    let text;
    try {
      text = await fsp.readFile(f.abs, 'utf8');
    } catch {
      // Unreadable file still counts as a hit if its name matches.
      if (nameMatch) out.push({ path: f.rel, kind: 'md', nameMatch: true, matches: [], mtime: await statMtime(f.abs) });
      continue;
    }
    const lines = text.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        total++;
        if (matches.length < 8) matches.push({ line: i + 1, text: lines[i].trim().slice(0, 300) });
        if (total >= MATCH_LIMIT) break;
      }
    }
    // mtime rides along so the client can offer date sorting without a second round-trip.
    if (nameMatch || matches.length > 0) {
      out.push({ path: f.rel, kind: 'md', nameMatch, matches, mtime: await statMtime(f.abs) });
    }
    if (total >= MATCH_LIMIT) mdCapped = true;
  }
  // Filename hits first, then by content-match count — the most relevant on top.
  // Within the name tier notes come before PDFs: this is a markdown reader, and
  // a PDF-heavy folder would otherwise bury every note under its filenames.
  out.sort((a, b) =>
    (b.nameMatch - a.nameMatch) ||
    ((a.kind === 'pdf') - (b.kind === 'pdf')) ||
    (b.matches.length - a.matches.length));
  return { files: out, total, truncated: mdCapped || pdfHits > PDF_LIMIT };
}

async function statMtime(abs) {
  try {
    return (await fsp.stat(abs)).mtimeMs;
  } catch {
    return 0;
  }
}

/* Expanding a file tells us which OTHER files it borrowed from. The autoreload
 * poll needs that set: without it, editing key_figures.md would never re-render
 * the open runsheet, because the poll watches the runsheet's own mtime and the
 * runsheet did not change. Keyed by project+path, refreshed on every /api/file. */
const depCache = new Map();
const depKey = (project, rel) => `${project} ${rel}`;

async function expandContent(abs, rel) {
  if (!mdt) return { content: null, deps: [abs] };
  const io = mdtIO();
  try {
    const res = await mdt.expandFile(abs, io);
    if (res.errors.length) {
      console.warn(`[notas] mdt: ${res.errors.length} unresolved ref(s) in ${rel}`);
    }
    return { content: res.text, deps: res.deps };
  } catch (e) {
    // A bug in the expander must never make a note unreadable.
    console.warn(`[notas] mdt failed on ${rel}:`, e.message);
    return { content: null, deps: [abs] };
  }
}

async function maxMtime(paths) {
  let max = 0;
  for (const p of paths) {
    const m = await statMtime(p);
    if (m > max) max = m;
  }
  return max;
}

async function resolveWikilink(project, name) {
  const files = [];
  await walkFiles(project.root, '', files);
  const want = name.toLowerCase();
  // Markdown before PDF: `[[relatório]]` written inside a note means the note,
  // even when a relatório.pdf sits in the same folder.
  const order = [...files.filter((f) => f.kind === 'md'), ...files.filter((f) => f.kind !== 'md')];
  const base = (f) => path.basename(f.rel, path.extname(f.rel)).toLowerCase();
  for (const f of order) {
    if (base(f) === want) return { path: f.rel, kind: f.kind };
  }
  // Fall back to a loose match (name contained in the basename).
  for (const f of order) {
    if (base(f).includes(want)) return { path: f.rel, kind: f.kind };
  }
  return { path: null, kind: null };
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/* ---------- writes (annotations) ----------
 *
 * A write needs a trusted caller: a direct localhost request, or a tailnet
 * request from a login listed in NOTAS_WRITERS. `tailscale serve` sets
 * X-Forwarded-For on everything it proxies and a direct localhost request never
 * carries one. For a tailnet user it also sets Tailscale-User-Login — after
 * deleting any copy the client sent, so it can't be forged through the proxy —
 * and sets none for tagged nodes or Funnel traffic. With NOTAS_WRITERS unset the
 * tailnet PWA stays a reader. */

const WRITERS = new Set(
  (process.env.NOTAS_WRITERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

const isProxied = (req) => Boolean(req.headers['x-forwarded-for']);
const canWrite = (req) =>
  !isProxied(req) || WRITERS.has(String(req.headers['tailscale-user-login'] || '').toLowerCase());

/* Every write must arrive as application/json. Any web page can POST text/plain
 * to 127.0.0.1 without asking (a CORS "simple request" — the answer is opaque
 * to it, but the write has already happened). A JSON POST from another origin
 * needs a preflight first, which this server never answers, so the browser
 * never sends it. The client's apiPost always sets the header. */
const isJSON = (req) => /^application\/json\b/i.test(req.headers['content-type'] || '');

function readBody(req, res, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        // Stop reading but leave the socket alive long enough to answer —
        // destroying it here would hand the client a reset instead of a 413.
        req.pause();
        res.once('finish', () => req.destroy());
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJSON(req, res, limit) {
  const raw = await readBody(req, res, limit);
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

/* One promise chain per absolute path. Two tabs annotating the same file (or one
 * annotating while another deletes) would otherwise interleave a read and an
 * append. The remaining race — against a vim rename-save landing in the same
 * millisecond — is accepted: single user, local tool. */
const writeChain = new Map();

function withFileLock(abs, fn) {
  const prev = writeChain.get(abs) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  writeChain.set(abs, tail);
  tail.then(() => {
    if (writeChain.get(abs) === tail) writeChain.delete(abs);
  });
  return run;
}

// Server-local date. toISOString() is UTC and would stamp tomorrow's date on
// anything written after 21:00 here.
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Resolve + gate a write target. Same guards as /api/file plus: real projects
// only (no "~"), markdown only, must already exist.
async function resolveWritable(body) {
  const project = getProject(body && body.project);
  if (!project) return { status: 404, error: 'unknown project' };
  if (project.browse) return { status: 403, error: 'anotações indisponíveis em ~' };
  const rel = typeof body.path === 'string' ? body.path : '';
  const abs = safeJoin(project.root, rel);
  if (!abs) return { status: 400, error: 'bad path' };
  if (!MD_EXTS.has(path.extname(abs).toLowerCase())) return { status: 400, error: 'not a markdown file' };
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return { status: 404, error: 'not found' };
  }
  if (!st.isFile()) return { status: 404, error: 'not found' };

  // Write to the real file, never to the link. appendFile follows a symlink but
  // rename(2) does not, so the delete path would drop a regular file on top of
  // the link — destroying it, and forking the note into two diverging copies.
  // (a favorites folder is full of such links.) Resolving here also
  // means a link can never be used to write outside its project.
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch {
    return { status: 404, error: 'not found' };
  }
  const root = await fsp.realpath(project.root).catch(() => project.root);
  if (real !== root && !real.startsWith(root + path.sep)) {
    return { status: 403, error: 'link aponta para fora do projeto' };
  }
  // rel stays the path the client asked for — that is the depCache key.
  return { project, rel, abs: real, st };
}

// The number the client must compare against: same dep-aware contract as
// /api/stat. A plain st.mtimeMs can sit *below* the dep max on a transcluding
// doc, which would make the poll fire a bogus "arquivo recarregado".
async function writeMtime(project, rel, abs) {
  const st = await fsp.stat(abs);
  const cached = depCache.get(depKey(project.name, rel));
  return cached ? Math.max(st.mtimeMs, await maxMtime(cached)) : st.mtimeMs;
}

// null = missing/blank, false = over the cap. Distinguishing them is the
// difference between a silent discard and "why did nothing happen?".
function textField(v, max) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  return s.length <= max ? s : false;
}

async function handleAnnotate(req, res) {
  let body;
  try {
    body = await readJSON(req, res);
  } catch (e) {
    return sendJSON(res, e.status || 400, { error: e.message });
  }
  const t = await resolveWritable(body);
  if (t.error) return sendJSON(res, t.status, { error: t.error });

  const TYPES = ['note', 'claude', 'hl'];
  const type = TYPES.includes(body.type) ? body.type : null;
  const quote = textField(body.quote, 10000);
  const comment = textField(body.comment, 10000);
  if (!type) return sendJSON(res, 400, { error: 'bad type' });
  if (quote === null) return sendJSON(res, 400, { error: 'trecho vazio' });
  if (quote === false) return sendJSON(res, 400, { error: 'trecho longo demais (máx. 10k)' });
  // A highlight is the passage and nothing else; anything sent as a comment
  // alongside one is dropped rather than half-honoured.
  if (type !== 'hl') {
    if (comment === null) return sendJSON(res, 400, { error: 'comentário vazio' });
    if (comment === false) return sendJSON(res, 400, { error: 'comentário longo demais (máx. 10k)' });
  }

  const before = ann.ctxAttr(body.before || '', true);
  const after = ann.ctxAttr(body.after || '', false);
  const color = ann.normColor(body.color);

  return withFileLock(t.abs, async () => {
    // Raw disk bytes, never the mdt-expanded text: the section lives at EOF,
    // outside every embed region, so the two agree there.
    const raw = await fsp.readFile(t.abs, 'utf8');
    const parsed = ann.parse(raw);
    const id = ann.newId(new Set(parsed.entries.map((e) => e.id)));
    const entry = ann.serializeEntry({ type, id, date: localDate(), quote, comment, before, after, color });
    // Append, don't rewrite: this lands on the file that is at the path *now*,
    // so an editor save in between is not lost. Worst case is a duplicate
    // heading, which the parser tolerates.
    await fsp.appendFile(t.abs, ann.composeAppend(raw, entry, parsed.headings.length > 0), 'utf8');
    return sendJSON(res, 200, { id, mtime: await writeMtime(t.project, t.rel, t.abs) });
  });
}

let tmpSeq = 0;

// tmp + rename: the file at the path is always a whole file, never a
// half-written one, whatever else is reading it.
async function writeAtomic(abs, text, mode) {
  const tmp = `${abs}.notas-${process.pid}-${tmpSeq++}.tmp`;
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.chmod(tmp, mode & 0o777);
    await fsp.rename(tmp, abs);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function handleAnnotateDelete(req, res) {
  let body;
  try {
    body = await readJSON(req, res);
  } catch (e) {
    return sendJSON(res, e.status || 400, { error: e.message });
  }
  const t = await resolveWritable(body);
  if (t.error) return sendJSON(res, t.status, { error: t.error });
  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^[a-z0-9]{3,8}$/.test(id)) return sendJSON(res, 400, { error: 'bad id' });

  return withFileLock(t.abs, async () => {
    const raw = await fsp.readFile(t.abs, 'utf8');
    const out = ann.removeEntry(raw, id);
    if (out.error === 'not found') return sendJSON(res, 404, { error: 'unknown annotation' });
    if (out.error === 'unterminated') return sendJSON(res, 409, { error: 'entrada sem terminador — corrija no editor' });

    await writeAtomic(t.abs, out.text, t.st.mode);
    return sendJSON(res, 200, { mtime: await writeMtime(t.project, t.rel, t.abs) });
  });
}

async function handleAnnotateColor(req, res) {
  let body;
  try {
    body = await readJSON(req, res);
  } catch (e) {
    return sendJSON(res, e.status || 400, { error: e.message });
  }
  const t = await resolveWritable(body);
  if (t.error) return sendJSON(res, t.status, { error: t.error });
  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^[a-z0-9]{3,8}$/.test(id)) return sendJSON(res, 400, { error: 'bad id' });
  // Unlike /api/annotate, an unknown colour here is a bug in the caller rather
  // than a missing field — refuse instead of silently painting it yellow.
  if (!ann.COLORS.includes(body.color)) return sendJSON(res, 400, { error: 'bad color' });

  return withFileLock(t.abs, async () => {
    const raw = await fsp.readFile(t.abs, 'utf8');
    const out = ann.setColor(raw, id, body.color);
    if (out.error === 'not found') return sendJSON(res, 404, { error: 'unknown annotation' });
    if (out.error === 'not a highlight') return sendJSON(res, 400, { error: 'só marcações têm cor' });

    await writeAtomic(t.abs, out.text, t.st.mode);
    return sendJSON(res, 200, { mtime: await writeMtime(t.project, t.rel, t.abs) });
  });
}

/* ---------- create ----------
 *
 * Writes a new markdown file and never touches one that already exists. For
 * clients that derive the path from the content (the hablarcondios extension):
 * saving the same page twice is a no-op that answers with where the first copy
 * is, so annotations already written into it survive.
 *
 * "Already exists" is decided by link(2), not by a stat that could race: the
 * text goes to a tmp file first and is linked into place, which fails with
 * EEXIST atomically — and a reader never sees a half-written file either.
 *
 * Like every write it only accepts application/json (see isJSON), which a
 * browser extension with host permission can send without a preflight. */

async function handleCreate(req, res) {
  let body;
  try {
    body = await readJSON(req, res);
  } catch (e) {
    return sendJSON(res, e.status || 400, { error: e.message });
  }
  const project = getProject(body && body.project);
  if (!project) return sendJSON(res, 404, { error: 'unknown project' });
  if (project.browse) return sendJSON(res, 403, { error: 'criação indisponível em ~' });
  const abs = safeJoin(project.root, typeof body.path === 'string' ? body.path : '');
  if (!abs || abs === project.root) return sendJSON(res, 400, { error: 'bad path' });
  if (!MD_EXTS.has(path.extname(abs).toLowerCase())) return sendJSON(res, 400, { error: 'not a markdown file' });
  const rel = path.relative(project.root, abs).split(path.sep).join('/');
  // Written but never listed is worse than refused.
  if (rel.split('/').some((seg) => seg.startsWith('.') || IGNORED_DIRS.has(seg))) {
    return sendJSON(res, 400, { error: 'caminho oculto' });
  }
  const content = textField(body.content, 1024 * 1024);
  if (!content) return sendJSON(res, 400, { error: 'conteúdo vazio' });

  // The folder must exist already, and really be inside the project — the
  // same symlink rule as resolveWritable.
  let dir;
  try {
    dir = await fsp.realpath(path.dirname(abs));
  } catch {
    return sendJSON(res, 404, { error: 'pasta não existe' });
  }
  const root = await fsp.realpath(project.root).catch(() => project.root);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    return sendJSON(res, 403, { error: 'link aponta para fora do projeto' });
  }
  const target = path.join(dir, path.basename(abs));

  return withFileLock(target, async () => {
    const tmp = `${target}.notas-${process.pid}-${tmpSeq++}.tmp`;
    try {
      await fsp.writeFile(tmp, content + '\n', { encoding: 'utf8', flag: 'wx' });
      await fsp.link(tmp, target);
    } catch (e) {
      if (e.code === 'EEXIST') return sendJSON(res, 200, { created: false, path: rel });
      throw e;
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
    return sendJSON(res, 201, { created: true, path: rel });
  });
}

/* ---------- dictation token ----------
 *
 * The AssemblyAI API key never leaves this process; the browser gets a token
 * that expires in 60 seconds. */

async function dictationConfig() {
  const file = path.join(os.homedir(), '.config', 'audiorecorder', 'config');
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split('\n')) {
    const s = line.trim();
    // A commented-out older key sits above the live one — skipping `#` lines is
    // the difference between a working mic and a 401.
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim(); // last assignment wins
  }
  return out;
}

async function handleAaiToken(res) {
  const cfg = await dictationConfig();
  const key = cfg.assemblyai_api_key;
  if (!key) return sendJSON(res, 503, { error: 'sem chave da AssemblyAI' });
  let r;
  try {
    // Raw key, no "Bearer" — that is what the v3 token endpoint wants.
    r = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=60', {
      headers: { Authorization: key },
    });
  } catch (e) {
    return sendJSON(res, 502, { error: `token indisponível: ${e.message}` });
  }
  if (!r.ok) return sendJSON(res, 502, { error: `token indisponível: HTTP ${r.status}` });
  const data = await r.json().catch(() => ({}));
  if (!data.token) return sendJSON(res, 502, { error: 'token indisponível' });
  const keyterms = String(cfg.assemblyai_keyterms || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return sendJSON(res, 200, { token: data.token, keyterms });
}

/* Single-range only. That is all a PDF viewer or an <img> ever asks for, and a
 * multipart/byteranges reply is not worth writing for a local reader.
 * undefined = send the whole file, null = 416, else {start, end} inclusive. */
function parseRange(header, size) {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined; // malformed — ignore it and send everything
  const [, from, to] = m;
  if (from === '' && to === '') return undefined;
  let start;
  let end;
  if (from === '') {
    const n = Number(to); // suffix form: the last n bytes
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

/* /api/raw carries the name in a query string, so without this every "save as"
 * would suggest "raw". RFC 5987 is the only form that survives both quotes and
 * the accents half of these filenames have. `inline` never forces a download —
 * it only says "render me if you can", which is exactly what a PDF wants. */
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // encodeURIComponent leaves `!'()*~` alone, but RFC 8187's attr-char excludes
  // `'()*` — and `'` is the ext-value's own delimiter, so one apostrophe in the
  // name makes a strict parser drop the whole parameter and fall back to the
  // ASCII form, which has already lost every accent.
  const ext = encodeURIComponent(name).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${ext}`;
}

async function sendFile(req, res, abs) {
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  if (!st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }

  const head = {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Disposition': contentDisposition(path.basename(abs)),
    // Chrome's PDF viewer reads the trailer first (the xref table lives at the
    // end) and then only the pages on screen. Without ranges it has to pull the
    // whole file before drawing page 1 — minutes for a 300 MB scan over the tailnet.
    'Accept-Ranges': 'bytes',
  };

  const range = parseRange(req.headers.range, st.size);
  if (range === null) {
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Accept-Ranges': 'bytes' });
    return res.end();
  }

  const stream = fs.createReadStream(abs, range ? { start: range.start, end: range.end } : {});
  // Headers only after the stream opens — writing 200 first meant an ENOENT
  // (missing asset, broken image link via /api/raw) threw ERR_HTTP_HEADERS_SENT
  // in the error handler and killed the whole process. The stat above narrows
  // the window but does not close it.
  stream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  stream.once('open', () => {
    if (range) {
      res.writeHead(206, {
        ...head,
        'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
        'Content-Length': range.end - range.start + 1,
      });
    } else {
      res.writeHead(200, { ...head, 'Content-Length': st.size });
    }
    stream.pipe(res);
  });
  // Closing the tab on a half-read 300 MB file must not leave the fd open.
  res.on('close', () => stream.destroy());
  // …and if the client left *while the stat above was pending*, 'close' already
  // fired and that listener will never run. The stream is open by now, piping
  // into a dead response, with nothing left to close it — one leaked fd per
  // abort, forever. Chrome cancels range requests constantly while you scroll a
  // big scan, so this window gets hit for real.
  if (res.destroyed) stream.destroy();
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/projects') {
      return sendJSON(res, 200, PROJECTS.map(({ name, root }) => ({ name, root })));
    }

    if (p === '/api/tree') {
      const project = getProject(url.searchParams.get('project'));
      if (!project) return sendJSON(res, 404, { error: 'unknown project' });
      if (project.browse) return sendJSON(res, 400, { error: 'use /api/ls for ~' });
      return sendJSON(res, 200, await buildTree(project.root));
    }

    if (p === '/api/ls') {
      const project = getProject(url.searchParams.get('project'));
      if (!project) return sendJSON(res, 404, { error: 'unknown project' });
      const rel = url.searchParams.get('path') || '';
      const abs = rel === '' ? project.root : safeJoin(project.root, rel);
      if (!abs) return sendJSON(res, 400, { error: 'bad path' });
      return sendJSON(res, 200, await listDir(abs, rel));
    }

    if (p === '/api/file' || p === '/api/stat' || p === '/api/raw') {
      const project = getProject(url.searchParams.get('project'));
      if (!project) return sendJSON(res, 404, { error: 'unknown project' });
      const abs = safeJoin(project.root, url.searchParams.get('path') || '');
      if (!abs) return sendJSON(res, 400, { error: 'bad path' });

      if (p === '/api/raw') return await sendFile(req, res, abs);

      // Only markdown goes through the reader. A PDF handed to /api/file would
      // be read whole as utf8 — 300 MB of mojibake, and mdt asked to expand it.
      if (p === '/api/file' && fileKind(abs) !== 'md') {
        return sendJSON(res, 415, { error: 'não é markdown', kind: fileKind(abs) });
      }

      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        return sendJSON(res, 404, { error: 'not found' });
      }
      const rel = url.searchParams.get('path') || '';
      if (p === '/api/stat') {
        // Report the newest mtime across the file AND everything it transcludes,
        // so editing a source re-renders every document that borrows from it.
        const cached = depCache.get(depKey(project.name, rel));
        const mtime = cached ? Math.max(st.mtimeMs, await maxMtime(cached)) : st.mtimeMs;
        return sendJSON(res, 200, { mtime });
      }
      const raw = await fsp.readFile(abs, 'utf8');
      const { content, deps } = await expandContent(abs, rel);
      depCache.set(depKey(project.name, rel), deps);
      // Must be the SAME number /api/stat reports, or the poll sees a newer
      // dependency, reloads, is handed the file's own (older) mtime, and loops.
      const mtime = Math.max(st.mtimeMs, await maxMtime(deps));
      return sendJSON(res, 200, { content: content === null ? raw : content, mtime, absPath: abs });
    }

    if (p === '/api/recent') {
      const days = Math.min(Number(url.searchParams.get('days') || 7), 90);
      return sendJSON(res, 200, await recentFiles(days));
    }

    if (p === '/api/search') {
      const project = getProject(url.searchParams.get('project'));
      if (!project) return sendJSON(res, 404, { error: 'unknown project' });
      if (project.browse) return sendJSON(res, 400, { error: 'busca disponível só em projetos' });
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return sendJSON(res, 400, { error: 'query too short' });
      return sendJSON(res, 200, await searchProject(project, q));
    }

    if (p === '/api/resolve') {
      const project = getProject(url.searchParams.get('project'));
      if (!project) return sendJSON(res, 404, { error: 'unknown project' });
      if (project.browse) return sendJSON(res, 200, { path: null, kind: null });
      const name = (url.searchParams.get('name') || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'missing name' });
      return sendJSON(res, 200, await resolveWikilink(project, name));
    }

    if (
      p === '/api/annotate' ||
      p === '/api/annotate/delete' ||
      p === '/api/annotate/color' ||
      p === '/api/create' ||
      p === '/api/aai-token'
    ) {
      // Writes and token minting need a trusted caller, see canWrite().
      if (!canWrite(req)) return sendJSON(res, 403, { error: 'sem permissão de escrita pela tailnet (NOTAS_WRITERS)' });
      // `return await`, not `return`: a bare `return promise` settles *after* this
      // try block has exited, so a disk error would escape as an unhandled
      // rejection — which Node turns into a process exit, killing the server.
      if (p === '/api/aai-token') {
        if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method not allowed' });
        return await handleAaiToken(res);
      }
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method not allowed' });
      if (!isJSON(req)) return sendJSON(res, 415, { error: 'use application/json' });
      if (p === '/api/annotate') return await handleAnnotate(req, res);
      if (p === '/api/annotate/color') return await handleAnnotateColor(req, res);
      if (p === '/api/create') return await handleCreate(req, res);
      return await handleAnnotateDelete(req, res);
    }

    // Static assets: /vendor/* from vendor dir, everything else from public.
    let abs;
    if (p.startsWith('/vendor/')) {
      abs = safeJoin(path.join(ROOT, 'vendor'), p.slice('/vendor/'.length));
    } else if (p === '/' || !path.extname(p)) {
      abs = path.join(ROOT, 'public', 'index.html');
    } else {
      abs = safeJoin(path.join(ROOT, 'public'), p.slice(1));
    }
    if (!abs) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('bad request');
    }
    return await sendFile(req, res, abs);
  } catch (err) {
    console.error('[notas]', err);
    return sendJSON(res, 500, { error: 'internal error' });
  }
};

for (const port of PORTS) {
  const server = http.createServer(handler);
  server.on('error', (err) => {
    console.warn(`[notas] could not bind port ${port}: ${err.code}`);
  });
  server.listen(port, HOST, () => {
    console.log(`[notas] http://${HOST}${port === 80 ? '' : `:${port}`}`);
  });
}
for (const p of PROJECTS) console.log(`[notas]   ${p.name} -> ${p.root}`);
