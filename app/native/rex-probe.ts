/**
 * The Rex backend as the Terminal worker registers it: RexClient behind the
 * reachability probe, which sends its HEAD request through the app's HTTP
 * helper.
 */
import { fetchTextWithUserAgent } from "../util/http";
import { createNativeRexClient } from "./rex-native";
import type { TerminalClient } from "../apps/terminal/terminal-client";
import type { RexEndpoint } from "../apps/terminal/rex/connection-string";
import type { RexHttpHead } from "../apps/terminal/rex/pairing";
import { RexProbedClient } from "../apps/terminal/rex/probed-client";

/** The HTTP stack's timeout covers each stage, so a separate timer bounds the whole request. */
const rexHttpHead: RexHttpHead = async (url, timeoutMs) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HEAD ${url} timed out`)), timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchTextWithUserAgent(url, { method: "HEAD", timeoutMs, dontFollowRedirects: true }),
      timeout,
    ]);
    return response.status;
  } finally {
    clearTimeout(timer);
  }
};

export function createProbedRexClient(endpoint: RexEndpoint, cols: number, rows: number): TerminalClient {
  return new RexProbedClient(createNativeRexClient(endpoint, cols, rows), endpoint, rexHttpHead);
}
