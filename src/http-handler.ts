import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput, Message } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk";
import {
  stashTools,
  setWriter,
  clearWriter,
  markClientToolNames,
  wasClientToolCalled,
  clearClientToolCalled,
  clearClientToolNames,
  wasToolFiredInRun,
  clearToolFiredInRun,
} from "./tool-store.js";
import { aguiChannelPlugin } from "./channel.js";
import { resolveGatewaySecret } from "./gateway-secret.js";

// ---------------------------------------------------------------------------
// Lightweight HTTP helpers (no internal imports needed)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendMethodNotAllowed(res: ServerResponse) {
  res.setHeader("Allow", "POST");
  res.statusCode = 405;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed");
}

function sendUnauthorized(res: ServerResponse) {
  sendJson(res, 401, { error: { message: "Authentication required", type: "unauthorized" } });
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function getBearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization?.trim() ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  return raw.slice(7).trim() || undefined;
}

// ---------------------------------------------------------------------------
// HMAC-signed device token utilities
// ---------------------------------------------------------------------------

function createDeviceToken(secret: string, deviceId: string): string {
  const encodedId = Buffer.from(deviceId).toString("base64url");
  const signature = createHmac("sha256", secret).update(deviceId).digest("hex").slice(0, 32);
  return `${encodedId}.${signature}`;
}

function verifyDeviceToken(token: string, secret: string): string | null {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex >= token.length - 1) {
    return null;
  }

  const encodedId = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);

  try {
    const deviceId = Buffer.from(encodedId, "base64url").toString("utf-8");

    // Validate it looks like a UUID
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
      return null;
    }

    const expectedSig = createHmac("sha256", secret).update(deviceId).digest("hex").slice(0, 32);

    // Constant-time comparison
    if (providedSig.length !== expectedSig.length) {
      return null;
    }
    const providedBuf = Buffer.from(providedSig);
    const expectedBuf = Buffer.from(expectedSig);
    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      return null;
    }

    return deviceId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extract text from AG-UI messages
// ---------------------------------------------------------------------------

function extractTextContent(msg: Message): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Build MsgContext-compatible body from AG-UI messages
// ---------------------------------------------------------------------------

