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

Edit `projects.json` (name → folder). The server reloads it automatically, no restart needed:

```json
{
  "Notes": "~/notes",
  "Reading": "~/Documents/reading"
}
```

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

## Config

Env vars: `NOTAS_PORT` (default 7777), `NOTAS_HOST` (default 127.0.0.1 — set
`0.0.0.0` to reach it from the phone on the same network; there is no auth,
so only do that on trusted networks).

Only `.md`/`.markdown` files are listed. Hidden dirs, `node_modules`, `.git`,
`.obsidian`, `.sync`, `.claude` are skipped. Path traversal outside project
roots is blocked server-side.
