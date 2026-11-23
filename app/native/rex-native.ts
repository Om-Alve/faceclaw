/**
 * RexClient on the phone: the control connection over openSocket, with the
 * Rex subprotocol in its one header slot, and the runtime's timers and clock.
 * Kept out of terminal-app.worker.ts so the worker only registers the backend.
 */
import { openSocket } from "./socket";
import { RexClient } from "../apps/terminal/rex-client";
import type { RexEndpoint } from "../apps/terminal/rex/connection-string";
import type { RexSocketFactory } from "../apps/terminal/rex/control";

const ABNORMAL_CLOSURE = 1006;

const openRexSocket: RexSocketFactory = (url, subprotocol, handlers) => {
  const socket = openSocket(
    url,
    {
      onOpen: () => handlers.onOpen(),
      onTextMessage: (message) => handlers.onMessage(message),
      onClosed: (code, reason) => handlers.onClose(code, reason),
      onFailure: (message) => handlers.onClose(ABNORMAL_CLOSURE, message),
    },
    { name: "Sec-WebSocket-Protocol", value: subprotocol },
  );
  return { send: (text) => socket.sendText(text), close: (code, reason) => socket.close(code, reason) };
};

export function createNativeRexClient(endpoint: RexEndpoint, cols: number, rows: number): RexClient {
  return new RexClient({
    endpoint,
    cols,
    rows,
    createSocket: openRexSocket,
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    now: () => Date.now(),
    log: (line) => console.log(line),
  });
}
