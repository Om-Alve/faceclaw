import { parseRexConnectionString, type RexEndpoint } from "./connection-string";

/**
 * Sends `HEAD url` and resolves with the HTTP status of the first response,
 * without following redirects, so a captive portal's page does not pass for
 * Rex. Rejects on a network error, or when no response arrives within
 * `timeoutMs`.
 */
export type RexHttpHead = (url: string, timeoutMs: number) => Promise<number>;

const PROBE_PATH = "/llms.txt";
// Under the 5 s budget for showing a failure, with time left to render it.
const REX_PROBE_TIMEOUT_MS = 4000;
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;

/**
 * "refused": Rex answers every request from a caller its access rules deny
 * with 403. "unreachable": no answer, or an answer that is neither 200 nor
 * 403, which means whatever answered is not a Rex server that will take the
 * control socket.
 */
export type RexProbeResult = "reachable" | "refused" | "unreachable";

/**
 * Probe Rex over plain HTTP before opening the control socket. A refused
 * WebSocket upgrade surfaces without its HTTP status, so only this request
 * tells a refused device from an unreachable server.
 */
export async function probeRex(endpoint: RexEndpoint, head: RexHttpHead): Promise<RexProbeResult> {
  let status: number;
  try {
    status = await head(`${endpoint.httpBase}${PROBE_PATH}`, REX_PROBE_TIMEOUT_MS);
  } catch {
    return "unreachable";
  }
  if (status === HTTP_OK) return "reachable";
  if (status === HTTP_FORBIDDEN) return "refused";
  return "unreachable";
}

export type RexFailureNotice = { line: string; hint: string };

export function rexFailureNotice(endpoint: RexEndpoint, failure: Exclude<RexProbeResult, "reachable">): RexFailureNotice {
  if (failure === "refused") {
    return { line: "Rex refused this device", hint: "Sign the phone into the same tailnet account" };
  }
  return {
    line: `Can't reach ${endpoint.displayHost}`,
    hint: endpoint.scheme === "https" ? "Check that Tailscale is on" : "Check that the relay is running",
  };
}

// A string tag, not an ok boolean: the app compiles without strictNullChecks,
// where a boolean-discriminated union does not narrow.
export type RexQrScan = { kind: "address"; connectionString: string } | { kind: "rejected"; message: string };

/**
 * What to save for a connection string the user added: a Rex address in its
 * canonical spelling, anything else as typed. Null when the same Rex server
 * is already saved under any spelling, so its panes are not listed twice.
 */
export function connectionStringToSave(input: string, saved: readonly string[]): string | null {
  const endpoint = parseRexConnectionString(input);
  if (!endpoint) return input;
  const known = saved.some((url) => parseRexConnectionString(url)?.connectionString === endpoint.connectionString);
  return known ? null : endpoint.connectionString;
}

/** Accept the https:// address that `rex server tailscale pair` shows as a QR code. */
export function parseRexPairingQr(payload: string): RexQrScan {
  const endpoint = parseRexConnectionString(payload);
  if (endpoint?.scheme !== "https") return { kind: "rejected", message: "Not a Rex pairing code" };
  return { kind: "address", connectionString: endpoint.connectionString };
}
