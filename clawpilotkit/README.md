# @contextableai/clawpilotkit

CopilotKit-based chat UI for [clawg-ui](https://github.com/contextable/clawg-ui).

The same prebuilt React + CopilotKit bundle runs in two modes:

- **Embedded** — as an OpenClaw plugin contributing the `chat.surface` slot
  in the operator console. The host iframe sends a context payload over
  `postMessage` (gateway URL, operator token, current session); the bundle
  wires CopilotKit straight to the `clawg-ui` operator-auth AG-UI route.
- **Standalone** — served by a tiny launcher against any clawg-ui gateway.
  The bundle falls into a setup screen, walks the user through device
  pairing, and then runs CopilotKit against the gateway's pairing-auth
  AG-UI route.

The bundle picks its mode at runtime: it pings its parent window with
`openclaw:ready` and waits ~500 ms for a context message; if none arrives
it switches to standalone.

## Embedded (OpenClaw plugin)

```bash
openclaw plugins install @contextableai/clawpilotkit
```

Restart the gateway. The plugin auto-registers the static UI route
(`/v1/clawpilotkit/ui`) and contributes the `chat.surface` slot, so the
operator console's Chat tab embeds the CopilotKit UI in place of the
built-in message thread + input box. No further configuration required;
authentication piggy-backs on the operator token the host already holds.

## Standalone (CLI launcher)

```bash
npx @contextableai/clawpilotkit
# → [clawpilotkit] open http://127.0.0.1:3939/
```

Open the printed URL in a browser. The setup screen accepts a clawg-ui
gateway URL (e.g. `http://localhost:18789`); on submit it kicks off the
device-pairing flow against `/v1/clawg-ui` on that gateway. Once the
gateway owner approves the pairing
(`openclaw pairing approve clawg-ui <code>`), CopilotKit chat goes live
against the gateway.

Flags:

```
--port, -p    port to bind (default 3939, env PORT)
--host, -h    host to bind (default 127.0.0.1, env HOST)
--help        show usage
```

The gateway must be running clawg-ui ≥ 0.7 so the pairing route allows
cross-origin requests from the launcher's origin.

## Building

```bash
npm install
npm run build      # builds the React app into ui/ and the plugin entry into dist/
npm run dev:app    # vite dev server for the React app (no auto plugin install)
```

`npm run build:app` writes the bundle to `ui/`. The launcher in `bin/`
serves that directory as-is and the plugin's static handler maps it under
`/v1/clawpilotkit/ui/` when running in embedded mode.
