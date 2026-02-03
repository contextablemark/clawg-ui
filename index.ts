import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { aguiChannelPlugin } from "./src/channel.js";
import { createAguiHttpHandler } from "./src/http-handler.js";
import { clawgUiToolFactory } from "./src/client-tools.js";
import {
  getWriter,
  pushToolCallId,
  popToolCallId,
  isClientTool,
  setClientToolCalled,
} from "./src/tool-store.js";

const plugin = {
  id: "clawg-ui",
  name: "CLAWG-UI",
  description: "AG-UI protocol endpoint for CopilotKit and HttpAgent clients",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: aguiChannelPlugin });
    api.registerTool(clawgUiToolFactory);
    api.registerHttpRoute({
      path: "/v1/clawg-ui",
      handler: createAguiHttpHandler(api),
    });

    // Emit TOOL_CALL_START + TOOL_CALL_ARGS from before_tool_call hook.
    // For client tools: also emit TOOL_CALL_END immediately (fire-and-forget).
    // For server tools: TOOL_CALL_END is emitted later by tool_result_persist.
    api.on("before_tool_call", (event, ctx) => {
      const sk = ctx.sessionKey;
      if (!sk) return;
      const writer = getWriter(sk);
      if (!writer) return;
      const toolCallId = `tool-${randomUUID()}`;
      writer({
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: event.toolName,
      });
      if (event.params && Object.keys(event.params).length > 0) {
        writer({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: JSON.stringify(event.params),
        });
      }

      if (isClientTool(sk, event.toolName)) {
        // Client tool: emit TOOL_CALL_END now. The run will finish and the
        // client initiates a new run with the tool result.
        writer({
          type: EventType.TOOL_CALL_END,
          toolCallId,
        });
        setClientToolCalled(sk);
      } else {
        // Server tool: push ID so tool_result_persist can emit
        // TOOL_CALL_RESULT + TOOL_CALL_END after execute() completes.
        pushToolCallId(sk, toolCallId);
      }
    });

    // Emit TOOL_CALL_RESULT + TOOL_CALL_END for server-side tools only.
    // Client tools already emitted TOOL_CALL_END in before_tool_call.
    api.on("tool_result_persist", (_event, ctx) => {
      const sk = ctx.sessionKey;
      if (!sk) return;
      const writer = getWriter(sk);
      const toolCallId = popToolCallId(sk);
      if (writer && toolCallId) {
        writer({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          content: "",
        });
        writer({
          type: EventType.TOOL_CALL_END,
          toolCallId,
        });
      }
    });
  },
};

export default plugin;
