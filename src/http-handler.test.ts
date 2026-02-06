import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventType } from "@ag-ui/core";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@ag-ui/encoder", () => ({
  EventEncoder: vi.fn().mockImplementation(() => ({
    getContentType: () => "text/event-stream",
    encode: (event: unknown) => `data: ${JSON.stringify(event)}\n\n`,
  })),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  emptyPluginConfigSchema: () => ({}),
}));

import { createAguiHttpHandler } from "./http-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReq(
  overrides: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): IncomingMessage & EventEmitter {
  const emitter = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(emitter, {
    method: overrides.method ?? "POST",
    url: "/v1/clawg-ui",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      ...overrides.headers,
    },
    destroy: vi.fn(),
  });

  // Simulate body streaming
  const bodyStr =
    overrides.body !== undefined ? JSON.stringify(overrides.body) : undefined;
  if (bodyStr !== undefined) {
    process.nextTick(() => {
      emitter.emit("data", Buffer.from(bodyStr));
      emitter.emit("end");
    });
  }

  return emitter as IncomingMessage & EventEmitter;
}

function createRes(): ServerResponse & {
  _chunks: string[];
  _headers: Record<string, string>;
  _ended: boolean;
} {
  const res = {
    statusCode: 200,
    _chunks: [] as string[],
    _headers: {} as Record<string, string>,
    _ended: false,
    setHeader(name: string, value: string) {
      res._headers[name.toLowerCase()] = value;
    },
    flushHeaders() {},
    write(chunk: string) {
      res._chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) {
        res._chunks.push(chunk);
      }
      res._ended = true;
    },
  };
  return res as unknown as ServerResponse & {
    _chunks: string[];
    _headers: Record<string, string>;
    _ended: boolean;
  };
}

