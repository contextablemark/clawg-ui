import {
  CopilotKitProvider,
  CopilotChat,
  WildcardToolCallRender,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";

// See Embedded.tsx for rationale; both modes share the same fallback.
const RENDER_TOOL_CALLS = [WildcardToolCallRender];
import { HttpAgent } from "@ag-ui/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  checkPairing,
  initiatePairing,
  joinUrl,
  type PairingPending,
} from "./pairing";

type PersistedConfig = {
  gatewayUrl: string;
  token: string | null;
  pendingPairingCode: string | null;
};

const STORAGE_KEY = "clawpilotkit.config";

function readConfig(): PersistedConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
    if (typeof parsed.gatewayUrl !== "string" || !parsed.gatewayUrl) return null;
    return {
      gatewayUrl: parsed.gatewayUrl,
      token: typeof parsed.token === "string" ? parsed.token : null,
      pendingPairingCode:
        typeof parsed.pendingPairingCode === "string"
          ? parsed.pendingPairingCode
          : null,
    };
  } catch {
    return null;
  }
}

function writeConfig(cfg: PersistedConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

function clearConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

type View =
  | { kind: "setup"; error?: string }
  | { kind: "pairing"; gatewayUrl: string; pairing: PairingPending; status: string }
  | { kind: "connected"; gatewayUrl: string; token: string }
  | { kind: "checking" };

export function Standalone() {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [threadId, setThreadId] = useState<string>(
    () => `clawpilotkit-${Date.now()}`,
  );

  const tryConnectWithToken = useCallback(
    async (gatewayUrl: string, token: string): Promise<View> => {
      const result = await checkPairing(gatewayUrl, token);
      switch (result.kind) {
        case "approved":
          writeConfig({ gatewayUrl, token, pendingPairingCode: null });
          return { kind: "connected", gatewayUrl, token };
        case "pending":
          return {
            kind: "pairing",
            gatewayUrl,
            pairing: {
              token,
              pairingCode:
                readConfig()?.pendingPairingCode ?? "(code not saved)",
            },
            status: "Still waiting for admin approval.",
          };
        case "token-invalid":
          clearConfig();
          return {
            kind: "setup",
            error: "Device token is no longer valid. Please re-pair.",
          };
        case "unreachable":
          return {
            kind: "setup",
            error: `Cannot reach gateway: ${result.detail}`,
          };
      }
    },
    [],
  );

  useEffect(() => {
    const cfg = readConfig();
    if (!cfg) {
      setView({ kind: "setup" });
      return;
    }
    if (!cfg.token) {
      setView({ kind: "setup" });
      return;
    }
    void tryConnectWithToken(cfg.gatewayUrl, cfg.token).then(setView);
  }, [tryConnectWithToken]);

  const onStartPairing = useCallback(async (gatewayUrl: string) => {
    try {
      const pairing = await initiatePairing(gatewayUrl);
      writeConfig({
        gatewayUrl,
        token: pairing.token,
        pendingPairingCode: pairing.pairingCode,
      });
      setView({
        kind: "pairing",
        gatewayUrl,
        pairing,
        status: "Waiting for admin approval.",
      });
    } catch (err) {
      setView({
        kind: "setup",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const onCheckApproval = useCallback(async () => {
    const cfg = readConfig();
    if (!cfg?.token) {
      setView({ kind: "setup" });
      return;
    }
    const next = await tryConnectWithToken(cfg.gatewayUrl, cfg.token);
    setView(next);
  }, [tryConnectWithToken]);

  const onReset = useCallback(() => {
    clearConfig();
    setView({ kind: "setup" });
  }, []);

  const onNewThread = useCallback(() => {
    setThreadId(`clawpilotkit-${Date.now()}`);
  }, []);

  if (view.kind === "checking") {
    return (
      <Shell title="CLAWPILOTKIT">
        <p>Connecting…</p>
      </Shell>
    );
  }

  if (view.kind === "setup") {
    return (
      <Shell title="CLAWPILOTKIT — setup">
        <SetupForm onSubmit={onStartPairing} error={view.error} />
      </Shell>
    );
  }

  if (view.kind === "pairing") {
    return (
      <Shell title="CLAWPILOTKIT — pairing">
        <PairingPanel
          gatewayUrl={view.gatewayUrl}
          pairing={view.pairing}
          status={view.status}
          onCheck={onCheckApproval}
          onReset={onReset}
        />
      </Shell>
    );
  }

  return (
    <Shell
      title="CLAWPILOTKIT"
      chrome={
        <ConnectedBar
          gatewayUrl={view.gatewayUrl}
          threadId={threadId}
          onNewThread={onNewThread}
          onReset={onReset}
        />
      }
    >
      <ChatPane
        gatewayUrl={view.gatewayUrl}
        token={view.token}
        threadId={threadId}
      />
    </Shell>
  );
}

function ChatPane({
  gatewayUrl,
  token,
  threadId,
}: {
  gatewayUrl: string;
  token: string;
  threadId: string;
}) {
  // CopilotKit overwrites HttpAgent.headers from the provider's `headers`
  // prop (see Embedded.tsx for the rationale), so the bearer token has to
  // live on the provider rather than on the agent.
  const agent = useMemo(
    () => new HttpAgent({ url: joinUrl(gatewayUrl, "/v1/clawg-ui") }),
    [gatewayUrl, threadId],
  );
  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}` }),
    [token],
  );
  return (
    <CopilotKitProvider
      key={`${token}:${threadId}`}
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

// ---------------------------------------------------------------------------
// Presentational subcomponents
// ---------------------------------------------------------------------------

function Shell({
  title,
  chrome,
  children,
}: {
  title: string;
  chrome?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="clawpilotkit-shell">
      <header className="clawpilotkit-header">
        <h1>{title}</h1>
      </header>
      {chrome}
      <main className="clawpilotkit-main">{children}</main>
    </div>
  );
}

function SetupForm({
  onSubmit,
  error,
}: {
  onSubmit: (gatewayUrl: string) => void;
  error?: string;
}) {
  const [value, setValue] = useState<string>(
    () => `${window.location.protocol}//${window.location.host}`,
  );
  return (
    <form
      className="clawpilotkit-setup"
      onSubmit={(ev) => {
        ev.preventDefault();
        const trimmed = value.trim().replace(/\/+$/, "");
        if (trimmed) onSubmit(trimmed);
      }}
    >
      <label htmlFor="gatewayUrl">OpenClaw gateway URL</label>
      <input
        id="gatewayUrl"
        name="gatewayUrl"
        type="url"
        placeholder="http://localhost:18789"
        value={value}
        onChange={(ev) => setValue(ev.target.value)}
        required
      />
      <button type="submit">Connect</button>
      {error ? <p className="clawpilotkit-error">{error}</p> : null}
    </form>
  );
}

function PairingPanel({
  gatewayUrl,
  pairing,
  status,
  onCheck,
  onReset,
}: {
  gatewayUrl: string;
  pairing: PairingPending;
  status: string;
  onCheck: () => void;
  onReset: () => void;
}) {
  const command = `openclaw pairing approve clawg-ui ${pairing.pairingCode}`;
  return (
    <div className="clawpilotkit-pairing">
      <p>
        Connected to <code>{gatewayUrl}</code>. Ask the gateway owner to
        approve this device by running:
      </p>
      <pre className="clawpilotkit-code">{command}</pre>
      <p>
        Pairing code: <strong>{pairing.pairingCode}</strong>
      </p>
      <p className="clawpilotkit-status">{status}</p>
      <div className="clawpilotkit-button-row">
        <button type="button" onClick={onCheck}>
          Check approval
        </button>
        <button type="button" onClick={onReset}>
          Start over
        </button>
      </div>
    </div>
  );
}

function ConnectedBar({
  gatewayUrl,
  threadId,
  onNewThread,
  onReset,
}: {
  gatewayUrl: string;
  threadId: string;
  onNewThread: () => void;
  onReset: () => void;
}) {
  return (
    <div className="clawpilotkit-chrome">
      <span className="clawpilotkit-chrome-label">
        Connected to <code>{gatewayUrl}</code> — thread{" "}
        <code>{threadId}</code>
      </span>
      <div className="clawpilotkit-chrome-actions">
        <button type="button" onClick={onNewThread}>
          New thread
        </button>
        <button type="button" onClick={onReset}>
          Disconnect
        </button>
      </div>
    </div>
  );
}
