import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
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
} from "./tool-store.js";

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
  sendJson(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
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

  for (const msg of messages) {
    const role = msg.role?.trim() ?? "";
    const content = extractTextContent(msg).trim();
    if (!role || !content) {
      continue;
    }
    if (role === "system") {
      systemParts.push(content);
      continue;
    }
    if (role === "user") {
      lastUserBody = content;
      parts.push(`User: ${content}`);
    } else if (role === "assistant") {
      parts.push(`Assistant: ${content}`);
    } else if (role === "tool") {
      parts.push(`Tool: ${content}`);
    }
  }

  // If there's only a single user message, use it directly (no envelope needed)
  const userMessages = messages.filter((m) => m.role === "user");
  const body =
    userMessages.length === 1 && parts.length === 1
      ? lastUserBody
      : parts.join("\n");

  return {
    body,
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Token-based auth check against gateway config
// ---------------------------------------------------------------------------

function authenticateRequest(
  req: IncomingMessage,
  api: OpenClawPluginApi,
): boolean {
  const token = getBearerToken(req);
  if (!token) {
    return false;
  }
  // Read the configured gateway token from config
  const gatewayAuth = api.config.gateway?.auth;
  const configuredToken =
    (gatewayAuth as Record<string, unknown> | undefined)?.token ??
    process.env.OPENCLAW_GATEWAY_TOKEN ??
    process.env.CLAWDBOT_GATEWAY_TOKEN;
  if (typeof configuredToken !== "string" || !configuredToken) {
    return false;
  }
  // Constant-time comparison
  if (token.length !== configuredToken.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ configuredToken.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// HTTP handler factory
// ---------------------------------------------------------------------------

export function createAguiHttpHandler(api: OpenClawPluginApi) {
  const runtime: PluginRuntime = api.runtime;

  return async function handleAguiRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // POST-only
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return;
    }

    // Auth
    if (!authenticateRequest(req, api)) {
      sendUnauthorized(res);
      return;
    }

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
    if (!hasUserMessage) {
      sendJson(res, 400, {
        error: {
          message: "At least one user message is required in `messages`.",
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
    const messageId = `msg-${randomUUID()}`;
    let messageStarted = false;

    const writeEvent = (event: Record<string, unknown>) => {
      if (closed) {
        return;
      }
      try {
        res.write(encoder.encode(event));
      } catch {
        // Client may have disconnected
        closed = true;
      }
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
    setWriter(sessionKey, writeEvent);
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
      From: `clawg-ui:${threadId}`,
      To: "clawg-ui",
      SessionKey: sessionKey,
      ChatType: "direct",
      ConversationLabel: "AG-UI",
      SenderName: "AG-UI Client",
      SenderId: `clawg-ui-${threadId}`,
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
        if (!messageStarted) {
          messageStarted = true;
          writeEvent({
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          });
        }
        writeEvent({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: text,
        });
        return true;
      },
      sendFinalReply: (payload: { text?: string }) => {
        if (closed) {
          return false;
        }
        const text = wasClientToolCalled(sessionKey) ? "" : payload.text?.trim();
        if (text) {
          if (!messageStarted) {
            messageStarted = true;
            writeEvent({
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
            });
          }
          writeEvent({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: text,
          });
        }
        // End the message and run
        if (messageStarted) {
          writeEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId,
          });
        }
        writeEvent({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
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
            messageId,
          });
        }
        writeEvent({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
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
    }
  };
}
