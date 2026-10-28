'use strict';
// Dictation over /api/dictate, end to end: real notas servers on free ports,
// the real `stt stream` with its fake provider (no network, no key), Node's
// own WebSocket client, and a raw socket where that client is too polite to
// send what needs testing. A generated stand-in for stt covers what the fake
// provider cannot do: show the exact bytes, ignore SIGTERM, die with no error
// line, stop reading its stdin.
//
//   node --test          (from the repo root)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STT = process.env.NOTAS_TEST_STT || path.join(os.homedir(), 'development', 'stt', 'bin', 'stt');
const IDLE_MS = 1500; // the stand-in server's idle timeout

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notas-test-'));
const sttConfig = path.join(tmp, 'stt.conf');
const fakeBin = path.join(tmp, 'fake-stt');
const fakeMode = path.join(tmp, 'fake-mode');
let real; // the real stt, provider=fake
let fake; // the stand-in
let missing; // NOTAS_STT_BIN pointing at nothing

const FAKE_STT = `#!${process.execPath}
// Stand-in for \`stt stream\`; what it does comes from the file in FAKE_STT_MODE.
const crypto = require('node:crypto');
const mode = require('node:fs').readFileSync(process.env.FAKE_STT_MODE, 'utf8').trim();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (mode === 'exit2') {
  process.stderr.write('usage: stt stream [-h]\\nstt stream: error: bad argument\\n');
  process.exit(2);
}
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
out({ type: 'ready', provider: 'stand-in', model: mode });
if (mode === 'no-read') {
  process.stdin.pause();
  setInterval(() => {}, 1000);
} else {
  const hash = crypto.createHash('sha256');
  let n = 0;
  process.stdin.on('data', (d) => {
    hash.update(d);
    n += d.length;
  });
  process.stdin.on('end', () => {
    out({ type: 'final', turn: 0, text: 'sha256=' + hash.digest('hex') + ' bytes=' + n });
    out({ type: 'end' });
    if (mode === 'ignore-term') setInterval(() => {}, 1000);
  });
}
`;

