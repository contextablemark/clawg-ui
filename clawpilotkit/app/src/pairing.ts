// clawg-ui pairing flow helpers (standalone mode only).
//
// Reference: https://github.com/contextable/clawg-ui#authentication
//
// Flow:
//   1. POST /v1/clawg-ui with no Authorization header -> 403 body carries
//      `error.pairing.token` and `error.pairing.pairingCode`.
//   2. Gateway admin runs `openclaw pairing approve clawg-ui <code>`.
//   3. POST /v1/clawg-ui with `Authorization: Bearer <token>` and an empty
//      JSON body -> 400 means auth passed (invalid body, as expected);
//      403 means pairing is still pending; 401 means the token is invalid
//      (admin revoked or secret rotated, reset the pairing).

export type PairingPending = {
  pairingCode: string;
  token: string;
  instructions?: string;
};

export type PairingCheck =
  | { kind: "approved" }
  | { kind: "pending" }
  | { kind: "token-invalid" }
  | { kind: "unreachable"; detail: string };

export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const prefixedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${prefixedPath}`;
}

export async function initiatePairing(
  gatewayUrl: string,
): Promise<PairingPending> {
  const url = joinUrl(gatewayUrl, "/v1/clawg-ui");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.status !== 403) {
    throw new Error(
      `Unexpected response from gateway (${res.status}); expected 403 pairing_pending`,
    );
  }
  const body = (await res.json().catch(() => null)) as {
    error?: { pairing?: PairingPending };
  } | null;
  const pairing = body?.error?.pairing;
  if (!pairing || !pairing.token || !pairing.pairingCode) {
    throw new Error("Gateway did not return a pairing code");
  }
  return pairing;
}

export async function checkPairing(
  gatewayUrl: string,
  token: string,
): Promise<PairingCheck> {
  const url = joinUrl(gatewayUrl, "/v1/clawg-ui");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
  } catch (err) {
    return {
      kind: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 400) return { kind: "approved" };
  if (res.status === 403) return { kind: "pending" };
  if (res.status === 401) return { kind: "token-invalid" };
  // 200 would mean the gateway accepted an empty-messages run; some older
  // clawg-ui versions return a valid empty SSE stream for that. Treat any
  // 2xx as "approved" too — auth clearly succeeded.
  if (res.status >= 200 && res.status < 300) return { kind: "approved" };
  return {
    kind: "unreachable",
    detail: `Unexpected status ${res.status}`,
  };
}
