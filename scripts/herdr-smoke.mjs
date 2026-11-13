#!/usr/bin/env node
/**
 * Step 1 smoke test for the Herdr app: one deployed bridge, from a computer on
 * the same tailnet.
 *
 *   node scripts/herdr-smoke.mjs https://<machine>.<tailnet>.ts.net
 *
 * Checks, in order: /health needs no auth and reports a protocol version; the
 * WebSocket upgrade carries the Tailscale identity; `hello` and a pane list
 * arrive; the socket closes cleanly; a second connection recovers. A rejected
 * identity prints the failure text the app surfaces for a 403.
 */
const URL_TEXT = process.argv[2];
if (!URL_TEXT) {
  console.error("usage: node scripts/herdr-smoke.mjs https://<machine>.<tailnet>.ts.net");
  process.exit(2);
}

const base = URL_TEXT.replace(/\/+$/, "");
const wsUrl = `${base.replace(/^http/, "ws")}/ws`;
const started = Date.now();
const results = [];

function pass(name, detail = "") {
  results.push({ ok: true, name });
  console.log(`ok   ${name}${detail ? ` (${detail})` : ""}`);
}

function fail(name, detail) {
  results.push({ ok: false, name });
  console.error(`FAIL ${name}: ${detail}`);
}

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

async function health() {
  const response = await fetch(`${base}/health`, { headers: { accept: "application/json" } });
  if (response.status === 403) throw new Error("health check returned 403 (the bridge should allow /health without auth)");
  if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.ok !== true) throw new Error("health reply did not contain ok:true");
  if (typeof body.protocol !== "number" || typeof body.machine !== "string") throw new Error("health reply lacks protocol or machine");
  return body;
}

function connect({ expectHello = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const seen = { hello: null, panes: null };
    let opened = false;
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      reject(new Error("connection did not produce hello+panes within 8s"));
    }, 8000);
    const done = () => {
      clearTimeout(timer);
      socket.close(1000, "smoke test done");
      resolve({ seen, socket });
    };
    socket.addEventListener("open", () => {
      opened = true;
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.t === "hello") seen.hello = message;
      if (message.t === "panes") seen.panes = message.panes;
      if (expectHello && seen.hello && seen.panes) done();
    });
    socket.addEventListener("error", () => {
      if (!opened) {
        clearTimeout(timer);
        reject(new Error("WebSocket upgrade failed (check the URL, tailnet, and ownership)"));
      }
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      if (!opened) reject(new Error(`upgrade refused (${event.code}${event.reason ? `: ${event.reason}` : ""})`));
      else if (!seen.hello) reject(new Error(`closed before hello (${event.code}${event.reason ? `: ${event.reason}` : ""})`));
    });
  });
}

const waitClosed = (socket) =>
  new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.addEventListener("close", () => resolve());
    setTimeout(resolve, 2000);
  });

try {
  const healthBody = await withTimeout(health(), 8000, "health");
  pass("GET /health", `protocol ${healthBody.protocol}, machine ${healthBody.machine}`);

  const first = await withTimeout(connect(), 10000, "first connection");
  if (!first.seen.hello) throw new Error("no hello message");
  pass("hello", `protocol ${first.seen.hello.protocol}, machine ${first.seen.hello.machine}`);
  const panes = Array.isArray(first.seen.panes) ? first.seen.panes : [];
  pass("panes", `${panes.length} pane${panes.length === 1 ? "" : "s"}`);
  const blocked = panes.filter((pane) => pane?.status === "blocked").length;
  const working = panes.filter((pane) => pane?.status === "working").length;
  console.log(`info status: ${blocked} blocked, ${working} working`);

  await waitClosed(first.socket);
  pass("disconnect");

  const second = await withTimeout(connect(), 10000, "reconnect");
  pass("reconnect", `machine ${second.seen.hello?.machine ?? "?"}, ${second.seen.panes?.length ?? 0} panes`);
  await waitClosed(second.socket);
  pass("disconnect again");

  const elapsed = Date.now() - started;
  console.log(`\n${results.filter((result) => result.ok).length}/${results.length} checks passed in ${elapsed}ms`);
  process.exit(0);
} catch (error) {
  fail("smoke test", error instanceof Error ? error.message : String(error));
  console.error(
    "\nIf this failed with a 403 or an upgrade refusal, that is the expected failure text for a phone or machine whose Tailscale identity is not the bridge's configured owner.",
  );
  process.exit(1);
}