/* ---------- helpers ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await sleep(10);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NOTAS_PORTS: String(port),
      NOTAS_HOST: '127.0.0.1',
      NOTAS_WRITERS: 'writer@example.com',
      NOTAS_ORIGINS: 'https://extra.example',
      NOTAS_DICTATE_IDLE_MS: '',
      STT_CONFIG: sttConfig,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  await until(() => log.includes(`http://127.0.0.1:${port}`) || proc.exitCode !== null, 5000, 'notas to start');
  assert.equal(proc.exitCode, null, `notas did not start:\n${log}`);
  return { port, proc, log: () => log };
}

async function stopServer(s) {
  if (!s || s.proc.exitCode !== null) return;
  s.proc.kill('SIGTERM');
  await once(s.proc, 'exit');
}

// Live processes whose parent is `pid`. The fields after comm's last ')' are
// fixed: state, then ppid.
function childrenOf(pid) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(ppid) === pid && state !== 'Z') out.push(Number(name));
  }
  return out;
}

const noChildren = (s, ms = 3000) =>
  until(() => childrenOf(s.proc.pid).length === 0, ms, () => `children of notas to go: ${childrenOf(s.proc.pid)}`);

// CPU time `pid` has used so far, in ms: utime + stime, in ticks of 10 ms
// (USER_HZ is 100 on Linux), 12th and 13th fields after comm.
function cpuMs(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return (Number(f[11]) + Number(f[12])) * 10;
}

// Writes it all, waiting for drain, until done or the socket is gone.
async function writeAll(socket, chunks) {
  for (const chunk of chunks) {
    if (socket.destroyed) return;
    if (!socket.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => {
          socket.off('drain', done);
          socket.off('close', done);
          resolve();
        };
        socket.on('drain', done);
        socket.on('close', done);
      });
    }
  }
}

// Node's WebSocket client, with every text frame and the close kept.
function connect(s, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/api/dictate`, headers ? { headers } : undefined);
  ws.binaryType = 'arraybuffer';
  const c = { ws, lines: [], closed: null, opened: false };
  ws.onopen = () => (c.opened = true);
  ws.onmessage = (m) => c.lines.push(m.data);
  ws.onerror = () => {};
  ws.onclose = (e) => (c.closed = { code: e.code, reason: e.reason });
  c.events = () => c.lines.map((l) => JSON.parse(l));
  c.has = (pred) => c.events().find(pred);
  c.waitFor = (pred, what, ms = 5000) => until(() => c.has(pred), ms, () => `${what}; got ${JSON.stringify(c.lines)}`);
  c.waitClosed = (ms = 5000) => until(() => c.closed, ms, () => `the socket to close; got ${JSON.stringify(c.lines)}`);
  return c;
}

// The handshake by hand, for status codes and for frames a browser never sends.
function rawUpgrade(s, extra = {}, pathname = '/api/dictate', connectOpts = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: s.port, host: '127.0.0.1', ...connectOpts });
    const headers = {
      Host: `127.0.0.1:${s.port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      'Sec-WebSocket-Version': '13',
      ...extra,
    };
    const lines = [`GET ${pathname} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) lines.push(`${k}: ${v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const head = buf.subarray(0, end).toString();
      resolve({ status: Number(head.split(' ')[1]), head, socket, rest: buf.subarray(end + 4), key: headers['Sec-WebSocket-Key'] });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

// For refusals: the status and the JSON body, read to the end.
async function refused(s, extra, pathname) {
  const r = await rawUpgrade(s, extra, pathname);
  const chunks = [r.rest];
  r.socket.on('data', (d) => chunks.push(d));
  await once(r.socket, 'close');
  return { status: r.status, body: JSON.parse(Buffer.concat(chunks).toString()) };
}

async function accepted(s, extra) {
  const r = await rawUpgrade(s, extra);
  r.socket.destroy();
  return r.status;
}

function clientFrame(opcode, payload, { fin = true, mask = true } = {}) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([head, payload]);
  head[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < len; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
}

// Server frames off a raw socket, parsed as they arrive.
function serverFrames(r) {
  const frames = [];
  const state = { frames, ended: false };
  let buf = r.rest;
  const parse = () => {
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      frames.push({
        fin: Boolean(buf[0] & 0x80),
        masked: Boolean(buf[1] & 0x80),
        opcode: buf[0] & 0x0f,
        payload: buf.subarray(off, off + len),
      });
      buf = buf.subarray(off + len);
    }
  };
  r.socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    parse();
  });
  r.socket.on('close', () => (state.ended = true));
  parse();
  state.text = () => frames.filter((f) => f.opcode === 1).map((f) => JSON.parse(f.payload.toString()));
  state.close = () => frames.find((f) => f.opcode === 8);
  return state;
}

const setMode = (mode) => fs.writeFileSync(fakeMode, mode);
const setSttConfig = (...lines) => fs.writeFileSync(sttConfig, ['provider = fake', ...lines].join('\n') + '\n');

/* ---------- setup ---------- */

before(async () => {
  assert.ok(fs.existsSync(STT), `stt not found at ${STT} (set NOTAS_TEST_STT)`);
  setSttConfig();
  fs.writeFileSync(fakeBin, FAKE_STT, { mode: 0o755 });
  setMode('hash');
  real = await startServer({ NOTAS_STT_BIN: STT });
  fake = await startServer({ NOTAS_STT_BIN: fakeBin, FAKE_STT_MODE: fakeMode, NOTAS_DICTATE_IDLE_MS: String(IDLE_MS) });
  missing = await startServer({ NOTAS_STT_BIN: path.join(tmp, 'no-such-stt') });
});

after(async () => {
  // Whatever happened in between, no test may have taken a server down.
  const crashed = [real, fake, missing].filter((s) => s && s.proc.exitCode !== null);
  await Promise.all([real, fake, missing].map(stopServer));
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.deepEqual(crashed.map((s) => s.log()), [], 'a notas server died during the tests');
});

/* ---------- through the real stt (provider=fake) ---------- */