function parseEvents(
  chunks: string[],
): Array<{ type: string; [key: string]: unknown }> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      const match = line.match(/^data:\s*(.+)$/);
      if (match?.[1]) {
        try {
          events.push(JSON.parse(match[1]));
        } catch {
          /* skip */
        }
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// HMAC token utilities (duplicated from http-handler for testing)
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto";

function createDeviceToken(secret: string, deviceId: string): string {
  const encodedId = Buffer.from(deviceId).toString("base64url");
  const signature = createHmac("sha256", secret).update(deviceId).digest("hex").slice(0, 32);
  return `${encodedId}.${signature}`;
}

// ---------------------------------------------------------------------------
// Fake plugin API + runtime
// ---------------------------------------------------------------------------

function createFakeApi(
  approvedDevices: string[] = [],
  options: { pairingCode?: string } = {},
) {
  const { pairingCode = "TEST1234" } = options;

  const dispatchReplyFromConfig = vi.fn().mockResolvedValue({
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  });

  const upsertPairingRequest = vi.fn().mockResolvedValue({
    code: pairingCode,
  });

  const readAllowFromStore = vi.fn().mockResolvedValue(approvedDevices);

  return {
    config: { gateway: { auth: { token: "test-gateway-secret" } } },
    runtime: {
      config: {
        loadConfig: () => ({
          session: { store: "/tmp/test-sessions" },
        }),
      },
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            sessionKey: "agui:test-session",
            agentId: "main",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi
            .fn()
            .mockImplementation(({ body }: { body: string }) => body),
          finalizeInboundContext: vi
            .fn()
            .mockImplementation((ctx: Record<string, unknown>) => ctx),
          dispatchReplyFromConfig,
        },
        pairing: {
          upsertPairingRequest,
          readAllowFromStore,
        },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const GATEWAY_SECRET = "test-gateway-secret";
const APPROVED_DEVICE_ID = "12345678-1234-1234-1234-123456789abc";

describe("AG-UI HTTP handler", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create fake API with the approved device
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as any);
    // Set env token for auth fallback
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
  });

  it("rejects non-POST with 405", async () => {
    const req = createReq({ method: "GET" });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("rejects invalid bearer token with 401", async () => {
    const req = createReq({
      headers: { authorization: "Bearer invalid.token" },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("rejects messages with only system role with 400", async () => {
    // Use an approved device token
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "system", content: "sys" }],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("accepts tool-only messages (tool result submission)", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-tool-only",
        runId: "r-tool-only",
        messages: [
          { role: "tool", toolCallId: "tc-1", content: "72°F sunny" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Should proceed with normal SSE flow
    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("emits RUN_STARTED as first SSE event", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events[0]?.threadId).toBe("t1");
    expect(events[0]?.runId).toBe("r1");
  });

  it("emits RUN_FINISHED after dispatch completes", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(res._ended).toBe(true);
  });

  it("calls dispatchReplyFromConfig with correct sessionKey and runId", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    expect(rt.channel.reply.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const call = rt.channel.reply.dispatchReplyFromConfig.mock.calls[0][0];
    expect(call.ctx.SessionKey).toBe("agui:test-session");
    expect(call.replyOptions.runId).toBe("r1");
  });

  it("sends TEXT_MESSAGE events when dispatcher.sendBlockReply is called", async () => {
    // Override dispatchReplyFromConfig to call the dispatcher
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher }: { dispatcher: any }) => {
        dispatcher.sendBlockReply({ text: "Hello from agent" });
        dispatcher.sendFinalReply({ text: "" });
        return { queuedFinal: true, counts: { tool: 0, block: 1, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    const contentEvt = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(contentEvt?.delta).toBe("Hello from agent\n\n");
  });

  it("sendToolResult does not crash and stream completes (tool events come from hooks)", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher }: { dispatcher: any }) => {
        const ok = dispatcher.sendToolResult({ text: "tool output" });
        expect(ok).toBe(true);
        dispatcher.sendFinalReply({ text: "done" });
        return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(res._ended).toBe(true);
  });

  it("emits RUN_ERROR on dispatch failure", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockRejectedValue(
      new Error("agent failed"),
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_ERROR);
    const errEvt = events.find((e) => e.type === EventType.RUN_ERROR);
    expect(errEvt?.message).toContain("agent failed");
    expect(res._ended).toBe(true);
  });

  it("suppresses text output when client tool was called", async () => {
    const { setClientToolCalled } = await import("./tool-store.js");

    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher, ctx }: { dispatcher: any; ctx: any }) => {
        // Simulate a client tool being called (flag set by before_tool_call hook)
        setClientToolCalled(ctx.SessionKey);
        // Agent tries to send text after tool call — should be suppressed
        dispatcher.sendBlockReply({ text: "unwanted text" });
        dispatcher.sendFinalReply({ text: "also unwanted" });
        return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ct",
        runId: "r-ct",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ name: "get_weather", description: "Get weather" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    // Should NOT contain text message events
    expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CONTENT);
    // Should still finish the run
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("includes tool messages in conversation context for new run", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-resume",
        runId: "r-resume",
        messages: [
          { role: "user", content: "Weather in Tokyo?" },
          { role: "tool", toolCallId: "tc-1", content: "72°F sunny" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Should proceed with normal SSE flow (has user message + tool context)
    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("handles client disconnect by aborting", async () => {
    const rt = (fakeApi as any).runtime;
    let capturedAbortSignal: AbortSignal | undefined;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ replyOptions }: { replyOptions: any }) => {
        capturedAbortSignal = replyOptions.abortSignal;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Simulate client disconnect
    (req as EventEmitter).emit("close");

    expect(capturedAbortSignal).toBeDefined();
    expect(capturedAbortSignal!.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Device Pairing Tests
// ---------------------------------------------------------------------------

describe("Device pairing", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
  });

  it("returns pairing_pending with pairingCode and token when no auth header", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as any);

    const req = createReq({
      headers: {}, // No authorization header
      body: {},
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res._chunks[0]);
    expect(body.error.type).toBe("pairing_pending");
    expect(body.error.pairing.pairingCode).toBe("TEST1234");
    expect(body.error.pairing.token).toBeDefined();
    expect(body.error.pairing.instructions).toContain("openclaw pairing approve clawg-ui");
  });

  it("calls upsertPairingRequest when initiating pairing", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as any);

    const req = createReq({
      headers: {}, // No authorization header
      body: {},
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    expect(rt.channel.pairing.upsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(rt.channel.pairing.upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "clawg-ui",
      }),
    );
  });

  it("rejects invalid HMAC signature with 401", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as any);

    // Token with invalid signature
    const req = createReq({
      headers: { authorization: "Bearer aW52YWxpZC1kZXZpY2UtaWQ.invalidsignature" },
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns pairing_pending for valid token but unapproved device", async () => {
    // No approved devices
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as any);

    // Create valid HMAC token for a device that's not approved
    const unapprovedDeviceId = "87654321-4321-4321-4321-abcdef123456";
    const token = createDeviceToken(GATEWAY_SECRET, unapprovedDeviceId);

    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res._chunks[0]);
    expect(body.error.type).toBe("pairing_pending");
    expect(body.error.message).toContain("pending approval");
  });

  it("proceeds normally for valid token with approved device", async () => {
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as any);

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);

    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: { messages: [{ role: "user", content: "Hello" }] },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("returns 429 rate_limit when max pending pairing requests reached", async () => {
    // Simulate rate limit by returning empty code
    fakeApi = createFakeApi([], { pairingCode: "" });
    handler = createAguiHttpHandler(fakeApi as any);

    const req = createReq({
      headers: {}, // No authorization header - initiates pairing
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res._chunks[0]);
    expect(body.error.type).toBe("rate_limit");
    expect(body.error.message).toContain("Too many pending pairing requests");
  });
});
