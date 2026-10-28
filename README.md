# Notas

Tiny local markdown *reader*. One Node server, zero dependencies, no build step.
Sidebar = mono file tree (terminal); content pane = book page (Literata/Fraunces).

## Run

```sh
node server.js          # → http://notas/ and http://127.0.0.1:7777
```

`http://notas/` works because of two system-level pieces (set up 2026-06-10):
- `/etc/hosts` has `127.0.0.1 notas`
- `/etc/sysctl.d/80-notas-unprivileged-port.conf` sets
  `net.ipv4.ip_unprivileged_port_start=80` so the server can bind port 80
  without root. Note: this allows *any* local process to bind ports ≥ 80.

Ports come from `NOTAS_PORTS` (default `80,7777`); a port that can't be bound
is skipped with a warning, the rest still work.

Or as a service (already set up):

```sh
systemctl --user status notas    # start/stop/restart/disable also work
```

## Projects

Projects are declared in `projects.json` (name → folder).

That file is personal config and is not tracked — copy the example and edit it:

```sh
cp projects.example.json projects.json
```

```json
{
  "Notes": "~/notes",
  "Reading": "~/Documents/reading"
}
```

The server reloads `projects.json` on change, so edits apply without a restart.

Without it, Notas falls back to `projects.example.json` rather than refusing to boot.

## iPhone (PWA over Tailscale)

Set up 2026-07-02. `tailscale serve` proxies HTTPS to the local server:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:7777
# → https://<machine>.<tailnet>.ts.net:8443  (tailnet only, persists across reboots)
# to remove: tailscale serve --https=8443 off
```

(Port 443 was already taken by another serve; PWAs need HTTPS for the
service worker, which tailscale provides with a valid ts.net cert.)

On the iPhone: open the URL in Safari → Share → **Add to Home Screen**.
Installs as a standalone app (manifest + icons in `public/`). A service
worker (`public/sw.js`) precaches the app shell and keeps every note read
online available offline; strategy is network-first, so content is always
fresh when the PC is reachable. `/api/stat` (the autoreload poll) is never
cached. To force-refresh the shell after big changes, bump `VERSION` in
`sw.js`.

On phones (≤ 900 px) the sidebar becomes a drawer behind the ☰ button.

## Features

- **Recentes** (landing view): files changed in the last 7 days across all projects,
  deduped when projects nest.
- Rendering: GFM via marked (same engine family as the Markdown Viewer extension),
  syntax highlighting (highlight.js), `[[wikilinks]]` (click resolves by filename),
  YAML frontmatter as a card, relative images/links served from the project,
  mermaid diagrams (lazy-loaded from CDN when present).
- ToC on wide screens with scroll-spy.
- Autoreload: open file re-renders ~2 s after it changes on disk.
- PDFs are listed alongside the notes and open in a new browser tab. See below.
- Search: `/` focuses the box, Enter searches the current project (server-side grep).
- Dark/light: follows the OS, toggle bottom-left, persisted.
- "copiar caminho" button copies the absolute file path.
- Anotações: select a passage, `n` for a note or `c` for a Claude instruction —
  typed or dictated, stored in the `.md` itself. `h` (or `1`–`4`) highlights it
  in one of four colours, no comment. See below.

## PDFs

`.pdf` files show up wherever `.md` files do — the tree, **Recentes**, search results — tagged `pdf` so you can tell before clicking.

Clicking one **opens it in a new tab**, in the browser's own PDF viewer. Notas never renders it and never leaves the page you were reading.

Under the hood every one of those rows is a plain `target="_blank"` link to `/api/raw`, so the click itself opens the tab and the router is never involved.

`/api/raw` answers `Range` requests. Chrome's viewer reads the trailer first and then only the pages on screen, so a 300 MB scan starts drawing immediately instead of downloading whole — which is the difference between usable and not over the tailnet.

A typed or bookmarked `#/p/…/file.pdf` URL (the `notas-open` skill produces these) lands on a small card that offers the tab, and tries to open it for you. Popup blockers make the attempt unreliable, never the link.

### Search matches the filename, not the contents

Nothing is ever read out of a PDF. `Downloads` alone holds ~700 of them at ~3 GB, and search fires live on every keystroke — extracting text on that path is not a trade worth making.

