# remote-control

Exposes a local JSON-RPC surface over a loopback WebSocket so external
processes (Node CLI clients, AI agents, `typora-plugin-remote-skill`, etc.)
can inspect and drive the running Typora instance.

## Architecture

```
┌────────────────────────────────┐           ┌─────────────────────────┐
│ Typora (Electron renderer)     │           │ sidecar (Node process)  │
│ ───────────────────────────    │  spawn    │ ─────────────────────   │
│ remote-control plugin          │──────────▶│ sidecar.mjs             │
│   ensureSidecar()              │           │   JSON-RPC over WS      │
│   connectRpc()  ◀──────────────┼── ws://…  │   listens on 127.0.0.1  │
│                                │           │   watches parent PID    │
└────────────────────────────────┘           └─────────────────────────┘
              ▲                                          │
              │                                          │ exec.run / exec.start
              │                                          ▼
              │                                     ┌─────────┐
              │                                     │  shell  │
              │                                     └─────────┘
              │
 RPC clients (CLI / skill / agents) also connect to the same sidecar
```

The sidecar is spawned **detached** so short-lived CLI clients don't die
when Typora switches foreground window — the sidecar therefore has its
own lifecycle management that tracks Typora's liveness explicitly.

## Session Model

The sidecar is a **hub/broker**, not a plain server. Every connection (Typora
plugin, CLI, AI agent) is a WebSocket session. Sessions carry a `role` assigned
at `session.authenticate` time:

- `role: 'typora'` — the host-app session. **Singleton** (`typoraSessionId` in
  `server.ts`); a fresh `authenticate(role: 'typora')` replaces the previous
  one so the plugin can reconnect cleanly after Typora restarts.
- `role: 'client'` — any external consumer (CLI, AI agent, bespoke Node
  importer). Many simultaneous instances are allowed.

All `typora.*` RPC methods run in the Typora session; the sidecar forwards them
via `forwardTypora` in `server.ts`. Clients can't talk to Typora without the
singleton being present (503 otherwise).

### Why `sessionCount` is usually ≥ 2

`system.getInfo.sessionCount` counts every connected WebSocket, including:

1. The Typora plugin (role=typora) — **always 1 when the plugin is loaded**.
2. The caller that just issued `system.getInfo` (role=client) — **+1** until
   that CLI invocation exits.

So the baseline sessionCount is `1 + <live client sessions>`. A one-off
`typora-remote-cli info` call will report `sessionCount: 2` at the moment of
measurement; the client's session disappears as soon as the CLI exits. You can
observe the underlying sockets directly:

```bash
ss -tnp state all '( sport = :5619 or dport = :5619 )'
#  LISTEN ... 127.0.0.1:5619          ← sidecar listener
#  ESTAB  ... 127.0.0.1:5619 ↔ 127.0.0.1:<X>   ← sidecar-side half of a session
#  ESTAB  ... 127.0.0.1:<X>  ↔ 127.0.0.1:5619  ← peer-side half (Typora or CLI)
```

### Role-based singleton trade-off

Because the latest `authenticate(role: 'typora')` wins the `typoraSessionId`,
any authenticated caller can take over routing by posing as Typora. That is
**by design** (supports Typora crash-and-reconnect) and the **token is the
trust anchor**. Ramifications:

