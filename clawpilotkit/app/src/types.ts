// Shape of the context the OpenClaw host sends after our `openclaw:ready`
// ping. See openclaw/ui/src/ui/views/extension-tab.ts for the sender.
export type OpenClawContext = {
  gatewayUrl: string;
  authToken: string;
  sessionKey: string;
  basePath: string;
  theme: { mode: "light" | "dark"; resolved: "light" | "dark" };
  locale: string;
  reloadNonce: number;
};

export type ResolvedMode =
  | { kind: "embedded"; ctx: OpenClawContext }
  | { kind: "standalone" };