So a PDF is only ever a **name hit**, it never contributes to the occurrence count, and the search header says how many of the results were PDFs.

The two kinds get separate budgets, because they cost nothing alike: 400 markdown *occurrences* (one file read each) and 100 PDF filename hits (one string compare each). Spending the markdown budget stops the reading, not the walk — otherwise a handful of chatty notes would swallow the counter and every PDF the walk had not reached yet would vanish silently. Either cap being hit shows as `(parcial)`.

Within the filename tier notes sort above PDFs. A folder like `~/Downloads` would otherwise bury every note under its own filenames.

Everything else stays markdown-only on purpose: `/api/file` refuses a PDF with a 415 rather than reading 300 MB as utf-8, annotations already refuse anything that is not `.md`, and `[[wikilinks]]` prefer a markdown file over a same-named PDF.

The service worker will not cache a PDF either — one of them would blow the origin's storage quota and evict every note in it.

## Transclusion (mdt)

If **mdt** is installed alongside Notas, `/api/file` resolves `![[file#section]]` embeds and
`{{@value}}` inline values before returning the content, so a note can borrow text
from another file instead of repeating it. Notas still boots and serves files
literally if mdt is missing or throws.

Which files this applies to is decided by mdt, not here: the engine walks up from
the file to the nearest `mdt.json`, and **a file with no `mdt.json` above it is
served raw**. That is what keeps the `~` browse project safe — real Obsidian vaults
and template files using `![[…]]` / `{{…}}` for their own purposes pass through
untouched.

Two things follow from it:

- `/api/stat` reports the newest mtime **across the whole dependency set**, not just
  the file's own. Otherwise editing `key_figures.md` would never re-render the open
  runsheet — the autoreload poll would be watching the wrong file. `/api/file`
  returns the same number, or the poll would reload in a loop.
- Borrowed text is wrapped client-side in `<figure class="mdt-embed">` with a caption
  that links to the source; substituted values get a faint dotted underline. Edit the
  source, never the copy.

**Search greps raw files**, so transcluded text does not match in the embedding file.
Correct behaviour — the source is where it lives.

Full syntax, config and hard rules live in mdt's own documentation.

## Anotações

Select text in the rendered page and press a key — the comment is written into the
`.md` file itself, not into a sidecar database.

- `n` — **nota**: a note to self. It stays in the file.
- `c` — **claude**: an instruction for a later Claude session.
- `h` — **marca**: a highlighter. No comment at all.

Pressing the key without a selection arms the page (crosshair cursor); the next
selection is what it acts on. `Esc` cancels at any point.

`n` and `c` open a comment popover: `Enter` saves, and an empty comment writes
nothing at all. Comments can be typed or dictated (see below).

### Marcas (highlighting)

`h` writes immediately — there is nothing to type, so the key press is the whole interaction.

`1`–`4` pick the colour directly: **yellow** (what `h` uses), **green**, **blue**, **pink**.

Click a highlight to recolour or remove it: the popover is four swatches and an `apagar` button, and `1`–`4` work there too.

Marking a passage that is already marked recolours it in place rather than nesting a second one — same entry, same id.

Highlights get no card in the rail, because there would be nothing on it. A highlight whose quote stopped matching gets one, showing the passage it lost, so there is still something to delete.

A highlight and a comment can cover the same passage — the marks nest and both tints show. Clicking lands on the innermost one.

### The convention

**`ann:claude` entries are instructions, not notes.** A later Claude session
reading the file applies each one to the quoted passage and then *removes that
entry* — and removes the `## Annotations` section when the last one goes. That is
the whole point: the file carries its own revision requests.

**`ann:note` and `ann:hl` entries stay.** Nothing removes them but you.

### Storage

Everything is appended to the end of the file, under one `## Annotations` heading:

```markdown
## Annotations

<!-- ann:note id=k3f9 2026-08-10 -->
> the text you selected as a quote
> second line of a multi-line selection

My personal note about this passage.
<!-- /ann -->

<!-- ann:claude id=x7q2 2026-08-10 before="ctx…" after="…ctx" -->
> another selected passage

Rewrite this section to be more concise, keep the numbers.
<!-- /ann -->

<!-- ann:hl id=m4t8 2026-08-10 -->
> a passage that is only highlighted
<!-- /ann -->

<!-- ann:hl id=b9p1 2026-08-10 color="blue" -->
> and one in a colour that is not the default
<!-- /ann -->
```

