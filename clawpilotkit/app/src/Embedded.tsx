import {
  CopilotKitProvider,
  CopilotChat,
  WildcardToolCallRender,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";

// Catch-all renderer so any tool call from the agent — `web_search`, MCP
// tools, plugin tools we don't have a bespoke card for — shows up as a
// collapsible pill in the message thread instead of being silently folded
// into the assistant text. Replace or supplement with `defineToolCallRenderer`
// entries (or `useRenderTool`) once we want bespoke cards for specific tools.
const RENDER_TOOL_CALLS = [WildcardToolCallRender];
import { HttpAgent } from "@ag-ui/client";
import { useEffect, useMemo, useState } from "react";
import { subscribeContext } from "./openclaw-bridge";
import type { OpenClawContext } from "./types";

type Props = { initialCtx: OpenClawContext };

// Embedded inside the OpenClaw chat.surface slot. The host owns the session /
// agent / thinking pickers and sidebar — we only render the message thread +
// input area. CopilotKit is wired to the clawg-ui operator-auth AG-UI endpoint
// via `selfManagedAgents` so CopilotRuntime is never involved.
export function Embedded({ initialCtx }: Props) {
  const [ctx, setCtx] = useState<OpenClawContext>(initialCtx);

  useEffect(() => subscribeContext(setCtx), []);

  useEffect(() => {
    document.documentElement.dataset.theme = ctx.theme.resolved;
  }, [ctx.theme.resolved]);

  const runtimeUrl = useMemo(
    () => joinUrl(toHttpOrigin(ctx.gatewayUrl), "/v1/clawg-ui/operator"),
    [ctx.gatewayUrl],
  );

  // Fresh HttpAgent whenever URL, session, or reloadNonce changes. The
  // Authorization header lives on CopilotKitProvider rather than the
  // HttpAgent because CopilotKit's AgentRegistry runs
  // `applyHeadersToAgent` on every HttpAgent instance and overwrites
  // `agent.headers` with the provider's `headers` prop — so anything we
  // set on the agent directly is wiped before the first fetch.
  const agent = useMemo(
    () => new HttpAgent({ url: runtimeUrl }),
    [runtimeUrl, ctx.sessionKey, ctx.reloadNonce],
  );

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${ctx.authToken}` }),
    [ctx.authToken],
  );

  const instanceKey = `${ctx.sessionKey}:${ctx.reloadNonce}`;

  return (
    <CopilotKitProvider
      key={instanceKey}
      agent="default"
      selfManagedAgents={{ default: agent }}
      headers={headers}
      renderToolCalls={RENDER_TOOL_CALLS}
    >
      <div className="clawpilotkit-chat-host">
        <CopilotChat />
      </div>
    </CopilotKitProvider>
  );
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const prefixedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${prefixedPath}`;
}

// Control UI stores `gatewayUrl` as the WebSocket URL (ws:// or wss://) because
// that's what its own transport uses. For HttpAgent fetches we need the http(s)
// equivalent of the same origin.
function toHttpOrigin(url: string): string {
  if (url.startsWith("ws://")) return `http://${url.slice(5)}`;
  if (url.startsWith("wss://")) return `https://${url.slice(6)}`;
  return url;
}
