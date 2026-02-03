# clawg-ui

![Banner](./clawgui.png)

An [OpenClaw](https://github.com/openclaw/openclaw) channel plugin that exposes the gateway as an [AG-UI](https://docs.ag-ui.com) protocol-compatible HTTP endpoint. AG-UI clients such as [CopilotKit](https://www.copilotkit.ai) UIs and `@ag-ui/client` `HttpAgent` instances can connect to OpenClaw and receive streamed responses.

## Installation

```bash
npm install @contextableai/clawg-ui
```

Or with the OpenClaw plugin CLI:

```bash
openclaw plugins install @contextableai/clawg-ui
```

Then restart the gateway. The plugin auto-registers the `/v1/clawg-ui` endpoint and the `clawg-ui` channel.

## How it works

The plugin registers as an OpenClaw channel and adds an HTTP route at `/v1/clawg-ui`. When an AG-UI client POSTs a `RunAgentInput` payload, the plugin:

1. Authenticates the request using the gateway bearer token
2. Parses the AG-UI messages into an OpenClaw inbound context
3. Routes to the appropriate agent via the gateway's standard routing
4. Dispatches the message through the reply pipeline (same path as Telegram, Teams, etc.)
5. Streams the agent's response back as AG-UI SSE events

```
AG-UI Client                        OpenClaw Gateway
    |                                      |
    |  POST /v1/agui (RunAgentInput)       |
    |------------------------------------->|
    |                                      |  Auth (bearer token)
    |                                      |  Route to agent
    |                                      |  Dispatch inbound message
    |                                      |
    |  SSE: RUN_STARTED                    |
    |<-------------------------------------|
    |  SSE: TEXT_MESSAGE_START             |
    |<-------------------------------------|
    |  SSE: TEXT_MESSAGE_CONTENT (delta)   |
    |<-------------------------------------|  (streamed chunks)
    |  SSE: TEXT_MESSAGE_CONTENT (delta)   |
    |<-------------------------------------|
    |  SSE: TOOL_CALL_START               |
    |<-------------------------------------|  (if agent uses tools)
    |  SSE: TOOL_CALL_END                 |
    |<-------------------------------------|
    |  SSE: TEXT_MESSAGE_END              |
    |<-------------------------------------|
    |  SSE: RUN_FINISHED                  |
    |<-------------------------------------|
```

## Usage

### Prerequisites

- OpenClaw gateway running (`openclaw gateway run`)
- A gateway auth token configured (`OPENCLAW_GATEWAY_TOKEN` env var or `gateway.auth.token` in config)

### curl

```bash
curl -N -X POST http://localhost:18789/v1/clawg-ui \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -d '{
    "threadId": "thread-1",
    "runId": "run-1",
    "messages": [
      {"role": "user", "content": "What is the weather in San Francisco?"}
    ]
  }'
```

### @ag-ui/client HttpAgent

```typescript
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "http://localhost:18789/v1/clawg-ui",
  headers: {
    Authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}`,
  },
});

const stream = agent.run({
  threadId: "thread-1",
  runId: "run-1",
  messages: [
    { role: "user", content: "Hello from CLAWG-UI" },
  ],
});

for await (const event of stream) {
  console.log(event.type, event);
}
```

### CopilotKit

```tsx
import { CopilotKit } from "@copilotkit/react-core";

function App() {
  return (
    <CopilotKit
      runtimeUrl="http://localhost:18789/v1/clawg-ui"
      headers={{
        Authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}`,
      }}
    >
      {/* your app */}
    </CopilotKit>
  );
}
```

## Request format

The endpoint accepts a POST with a JSON body matching the AG-UI `RunAgentInput` schema:

| Field | Type | Required | Description |
|---|---|---|---|
| `threadId` | string | no | Conversation thread ID. Auto-generated if omitted. |
| `runId` | string | no | Unique run ID. Auto-generated if omitted. |
| `messages` | Message[] | yes | Array of messages. At least one `user` message required. |
| `tools` | Tool[] | no | Client-side tool definitions (reserved for future use). |
| `state` | object | no | Client state (reserved for future use). |

### Message format

```json
{
  "role": "user",
  "content": "Hello"
}
```

Supported roles: `user`, `assistant`, `system`, `tool`.

## Response format

The response is an SSE stream. Each event is a `data:` line containing a JSON object with a `type` field from the AG-UI `EventType` enum:

| Event | When |
|---|---|
| `RUN_STARTED` | Immediately after validation |
| `TEXT_MESSAGE_START` | First assistant text chunk |
| `TEXT_MESSAGE_CONTENT` | Each streamed text delta |
| `TEXT_MESSAGE_END` | After last text chunk |
| `TOOL_CALL_START` | Agent invokes a tool |
| `TOOL_CALL_END` | Tool execution complete |
| `RUN_FINISHED` | Agent run complete |
| `RUN_ERROR` | On failure |

## Authentication

The endpoint uses the same bearer token as the OpenClaw gateway. Set it via:

- Environment variable: `OPENCLAW_GATEWAY_TOKEN`
- Config file: `gateway.auth.token`

Pass it in the `Authorization` header:

```
Authorization: Bearer <token>
```

## Agent routing

The plugin uses OpenClaw's standard agent routing. By default, messages route to the `main` agent. To target a specific agent, set the `X-OpenClaw-Agent-Id` header:

```bash
curl -N -X POST http://localhost:18789/v1/clawg-ui \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "X-OpenClaw-Agent-Id: my-agent" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

## Error responses

Non-streaming errors return JSON:

| Status | Meaning |
|---|---|
| 400 | Invalid request (missing messages, bad JSON) |
| 401 | Unauthorized (missing or invalid token) |
| 405 | Method not allowed (only POST accepted) |

Streaming errors emit a `RUN_ERROR` event and close the connection.

## Development

```bash
git clone https://github.com/contextablemark/clawg-ui
cd clawg-ui
npm install
npm test
```

## License

MIT
