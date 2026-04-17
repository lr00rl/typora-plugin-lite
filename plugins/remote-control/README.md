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

- WebSocket server binds to `127.0.0.1` only (no LAN exposure).
- Every RPC call after connect requires `session.authenticate` with the
  bearer token from `<dataDir>/remote-control/settings.json`.
- Tokens are generated on first launch and persisted across restarts.

## Disable entirely

Run `Remote Control: Stop Local Service` once (persists `enabled=false`
in settings). The plugin will no longer spawn the sidecar on startup until
you run `Remote Control: Start Local Service` again.
