# Changelog

## 0.1.0 (2026-04-29)

Initial release. CopilotKit-based chat UI for clawg-ui in two modes off
the same prebuilt React bundle:

### Embedded (`chat.surface` slot, OpenClaw operator console)
- Plugin entry registers the static UI route at `/v1/clawpilotkit/ui` and
  declares a `chat.surface` slot contribution. The OpenClaw operator
  console renders the bundle inside the Chat tab in place of the built-in
  message thread + input box; CopilotKit talks to clawg-ui's
  operator-auth route at `/v1/clawg-ui/operator` using the gateway token
  forwarded over the iframe `postMessage` handshake.
- Subscribes to subsequent `openclaw:context` messages so session
  switches, theme toggles, and `reloadNonce` bumps remount the chat with
  the host-supplied state.

### Standalone (CLI launcher)
- `npx @contextableai/clawpilotkit` (or `clawpilotkit` after install)
  starts a tiny `node:http` server (default `127.0.0.1:3939`) that
  serves the prebuilt `ui/` bundle. Works on any host that can reach a
  clawg-ui gateway — no OpenClaw plugin host required.
- Setup screen accepts a clawg-ui gateway URL, walks the user through
  device pairing against `/v1/clawg-ui`, persists the issued token in
  `sessionStorage`, and then runs CopilotKit against that gateway.
- Flags: `--port <port>` (env `PORT`), `--host <host>` (env `HOST`),
  `--help`.

### Implementation notes
- Mode detection: the React entry pings `window.parent` with
  `openclaw:ready` and listens for `openclaw:context`. If no context
  arrives within ~500 ms (or `window.parent === window`), it falls into
  standalone mode.
- AG-UI transport: uses `HttpAgent` from `@ag-ui/client` plumbed through
  `CopilotKitProvider`'s `selfManagedAgents` + `headers` props (the
  provider's `AgentRegistry.applyHeadersToAgent` overwrites
  `agent.headers` with the provider's `headers` prop on every render, so
  the bearer token has to live on the provider rather than on the agent).
- Requires clawg-ui ≥ 0.7.0 on the gateway side so cross-origin requests
  from both the sandboxed iframe (embedded) and the launcher's separate
  origin (standalone) are accepted.