test('audio in, stt lines out verbatim, stop ends the session', async () => {
  const c = connect(real);
  await c.waitFor((e) => e.type === 'ready', 'ready');
  assert.equal(c.lines[0], '{"type": "ready", "provider": "fake", "model": "fake"}');
  assert.equal(childrenOf(real.proc.pid).length, 1, 'one stt per session');

  // 7-, 16- and 64-bit payload lengths: 24 × 3200 + 100 + 70000 = 146900 bytes.
  for (let i = 0; i < 24; i++) c.ws.send(new Uint8Array(3200));
  c.ws.send(new Uint8Array(100));
  c.ws.send(new Uint8Array(70000));
  await c.waitFor((e) => e.type === 'final' && e.turn === 1, 'the second final');
  c.ws.send(JSON.stringify({ type: 'stop' }));
  await c.waitFor((e) => e.type === 'end', 'end');
  const closed = await c.waitClosed();

  const texts = c.events().filter((e) => e.type === 'final').map((e) => e.text);
  assert.deepEqual(texts, [
    'fake turn 0 bytes=64000',
    'fake turn 1 bytes=64000',
    // No terms and no languages: notas passes neither, and this config sets neither.
    'fake turn 2 end total=146900 terms=0 languages=',
  ]);
  assert.ok(c.has((e) => e.type === 'partial' && e.turn === 0 && e.text === 'fake turn 0 word'));
  assert.equal(c.events().at(-1).type, 'end');
  assert.equal(closed.code, 1000);
  await noChildren(real);
});

test('closing the socket cancels stt', async () => {
  const c = connect(real);
  await c.waitFor((e) => e.type === 'ready', 'ready');
  c.ws.send(new Uint8Array(3200));
  assert.equal(childrenOf(real.proc.pid).length, 1);
  c.ws.close();
  await noChildren(real);
});

test('two sessions at once keep their own audio', async () => {
  const a = connect(real);
  const b = connect(real);
  await a.waitFor((e) => e.type === 'ready', 'ready on a');
  await b.waitFor((e) => e.type === 'ready', 'ready on b');
  a.ws.send(new Uint8Array(1000));
  b.ws.send(new Uint8Array(2000));
  a.ws.send(JSON.stringify({ type: 'stop' }));
  b.ws.send(JSON.stringify({ type: 'stop' }));
  await a.waitFor((e) => e.type === 'end', 'end on a');
  await b.waitFor((e) => e.type === 'end', 'end on b');
  assert.match(a.has((e) => e.type === 'final').text, /total=1000 /);
  assert.match(b.has((e) => e.type === 'final').text, /total=2000 /);
  await noChildren(real);
});

test("stt's error line reaches the browser as it is", async () => {
  setSttConfig('fake_fail = connect:auth');
  try {
    const c = connect(real);
    await c.waitFor((e) => e.type === 'error', 'the error line');
    const closed = await c.waitClosed();
    assert.deepEqual(c.events(), [
      { type: 'error', kind: 'auth', fatal: true, routine: false, retry_after: null, message: 'fake auth failure at connect' },
    ]);
    assert.equal(closed.code, 1011);
  } finally {
    setSttConfig();
  }
  await noChildren(real);
});

/* ---------- who may connect ---------- */

test('a foreign Origin is refused before anything starts', async () => {
  for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:1']) {
    const r = await refused(real, { Origin: origin });
    assert.equal(r.status, 403, origin);
    assert.equal(r.body.error, 'origem não permitida');
  }
  assert.deepEqual(childrenOf(real.proc.pid), []);
});

test('our origins, the same host, NOTAS_ORIGINS and no Origin are let in', async () => {
  for (const origin of [
    'http://notas',
    'http://localhost:7777',
    `http://127.0.0.1:${real.port}`,
    'https://extra.example',
    undefined,
  ]) {
    assert.equal(await accepted(real, { Origin: origin }), 101, String(origin));
  }
  await noChildren(real);
});

test('a same-host Origin counts only on a name notas knows', async () => {
  // DNS rebinding: a hostile page whose name now resolves to 127.0.0.1 sends
  // its own name as both Host and Origin.
  for (const host of ['rebind.attacker.example', `rebind.attacker.example:${real.port}`]) {
    const r = await rawUpgrade(real, { Host: host, Origin: `http://${host}` });
    r.socket.destroy();
    assert.equal(r.status, 403, host);
  }
  // The listed names (NOTAS_ORIGINS included) keep it, on any port.
  for (const host of [`localhost:${real.port}`, `notas:${real.port}`, 'extra.example:8080']) {
    assert.equal(await accepted(real, { Host: host, Origin: `http://${host}` }), 101, host);
  }
  await noChildren(real);
});

