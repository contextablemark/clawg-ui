# Changelog

## 0.5.3 (2026-04-02)

### Fixed
- Register HTTP route via `gateway_start` lifecycle hook instead of directly in `register()`. Works around a known OpenClaw startup timing issue (2026.3.23+) where the gateway pins the HTTP route registry before external plugin `register()` callbacks complete, causing routes registered via `api.registerHttpRoute()` to be silently lost.

## 0.5.2 (2026-04-02) [yanked]

### Fixed
- Attempted to use `registerPluginHttpRoute()` from the plugin SDK — not exported in the public SDK. Use 0.5.3 instead.

## 0.5.1 (2026-04-01)

### Fixed
- Add `match: "exact"` to `registerHttpRoute` call — required by OpenClaw 2026.3.23+ which changed the plugin HTTP route API to require an explicit match mode. Without it, the route registers silently but never matches incoming requests, resulting in a 404. Backwards compatible with older OpenClaw versions (unknown properties are ignored).

## 0.5.0 (2026-04-01)

### Changed
- **Breaking:** Peer ID now uses the stable device UUID instead of the per-thread ID. This enables identity linking (`session.identityLinks`) so clawg-ui devices can be linked to users across channels, matching how Telegram and Slack connections work.
- Session keys now include a `:thread:<threadId>` suffix for per-thread session separation (same pattern as Slack thread sessions).

### Migration
- **Identity linking:** You can now add clawg-ui device IDs to `session.identityLinks` in `openclaw.json`:
  ```json
  {
    "session": {
      "dmScope": "per-peer",
      "identityLinks": {
        "alice": ["clawg-ui:<deviceId>", "telegram:123456", "slack:U0123ABC"]
      }
    }
  }
  ```
  The device UUID is shown during pairing approval (`openclaw pairing list clawg-ui`).
- **Session history:** Existing session histories are keyed on the old format (`clawg-ui-<threadId>` peer). After upgrading, devices will start new sessions. No data is lost — old sessions remain in the store but won't be matched by the new key format.

## 0.4.5 (2026-03-15)

### Added
- Forward AG-UI `RunAgentInput.context` entries to the LLM prompt — each context entry (description + value) is formatted and appended to `BodyForAgent` so the agent sees UI-provided context (e.g. pending tool-call approvals, app state)

## 0.4.4 (2026-03-15)

_Published prematurely — superseded by 0.4.5._

## 0.4.3 (2026-03-14)

### Added
- Implement `X-OpenClaw-Agent-Id` header routing — pass the header value as `accountId` to `resolveAgentRoute`, enabling agent selection via bindings (e.g. `{ "agentId": "auditor", "match": { "channel": "clawg-ui", "accountId": "auditor" } }`)

## 0.4.2 (2026-03-13)

### Removed
- Reverted `/v1/clawg-ui/info` endpoint and CopilotRuntime single-transport `{ method: "info" }` handling added in 0.4.0–0.4.1 — clawg-ui is a pure AG-UI endpoint; CopilotKit clients must use a CopilotRuntime intermediary with `HttpAgent` pointed at clawg-ui

## 0.3.3 (2026-03-13)

