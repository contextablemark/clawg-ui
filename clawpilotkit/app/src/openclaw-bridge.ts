import type { OpenClawContext } from "./types";

const CONTEXT_MESSAGE_TYPE = "openclaw:context";
const READY_MESSAGE_TYPE = "openclaw:ready";

// How long we wait for the host to deliver a context payload before deciding
// we're running standalone. The host normally replies within a few ms; 500ms
// is a generous upper bound that still keeps the standalone-mode fallback
// snappy for users who just double-clicked the URL.
const EMBEDDED_PROBE_TIMEOUT_MS = 500;

// Ping cadence while we're waiting for the embedded-host handshake. Matches
// the pattern from the earlier placeholder mount.js: the host attaches its
// listener lazily so our first `ready` may land before anyone is listening.
const READY_PING_INTERVAL_MS = 80;

function isRunningInIframe(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

function postReady(): void {
  if (!window.parent || window.parent === window) return;
  try {
    window.parent.postMessage({ type: READY_MESSAGE_TYPE }, "*");
  } catch {
    // The parent may be in a context where postMessage is rejected. Nothing
    // we can do about that from here — the caller's timeout will fire and
    // we'll drop into standalone mode.
  }
}

function isContextMessage(data: unknown): data is { ctx: OpenClawContext } {
  if (!data || typeof data !== "object") return false;
  const msg = data as { type?: unknown; ctx?: unknown };
  if (msg.type !== CONTEXT_MESSAGE_TYPE) return false;
  return typeof msg.ctx === "object" && msg.ctx !== null;
}

// Await either an initial `openclaw:context` from the host or a
// standalone-mode timeout. Resolves with the first ctx payload received, or
// `null` if we should fall back to standalone mode.
export function waitForInitialContext(): Promise<OpenClawContext | null> {
  return new Promise((resolve) => {
    if (!isRunningInIframe()) {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (ctx: OpenClawContext | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(pingInterval);
      clearTimeout(timeoutHandle);
      resolve(ctx);
    };

    const onMessage = (event: MessageEvent) => {
      if (!isContextMessage(event.data)) return;
      finish(event.data.ctx);
    };
    window.addEventListener("message", onMessage);

    postReady();
    const pingInterval = window.setInterval(postReady, READY_PING_INTERVAL_MS);
    const timeoutHandle = window.setTimeout(
      () => finish(null),
      EMBEDDED_PROBE_TIMEOUT_MS,
    );
  });
}

// Subscribe to subsequent context updates (session change, theme toggle,
// reloadNonce bump). The callback is invoked on every `openclaw:context`
// message after the initial handshake; returns an unsubscribe function.
export function subscribeContext(cb: (ctx: OpenClawContext) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (!isContextMessage(event.data)) return;
    cb(event.data.ctx);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
