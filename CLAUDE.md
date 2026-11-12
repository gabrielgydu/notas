# Notas — instructions for Claude

## Ship every change

When a change is done and checked, commit it, push it to `origin main`, and deploy it — without asking first.

Work happens directly on `main`; there are no PR branches in this repo.

## Deploying

Notas runs as the user service `notas` (`notas.service`), serving `http://notas/` from this checkout.

Files under `public/` are read from disk on every request, so a change there is live as soon as it is saved: no restart.

Anything Node loads at startup needs `systemctl --user restart notas`: `server.js`, `public/annotations.js` (the server `require`s it), and `~/development/mdt`.

After a restart, confirm `curl -s -o /dev/null -w '%{http_code}' http://notas/` returns `200`.

## Checks

`npm test` before committing.
