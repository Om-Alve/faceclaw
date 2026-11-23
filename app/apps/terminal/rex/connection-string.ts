/**
 * Rex server connection strings, parsed once into every URL the Rex backend
 * needs:
 * - https://<host>[:port][/]: the tailnet address `rex server tailscale pair`
 *   encodes. Control and data run over wss://.
 * - rex://<host>:<port>[/]: a plain-WebSocket relay to a local Rex socket,
 *   such as scripts/rex-relay.mjs over `adb reverse`.
 *
 * Paths, queries, fragments and credentials are rejected rather than dropped:
 * Rex serves its API only at fixed paths, and a user@ prefix picks an account
 * on Rex's login server, which this backend does not support.
 */

const REX_CONTROL_PATH = "/api/control";
const REX_DATA_PATH = "/api/data";

const HTTPS_DEFAULT_PORT = 443;
const MAX_PORT = 65535;

export type RexEndpoint = {
  /** "https" reaches Rex's built-in Tailscale node; "rex" a plain relay. */
  scheme: "https" | "rex";
  /** host[:port] for messages; the port is left out when it is the https default. */
  displayHost: string;
  /** One spelling per server, so the same server is never saved twice. */
  connectionString: string;
  controlUrl: string;
  dataUrl: string;
  /** Base for plain HTTP requests, such as the reachability probe. No trailing slash. */
  httpBase: string;
};

const CONNECTION_STRING =
  /^(https|rex):\/\/(\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?\/?$/i;

/** Parse a Rex connection string; null if it is not one of the two accepted forms. */
export function parseRexConnectionString(input: string): RexEndpoint | null {
  const match = CONNECTION_STRING.exec(input.trim());
  if (!match) return null;
  const scheme = match[1]!.toLowerCase() === "https" ? "https" : "rex";
  const host = match[2]!.toLowerCase();
  if (scheme === "rex" && match[3] === undefined) return null;
  const port = match[3] === undefined ? HTTPS_DEFAULT_PORT : parseInt(match[3], 10);
  if (!(port >= 1 && port <= MAX_PORT)) return null;
  const displayHost = scheme === "https" && port === HTTPS_DEFAULT_PORT ? host : `${host}:${port}`;
  const [webSocketScheme, httpScheme] = scheme === "https" ? ["wss", "https"] : ["ws", "http"];
  return {
    scheme,
    displayHost,
    connectionString: `${scheme}://${displayHost}`,
    controlUrl: `${webSocketScheme}://${displayHost}${REX_CONTROL_PATH}`,
    dataUrl: `${webSocketScheme}://${displayHost}${REX_DATA_PATH}`,
    httpBase: `${httpScheme}://${displayHost}`,
  };
}