test('a proxied caller needs to be a writer', async () => {
  const r = await refused(real, { 'X-Forwarded-For': '100.64.0.7' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /NOTAS_WRITERS/);
  assert.equal(
    await accepted(real, { 'X-Forwarded-For': '100.64.0.7', 'Tailscale-User-Login': 'writer@example.com' }),
    101
  );
  await noChildren(real);
});

test('other upgrade paths and broken handshakes are refused', async () => {
  assert.equal((await refused(real, {}, '/api/other')).status, 404);
  assert.equal((await refused(real, { 'Sec-WebSocket-Version': '8' })).status, 400);
  assert.equal((await refused(real, { 'Sec-WebSocket-Key': undefined })).status, 400);
  assert.deepEqual(childrenOf(real.proc.pid), []);
});

test('an Upgrade that is not a WebSocket is served as a plain request', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: real.port,
        path: '/api/projects',
        headers: { Connection: 'Upgrade, HTTP2-Settings', Upgrade: 'h2c', 'HTTP2-Settings': 'AAMAAABkAAQAoAAAAAIAAAAA' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('upgrade', () => reject(new Error('switched protocols')));
    req.on('error', reject);
  });
  assert.equal(status, 200);
});

/* ---------- framing ---------- */

test('ping gets its pong, unmasked', async () => {
  const r = await rawUpgrade(real);
  assert.equal(r.status, 101);
  const f = serverFrames(r);
  r.socket.write(clientFrame(0x9, Buffer.from('hi')));
  await until(() => f.frames.find((x) => x.opcode === 0xa), 3000, 'pong');
  const pong = f.frames.find((x) => x.opcode === 0xa);
  assert.equal(pong.payload.toString(), 'hi');
  assert.equal(pong.masked, false);
  r.socket.destroy();
  await noChildren(real);
});

test('pings from a client that reads nothing do not pile up in notas', async () => {
  const r = await rawUpgrade(real);
  const f = serverFrames(r);
  await until(() => f.text().some((e) => e.type === 'ready'), 5000, 'ready');
  r.socket.pause();
  // 320 000 pings, 42 MB, in batches of 4000.
  const PINGS = 320000;
  const batch = Buffer.concat(Array.from({ length: 4000 }, () => clientFrame(0x9, Buffer.alloc(125, 1))));
  await writeAll(r.socket, Array.from({ length: PINGS / 4000 }, () => batch));
  // stt's end comes after every pong notas queued before it.
  r.socket.write(clientFrame(0x1, Buffer.from('{"type":"stop"}')));
  r.socket.resume();
  await until(() => f.text().some((e) => e.type === 'end'), 20000, 'end');
  // The kernel's socket buffers take a few MB of pongs whatever notas does
  // (about 36 000 here); a notas that queues them all sends every one.
  const pongs = f.frames.filter((x) => x.opcode === 0xa).length;
  assert.ok(pongs > 0, 'no pong at all');
  assert.ok(pongs < PINGS / 4, `${pongs} of ${PINGS} pongs were queued for a client that read nothing`);
  r.socket.destroy();
  await noChildren(real);
});

for (const [name, frame, code] of [
  ['a fragmented message', () => clientFrame(0x2, Buffer.alloc(10), { fin: false }), 1003],
  ['an unmasked frame', () => clientFrame(0x2, Buffer.alloc(10), { mask: false }), 1002],
  ['a frame over 1 MiB', () => clientFrame(0x2, Buffer.alloc(1024 * 1024 + 1)), 1009],
]) {
  test(`${name} closes the session, not the server`, async () => {
    const r = await rawUpgrade(real);
    const f = serverFrames(r);
    r.socket.write(frame());
    await until(() => f.close(), 3000, 'a close frame');
    assert.equal(f.close().payload.readUInt16BE(0), code);
    await until(() => f.ended, 5000, 'the socket to end');
    await noChildren(real);
    const res = await fetch(`http://127.0.0.1:${real.port}/api/projects`);
    assert.equal(res.status, 200);
  });
}

test('bytes that follow a refused frame are dropped, not buffered', async () => {
  // Half-open, so the client can go on sending after notas's close frame and
  // FIN; notas reads on until the client ends too, or for 2 s at most.
  const r = await rawUpgrade(real, {}, '/api/dictate', { allowHalfOpen: true });
  const f = serverFrames(r);
  await until(() => f.text().some((e) => e.type === 'ready'), 5000, 'ready');
  const cpu0 = cpuMs(real.proc.pid);
  r.socket.write(clientFrame(0x2, Buffer.alloc(10), { mask: false }));
  await until(() => f.close(), 3000, 'a close frame');
  // 32 MB more.
  await writeAll(r.socket, Array.from({ length: 512 }, () => Buffer.alloc(64 * 1024, 0x82)));
  if (!r.socket.destroyed) r.socket.end();
  await until(() => f.ended, 5000, 'the socket to end');
  const cpu = cpuMs(real.proc.pid) - cpu0;
  // Dropped, 32 MB cost tens of ms; buffered, each chunk copied everything
  // before it again, and notas spent most of the 2 s doing that.
  assert.ok(cpu < 500, `notas spent ${cpu} ms of CPU on bytes after the refused frame`);
  await noChildren(real);
});