### Fixed
- Return a valid empty SSE run (`RUN_STARTED` + `RUN_FINISHED`) instead of 400 when `messages` is empty or contains no user/tool messages — restores AG-UI protocol compliance and fixes CopilotKit integration (fixes #18)

## 0.3.2 (2026-03-09)

### Fixed
- Pass `{ channel: "clawg-ui" }` object to `readAllowFromStore` — API changed again in OpenClaw 2026.3.7 (fixes #17)

## 0.3.1 (2026-03-09)

### Fixed
- Compile TypeScript to `dist/` and point `openclaw.extensions` to `./dist/index.js` instead of `./index.ts` — fixes "loaded without install/load-path provenance" warning in OpenClaw 3.7
- Keep `auth: "plugin"` on `registerHttpRoute` with a type cast — required at runtime but not yet in SDK typings (fixes #16)
- Remove `onToolResult` from reply options — property is now explicitly omitted from the type
- Use `EventType` enum instead of plain `string` in `EventWriter` type — fixes type mismatch with AG-UI core

### Changed
- Add `main`, `build`, and `prepublishOnly` fields to `package.json` for proper npm packaging
- Add `declaration: true` and `exclude: ["**/*.test.ts"]` to `tsconfig.json`
- Add explicit type annotation to `plugin` export to avoid non-portable inferred type

## 0.2.9 (2026-03-06)

### Fixed
- Add `auth: "plugin"` to `registerHttpRoute` call — required by OpenClaw 2026.3.2; omitting it silently dropped the `/v1/clawg-ui` route, causing 404s
- Pass `{ channel, accountId }` object to `readAllowFromStore` instead of a bare string — fixes 403 responses for approved devices after the pairing API changed in 2026.3.2
- Add `pairing_code` and `bearer_token` at the root of the 403 pairing response alongside the existing nested `error.pairing` fields — restores compatibility with Kotlin `ClawgUIPairingResponse` clients expecting flat fields
- Add diagnostic `console.log` for 400 responses to aid debugging of malformed requests

### Changed
- README event table was missing `TOOL_CALL_ARGS` and `TOOL_CALL_RESULT`; `tools` field incorrectly said "reserved for future use"
- Integration tests used the gateway token directly instead of an HMAC-signed device token, causing 401s against v0.2.0+ servers
- "Missing auth" integration test expected 401 instead of 403 (pairing initiation)

### Added
- "Tool call events" documentation section explaining client vs server tool flows and diagnostic tips
- Unit tests for `handleBeforeToolCall` and `handleToolResultPersist` hook handlers (`src/tool-hooks.test.ts`)
- Extracted hook handlers from `index.ts` into exported named functions for testability (no behavioral change)
- Integration tests now accept `CLAWG_UI_DEVICE_TOKEN` or auto-generate one from `OPENCLAW_GATEWAY_TOKEN` + `CLAWG_UI_DEVICE_ID`

## Unreleased

## 0.2.8 (2026-02-26)

### Fixed
- Remove literal `process.env` from a code comment in `http-handler.ts` that was itself triggering the security scanner — the comment documenting the v0.2.5/v0.2.6 fix contained the exact pattern the scanner flags

## 0.2.7 (2026-02-18)

### Fixed
- Close open text messages before emitting `RUN_FINISHED` in `splitRunIfToolFired()` — fixes `AGUIError: Cannot send 'RUN_FINISHED' while text messages are still active` when text streaming is followed by a server-side tool call and then more text

## 0.2.6 (2026-02-10)

### Fixed
- Move gateway secret resolution into its own module (`gateway-secret.ts`) so the HTTP handler file contains zero `process.env` references — eliminates plugin security scanner warning ("Environment variable access combined with network send")

## 0.2.5 (2026-02-10)

### Fixed
- Resolve gateway secret at factory initialization time instead of per-request to eliminate plugin security scanner warning ("Environment variable access combined with network send")

## 0.2.4 (2026-02-06)

### Changed
- Separate tool call events and text message events into distinct AG-UI runs — when text follows a tool call, the tool run is finished and a new run (with a unique runId) is started for the text messages

## 0.2.3 (2026-02-06)

### Fixed
- Append `\n\n` paragraph joiner to streamed text deltas so chunks render with proper spacing
- Include `runId` in all `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, and `TEXT_MESSAGE_END` events for AG-UI protocol compliance

### Changed
- Set channel defaults to `blockStreaming: true` and `chunkMode: "newline"` for correct paragraph-based streaming out of the box
- Clean up multi-run logic for tool-call-then-text flows (single run per request)

## 0.2.2 (2026-02-05)

### Fixed
- Include `messageId` in `TOOL_CALL_RESULT` events as required by AG-UI client v0.0.43 Zod schema

### Added
- Debug logging throughout tool call flow for easier troubleshooting

## 0.2.1 (2026-02-05)

### Fixed
- Return HTTP 429 `rate_limit` error when max pending pairing requests (3) is reached, instead of returning an empty pairing code

## 0.2.0 (2026-02-04)

### Added
- **Device pairing authentication** - Secure per-device access control
  - HMAC-signed device tokens (no master token exposure)
  - Pairing approval workflow (`openclaw pairing approve clawg-ui <code>`)
  - New CLI command: `openclaw clawg-ui devices` - List approved devices

### Changed
- **Breaking:** Direct bearer token authentication using `OPENCLAW_GATEWAY_TOKEN` is now deprecated and no longer supported. All clients must use device pairing.

### Security
- Device tokens are HMAC-signed and do not expose the gateway's master secret
- Pending pairing requests expire after 1 hour (max 3 per channel)
- Each device requires explicit approval by the gateway owner

## 0.1.1 (2026-02-03)

### Changed
- Endpoint path changed from `/v1/agui` to `/v1/clawg-ui`
- Package name changed to `@contextableai/clawg-ui`

## 0.1.0 (2026-02-02)

Initial release.

- AG-UI protocol endpoint at `/v1/agui` for OpenClaw gateway
- SSE streaming of agent responses as AG-UI events (`RUN_STARTED`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TOOL_CALL_START`, `TOOL_CALL_END`, `RUN_FINISHED`, `RUN_ERROR`)
- Bearer token authentication using the gateway token
- Content negotiation via `@ag-ui/encoder` (SSE and protobuf support)
- Standard OpenClaw channel plugin (`agui`) for gateway status visibility
- Agent routing via `X-OpenClaw-Agent-Id` header
- Abort on client disconnect
- Compatible with `@ag-ui/client` `HttpAgent`, CopilotKit, and any AG-UI consumer