- The token file must remain readable only by the current OS user (plugin-lite
  writes it via `settings.save()` under the user's data dir).
- A leaked token on a multi-user machine can impersonate Typora. Rotate the
  token via the Plugin Center settings UI if exposure is suspected — the
  sidecar will auto-restart within 500ms and all existing sessions will drop.

## Lifecycle

### Startup

1. `onload` calls `enableService()` which calls `ensureSidecar()`.
2. `ensureSidecar` first pings port `5619`. If a previous sidecar is still
   there, it's reused.
3. Otherwise it spawns a fresh sidecar with:
   ```
   node sidecar.mjs --host 127.0.0.1 --port 5619 \
                    --token <random-hex> \
                    --parent-pid <Electron main PID>
   ```
   with `detached: true` + `child.unref()` so the sidecar survives short
   renderer restarts.

### Parent-death watchdog (orphan protection)

On startup the sidecar starts a 5-second interval that calls
`process.kill(parentPid, 0)` — Node's cross-platform process-existence
probe. If the probe throws `ESRCH` or `ENOENT`, the parent is gone and the
sidecar calls `gracefulShutdown()`.

`gracefulShutdown()`:
- runs `server.close()` (shuts down WebSocket sessions + kills any live
  `exec.start` children);
- exits with code `0` on clean close, `1` on exception;
- has a **5-second hard deadline** via a secondary `setTimeout(exit(1))`,
  so a stuck child can't keep the sidecar alive indefinitely.

### Signal handling

The sidecar installs handlers for `SIGTERM` and `SIGINT` that route into
the same `gracefulShutdown()` path. A user-initiated `kill <sidecar-pid>`
therefore results in clean teardown.

### Normal shutdown via RPC

When Typora closes gracefully, the plugin's `onunload` calls the
`system.shutdown` RPC method, which runs `server.close()` inside a
`queueMicrotask` so the RPC response is sent first.

## Startup Log

Sidecar writes to `<dataDir>/remote-control/logs/sidecar.log`. On
successful startup you should see:

```
[tpl:remote-control:sidecar] listening on 127.0.0.1:5619 (pid=12345, parent-pid=54321)
```

If `parent-pid=n/a` appears, the watchdog is disabled (either Typora
couldn't resolve its main PID, or the sidecar was launched by hand). The
sidecar still handles `SIGTERM`/`SIGINT` cleanly in that case, but won't
self-exit on Typora crash.

## Troubleshooting

### `EADDRINUSE: address already in use 127.0.0.1:5619`

An old sidecar is still bound to port 5619 — typically from a previous
Typora session that crashed (`kill -9`, OOM, power loss) before the
watchdog fix landed.

```bash
# Find who's holding the port
ss -Htnlp 'sport = :5619'
# or
lsof -i :5619 -sTCP:LISTEN

# Kill it
kill <pid>

# Restart Typora or run the "Remote Control: Start Local Service" command
```

After the watchdog fix, new sidecars self-exit within 5s of Typora death,
so this state should not re-occur.

### `pstree -asp <sidecar-pid>` shows `systemd,1` as the parent

Expected — `detached: true` reparents the sidecar to init/systemd. The
watchdog compensates by polling the **original** parent PID passed via
`--parent-pid`, independent of the actual UNIX parent relationship.

### Sidecar won't exit when I close Typora

Check `sidecar.log` for the `parent-pid=` value. If it's `n/a`, the plugin
didn't resolve a valid parent PID and the watchdog is inactive for that
session. Workarounds:

- Use the `Remote Control: Stop Local Service` command before closing Typora.
- Or `kill <sidecar-pid>` manually.
- File an issue — the plugin should always be able to read
  `window.process.ppid` inside the Electron renderer.

## Security

### Transport & storage

- WebSocket server binds to `127.0.0.1` only (no LAN exposure).
- Every RPC call after connect requires `session.authenticate` with the
  bearer token from `<dataDir>/remote-control/settings.json`.
- Tokens are generated on first launch and persisted across restarts.
- `getDocument` / `getContext` markdown responses are wrapped in per-response
  nonce boundary markers (`<<<TPL_DOC_START id="..." trust="untrusted">>>...`
  …`<<<TPL_DOC_END id="...">>>`) to neutralise prompt injection via user
  content. Hardcoded invariant; no user toggle.

### Authorization matrix

All RPC methods stack through four layers. Each layer inherits the rejections
of the layer above it.

| Layer | Required | Methods | Typical failure |
|---|---|---|---|
| **L0** — open | — | `session.authenticate` | (none; entry point) |
| **L1** — authenticated | L0 + valid token | `system.ping`, `system.getInfo`, `system.shutdown` | 401 `Unauthenticated session`, 403 `Invalid token` |
| **L2** — needs Typora session | L1 + `typoraSessionId !== null` | `typora.getContext`, `typora.getDocument`, `typora.setDocument`, `typora.setSourceMode`, `typora.insertText`, `typora.openFile`, `typora.openFolder`, `typora.commands.{list,invoke}`, `typora.plugins.{list,setEnabled,commands.list,commands.invoke}` | 503 `Typora session is unavailable` (when Typora crashed or disabled the plugin) |
| **L3** — needs `allowExec=true` | L1 + plugin setting `allowExec: true` | `exec.run`, `exec.start`, `exec.kill`, `exec.list` | 403 `exec disabled by server policy (allowExec=false)` |

**`system.shutdown` is only at L1** — any authenticated session can ask the
sidecar to exit. This is intentional for management use; it also means a
leaked token's first move can kill the sidecar. The parent-pid watchdog
restarts a fresh sidecar on next Typora launch.

### Testing the security gates

```bash
# L1: unauth probe — expect 401
node -e '
const ws = new WebSocket("ws://127.0.0.1:5619/rpc")
ws.addEventListener("open", () => ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"system.ping"})))
ws.addEventListener("message", e => { console.log(e.data); ws.close() })
'
# → {"id":1,"error":{"code":401,"message":"Unauthenticated session"}}

# L1: wrong token — expect 403
node <path-to-cli>/typora-remote-cli.mjs --url ws://127.0.0.1:5619/rpc --token WRONG ping
# → RPC error 403: Invalid token

# L2: Typora absent — kill Typora then try (sidecar self-exits within 5s via
# parent-pid watchdog, but you can catch the 503 window if quick enough)
pkill Typora; node <path-to-cli>/typora-remote-cli.mjs context
# → RPC error 503: Typora session is unavailable

# L3: default-deny exec — expect 403
node <path-to-cli>/typora-remote-cli.mjs run "echo hi"
# → RPC error 403: exec disabled by server policy (allowExec=false). Enable
#   it in the Plugin Center → remote-control → Security.

# L3: after opt-in (flip "Allow shell execution" in Plugin Center)
node <path-to-cli>/typora-remote-cli.mjs run "echo hi"
# → { "exitCode": 0, "stdout": "hi\n", ... }

# Boundary markers on document reads — always on, no toggle
node <path-to-cli>/typora-remote-cli.mjs document
# → { "markdown": "<<<TPL_DOC_START id=\"<hex>\" trust=\"untrusted\">>>\n
#     ...user markdown...\n<<<TPL_DOC_END id=\"<hex>\">>>" }
```

Script the full chain as a regression smoke test — every release should pass
all five assertions before shipping.

## Disable entirely

Run `Remote Control: Stop Local Service` once (persists `enabled=false`
in settings). The plugin will no longer spawn the sidecar on startup until
you run `Remote Control: Start Local Service` again.
