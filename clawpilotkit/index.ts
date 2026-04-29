import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createStaticUiHandler } from "./src/static-ui-handler.js";

const plugin: {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "clawpilotkit",
  name: "CLAWPILOTKIT",
  description:
    "CopilotKit-based UI for OpenClaw — embeds as a chat.surface slot and also serves a standalone client",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // Register the static UI route via plugin-runtime. api.registerHttpRoute
    // writes to the loader's private registry which the gateway HTTP handler
    // does not read; registerPluginHttpRoute writes to the pinned registry.
    import("openclaw/plugin-sdk/plugin-runtime")
      .then((mod: any) => {
        mod.registerPluginHttpRoute({
          path: "/v1/clawpilotkit/ui",
          auth: "plugin",
          match: "prefix",
          pluginId: "clawpilotkit",
          handler: createStaticUiHandler(),
        });
      })
      .catch((err: unknown) => {
        console.error("[clawpilotkit] failed to register HTTP routes:", err);
      });
  },
};

export default plugin;
