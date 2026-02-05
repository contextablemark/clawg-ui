# Changelog

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