function buildBodyFromMessages(messages: Message[]): {
  body: string;
  systemPrompt?: string;
} {
  const systemParts: string[] = [];
  const parts: string[] = [];
  let lastUserBody = "";
  let lastToolBody = "";

  for (const msg of messages) {
    const role = msg.role?.trim() ?? "";
    const content = extractTextContent(msg).trim();
    // Allow messages with no content (e.g., assistant with only toolCalls)
    if (!role) {
      continue;
    }
    if (role === "system") {
      if (content) systemParts.push(content);
      continue;
    }
    if (role === "user") {
      lastUserBody = content;
      if (content) parts.push(`User: ${content}`);
    } else if (role === "assistant") {
      if (content) parts.push(`Assistant: ${content}`);
    } else if (role === "tool") {
      lastToolBody = content;
      if (content) parts.push(`Tool result: ${content}`);
    }
  }

  // If there's only a single user message, use it directly (no envelope needed)
  // If there's only a tool result (resuming after client tool), use it directly
  const userMessages = messages.filter((m) => m.role === "user");
  const toolMessages = messages.filter((m) => m.role === "tool");
  let body: string;
  if (userMessages.length === 1 && parts.length === 1) {
    body = lastUserBody;
  } else if (userMessages.length === 0 && toolMessages.length > 0 && parts.length === toolMessages.length) {
    // Tool-result-only submission: format as tool result for agent context
    body = `Tool result: ${lastToolBody}`;
  } else {
    body = parts.join("\n");
  }

  return {
    body,
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

// ---------------------------------------------------------------------------
// HTTP handler factory
// ---------------------------------------------------------------------------

export function createAguiHttpHandler(api: OpenClawPluginApi) {
  const runtime: PluginRuntime = api.runtime;

  // Resolve once at init so the per-request handler never touches env vars.
  const gatewaySecret = resolveGatewaySecret(api);

  return async function handleAguiRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // POST-only
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return;
    }

    // Verify gateway secret was resolved at startup
    if (!gatewaySecret) {
      sendJson(res, 500, {
        error: { message: "Gateway not configured", type: "server_error" },
      });
      return;
    }

    // ---------------------------------------------------------------------------
    // Authentication: No auth (pairing initiation) or Device token
    // ---------------------------------------------------------------------------
    let deviceId: string;

    const bearerToken = getBearerToken(req);

    if (!bearerToken) {
      // No auth header: initiate pairing
      // Generate new device ID
      deviceId = randomUUID();

      // Add to pending via OpenClaw pairing API - returns a pairing code for approval
      const { code: pairingCode } = await runtime.channel.pairing.upsertPairingRequest({
        channel: "clawg-ui",
        id: deviceId,
        pairingAdapter: aguiChannelPlugin.pairing,
      });

      // Rate limit reached - max pending requests exceeded
      if (!pairingCode) {
        sendJson(res, 429, {
          error: {
            type: "rate_limit",
            message: "Too many pending pairing requests. Please wait for existing requests to expire (10 minutes) or ask the owner to approve/reject them.",
          },
        });
        return;
      }

      // Generate signed device token
      const deviceToken = createDeviceToken(gatewaySecret, deviceId);

      // Return pairing pending response with device token and pairing code
      sendJson(res, 403, {
        error: {
          type: "pairing_pending",
          message: "Device pending approval",
          pairing: {
            pairingCode,
            token: deviceToken,
            instructions: `Save this token for use as a Bearer token and ask the owner to approve: openclaw pairing approve clawg-ui ${pairingCode}`,
          },
        },
      });
      return;
    }

    // Device token flow: verify HMAC signature, extract device ID
    const extractedDeviceId = verifyDeviceToken(bearerToken, gatewaySecret);
    if (!extractedDeviceId) {
      sendUnauthorized(res);
      return;
    }
    deviceId = extractedDeviceId;

    // ---------------------------------------------------------------------------
    // Pairing check: verify device is approved
    // ---------------------------------------------------------------------------
    const storeAllowFrom = await runtime.channel.pairing
      .readAllowFromStore("clawg-ui")
      .catch(() => []);
    const normalizedAllowFrom = storeAllowFrom.map((e) =>
      e.replace(/^clawg-ui:/i, "").toLowerCase(),
    );
    const allowed = normalizedAllowFrom.includes(deviceId.toLowerCase());

    if (!allowed) {
      sendJson(res, 403, {
        error: {
          type: "pairing_pending",
          message: "Device pending approval. Ask the owner to approve using the pairing code from your initial pairing response.",
        },
      });
      return;
    }

    // ---------------------------------------------------------------------------
    // Device approved - proceed with request
    // ---------------------------------------------------------------------------

    // Parse body
    let body: unknown;
    try {
      body = await readJsonBody(req, 1024 * 1024);
    } catch (err) {
      sendJson(res, 400, {
        error: { message: String(err), type: "invalid_request_error" },
      });
      return;
    }

    const input = body as RunAgentInput;
    const threadId = input.threadId || `clawg-ui-${randomUUID()}`;
    const runId = input.runId || `clawg-ui-run-${randomUUID()}`;

    // Validate messages
    const messages: Message[] = Array.isArray(input.messages)
      ? input.messages
      : [];

    const hasUserMessage = messages.some((m) => m.role === "user");
    const hasToolMessage = messages.some((m) => m.role === "tool");
    if (!hasUserMessage && !hasToolMessage) {
      sendJson(res, 400, {
        error: {
          message: "At least one user or tool message is required in `messages`.",
          type: "invalid_request_error",
        },
      });
      return;
    }

    // Build body from messages
    const { body: messageBody } = buildBodyFromMessages(messages);
    if (!messageBody.trim()) {
      sendJson(res, 400, {
        error: {
          message: "Could not extract a prompt from `messages`.",
          type: "invalid_request_error",
        },
      });
      return;
    }

    // Resolve agent route
    const cfg = runtime.config.loadConfig();
    const route = runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: "clawg-ui",
      peer: { kind: "dm", id: `clawg-ui-${threadId}` },
    });

    // Set up SSE via EventEncoder
    const accept =
      typeof req.headers.accept === "string"
        ? req.headers.accept
        : "text/event-stream";
    const encoder = new EventEncoder({ accept });
    res.statusCode = 200;
    res.setHeader("Content-Type", encoder.getContentType());
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    let currentMessageId = `msg-${randomUUID()}`;
    let messageStarted = false;
    let currentRunId = runId;

    const writeEvent = (event: { type: EventType } & Record<string, unknown>) => {
      if (closed) {
        return;
      }
      try {
        res.write(encoder.encode(event as Parameters<typeof encoder.encode>[0]));
      } catch {
        // Client may have disconnected
        closed = true;
      }
    };

    // If a tool call was emitted in the current run, finish that run and start
    // a fresh one for text messages. This keeps tool events and text events in
    // separate runs per the AG-UI protocol.
    const splitRunIfToolFired = () => {
      if (!wasToolFiredInRun(sessionKey)) {
        return;
      }
      // Close any open text message before ending the run
      if (messageStarted) {
        writeEvent({
          type: EventType.TEXT_MESSAGE_END,
          messageId: currentMessageId,
          runId: currentRunId,
        });
        messageStarted = false;
      }
      // End the tool run
      writeEvent({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: currentRunId,
      });
      // Start a new run for text messages
      currentRunId = `clawg-ui-run-${randomUUID()}`;
      currentMessageId = `msg-${randomUUID()}`;
      messageStarted = false;
      clearToolFiredInRun(sessionKey);
      writeEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: currentRunId,
      });
    };

    // Handle client disconnect
    req.on("close", () => {
      closed = true;
    });

    // Emit RUN_STARTED
    writeEvent({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    });

    // Build inbound context using the plugin runtime (same pattern as msteams)
    const sessionKey = route.sessionKey;

    // Stash client-provided tools so the plugin tool factory can pick them up
    if (Array.isArray(input.tools) && input.tools.length > 0) {
      stashTools(sessionKey, input.tools);
      markClientToolNames(
        sessionKey,
        input.tools.map((t: { name: string }) => t.name),
      );
    }

    // Register SSE writer so before/after_tool_call hooks can emit AG-UI events
    setWriter(sessionKey, writeEvent, currentMessageId);
    const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey,
    });
    const envelopedBody = runtime.channel.reply.formatAgentEnvelope({
      channel: "AG-UI",
      from: "User",
      timestamp: new Date(),
      previousTimestamp,
      envelope: envelopeOptions,
      body: messageBody,
    });

    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: envelopedBody,
      RawBody: messageBody,
      CommandBody: messageBody,
      From: `clawg-ui:${deviceId}`,
      To: "clawg-ui",
      SessionKey: sessionKey,
      ChatType: "direct",
      ConversationLabel: "AG-UI",
      SenderName: "AG-UI Client",
      SenderId: deviceId,
      Provider: "clawg-ui" as const,
      Surface: "clawg-ui" as const,
      MessageSid: runId,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: true,
      OriginatingChannel: "clawg-ui" as const,
    });

    // Record inbound session
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      onRecordError: () => {},
    });

    // Create reply dispatcher — translates reply payloads into AG-UI SSE events
    const abortController = new AbortController();
    req.on("close", () => {
      abortController.abort();
    });

    const dispatcher = {
      sendToolResult: (_payload: { text?: string }) => {
        // Tool call events are emitted by before/after_tool_call hooks
        return !closed;
      },
      sendBlockReply: (payload: { text?: string }) => {
        if (closed || wasClientToolCalled(sessionKey)) {
          return false;
        }
        const text = payload.text?.trim();
        if (!text) {
          return false;
        }

        splitRunIfToolFired();

        if (!messageStarted) {
          messageStarted = true;
          writeEvent({
            type: EventType.TEXT_MESSAGE_START,
            messageId: currentMessageId,
            runId: currentRunId,
            role: "assistant",
          });
        }

        // Join chunks with \n\n (breakPreference: paragraph uses double-newline joiner)
        writeEvent({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: currentMessageId,
          runId: currentRunId,
          delta: text + "\n\n",
        });
        return true;
      },
      sendFinalReply: (payload: { text?: string }) => {
        if (closed) {
          return false;
        }
        const text = wasClientToolCalled(sessionKey) ? "" : payload.text?.trim();

        if (text) {
          splitRunIfToolFired();

          if (!messageStarted) {
            messageStarted = true;
            writeEvent({
              type: EventType.TEXT_MESSAGE_START,
              messageId: currentMessageId,
              runId: currentRunId,
              role: "assistant",
            });
          }
          // Join chunks with \n\n (breakPreference: paragraph uses double-newline joiner)
          writeEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: currentMessageId,
            runId: currentRunId,
            delta: text + "\n\n",
          });
        }
        // End the message and run
        if (messageStarted) {
          writeEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentMessageId,
            runId: currentRunId,
          });
        }
        writeEvent({
          type: EventType.RUN_FINISHED,
          threadId,
          runId: currentRunId,
        });
        closed = true;
        res.end();
        return true;
      },
      waitForIdle: () => Promise.resolve(),
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    };

    // Dispatch the inbound message — this triggers the agent run
    try {
      await runtime.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          runId,
          abortSignal: abortController.signal,
          disableBlockStreaming: false,
          onAgentRunStart: () => {},
          onToolResult: () => {
            // Tool call events are emitted by before/after_tool_call hooks
          },
        },
      });

      // If the dispatcher's final reply didn't close the stream, close it now
      if (!closed) {
        if (messageStarted) {
          writeEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentMessageId,
            runId: currentRunId,
          });
        }
        writeEvent({
          type: EventType.RUN_FINISHED,
          threadId,
          runId: currentRunId,
        });
        closed = true;
        res.end();
      }
    } catch (err) {
      if (!closed) {
        writeEvent({
          type: EventType.RUN_ERROR,
          message: String(err),
        });
        closed = true;
        res.end();
      }
    } finally {
      clearWriter(sessionKey);
      clearClientToolCalled(sessionKey);
      clearClientToolNames(sessionKey);
      clearToolFiredInRun(sessionKey);
    }
  };
}