/* ---------- through the stand-in ---------- */

test('frames reach stt in order, byte for byte', async () => {
  setMode('hash');
  const c = connect(fake);
  await c.waitFor((e) => e.type === 'ready', 'ready');
  const sent = [];
  for (let i = 0; i < 40; i++) {
    const n = i === 20 ? 70000 : 100 + i * 97;
    const buf = Buffer.alloc(n, i);
    sent.push(buf);
    c.ws.send(buf);
  }
  c.ws.send(JSON.stringify({ type: 'stop' }));
  await c.waitFor((e) => e.type === 'end', 'end');
  const all = Buffer.concat(sent);
  const want = `sha256=${crypto.createHash('sha256').update(all).digest('hex')} bytes=${all.length}`;
  assert.equal(c.has((e) => e.type === 'final').text, want);
  await noChildren(fake);
});

test('an stt that ignores SIGTERM is killed 2 s later', async () => {
  setMode('ignore-term');
  const c = connect(fake);
  await c.waitFor((e) => e.type === 'ready', 'ready');
  const t0 = Date.now();
  c.ws.close();
  await sleep(1000);
  assert.equal(childrenOf(fake.proc.pid).length, 1, 'still there after SIGTERM');
  await noChildren(fake, 4000);
  assert.ok(Date.now() - t0 >= 1900, 'gone only after the SIGKILL grace');
});

test('an stt that dies without an error line is reported with its last stderr line', async () => {
  setMode('exit2');
  const c = connect(fake);
  await c.waitFor((e) => e.type === 'error', 'the error line');
  const closed = await c.waitClosed();
  assert.deepEqual(c.events(), [
    { type: 'error', kind: 'internal', fatal: true, routine: false, retry_after: null, message: 'stt stream: error: bad argument' },
  ]);
  assert.equal(closed.code, 1011);
  await noChildren(fake);
});

test('an stt that stops reading is killed', async () => {
  setMode('no-read');
  const c = connect(fake);
  await c.waitFor((e) => e.type === 'ready', 'ready');
  for (let i = 0; i < 40 && !c.closed; i++) {
    c.ws.send(new Uint8Array(32000));
    await sleep(5);
  }
  await c.waitFor((e) => e.type === 'error', 'the backlog error');
  assert.equal(c.has((e) => e.type === 'error').message, 'stt parou de ler o áudio');
  assert.equal((await c.waitClosed()).code, 1011);
  await noChildren(fake);
});

test('a session with no audio for the idle timeout is ended', async () => {
  setMode('hash');
  const c = connect(fake);
  await c.waitFor((e) => e.type === 'ready', 'ready');
  c.ws.send(new Uint8Array(3200));
  await c.waitFor((e) => e.type === 'error', 'the idle error', IDLE_MS + 3000);
  const err = c.has((e) => e.type === 'error');
  assert.equal(err.kind, 'timeout');
  assert.match(err.message, /sem atividade/);
  assert.equal((await c.waitClosed()).code, 1000);
  await noChildren(fake);
});

/* ---------- no stt at all ---------- */

test('a missing stt is reported, and notas stays up', async () => {
  const c = connect(missing);
  await c.waitFor((e) => e.type === 'error', 'the error line');
  const err = c.has((e) => e.type === 'error');
  assert.equal(err.kind, 'config');
  assert.match(err.message, /^stt não encontrado \(/);
  assert.equal((await c.waitClosed()).code, 1011);
  // Audio sent into the dead session must not hurt either.
  const d = connect(missing);
  d.ws.onopen = () => d.ws.send(new Uint8Array(3200));
  await d.waitClosed();
  const res = await fetch(`http://127.0.0.1:${missing.port}/api/projects`);
  assert.equal(res.status, 200);
  assert.equal(missing.proc.exitCode, null);
});