The section renders as ordinary markdown at the foot of the page — that is
deliberate, the annotations are part of the note now.

It renders **folded shut**, though: it is storage, and the same annotations are already on the page as marks and cards.

Its own heading is the lever — click it, or Enter/Space it, and the count beside it says how many entries are folded away.

It stays open while the file re-renders under it (a save, the 2 s autoreload), and folds again for the next file.

A highlight is the quote and nothing else: no blank line, no body. Yellow is never written out, so a bare `ann:hl` marker *is* a yellow highlight.

The quote is what re-finds the passage on every render: nothing stores a position,
so text you add above it does not break the link. `before`/`after` (≤ 32 chars) are
written only when the quoted text appears more than once, to say *which* one.

Recolouring rewrites the marker line and nothing else — it is not a delete plus an append, so the entry keeps its id and its place in the section.

When a quote no longer matches, the card says `trecho não encontrado`; when it
matches several times with no way to tell them apart, `trecho ambíguo`. Neither
highlights anything — a highlight on the wrong passage is worse than none.

The grammar lives in `public/annotations.js`, shared verbatim by the server and the
browser. Hand-editing is fine; an entry left without its `<!-- /ann -->` is parsed
but refused for deletion (409) rather than risk excising the wrong span.

### Where it works

The marks themselves render at every width. The margin rail (left, opposite the ToC) appears only at ≥ 1180 px.

Below that, clicking a `nota`/`claude` mark opens a popover with the comment and a delete button — and a lost entry, which exists only as a card, is out of reach until the window is wide enough again.

Clicking a `marca` always opens its own popover, rail or no rail.

Writes need a trusted caller: `/api/annotate`, `/api/annotate/delete`, `/api/annotate/color`, `/api/create` and the dictation socket `/api/dictate` accept a direct localhost request, or a tailnet request whose Tailscale login is listed in `NOTAS_WRITERS`.

`tailscale serve` sets `X-Forwarded-For` on everything it proxies, which a direct localhost request never carries.

For tailnet users it also sets `Tailscale-User-Login`, after deleting any copy the client sent, so the login can't be forged through the proxy; tagged nodes and Funnel traffic get no login at all.

With `NOTAS_WRITERS` unset, the tailnet PWA stays a reader.

The `~` browse pseudo-project is refused too — annotations are for files inside a declared project.

Every write (`/api/annotate*`, `/api/create`) must also arrive as `application/json`, or it is refused with 415.

That is the guard against other websites: any page you visit can POST `text/plain` to `127.0.0.1` without asking, and before this it could append annotations to your notes.

A JSON POST from another origin needs a CORS preflight first, which Notas never answers, so the browser never sends it. The client's `apiPost` always sets the header.

### Ditado (dictation)

The popover records straight into the comment box.

The browser sends the mic's audio (16 kHz mono PCM) over a WebSocket to `/api/dictate`, and the notas server runs one `stt stream` per session and passes its JSON lines back unchanged.

stt (`~/development/stt`) is the speech-to-text tool every transcriber on this machine shares: Soniox by default, AssemblyAI selectable.

It owns the provider, the API key, the language hints and the key terms, all in `~/.config/stt/config`; notas reads no speech config and holds no key.

Two prerequisites:

- stt installed (`~/development/stt/install.sh` links `~/.local/bin/stt`), with python-websockets and a key for its provider; `stt check` says whether live transcription is ready.

  notas runs `~/.local/bin/stt` by absolute path, because the systemd user manager's PATH has no `~/.local/bin`; `NOTAS_STT_BIN` points it elsewhere.
- The mic needs a secure context.

  `http://notas/` is not one, so Brave is launched with `--unsafely-treat-insecure-origin-as-secure=http://notas`.

  Without the flag the popover just says `ditado indisponível — digite` and typing still works.

The socket takes the same trusted callers as a write (see *Where it works*).

