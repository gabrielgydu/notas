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
- Search: `/` focuses the box, Enter searches the current project (server-side grep).
- Dark/light: follows the OS, toggle bottom-left, persisted.
- "copiar caminho" button copies the absolute file path.
- Anotações: select a passage, `n` for a note or `c` for a Claude instruction —
  typed or dictated, stored in the `.md` itself. `h` (or `1`–`4`) highlights it
  in one of four colours, no comment. See below.

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

Writes are **desktop-only, on purpose**: `/api/annotate`, `/api/annotate/delete`,
`/api/annotate/color` and `/api/aai-token` all refuse any request carrying
`X-Forwarded-For`, which
`tailscale serve` sets and a direct localhost request never does. The tailnet PWA
stays a reader. The `~` browse pseudo-project is refused too — annotations are for
files inside a declared project.

### Ditado (dictation)

The popover records straight into the comment box via AssemblyAI
Universal-Streaming v3.

Two prerequisites:

- `~/.config/audiorecorder/config` must have `assemblyai_api_key=…` (optionally
  `assemblyai_keyterms=a,b,c`). The key never leaves the server; the browser gets a
  60-second token from `/api/aai-token`.

  **Only the first 100 keyterms are sent.** Streaming v3 rejects more than that
  (`error_code 3006`), closing the session the moment it opens — and everything
  travels in the WebSocket URL, whose request line dies just past 8192 bytes, so
  the list is trimmed again if the token pushes it over. The config's own comment
  quotes the *batch* API's limit of 1000; that number does not apply here. How many
  were actually sent is logged to the console on every connection.
- The mic needs a secure context. `http://notas/` is not one, so Brave is launched
  with `--unsafely-treat-insecure-origin-as-secure=http://notas`. Without the flag
  the popover just says `ditado indisponível — digite` and typing still works.

Typing while the mic is live pauses it and folds the transcript into what you have
— the mic button re-arms with a fresh session that appends. Saving mid-sentence
waits up to 800 ms for the final formatted revision, then writes.

## Config

Env vars: `NOTAS_PORT` (default 7777), `NOTAS_HOST` (default 127.0.0.1 — set
`0.0.0.0` to reach it from the phone on the same network; there is no auth,
so only do that on trusted networks).

Only `.md`/`.markdown` files are listed. Hidden dirs, `node_modules`, `.git`,
`.obsidian`, `.sync`, `.claude` are skipped. Path traversal outside project
roots is blocked server-side.

## License

MIT — see [`LICENSE`](LICENSE).

Vendored third-party assets under `vendor/` keep their own licenses:

- [marked](https://github.com/markedjs/marked) v9.1.6 — MIT
- [highlight.js](https://github.com/highlightjs/highlight.js) v11.9.0 — BSD-3-Clause
- Literata, Fraunces and IBM Plex Mono — SIL Open Font License 1.1
