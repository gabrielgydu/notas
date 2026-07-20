#!/usr/bin/env node
// Notas — tiny local markdown reading server. No dependencies.
// Projects are defined in projects.json next to this file.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

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
  const file = path.join(ROOT, 'projects.json');
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

// One directory level: dirs first, then markdown files. Each node carries its
// own mtime (ms) so the client can offer date sorting; dir mtime reflects when
// its listing last changed (add/remove/rename), not edits to files within.
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
    if (!isDir && !(e.isFile() && MD_EXTS.has(path.extname(e.name).toLowerCase()))) continue;
    let mtime = 0;
    try { mtime = (await fsp.stat(path.join(dir, e.name))).mtimeMs; } catch { /* ignore */ }
    (isDir ? dirs : files).push({ type: isDir ? 'dir' : 'file', name: e.name, path: childRel, mtime });
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
    } else if (e.isFile() && MD_EXTS.has(path.extname(e.name).toLowerCase())) {
      files.push({ type: 'file', name: e.name, path: childRel, mtime });
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
    } else if (e.isFile() && MD_EXTS.has(path.extname(e.name).toLowerCase())) {
      out.push({ abs: path.join(dir, e.name), rel: childRel });
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
        byAbs.set(f.abs, { project: p.name, path: f.rel, mtime: st.mtimeMs, rootLen: p.root.length });
      }
    }
  }
  const result = [...byAbs.values()].map(({ rootLen, ...r }) => r);
  result.sort((a, b) => b.mtime - a.mtime);
  return result.slice(0, 150);
}

async function searchProject(project, query) {
  const files = [];
  await walkFiles(project.root, '', files);
  const q = query.toLowerCase();
  const out = [];
  let total = 0;
  for (const f of files) {
    const nameMatch = f.rel.toLowerCase().includes(q);
    let text;
    try {
      text = await fsp.readFile(f.abs, 'utf8');
    } catch {
      // Unreadable file still counts as a hit if its name matches.
      if (nameMatch) out.push({ path: f.rel, nameMatch: true, matches: [] });
      continue;
    }
    const lines = text.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        total++;
        if (matches.length < 8) matches.push({ line: i + 1, text: lines[i].trim().slice(0, 300) });
        if (total >= 400) break;
      }
    }
    if (nameMatch || matches.length > 0) out.push({ path: f.rel, nameMatch, matches });
    if (total >= 400) break;
  }
  // Filename hits first, then by content-match count — the most relevant on top.
  out.sort((a, b) => (b.nameMatch - a.nameMatch) || (b.matches.length - a.matches.length));
  return { files: out, total, truncated: total >= 400 };
}

async function resolveWikilink(project, name) {
  const files = [];
  await walkFiles(project.root, '', files);
  const want = name.toLowerCase();
  for (const f of files) {
    const base = path.basename(f.rel, path.extname(f.rel)).toLowerCase();
    if (base === want) return f.rel;
  }
  // Fall back to a loose match (name contained in the basename).
  for (const f of files) {
    const base = path.basename(f.rel, path.extname(f.rel)).toLowerCase();
    if (base.includes(want)) return f.rel;
  }
  return null;
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, abs) {
  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const stream = fs.createReadStream(abs);
  // Headers only after the stream opens — writing 200 first meant an ENOENT
  // (missing asset, broken image link via /api/raw) threw ERR_HTTP_HEADERS_SENT
  // in the error handler and killed the whole process.
  stream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  stream.once('open', () => {
    res.writeHead(200, { 'Content-Type': mime });
    stream.pipe(res);
  });
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

      if (p === '/api/raw') return sendFile(res, abs);

      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        return sendJSON(res, 404, { error: 'not found' });
      }
      if (p === '/api/stat') return sendJSON(res, 200, { mtime: st.mtimeMs });
      const content = await fsp.readFile(abs, 'utf8');
      return sendJSON(res, 200, { content, mtime: st.mtimeMs, absPath: abs });
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
      if (project.browse) return sendJSON(res, 200, { path: null });
      const name = (url.searchParams.get('name') || '').trim();
      if (!name) return sendJSON(res, 400, { error: 'missing name' });
      return sendJSON(res, 200, { path: await resolveWikilink(project, name) });
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
    return sendFile(res, abs);
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