It also checks the Origin, because a WebSocket handshake is not covered by CORS: without the check, any page open in the browser could stream audio through the paid provider and read the transcript.

Allowed are no Origin (a local client that is not a browser), `http://notas`, `http://127.0.0.1` and `http://localhost` (with or without `:7777`), and whatever `NOTAS_ORIGINS` lists; anything else gets a 403 before stt starts.

Dictating from the phone through `tailscale serve` therefore needs the tailnet URL in `NOTAS_ORIGINS`, e.g. `Environment=NOTAS_ORIGINS=https://<machine>.<tailnet>.ts.net:8443` in the service unit.

On one of those names, an Origin with another port passes too when it matches the request's own Host, as when notas listens on another port.

Any other name is refused even when it matches the Host: after DNS rebinding, a hostile page's own name points at 127.0.0.1, and its Host and Origin agree.

Closing the socket cancels the session: notas sends stt a SIGTERM, then a SIGKILL 2 s later if it is still running.

A session that gets no audio for 30 s, such as a phone that went to sleep, is ended the same way, so a paid session never outlives its page.

stt sends as many key terms as the provider takes, most important first; when it has to cut the list, its note saying how many went out shows up in the browser console.

Typing while the mic is live pauses it and folds the transcript into what you have; the mic button re-arms with a fresh session that appends.

Saving mid-sentence ends the audio and waits up to 2 s for stt's last turn, then writes.

## Creating files (`/api/create`)

`POST /api/create` with `{ project, path, content }` writes a new markdown file and **never touches one that already exists**.

Answers `201 { created: true, path }` for a new file, `200 { created: false, path }` when something is already there. The existing file is left byte-for-byte alone.

It is meant for clients that derive the path from the content: saving the same thing twice just tells you where the first copy is, and annotations already written into it survive.

"Already exists" is decided by `link(2)`, not by a stat that could race: the text goes to a tmp file and is linked into place, which fails atomically with `EEXIST`.

A reader never sees a half-written file either.

The folder must already exist inside the project (symlinks resolved, same rule as annotations). Hidden paths, non-markdown files and the `~` pseudo-project are refused.

Like every write it is localhost-only and JSON-only (see *Where it works* above). A browser extension with host permission can send JSON without the preflight a web page would need.

Its one client today is the hablarcondios extension (`~/development/hablarcondios/extension`).

## Config

Env vars:

- `NOTAS_PORTS` (default `80,7777`; `NOTAS_PORT` is still read as a one-port alias).
- `NOTAS_HOST` (default 127.0.0.1 — set `0.0.0.0` to reach it from the phone on the same network; there is no auth, so only do that on trusted networks).
- `NOTAS_WRITERS` (comma-separated Tailscale logins allowed to write through `tailscale serve`; default none — see the write rules above).
- `NOTAS_STT_BIN` (default `~/.local/bin/stt`; the stt command dictation runs).
- `NOTAS_ORIGINS` (comma-separated extra origins allowed to open the dictation socket, e.g. the tailnet URL `https://<machine>.<tailnet>.ts.net:8443`).
- `NOTAS_DICTATE_IDLE_MS` (default 30000; how long a dictation session may go without audio before it is ended).

Only `.md`/`.markdown` and `.pdf` files are listed. Hidden dirs, `node_modules`, `.git`,
`.obsidian`, `.sync`, `.claude` are skipped. Path traversal outside project
roots is blocked server-side.

## Tests

```sh
node --test      # or: npm test
```

They start notas on free ports and drive `/api/dictate` with Node's own WebSocket client, through the real `stt` and its fake provider: no network, no key, never the real config.

A generated stand-in for stt covers what the fake provider cannot show, such as the exact bytes stt received or an stt that ignores SIGTERM.

`NOTAS_TEST_STT` points them at another stt (default `~/development/stt/bin/stt`).

## License

MIT — see [`LICENSE`](LICENSE).

Vendored third-party assets under `vendor/` keep their own licenses:

- [marked](https://github.com/markedjs/marked) v9.1.6 — MIT
- [highlight.js](https://github.com/highlightjs/highlight.js) v11.9.0 — BSD-3-Clause
- Literata, Fraunces and IBM Plex Mono — SIL Open Font License 1.1
