# Changelog

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
