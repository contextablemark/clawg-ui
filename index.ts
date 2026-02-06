import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Command } from "commander";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { aguiChannelPlugin } from "./src/channel.js";
import { createAguiHttpHandler } from "./src/http-handler.js";
import { clawgUiToolFactory } from "./src/client-tools.js";
import {
  getWriter,
  getMessageId,
  pushToolCallId,
  popToolCallId,
  isClientTool,
  setClientToolCalled,
  setToolFiredInRun,
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
      console.log(`[clawg-ui] before_tool_call: tool=${event.toolName}, sessionKey=${sk ?? "none"}, hasParams=${!!(event.params && Object.keys(event.params).length > 0)}, params=${JSON.stringify(event.params ?? {})}`);
      if (!sk) {
        console.log(`[clawg-ui] before_tool_call: skipping, no sessionKey`);
        return;
      }
      const writer = getWriter(sk);
      if (!writer) {
        console.log(`[clawg-ui] before_tool_call: skipping, no writer for sessionKey=${sk}`);
        return;
      }
      const toolCallId = `tool-${randomUUID()}`;
      console.log(`[clawg-ui] before_tool_call: emitting TOOL_CALL_START, toolCallId=${toolCallId}`);
      writer({
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: event.toolName,
      });
      setToolFiredInRun(sk);
      if (event.params && Object.keys(event.params).length > 0) {
        console.log(`[clawg-ui] before_tool_call: emitting TOOL_CALL_ARGS, params=${JSON.stringify(event.params)}`);
        writer({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: JSON.stringify(event.params),
        });
      }

      if (isClientTool(sk, event.toolName)) {
        // Client tool: emit TOOL_CALL_END now. The run will finish and the
        // client initiates a new run with the tool result.
        console.log(`[clawg-ui] before_tool_call: client tool detected, emitting TOOL_CALL_END immediately`);
        writer({
          type: EventType.TOOL_CALL_END,
          toolCallId,
        });
        setClientToolCalled(sk);
      } else {
        // Server tool: push ID so tool_result_persist can emit
        // TOOL_CALL_RESULT + TOOL_CALL_END after execute() completes.
        console.log(`[clawg-ui] before_tool_call: server tool, pushing toolCallId to stack`);
        pushToolCallId(sk, toolCallId);
      }
    });

    // Emit TOOL_CALL_RESULT + TOOL_CALL_END for server-side tools only.
    // Client tools already emitted TOOL_CALL_END in before_tool_call.
    api.on("tool_result_persist", (event, ctx) => {
      const sk = ctx.sessionKey;
      console.log(`[clawg-ui] tool_result_persist: sessionKey=${sk ?? "none"}, event=${JSON.stringify(event)}`);
      if (!sk) {
        console.log(`[clawg-ui] tool_result_persist: skipping, no sessionKey`);
        return;
      }
      const writer = getWriter(sk);
      const toolCallId = popToolCallId(sk);
      const messageId = getMessageId(sk);
      console.log(`[clawg-ui] tool_result_persist: writer=${writer ? "present" : "missing"}, toolCallId=${toolCallId ?? "none"}, messageId=${messageId ?? "none"}`);
      if (writer && toolCallId && messageId) {
        console.log(`[clawg-ui] tool_result_persist: emitting TOOL_CALL_RESULT and TOOL_CALL_END`);
        writer({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          messageId,
          content: "",
        });
        writer({
          type: EventType.TOOL_CALL_END,
          toolCallId,
        });
      }
    });

    // CLI commands for device management
    api.registerCli(
      ({ program }: { program: Command }) => {
        const clawgUi = program
          .command("clawg-ui")
          .description("CLAWG-UI (AG-UI) channel commands");

        clawgUi
          .command("devices")
          .description("List approved devices")
          .action(async () => {
            const devices = await api.runtime.channel.pairing.readAllowFromStore("clawg-ui");
            if (devices.length === 0) {
              console.log("No approved devices.");
              return;
            }
            console.log("Approved devices:");
            for (const deviceId of devices) {
              console.log(`  ${deviceId}`);
            }
          });
      },
      { commands: ["clawg-ui"] },
    );
  },
};

export default plugin;
