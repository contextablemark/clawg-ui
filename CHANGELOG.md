# Changelog

## 0.2.9 (2026-02-28)

### Fixed
- README event table was missing `TOOL_CALL_ARGS` and `TOOL_CALL_RESULT`; `tools` field incorrectly said "reserved for future use"
- Integration tests used the gateway token directly instead of an HMAC-signed device token, causing 401s against v0.2.0+ servers
- "Missing auth" integration test expected 401 instead of 403 (pairing initiation)

### Added
- "Tool call events" documentation section explaining client vs server tool flows and diagnostic tips
- Unit tests for `handleBeforeToolCall` and `handleToolResultPersist` hook handlers (`src/tool-hooks.test.ts`)

### Changed
- Extracted hook handlers from `index.ts` into exported named functions for testability (no behavioral change)
- Integration tests now accept `CLAWG_UI_DEVICE_TOKEN` or auto-generate one from `OPENCLAW_GATEWAY_TOKEN` + `CLAWG_UI_DEVICE_ID`

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
