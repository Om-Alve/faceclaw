/**
 * Herdr app, hosted in its own worker thread: one window that follows and
 * controls Herdr panes across the wearer's machines (design/herdr/PLAN.md).
 *
 * Screens, inside the one "herdr:main" window:
 * - setup: first run. Scan the bridge's pairing QR or type its URL on the
 *   phone; the hub replaces it once a bridge says hello.
 * - hub: panes needing the wearer first, then workspaces across every machine.
 *   A one-pane workspace opens its pane directly.
 * - workspace: the panes of one Herdr workspace.
 * - pane: a readable conversation or screen view with an entry-id scroll
 *   anchor, a frozen position while output streams in, unread starts, queue
 *   lines and a live-tail jump.
 * - subagent: a read-only transcript reached from its parent pane.
 * - compose / review: one draft with a fixed target, from voice, the phone
 *   keyboard or the watch, confirmed before it is sent.
 * - machines: add, connect, retry and remove bridges (machine management also
 *   lives in the window menu, not in the daily list).
 * Keys mode is an overlay on the pane reader, not a screen.
 *
 * Connections: one persistent HerdrMachineClient per enabled machine record,
 * deduplicated by `hello.machine`. Only the displayed pane has an open view
 * subscription; the client reopens it after a reconnect. The worker also
 * publishes the Glanceboard snapshot, raises attention and (optionally) wakes
 * the glasses for a new blocked pane, and answers the assistant's Herdr tools.
 *
 * Frames are painted here and submitted straight to the compositor from this
 * worker's thread.
 */
import "@nativescript/core/globals";
import { finishWorkerShutdown } from "../../ui/shell/worker-lifecycle";
import { GrayImage, type UiFont } from "../../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, type Plane } from "../../graphics/plane";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import * as frameTimings from "../../native/frame-timings";
import { getActiveDisplay } from "../../native/active-display";
import { getStringSetting, onSettingsStoreChanged, setStringSetting } from "../../native/settings-store";
import { openSocket } from "../../native/socket";
import { scanQrCode } from "../../native/qr-scan";
import { drawSubmenuIndicator, drawToggleMenuItem, submenuItem, type MenuItem } from "../../ui/menu";
import { Menu, type MenuDrawArgs } from "../../ui/menu-core";
import { lineStep, listRowHeight } from "../../ui/metrics";
import { WindowMenu, WindowMenuLayer } from "../../ui/window-menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import type { ToolResult, ToolSpec } from "../../assistant/tool-registry";
import { GESTURE_CLICK, directionalFallback, type InputEvent } from "../../ui/gestures";
import { isAllowedKey, normalizePromptText, promptRevision, PROTOCOL_VERSION_3, type ChatEntry, type PaneSummary, type SubagentSummary } from "./protocol";
import {
  buildHub,
  canQueue,
  chatHeader,
  cleanEntries,
  draftTarget,
  duplicateMachineIds,
  formatAge,
  fullPaneKey,
  groupWorkspaces,
  isDoneUnseen,
  KEY_PALETTE,
  markRead,
  needingCount,
  oneLine,
  paneRowLabel,
  primaryAction,
  queueSummaryText,
  refKey,
  rowLabel,
  sendNowLabel,
  snippetActions,
  sortSubagents,
  statusLabel,
  subHeader,
  subRow,
  urlFromQrPayload,
  validateDraft,
  workspaceKey,
  workspaceRowLabel,
  type Draft,
  type DraftProblem,
  type Hub,
  type PaneRef,
  type ReadMarkers,
  type WorkspaceGroup,
} from "./model";
import { HerdrMachineClient, describeSocketFailure, type ClientSnapshot, type HerdrSocket, type SocketFactory, type ViewState, type WriteResult } from "./client";
import { anchorAt, firstUnreadEntryId, latestActivity, layoutReader, lineForAnchor, newOutputCount, resolveScroll, trimEntries, type ReaderLine, type ScrollAnchor } from "./reader";
import { canEnterKeysMode, KEYS_MODE_HINT, keysForDirection, keysModeBanner } from "./keys";
import { buildGlanceSnapshot, HERDR_GLANCE_STATE_KEY, wakeCandidates } from "./glance";
import {
  HERDR_COMPOSE_DRAFT_KEY,
  HERDR_URL_DRAFT_KEY,
  addMachineFromUrl,
  loadMachines,
  machineDisplayName,
  removeMachine,
  updateMachine,
  type HerdrMachine,
} from "./machines";
import { loadReadMarkers, saveReadMarkers, setWakeOnBlocked, wakeOnBlockedEnabled } from "./settings";
import { hasHerdrBackgroundWork } from "./background";

declare const global: any;

const APP_TITLE = "Herdr";
const MAIN_WINDOW_ID = "herdr:main";
/** Coalesce stream-driven repaints: a busy pane can update several times a second. */
const DATA_RENDER_COALESCE_MS = 150;
const PUBLISH_COALESCE_MS = 300;
const NOTICE_MS = 6_000;
const WAKE_COALESCE_MS = 250;
const READER_STATE_LIMIT = 40;
const TITLE_X = 14;
const TITLE_Y = 8;
const LIST_LEFT = 10;
const LIST_RIGHT = 18;
const BODY_LEFT = 12;
const BODY_RIGHT = 16;
const READER_HEADER_LINES = 3;

function font(): UiFont {
  return getDefaultSmallFont();
}

// ---------------------------------------------------------------------------
// State

type ComposeKind = "message" | "command" | "type";

type Screen =
  | { kind: "setup"; editingUrl: boolean; returnTo: "hub" | "machines"; busy: string; error: string }
  | { kind: "hub" }
  | { kind: "workspace"; machineId: string; session: string; workspace: string }
  | { kind: "pane"; machineId: string; paneId: string; fromHub?: boolean }
  | { kind: "subagent"; machineId: string; paneId: string; subagent: SubagentSummary; fromHub?: boolean }
  | { kind: "compose"; machineId: string; paneId: string }
  | { kind: "review" }
  | { kind: "machines" };

type AppWindow = {
  windowId: string;
  surfaceId: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  focused: boolean;
  menu: WindowMenu | null;
  lastSubmittedFingerprint: string;
  renderTimer: ReturnType<typeof setTimeout> | null;
};

type ListItem = {
  key: string;
  kind: "heading" | "tag" | "pane" | "workspace" | "action" | "text";
  label: string;
  right?: string;
  marker?: string;
  markerValue?: number;
  submenu?: boolean;
  onSelect?: () => void;
};

type ReaderState = {
  /** The top visible entry, or null to follow the live tail. */
  anchor: ScrollAnchor | null;
  /** Lines below the anchor when it was frozen, so "N new" counts only new output. */
  anchorBelow: number;
  anchorLost: boolean;
  /** Entry that starts the unread stretch, drawn with the "— new —" marker. */
  firstUnread: string | null;
  decideUnread: boolean;
  needsFreeze: boolean;
  lastDataAt: number;
  lastSignature: string;
  loadingOlder: boolean;
  olderRequestedFor: string | null;
  /** Last content held while the connection is down (the client drops its view on close). */
  cache: ViewState | null;
  cacheKey: string;
};

type ComposeState = {
  key: string;
  kind: ComposeKind;
  machineId: string;
  paneId: string;
  draft: Draft;
  returnTo: Screen;
  /** The pane was opened from the hub, so Back from it returns there. */
  fromHub: boolean;
};

type ReaderScope = { machineId: string; paneId: string; subagentId?: string };

type AnswerGuard = { machineId: string; paneId: string; stateSeq: number; promptText: string };

type PaneMatch = { client: HerdrMachineClient; ref: PaneRef };

let window: AppWindow | null = null;
let screen: Screen = { kind: "hub" };
let screenOn = true;
let notice: { text: string; untilMs: number } | null = null;

const clients = new Map<string, HerdrMachineClient>();
let machineRecords: HerdrMachine[] = loadMachines();
/** Records suppressed because another record reports the same `hello.machine`. */
let duplicates = new Set<string>();
const lastPhase = new Map<string, string>();
const lastPanes = new Map<string, readonly PaneSummary[]>();
/** Machines whose next pane snapshot is a baseline, not a wake-worthy event. */
const baselinePending = new Set<string>();
const blockedIdentities = new Map<string, string>();
let lastNotified: { key: string; identity: string } | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

let readMarkers: ReadMarkers = loadReadMarkers();
const readers = new Map<string, ReaderState>();
const drafts = new Map<string, Draft>();
let compose: ComposeState | null = null;
/** A write whose reply never arrived, for the explicit Check output action (never auto-retried). */
let deliveryUnknown: { machineId: string; paneId: string } | null = null;

let keysMode: { machineId: string; paneId: string } | null = null;
/** Which flow owns the phone text editor, so Back ends the right one. */
let textEditOwner: "url" | "draft" | null = null;
let viewTargetKey = "";

let listMenu: Menu<ListItem> | null = null;
let hubSelectionKey: string | null = null;
let machinesSelectionKey: string | null = null;
let reviewSelectionKey: string | null = null;
let composeSelectionKey: string | null = "review";
const workspaceSelections = new Map<string, string>();

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let publishTimer: ReturnType<typeof setTimeout> | null = null;
let lastPublishedSnapshot = "";
let scanning = false;
let dedupeGuard = false;

function post(message: WorkerAppReply): void {
  global.postMessage(message);
}

function showNotice(text: string): void {
  notice = { text, untilMs: Date.now() + NOTICE_MS };
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    notice = null;
    render();
  }, NOTICE_MS);
  render();
}

function activeNotice(): string {
  return notice && notice.untilMs > Date.now() ? notice.text : "";
}

// ---------------------------------------------------------------------------
// Assistant tools

const HERDR_TOOLS: ToolSpec[] = [
  {
    name: "list_panes",
    description: "List the Herdr panes on the user's machines with their machine, workspace, agent, status and queued-message counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "read_pane",
    description: "Read the recent conversation or screen text of one Herdr pane. Find it with machine and a workspace or pane id.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Machine label or id; omit when only one machine has a match." },
        pane: { type: "string", description: "Bridge pane id (default/w1:p1), short pane id (w1:p1), workspace or title." },
        workspace: { type: "string", description: "Workspace name, to narrow the match." },
        subagent: { type: "string", description: "Subagent id, to read a subagent's transcript." },
      },
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
  {
    name: "send_text",
    description:
      "Send text to one Herdr pane: an agent message on an agent pane, a shell command otherwise. Queues it for a working agent when queue is true.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Machine label or id; omit when only one machine has a match." },
        pane: { type: "string", description: "Bridge pane id (default/w1:p1), short pane id, workspace or title." },
        workspace: { type: "string", description: "Workspace name, to narrow the match." },
        text: { type: "string", description: "The message or command to send." },
        queue: { type: "boolean", description: "Hold an agent message until the agent is idle." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
  {
    name: "send_keys",
    description: "Send allowed key combos to one Herdr pane, e.g. [\"enter\"], [\"ctrl+c\"], [\"up\"], [\"y\"].",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Machine label or id; omit when only one machine has a match." },
        pane: { type: "string", description: "Bridge pane id, short pane id, workspace or title." },
        workspace: { type: "string", description: "Workspace name, to narrow the match." },
        keys: { type: "array", items: { type: "string" }, description: "Key combos, each valid for Herdr pane.send_keys." },
      },
      required: ["keys"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
  {
    name: "queue_list",
    description: "List queued and undelivered messages for Herdr panes, with item ids where the pane is open.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Machine label or id, to narrow the list." },
        pane: { type: "string", description: "Bridge pane id, short pane id, workspace or title." },
      },
      additionalProperties: false,
    },
    availability: "open",
  },
  {
    name: "queue_remove",
    description: "Remove a queued message from a Herdr pane's bridge queue. Reports \"Too late\" if the bridge is already delivering it.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Machine label or id." },
        pane: { type: "string", description: "Bridge pane id, short pane id, workspace or title." },
        item: { type: "string", description: "Queue item id; omit when the open pane has exactly one." },
      },
      required: ["pane"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
];

// ---------------------------------------------------------------------------
// Worker messages

// The host queues messages until this arrives: posts to a worker whose bundle
// is still evaluating can be silently dropped (see WorkerAppHost).
post({ type: "worker-ready" });

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "check-idle":
      reportIdle();
      break;
    case "shutdown":
      stopAllClients();
      endTextEdit();
      finishWorkerShutdown();
      break;
    case "open-window":
      openWindow(message.windowId, message.surfaceId, message.viewport);
      break;
    case "resize-window":
      if (!window || window.windowId !== message.windowId) break;
      window.viewportWidth = message.viewport.width;
      window.viewportHeight = message.viewport.height;
      window.menu?.resize(message.viewport);
      window.lastSubmittedFingerprint = "";
      renderNow();
      break;
    case "close-window":
      if (!window || window.windowId !== message.windowId) break;
      closeWindow();
      break;
    case "input":
      if (!window || window.windowId !== message.windowId) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown herdr window");
        break;
      }
      window.focused = message.focused;
      if (!message.focused) exitKeysMode(false);
      inferForeground(message.focused);
      frameTimings.logFrame(message.frameId, `input received in ${message.windowId} worker`);
      handleInput(window, message.event as InputEvent, message.frameId);
      break;
    case "text-input":
      if (window && window.windowId === message.windowId) handleTextInput(message.text, message.submit === true);
      break;
    case "render":
      if (!window || window.windowId !== message.windowId) break;
      window.focused = message.focused;
      inferForeground(message.focused);
      renderNow();
      break;
    case "foreground":
      if (!window || window.windowId !== message.windowId) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      if (!message.foreground) exitKeysMode(false);
      if (window.foreground) renderNow();
      break;
    case "input-focus":
      if (!message.focused) exitKeysMode(false);
      break;
    case "screen":
      screenOn = message.on;
      if (!screenOn) exitKeysMode(false);
      if (screenOn) renderNow();
      break;
    case "tool-call": {
      const callId = message.callId;
      Promise.resolve(handleHerdrTool(message.name, message.args))
        .then((result) => post({ type: "tool-result", callId, result }))
        .catch((error) => post({ type: "tool-result", callId, result: { ok: false, error: errorMessage(error) } }));
      break;
    }
    case "navigation-sensors":
      break;
  }
};

/** Input and render messages only reach the foreground window; backstops a lost "foreground". */
function inferForeground(focused: boolean): void {
  if (!focused || !window || window.foreground) return;
  window.foreground = true;
}

onSettingsStoreChanged((key) => {
  if (key.startsWith("glanceboard.")) {
    if (!window) {
      if (hasHerdrBackgroundWork()) syncClients();
      else {
        stopAllClients();
        reportIdle();
      }
      return;
    }
    schedulePublish();
    return;
  }
  if (key === "herdr.machines") {
    syncClients();
    if (!window && !hasHerdrBackgroundWork()) reportIdle();
    render();
    schedulePublish();
    return;
  }
  if (key === HERDR_URL_DRAFT_KEY) {
    if (screen.kind === "setup") render();
    return;
  }
  if (key === HERDR_COMPOSE_DRAFT_KEY) {
    if (textEditOwner === "draft" && compose && (screen.kind === "compose" || screen.kind === "review")) {
      const text = getStringSetting(HERDR_COMPOSE_DRAFT_KEY, "");
      if (text !== compose.draft.text) {
        compose.draft = { ...compose.draft, text };
        drafts.set(compose.key, compose.draft);
        scheduleRender();
      }
    }
    return;
  }
  if (key.startsWith("herdr.")) {
    render();
    schedulePublish();
  }
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportIdle(): void {
  if (!window && !hasHerdrBackgroundWork()) post({ type: "worker-idle" });
}

function openWindow(windowId: string, surfaceId: string, viewport: { width: number; height: number }): void {
  window = {
    windowId,
    surfaceId,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    foreground: false,
    focused: false,
    menu: null,
    lastSubmittedFingerprint: "",
    renderTimer: null,
  };
  post({ type: "set-tools", windowId, tools: HERDR_TOOLS });
  post({ type: "set-window-gestures", windowId, hasAppMenu: true, claimsLongPress: false });
  if (!machineRecords.length) screen = { kind: "setup", editingUrl: false, returnTo: "hub", busy: "", error: "" };
  syncClients();
  syncTitle();
  syncViewTarget();
  render();
}

function closeWindow(): void {
  if (!window) return;
  endTextEdit();
  exitKeysMode(false);
  window.menu?.close();
  if (window.renderTimer) clearTimeout(window.renderTimer);
  window = null;
  screen = { kind: "hub" };
  compose = null;
  hubSelectionKey = null;
  syncViewTarget();
  if (!hasHerdrBackgroundWork()) stopAllClients();
  schedulePublish();
  reportIdle();
}

// ---------------------------------------------------------------------------
// Connections

const socketFactory: SocketFactory = (url, handlers) => {
  let ended = false;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    handlers.onClose(reason);
  };
  const socket = openSocket(url, {
    onOpen: () => handlers.onOpen(),
    onTextMessage: (text) => handlers.onMessage(text),
    onClosed: (code, reason) => end(reason || `Connection closed (${code}).`),
    onFailure: (message) => end(describeSocketFailure(message)),
  });
  const herdrSocket: HerdrSocket = {
    send: (text) => {
      socket.sendText(text);
    },
    close: () => {
      ended = true;
      socket.close(1000, "closing");
    },
  };
  return herdrSocket;
};

/** Whether connections should exist: an open window, or background work (widget/wake). */
function clientsShouldRun(): boolean {
  return Boolean(window) || hasHerdrBackgroundWork();
}

/** Reconcile live clients with the stored machine list (start, stop, update). */
function syncClients(): void {
  machineRecords = loadMachines();
  const wanted = new Set(machineRecords.filter((machine) => machine.enabled).map((machine) => machine.id));
  for (const [id, client] of Array.from(clients)) {
    if (wanted.has(id)) continue;
    client.stop();
    clients.delete(id);
    lastPhase.delete(id);
    lastPanes.delete(id);
    baselinePending.delete(id);
  }
  for (const machine of machineRecords) {
    if (!machine.enabled) continue;
    let client = clients.get(machine.id);
    if (!client) {
      client = new HerdrMachineClient({
        machine: { id: machine.id, label: machine.label, url: machine.url },
        createSocket: socketFactory,
        onChange: () => onClientChanged(machine.id),
        log: (message) => console.log(`herdr ${machine.id}: ${message}`),
      });
      clients.set(machine.id, client);
      lastPhase.set(machine.id, "idle");
      baselinePending.add(machine.id);
    } else {
      client.updateConfig({ id: machine.id, label: machine.label, url: machine.url });
    }
    if (clientsShouldRun()) client.start();
    else client.stop();
  }
  enforceDuplicates();
  viewTargetKey = "";
  syncViewTarget();
  schedulePublish();
}

function stopAllClients(): void {
  for (const client of clients.values()) client.stop();
}

/** The first enabled record reporting a machine wins; stop the records that repeat it. */
function enforceDuplicates(): void {
  if (dedupeGuard) return;
  dedupeGuard = true;
  try {
    const enabled = machineRecords.filter((machine) => machine.enabled);
    const reported = new Map<string, string>();
    for (const machine of enabled) {
      const name = clients.get(machine.id)?.snapshot.machine ?? machine.machine;
      if (name) reported.set(machine.id, name);
    }
    duplicates = new Set(duplicateMachineIds(enabled.map((machine) => machine.id), reported));
    for (const machine of enabled) {
      const client = clients.get(machine.id);
      if (!client) continue;
      if (duplicates.has(machine.id)) {
        if (client.snapshot.phase !== "off") client.stop();
      } else if (client.snapshot.phase === "off" && clientsShouldRun()) {
        client.start();
      }
    }
  } finally {
    dedupeGuard = false;
  }
}

function onClientChanged(machineId: string): void {
  const client = clients.get(machineId);
  if (!client) return;
  enforceDuplicates();
  persistMachineName(machineId);
  const snapshot = client.snapshot;
  const phase = snapshot.phase;
  if (lastPhase.get(machineId) !== phase) {
    lastPhase.set(machineId, phase);
    if (phase === "connected") baselinePending.add(machineId);
  }
  if (lastPanes.get(machineId) !== snapshot.panes) {
    lastPanes.set(machineId, snapshot.panes);
    if (baselinePending.has(machineId)) {
      baselinePending.delete(machineId);
      recordBlockedIdentities();
    } else {
      noteBlockedEvents();
    }
  }
  if (keysMode && keysMode.machineId === machineId) {
    const ref = findRef(keysMode.machineId, keysMode.paneId);
    if (!ref || ref.pane.status === "blocked") exitKeysMode(false);
  }
  if (screen.kind === "setup" && phase === "connected") {
    showScreen({ kind: "hub" });
  }
  schedulePublish();
  scheduleRender();
}

/** Remember `hello.machine` on the record, so dedupe works before the next connection. */
function persistMachineName(machineId: string): void {
  const name = clients.get(machineId)?.snapshot.machine;
  if (!name) return;
  const stored = machineRecords.find((machine) => machine.id === machineId);
  if (!stored || stored.machine === name) return;
  machineRecords = machineRecords.map((machine) => (machine.id === machineId ? { ...machine, machine: name } : machine));
  updateMachine(machineId, { machine: name });
}

function nameOf(machine: HerdrMachine): string {
  const client = clients.get(machine.id);
  return machineDisplayName({ ...machine, machine: client?.snapshot.machine ?? machine.machine });
}

function machinePhaseText(client: HerdrMachineClient | undefined): string {
  if (!client) return "off";
  const snapshot = client.snapshot;
  switch (snapshot.phase) {
    case "connected":
      if (snapshot.protocol >= PROTOCOL_VERSION_3) return "connected · protocol 3";
      if (snapshot.protocol >= 2) return "connected · protocol 2";
      return `bridge protocol ${snapshot.protocol}`;
    case "connecting":
      return "connecting…";
    case "retrying":
      return snapshot.status || "reconnecting…";
    case "forbidden":
      return "bridge refused this phone";
    case "unreachable":
      return "can't reach the bridge";
    case "idle":
      return "not connected";
    case "off":
      return "off";
  }
}

function visibleMachines(): HerdrMachine[] {
  return machineRecords.filter((machine) => machine.enabled && !duplicates.has(machine.id));
}

function multiMachine(): boolean {
  return visibleMachines().length > 1;
}

/** Every pane on every enabled, non-duplicate machine (last snapshot while offline). */
function allRefs(): PaneRef[] {
  const refs: PaneRef[] = [];
  for (const machine of machineRecords) {
    if (!machine.enabled || duplicates.has(machine.id)) continue;
    const client = clients.get(machine.id);
    if (!client) continue;
    const label = nameOf(machine);
    for (const pane of client.snapshot.panes) refs.push({ machineId: machine.id, machine: label, pane });
  }
  return refs;
}

function refsFor(machineId: string): PaneRef[] {
  const machine = machineRecords.find((candidate) => candidate.id === machineId);
  const client = clients.get(machineId);
  if (!machine || !client) return [];
  const label = nameOf(machine);
  return client.snapshot.panes.map((pane) => ({ machineId, machine: label, pane }));
}

function findRef(machineId: string, paneId: string): PaneRef | undefined {
  return allRefs().find((ref) => ref.machineId === machineId && ref.pane.id === paneId);
}

function findMachine(machineId: string): HerdrMachine | undefined {
  return machineRecords.find((machine) => machine.id === machineId);
}

function onlineFor(machineId: string): boolean {
  return clients.get(machineId)?.snapshot.phase === "connected";
}

// ---------------------------------------------------------------------------
// Glanceboard snapshot

function schedulePublish(): void {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publishGlanceSnapshot();
  }, PUBLISH_COALESCE_MS);
}

function publishGlanceSnapshot(): void {
  const queueCounts = new Map<string, number>();
  for (const [machineId, client] of clients) {
    for (const [paneId, summary] of client.snapshot.queueSummaries) queueCounts.set(`${machineId}|${paneId}`, summary.pending);
  }
  const machines = machineRecords.map((machine) => {
    const client = clients.get(machine.id);
    const enabled = machine.enabled && !duplicates.has(machine.id);
    const phase: string = enabled ? client?.snapshot.phase ?? "off" : "off";
    return {
      id: machine.id,
      label: nameOf(machine),
      enabled,
      phase,
      panes: phase === "connected" ? refsFor(machine.id) : [],
    };
  });
  const snapshot = buildGlanceSnapshot(machines, readMarkers, queueCounts);
  const encoded = JSON.stringify(snapshot);
  if (encoded === lastPublishedSnapshot) return;
  lastPublishedSnapshot = encoded;
  post({ type: "publish-state", key: HERDR_GLANCE_STATE_KEY, state: snapshot });
}

// ---------------------------------------------------------------------------
// Attention and wake

function blockedIdentity(ref: PaneRef): string {
  return `${fullPaneKey(ref)}|${ref.pane.stateSeq}`;
}

/** Treat the current pane list as already seen (a connection's first snapshot). */
function recordBlockedIdentities(): void {
  const seen = new Set<string>();
  for (const ref of allRefs()) {
    const key = refKey(ref);
    if (ref.pane.status !== "blocked") {
      blockedIdentities.delete(key);
      continue;
    }
    seen.add(key);
    blockedIdentities.set(key, blockedIdentity(ref));
  }
  for (const key of Array.from(blockedIdentities.keys())) if (!seen.has(key)) blockedIdentities.delete(key);
}

/** Raise attention and (optionally) schedule one coalesced wake for new blocked panes. */
function noteBlockedEvents(): void {
  const refs = allRefs();
  let event = false;
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = refKey(ref);
    seen.add(key);
    if (ref.pane.status !== "blocked") {
      blockedIdentities.delete(key);
      continue;
    }
    const identity = blockedIdentity(ref);
    const previous = blockedIdentities.get(key);
    blockedIdentities.set(key, identity);
    if (previous !== identity) event = true;
  }
  for (const key of Array.from(blockedIdentities.keys())) if (!seen.has(key)) blockedIdentities.delete(key);
  if (!event) return;
  const viewing = window?.foreground === true && screenOn;
  if (window && !viewing) post({ type: "set-attention", windowId: window.windowId, attention: true });
  if (wakeOnBlockedEnabled() && asleepForWake()) scheduleWake();
}

function asleepForWake(): boolean {
  return !window || !screenOn;
}

function scheduleWake(): void {
  if (wakeTimer) return;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wakeNow();
  }, WAKE_COALESCE_MS);
}

/** One deterministic pane from simultaneous blocked events; no wake for one already notified. */
function wakeNow(): void {
  if (!wakeOnBlockedEnabled() || !asleepForWake()) return;
  const candidates = wakeCandidates(allRefs().filter((ref) => onlineFor(ref.machineId)));
  const pick = candidates[0];
  if (!pick) return;
  const key = refKey(pick);
  const identity = blockedIdentity(pick);
  if (lastNotified && lastNotified.key === key && lastNotified.identity === identity) return;
  lastNotified = { key, identity };
  hubSelectionKey = `needs:${key}`;
  showScreen({ kind: "hub" });
  if (!window) {
    post({ type: "open-window-request", windowId: MAIN_WINDOW_ID, title: APP_TITLE, iconLetter: "H", icon: "activity", focus: false });
  }
  // The shell drops this unless the glasses are actually asleep.
  post({ type: "wake-window", windowId: MAIN_WINDOW_ID });
}

// ---------------------------------------------------------------------------
// Screens and navigation

function showScreen(next: Screen): void {
  const previous = screen;
  const leavingDraft = (previous.kind === "compose" || previous.kind === "review") && next.kind !== "compose" && next.kind !== "review";
  if (leavingDraft || (previous.kind === "setup" && next.kind !== "setup")) endTextEdit();
  if (next.kind !== "pane" && next.kind !== "subagent") exitKeysMode(false);
  screen = next;
  syncTitle();
  syncViewTarget();
  scheduleRender();
}

function syncTitle(): void {
  if (!window) return;
  let title = APP_TITLE;
  if (screen.kind === "pane" || screen.kind === "subagent") {
    const ref = findRef(screen.machineId, screen.paneId);
    title = ref ? `${ref.machine}/${ref.pane.workspace}` : "Herdr pane";
  } else if (screen.kind === "workspace") {
    const machine = findMachine(screen.machineId);
    title = `${machine ? machineDisplayName(machine) : screen.machineId}/${screen.workspace}`;
  }
  post({ type: "set-title", windowId: window.windowId, title });
}

function goBack(frameId: number): void {
  switch (screen.kind) {
    case "subagent": {
      showScreen({ kind: "pane", machineId: screen.machineId, paneId: screen.paneId, fromHub: screen.fromHub });
      renderNow(frameId);
      return;
    }
    case "pane": {
      if (screen.fromHub) {
        showScreen({ kind: "hub" });
        renderNow(frameId);
        return;
      }
      const ref = findRef(screen.machineId, screen.paneId);
      if (ref) openWorkspace({ machineId: ref.machineId, session: ref.pane.session, workspace: ref.pane.workspace }, `pane:${refKey(ref)}`);
      else showScreen({ kind: "hub" });
      renderNow(frameId);
      return;
    }
    case "compose": {
      const { machineId, paneId } = screen;
      showScreen({ kind: "pane", machineId, paneId, fromHub: compose?.fromHub === true });
      renderNow(frameId);
      return;
    }
    case "review":
      showScreen({ kind: "compose", machineId: compose?.machineId ?? "", paneId: compose?.paneId ?? "" });
      renderNow(frameId);
      return;
    case "workspace":
    case "machines":
      showScreen({ kind: "hub" });
      renderNow(frameId);
      return;
    case "setup": {
      const returnTo = screen.returnTo;
      if (returnTo === "machines" && machineRecords.length) showScreen({ kind: "machines" });
      else if (machineRecords.length) showScreen({ kind: "hub" });
      else {
        frameTimings.finishFrame(frameId, "discarded: herdr yielded focus");
        if (window) post({ type: "yield-focus", windowId: window.windowId });
        return;
      }
      renderNow(frameId);
      return;
    }
    case "hub":
      frameTimings.finishFrame(frameId, "discarded: herdr yielded focus");
      if (window) post({ type: "yield-focus", windowId: window.windowId });
      return;
  }
}

function openPane(machineId: string, paneId: string, fromHub = false): void {
  exitKeysMode(false);
  showScreen({ kind: "pane", machineId, paneId, fromHub });
  if (window) post({ type: "set-attention", windowId: window.windowId, attention: false });
  const ref = findRef(machineId, paneId);
  const state = readerStateFor(viewKeyOf({ machineId, paneId }));
  if (ref && isDoneUnseen(ref, readMarkers)) {
    state.decideUnread = true;
    state.firstUnread = null;
    state.anchor = null;
    state.anchorBelow = 0;
    state.anchorLost = false;
  }
  renderNow();
}

function openSubagent(ref: PaneRef, subagent: SubagentSummary): void {
  exitKeysMode(false);
  const fromHub = screen.kind === "pane" && screen.fromHub === true;
  showScreen({ kind: "subagent", machineId: ref.machineId, paneId: ref.pane.id, subagent, fromHub });
  readerStateFor(viewKeyOf({ machineId: ref.machineId, paneId: ref.pane.id, subagentId: subagent.id }));
  renderNow();
}

function openWorkspace(fields: { machineId: string; session: string; workspace: string }, selectKey?: string): void {
  const key = workspaceKey(fields.machineId, fields.session, fields.workspace);
  const group = currentGroups().find((candidate) => candidate.key === key);
  const fallback = group?.refs[0] ? `pane:${refKey(group.refs[0])}` : null;
  workspaceSelections.set(key, selectKey ?? workspaceSelections.get(key) ?? fallback ?? "");
  showScreen({ kind: "workspace", ...fields });
}

function openWorkspaceGroup(group: WorkspaceGroup): void {
  const selectKey = group.refs[0] ? `pane:${refKey(group.refs[0])}` : undefined;
  openWorkspace({ machineId: group.machineId, session: group.session, workspace: group.workspace }, selectKey);
}

function currentHub(): Hub {
  return buildHub(allRefs(), readMarkers, multiMachine());
}

function currentGroups(): WorkspaceGroup[] {
  return groupWorkspaces(allRefs(), readMarkers);
}

function currentWorkspaceGroup(): WorkspaceGroup | undefined {
  const current = screen;
  if (current.kind !== "workspace") return undefined;
  return currentGroups().find(
    (group) => group.machineId === current.machineId && group.session === current.session && group.workspace === current.workspace,
  );
}

function setMachineEnabled(machineId: string, enabled: boolean): void {
  updateMachine(machineId, { enabled });
  syncClients();
  render();
}

function openMachinesScreen(): void {
  showScreen({ kind: "machines" });
  renderNow();
}

function beginSetup(returnTo: "hub" | "machines"): void {
  showScreen({ kind: "setup", editingUrl: false, returnTo, busy: "", error: "" });
  renderNow();
}

// ---------------------------------------------------------------------------
// Phone text editor

function startUrlEdit(): void {
  if (screen.kind !== "setup") return;
  endTextEdit();
  setStringSetting(HERDR_URL_DRAFT_KEY, "");
  textEditOwner = "url";
  screen = { ...screen, editingUrl: true, error: "" };
  post({ type: "start-text-setting-edit", settingId: HERDR_URL_DRAFT_KEY });
  render();
}

function startDraftEdit(): void {
  if (!compose) return;
  endTextEdit();
  setStringSetting(HERDR_COMPOSE_DRAFT_KEY, compose.draft.text);
  textEditOwner = "draft";
  post({ type: "start-text-setting-edit", settingId: HERDR_COMPOSE_DRAFT_KEY });
}

function endTextEdit(): void {
  if (!textEditOwner) return;
  textEditOwner = null;
  post({ type: "end-text-setting-edit" });
}

function cancelUrlEdit(): void {
  endTextEdit();
  if (screen.kind === "setup") screen = { ...screen, editingUrl: false };
  render();
}

async function scanBridge(): Promise<void> {
  if (scanning) return;
  scanning = true;
  if (screen.kind === "setup") screen = { ...screen, busy: "Opening the scanner…", error: "" };
  render();
  try {
    const payload = await scanQrCode();
    if (!payload) {
      if (screen.kind === "setup") screen = { ...screen, busy: "" };
      render();
      return;
    }
    const url = urlFromQrPayload(payload);
    if (!url) {
      if (screen.kind === "setup") screen = { ...screen, busy: "", error: "That QR code is not a bridge URL." };
      render();
      return;
    }
    submitBridgeUrl(url);
  } catch (error) {
    if (screen.kind === "setup") screen = { ...screen, busy: "", error: errorMessage(error) };
    render();
  } finally {
    scanning = false;
  }
}

function submitBridgeUrl(input: string): void {
  const result = addMachineFromUrl(input);
  if ("error" in result) {
    if (screen.kind === "setup") screen = { ...screen, busy: "", error: result.error };
    else showNotice(result.error);
    render();
    return;
  }
  endTextEdit();
  syncClients();
  if (screen.kind === "setup") {
    if (result.added) {
      machineRecords = loadMachines();
      screen = { ...screen, editingUrl: false, busy: `Connecting to ${machineDisplayName(result.machine)}…`, error: "" };
    } else {
      showScreen({ kind: "hub" });
    }
  } else {
    showScreen({ kind: "hub" });
  }
  render();
}

// ---------------------------------------------------------------------------
// Reader state

function viewKeyOf(scope: ReaderScope): string {
  return `${scope.machineId}|${scope.paneId}|${scope.subagentId ?? ""}`;
}

function readerStateFor(key: string): ReaderState {
  let state = readers.get(key);
  if (!state) {
    state = {
      anchor: null,
      anchorBelow: 0,
      anchorLost: false,
      firstUnread: null,
      decideUnread: false,
      needsFreeze: false,
      lastDataAt: Date.now(),
      lastSignature: "",
      loadingOlder: false,
      olderRequestedFor: null,
      cache: null,
      cacheKey: "",
    };
    readers.set(key, state);
    if (readers.size > READER_STATE_LIMIT) {
      const oldest = readers.keys().next().value;
      if (oldest !== undefined && oldest !== key) readers.delete(oldest);
    }
  }
  return state;
}

function readerScope(): ReaderScope | null {
  if (screen.kind === "pane") return { machineId: screen.machineId, paneId: screen.paneId };
  if (screen.kind === "subagent") return { machineId: screen.machineId, paneId: screen.paneId, subagentId: screen.subagent.id };
  if ((screen.kind === "compose" || screen.kind === "review") && compose) {
    return { machineId: compose.machineId, paneId: compose.paneId };
  }
  return null;
}

function viewForScope(scope: ReaderScope): ViewState | undefined {
  const view = clients.get(scope.machineId)?.snapshot.view;
  if (!view || view.pane !== scope.paneId) return undefined;
  if ((view.subagent ?? undefined) !== (scope.subagentId ?? undefined)) return undefined;
  return view;
}

/** Keep only the displayed pane's view subscription open, and reopen it after a reconnect. */
function syncViewTarget(): void {
  const scope = readerScope();
  const key = scope ? viewKeyOf(scope) : "";
  if (key === viewTargetKey) return;
  viewTargetKey = key;
  for (const [machineId, client] of clients) {
    if (scope && machineId === scope.machineId) client.openView(scope.paneId, scope.subagentId);
    else if (client.snapshot.view) client.closeView();
  }
}

function readerSignature(view: ViewState): string {
  const last = view.entries[view.entries.length - 1];
  return `${view.entries.length}|${last?.id ?? ""}|${view.source ?? ""}|${view.prompt ?? ""}|${view.queue.length}|${view.outcomes.length}`;
}

/** First data for a pane opened from a done marker: start at the first unread entry. */
function reconcileReader(state: ReaderState, view: ViewState): void {
  const signature = readerSignature(view);
  if (signature !== state.lastSignature) {
    state.lastSignature = signature;
    state.lastDataAt = Date.now();
  }
  if (!state.decideUnread || !view.source) return;
  state.decideUnread = false;
  const entryId = firstUnreadEntryId(view.entries);
  state.firstUnread = entryId;
  if (entryId) {
    state.anchor = { entryId, lineOffset: 0 };
    state.anchorBelow = 0;
    state.anchorLost = false;
    state.needsFreeze = true;
  }
}

type ReaderMetrics = {
  step: number;
  lines: ReaderLine[];
  visible: number;
  maxFirst: number;
  first: number;
  bodyTop: number;
  bodyHeight: number;
  width: number;
};

function bodyMetrics(win: AppWindow): { step: number; bodyTop: number; bodyHeight: number; width: number } {
  const step = lineStep(font());
  const bodyTop = 6 + READER_HEADER_LINES * step + 8;
  const bodyHeight = Math.max(step, win.viewportHeight - bodyTop - step - 10);
  return { step, bodyTop, bodyHeight, width: win.viewportWidth - BODY_LEFT - BODY_RIGHT };
}

function readerMetrics(win: AppWindow, ref: PaneRef, view: ViewState, state: ReaderState): ReaderMetrics {
  const { step, bodyTop, bodyHeight, width } = bodyMetrics(win);
  const entries = cleanEntries(trimEntries(view.entries, 800));
  const lines = layoutReader({
    entries,
    prompt: view.subagent ? null : view.prompt,
    queue: view.subagent ? [] : view.queue,
    outcomes: view.subagent ? [] : view.outcomes,
    firstUnreadEntryId: state.firstUnread,
    hasOlder: view.hasOlder,
    source: view.source,
    wrap: (text) => wrapText(font(), text, Math.max(20, width - 8)),
  });
  const visible = Math.max(1, Math.floor(bodyHeight / step));
  const maxFirst = Math.max(0, lines.length - visible);
  const resolved = state.anchor ? resolveScroll(lines, state.anchor, visible) : null;
  const first = state.anchor ? resolved ?? 0 : maxFirst;
  return { step, lines, visible, maxFirst, first: Math.min(first, maxFirst), bodyTop, bodyHeight, width };
}

function freezeAnchor(state: ReaderState, lines: readonly ReaderLine[], firstLine: number): void {
  const anchor = anchorAt(lines, firstLine);
  if (!anchor) {
    state.anchor = null;
    return;
  }
  state.anchor = anchor;
  state.anchorLost = false;
  const line = lineForAnchor(lines, anchor);
  state.anchorBelow = line === null ? 0 : Math.max(0, lines.length - line);
}

function maybeRequestOlder(ref: PaneRef, view: ViewState, state: ReaderState): void {
  const before = view.entries[0]?.id;
  if (!view.hasOlder || state.loadingOlder || !before || state.olderRequestedFor === before) return;
  if (!onlineFor(ref.machineId)) return;
  const client = clients.get(ref.machineId);
  if (!client) return;
  state.loadingOlder = true;
  state.olderRequestedFor = before;
  void client.requestOlder(before).then((result) => {
    state.loadingOlder = false;
    if (result.status === "ok") return;
    state.olderRequestedFor = null;
    showNotice(result.status === "error" ? `Earlier output: ${result.message}` : "The bridge did not answer; try again.");
  });
}

/** Clear a completion marker at the live tail (transcripts only; screen panes need Mark read). */
function maybeMarkRead(ref: PaneRef): void {
  if (screen.kind !== "pane") return;
  if (ref.pane.chat !== "transcript") return;
  if (!isDoneUnseen(ref, readMarkers)) return;
  const view = viewForScope({ machineId: ref.machineId, paneId: ref.pane.id });
  if (!view || !view.entries.length) return;
  readMarkers = markRead(readMarkers, ref);
  saveReadMarkers(readMarkers, allRefs());
  const state = readerStateFor(viewKeyOf({ machineId: ref.machineId, paneId: ref.pane.id }));
  state.firstUnread = null;
}

function markPaneRead(ref: PaneRef): void {
  readMarkers = markRead(readMarkers, ref);
  saveReadMarkers(readMarkers, allRefs());
  const state = readerStateFor(viewKeyOf({ machineId: ref.machineId, paneId: ref.pane.id }));
  state.firstUnread = null;
  showNotice("Marked read");
}

// ---------------------------------------------------------------------------
// Input

function openWindowMenu(items: MenuItem[], title: string, selectedIndex?: number): void {
  const open = () => {
    if (!window) return;
    windowMenu(window).open(items, title, selectedIndex);
    renderNow();
  };
  if (window?.menu?.isOpen()) setTimeout(open, 0);
  else open();
}

function windowMenu(win: AppWindow): WindowMenu {
  win.menu ??= new WindowMenu({
    windowId: win.windowId,
    post,
    title: () => APP_TITLE,
    items: () => menuItems(),
    size: { width: win.viewportWidth, height: win.viewportHeight },
    paintBase: () => paintContent(win),
    isFocused: () => win.focused,
  });
  return win.menu;
}

function handleInput(win: AppWindow, event: InputEvent, frameId: number): void {
  if (win.menu?.isOpen()) {
    void win.menu
      .handleInput(event)
      .catch((error) => console.error(`herdr menu input failed: ${error}`))
      .then(() => renderNow(frameId));
    return;
  }
  if (event.type === "short-then-long-press") {
    openWindowMenu(menuItems(), APP_TITLE);
    renderNow(frameId);
    return;
  }
  if (event.type === "system-menu-opened" || event.type === "long-press" || event.type === "long-press-release") {
    frameTimings.finishFrame(frameId, "discarded: herdr ignored input");
    return;
  }
  if (keysMode) {
    handleKeysInput(event as InputEvent, frameId);
    return;
  }
  const interpreted = directionalFallback(event);
  if (interpreted.type === "double-click") {
    goBack(frameId);
    return;
  }
  switch (screen.kind) {
    case "setup":
    case "hub":
    case "workspace":
    case "machines":
    case "review":
      handleListInput(interpreted, frameId);
      return;
    case "pane":
    case "subagent":
      handleReaderInput(interpreted, frameId);
      return;
    case "compose":
      handleComposeInput(interpreted, frameId);
      return;
  }
}

function handleListInput(event: InputEvent, frameId: number): void {
  if (event.type !== "scroll-up" && event.type !== "scroll-down" && event.type !== "click") {
    frameTimings.finishFrame(frameId, "discarded: herdr list ignored input");
    return;
  }
  const items = currentListItems();
  const menu = list();
  menu.setItems(items, selectionIndex(items));
  menu.handleInput(event).catch((error) => console.error("herdr list action failed", error));
  setActiveSelectionKey(menu.selectedItem?.key ?? activeSelectionKey());
  renderNow(frameId);
}

function currentListItems(): ListItem[] {
  switch (screen.kind) {
    case "setup":
      return setupItems();
    case "workspace":
      return workspaceItems();
    case "machines":
      return machineItems();
    case "review":
      return reviewItems();
    default:
      return hubItems();
  }
}

function handleReaderInput(event: InputEvent, frameId: number): void {
  const scope = readerScope();
  const ref = scope ? findRef(scope.machineId, scope.paneId) : undefined;
  const state = scope ? readerStateFor(viewKeyOf(scope)) : null;
  const cached = state && ref && state.cache && state.cacheKey === fullPaneKey(ref) ? state.cache : undefined;
  // A disconnected pane keeps its last content readable; the live view wins when present.
  const view = (scope ? viewForScope(scope) : undefined) ?? cached;
  if (!scope || !ref || !view || !state || !window) {
    frameTimings.finishFrame(frameId, "discarded: herdr no pane view");
    return;
  }
  if (event.type === "scroll-up" || event.type === "scroll-down") {
    const metrics = readerMetrics(window, ref, view, state);
    const step = scrollStep(metrics.visible);
    const next = event.type === "scroll-up" ? Math.max(0, metrics.first - step) : Math.min(metrics.maxFirst, metrics.first + step);
    if (next >= metrics.maxFirst) {
      state.anchor = null;
      state.anchorBelow = 0;
      state.anchorLost = false;
      maybeMarkRead(ref);
    } else {
      freezeAnchor(state, metrics.lines, next);
      if (next === 0) maybeRequestOlder(ref, view, state);
    }
    renderNow(frameId);
    return;
  }
  if (event.type === "click") {
    frameTimings.finishFrame(frameId, "discarded: herdr opened pane action");
    openPrimary(ref, view);
    return;
  }
  frameTimings.finishFrame(frameId, "discarded: herdr reader ignored input");
}

function handleComposeInput(event: InputEvent, frameId: number): void {
  if (event.type !== "scroll-up" && event.type !== "scroll-down" && event.type !== "click") {
    frameTimings.finishFrame(frameId, "discarded: herdr compose ignored input");
    return;
  }
  const items = composeItems();
  const menu = list();
  menu.setItems(items, selectionIndex(items));
  menu.handleInput(event).catch((error) => console.error("herdr compose action failed", error));
  setActiveSelectionKey(menu.selectedItem?.key ?? activeSelectionKey());
  renderNow(frameId);
}

function scrollStep(visible: number): number {
  return Math.max(3, Math.floor(visible / 4));
}

function openPrimary(ref: PaneRef, view: ViewState): void {
  const action = primaryAction(ref.pane, screen.kind === "subagent");
  switch (action) {
    case "answer":
      openAnswerMenu(ref, view);
      return;
    case "compose":
      openCompose(ref, "message");
      return;
    case "command":
      openCompose(ref, "command");
      return;
    case "read":
      showNotice("This subagent view is read-only.");
      return;
  }
}

// ---------------------------------------------------------------------------
// Keys mode

function enterKeysMode(ref: PaneRef): void {
  if (!canEnterKeysMode(screen.kind === "subagent", ref.pane.status === "blocked")) return;
  keysMode = { machineId: ref.machineId, paneId: ref.pane.id };
  showNotice(keysModeBanner(ref.machine, paneLabel(ref)));
}

function exitKeysMode(notify: boolean): void {
  if (!keysMode) return;
  keysMode = null;
  if (notify) showNotice("Keys mode off");
  else render();
}

function paneLabel(ref: PaneRef): string {
  return `${ref.pane.workspace}/${ref.pane.tab || ref.pane.paneId}`;
}

function handleKeysInput(event: InputEvent, frameId: number): void {
  const mode = keysMode;
  if (!mode) return;
  const ref = findRef(mode.machineId, mode.paneId);
  if (!ref) {
    exitKeysMode(false);
    frameTimings.finishFrame(frameId, "discarded: herdr keys target gone");
    return;
  }
  switch (event.type) {
    case "scroll-up":
      void sendKeysModeKey(ref, "up");
      frameTimings.finishFrame(frameId, "discarded: herdr keys mode");
      return;
    case "scroll-down":
      void sendKeysModeKey(ref, "down");
      frameTimings.finishFrame(frameId, "discarded: herdr keys mode");
      return;
    case "swipe-up":
      void sendKeysModeKey(ref, keysForDirection("up")[0]!);
      frameTimings.finishFrame(frameId, "discarded: herdr keys mode");
      return;
    case "swipe-down":
      void sendKeysModeKey(ref, keysForDirection("down")[0]!);
      frameTimings.finishFrame(frameId, "discarded: herdr keys mode");
      return;
    case "swipe-left":
      void sendKeysModeKey(ref, keysForDirection("left")[0]!);
      frameTimings.finishFrame(frameId, "discarded: herdr keys mode");
      return;
    case "swipe-right":
      void sendKeysModeKey(ref, keysForDirection("right")[0]!);
      frameTimings.finishFrame(frameId, "discarded: herdr keys mode");
      return;
    case "click":
      void sendKeysModeKey(ref, "enter");
      frameTimings.finishFrame(frameId, "discarded: herdr keys mode");
      return;
    case "double-click":
      exitKeysMode(true);
      renderNow(frameId);
      return;
    case "short-then-long-press":
      openWindowMenu(menuItems(), APP_TITLE);
      renderNow(frameId);
      return;
    default:
      frameTimings.finishFrame(frameId, "discarded: herdr keys ignored input");
  }
}

async function sendKeysModeKey(ref: PaneRef, key: string): Promise<void> {
  const client = clients.get(ref.machineId);
  if (!client) return;
  const result = await client.sendKeys(ref.pane.id, [key], ref.pane.terminalId);
  if (result.status === "ok") return;
  showNotice(writeFailureText(result));
  if (result.status === "error" && (result.code === "unknown_pane" || result.code === "terminal_changed")) exitKeysMode(false);
}

// ---------------------------------------------------------------------------
// Text input (voice and the phone editor)

function handleTextInput(raw: string, submit: boolean): void {
  const text = raw.trim();
  if (!text) return;
  if (screen.kind === "setup" && screen.editingUrl) {
    setStringSetting(HERDR_URL_DRAFT_KEY, text);
    render();
    return;
  }
  if (screen.kind === "compose" || screen.kind === "review") {
    if (!compose) return;
    compose.draft = { ...compose.draft, text };
    drafts.set(compose.key, compose.draft);
    if (submit) openReview(true);
    else render();
    return;
  }
  if (screen.kind === "pane" || screen.kind === "subagent") {
    const scope = readerScope();
    const ref = scope ? findRef(scope.machineId, scope.paneId) : undefined;
    if (!scope || !ref) {
      showNotice("Open a pane first.");
      return;
    }
    if (screen.kind === "subagent") {
      showNotice("This subagent view is read-only.");
      return;
    }
    const action = primaryAction(ref.pane, false);
    if (action === "answer") {
      showNotice("This agent is blocked; answer its prompt from the pane menu.");
      return;
    }
    const kind: ComposeKind = action === "command" ? "command" : "message";
    openCompose(ref, kind);
    if (!compose) return;
    compose.draft = { ...compose.draft, text };
    drafts.set(compose.key, compose.draft);
    if (submit) openReview(true);
    else render();
    return;
  }
  showNotice("Open a pane to send it text.");
}

// ---------------------------------------------------------------------------
// Compose and review

function draftKeyFor(ref: PaneRef, kind: ComposeKind): string {
  return `${ref.machineId}|${ref.pane.id}|${kind}`;
}

function openCompose(ref: PaneRef, kind: ComposeKind): void {
  if (screen.kind === "subagent") {
    showNotice("This subagent view is read-only.");
    return;
  }
  if (ref.pane.status === "blocked") {
    showNotice("This agent is blocked; answer its prompt instead.");
    return;
  }
  const key = draftKeyFor(ref, kind);
  const existing = drafts.get(key);
  const draft: Draft = existing ? { target: existing.target, text: existing.text } : { target: draftTarget(ref), text: "" };
  drafts.set(key, draft);
  const fromHub = screen.kind === "pane" ? screen.fromHub === true : false;
  const returnTo: Screen = screen.kind === "pane" ? screen : { kind: "pane", machineId: ref.machineId, paneId: ref.pane.id, fromHub };
  compose = { key, kind, machineId: ref.machineId, paneId: ref.pane.id, draft, returnTo, fromHub };
  composeSelectionKey = "review";
  showScreen({ kind: "compose", machineId: ref.machineId, paneId: ref.pane.id });
  startDraftEdit();
  renderNow();
}

function composeRef(): PaneRef | undefined {
  return compose ? findRef(compose.machineId, compose.paneId) : undefined;
}

function discardDraft(): void {
  if (!compose) return;
  drafts.delete(compose.key);
  const target = compose;
  compose = null;
  endTextEdit();
  setStringSetting(HERDR_COMPOSE_DRAFT_KEY, "");
  showScreen({ kind: "pane", machineId: target.machineId, paneId: target.paneId, fromHub: target.fromHub });
  showNotice("Draft discarded");
}

function draftProblem(): DraftProblem | null {
  if (!compose) return null;
  const ref = composeRef();
  if (!ref) return "pane_gone";
  const view = viewForScope({ machineId: compose.machineId, paneId: compose.paneId });
  return validateDraft(compose.draft, ref, onlineFor(compose.machineId), view?.prompt ?? null);
}

function problemText(problem: DraftProblem | null): string {
  switch (problem) {
    case "offline":
      return "Offline. Nothing will be sent until the bridge reconnects.";
    case "pane_gone":
      return "The pane is gone. Choose another target.";
    case "terminal_changed":
      return "The terminal in this pane changed. Choose this pane to retarget.";
    case "session_changed":
      return "The agent session changed. Choose this pane to retarget.";
    case "prompt_changed":
      return "The prompt changed; answer the visible prompt again.";
    default:
      return "";
  }
}

function retargetDraft(): void {
  if (!compose) return;
  const ref = composeRef();
  if (!ref) {
    showNotice("The pane is gone; choose another.");
    return;
  }
  compose.draft = { target: draftTarget(ref), text: compose.draft.text };
  drafts.set(compose.key, compose.draft);
  showNotice("Draft retargeted to this pane");
  render();
}

function openReview(force = false): void {
  if (!compose) return;
  if (!compose.draft.text.trim() && !force) {
    showNotice("Type or say something first.");
    return;
  }
  showScreen({ kind: "review" });
  reviewSelectionKey = queueRecommended() ? "review:queue" : "review:send";
  renderNow();
}

function queueRecommended(): boolean {
  if (!compose) return false;
  const ref = composeRef();
  if (!ref) return false;
  return compose.kind === "message" && canQueue(ref.pane, screen.kind === "subagent") && ref.pane.status === "working";
}

async function submitDraft(queue: boolean): Promise<void> {
  const current = compose;
  if (!current) return;
  if (!current.draft.text.trim()) {
    showNotice("Type or say something first.");
    render();
    return;
  }
  const ref = composeRef();
  const client = clients.get(current.machineId);
  if (!ref || !client) {
    showNotice("The pane is gone; choose another target.");
    render();
    return;
  }
  const problem = validateDraft(current.draft, ref, onlineFor(current.machineId), viewForScope({ machineId: current.machineId, paneId: current.paneId })?.prompt ?? null);
  if (problem) {
    showNotice(problemText(problem));
    render();
    return;
  }
  const queued = queue && current.kind === "message" && canQueue(ref.pane, false);
  showNotice(queued ? "Queueing…" : "Sending…");
  const result = await client.sendText(ref.pane, current.kind, current.draft.text, {
    queue: queued,
    terminalId: current.draft.target.terminalId ?? ref.pane.terminalId,
  });
  if (result.status === "ok") {
    deliveryUnknown = null;
    drafts.delete(current.key);
    compose = null;
    endTextEdit();
    setStringSetting(HERDR_COMPOSE_DRAFT_KEY, "");
    const state = readerStateFor(viewKeyOf({ machineId: current.machineId, paneId: current.paneId }));
    state.anchor = null;
    state.anchorBelow = 0;
    state.firstUnread = null;
    showScreen({ kind: "pane", machineId: current.machineId, paneId: current.paneId, fromHub: current.fromHub });
    showNotice(queued ? "Queued" : current.kind === "type" ? "Typed" : "Sent");
    return;
  }
  if (result.status === "unknown") deliveryUnknown = { machineId: current.machineId, paneId: current.paneId };
  showNotice(writeFailureText(result));
  render();
}

function writeFailureText(result: WriteResult): string {
  if (result.status === "unknown") return `Delivery unknown: ${result.message}`;
  if (result.status === "error") {
    switch (result.code) {
      case "agent_blocked":
        return "Blocked: answer the agent's prompt instead.";
      case "stale_prompt":
        return "The prompt changed; nothing was sent.";
      case "terminal_changed":
        return "The terminal changed; nothing was sent.";
      case "queue_closed":
        return "The queue closed; send it now.";
      case "unknown_item":
        return "Too late: the bridge is already delivering it.";
      case "unknown_pane":
        return "The pane is gone.";
      case "key_not_allowed":
        return result.message;
      default:
        return `Failed: ${result.message}`;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Answers, keys, snippets, queue

function answerGuard(ref: PaneRef, view: ViewState | undefined): AnswerGuard {
  return { machineId: ref.machineId, paneId: ref.pane.id, stateSeq: ref.pane.stateSeq, promptText: view?.prompt ?? "" };
}

function openAnswerMenu(ref: PaneRef, view: ViewState): void {
  const guard = answerGuard(ref, view);
  const items: MenuItem[] = [];
  if (view.prompt) {
    const line = oneLine(view.prompt);
    items.push({ label: truncateText(font(), line, 230), disabled: true, onSelect: () => {} });
  }
  const choices = promptChoices(view.entries);
  for (const choice of choices) {
    items.push({
      label: truncateText(font(), choice.label, 230),
      onSelect: (ctx) => {
        ctx.stack.pop();
        void submitAnswer(guard, choice.keys, choice.label);
      },
    });
  }
  for (const key of ANSWER_KEYS) {
    items.push({
      label: key.label,
      onSelect: (ctx) => {
        ctx.stack.pop();
        void submitAnswer(guard, key.keys, key.label);
      },
    });
  }
  if (!items.length) items.push({ label: "No visible prompt", disabled: true, onSelect: () => {} });
  openWindowMenu(items, "Answer");
}

const ANSWER_KEYS = [
  { label: "Enter", keys: ["enter"] },
  { label: "y", keys: ["y"] },
  { label: "n", keys: ["n"] },
  { label: "1", keys: ["1"] },
  { label: "2", keys: ["2"] },
  { label: "3", keys: ["3"] },
  { label: "Escape", keys: ["esc"] },
  { label: "Ctrl+C", keys: ["ctrl+c"] },
];

function promptChoices(entries: readonly ChatEntry[]): Array<{ label: string; keys: string[] }> {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || entry.kind !== "question" || entry.answered) continue;
    const choices: Array<{ label: string; keys: string[] }> = [];
    for (const question of entry.questions) {
      for (let optionIndex = 0; optionIndex < question.options.length && optionIndex < 9; optionIndex++) {
        choices.push({ label: question.options[optionIndex]!, keys: [String(optionIndex + 1)] });
      }
    }
    if (choices.length) return choices;
  }
  return [];
}

/** Send keys only if the prompt the wearer saw is still the prompt on the pane. */
async function submitAnswer(guard: AnswerGuard, keys: string[], label: string): Promise<void> {
  const ref = findRef(guard.machineId, guard.paneId);
  const client = clients.get(guard.machineId);
  if (!ref || !client) {
    showNotice("The pane is gone; nothing was sent.");
    return;
  }
  const view = viewForScope({ machineId: guard.machineId, paneId: guard.paneId });
  const currentPrompt = view?.prompt ?? "";
  if (
    ref.pane.stateSeq !== guard.stateSeq ||
    normalizePromptText(currentPrompt) !== normalizePromptText(guard.promptText) ||
    ref.pane.status !== "blocked"
  ) {
    showNotice("The prompt changed; nothing was sent.");
    render();
    return;
  }
  const revision = ref.pane.terminalId ? promptRevision(ref.pane.terminalId, guard.stateSeq, guard.promptText) : undefined;
  const result = await client.answer(ref.pane, keys, revision);
  showNotice(result.status === "ok" ? `Sent ${label}` : writeFailureText(result));
}

async function sendKeysDirect(ref: PaneRef, keys: string[], label: string): Promise<void> {
  const client = clients.get(ref.machineId);
  if (!client) return;
  const result = await client.sendKeys(ref.pane.id, keys, ref.pane.terminalId);
  showNotice(result.status === "ok" ? `Sent ${label}` : writeFailureText(result));
}

async function sendSnippet(ref: PaneRef, action: { label: string; keys?: string[]; text?: string; enter?: boolean }): Promise<void> {
  if (action.keys?.length) {
    if (ref.pane.status === "blocked") {
      const view = viewForScope({ machineId: ref.machineId, paneId: ref.pane.id });
      if (view) {
        await submitAnswer(answerGuard(ref, view), action.keys, action.label);
        return;
      }
    }
    await sendKeysDirect(ref, action.keys, action.label);
    return;
  }
  if (action.text === undefined) return;
  if (ref.pane.status === "blocked") {
    showNotice("This agent is blocked; use a key answer instead.");
    return;
  }
  const client = clients.get(ref.machineId);
  if (!client) return;
  const kind: ComposeKind = action.enter ? (ref.pane.agent ? "message" : "command") : "type";
  const result = await client.sendText(ref.pane, kind, action.text, { terminalId: ref.pane.terminalId });
  showNotice(result.status === "ok" ? `Sent ${action.label}` : writeFailureText(result));
}

async function removeQueuedItem(ref: PaneRef, itemId: string): Promise<void> {
  const client = clients.get(ref.machineId);
  if (!client) return;
  const result = await client.unqueue(ref.pane.id, itemId);
  if (result.status === "ok") {
    showNotice("Removed from the queue");
    return;
  }
  showNotice(result.status === "error" && result.code === "unknown_item" ? "Too late: already delivering it." : writeFailureText(result));
}

// ---------------------------------------------------------------------------
// App and pane menus

function menuItems(): MenuItem[] {
  switch (screen.kind) {
    case "hub":
      return hubMenuItems();
    case "workspace":
      return workspaceMenuItems();
    case "pane":
    case "subagent":
      return paneMenuItems();
    case "machines":
      return machineMenuItems();
    case "setup":
      return setupMenuItems();
    case "compose":
    case "review":
      return draftMenuItems();
  }
}

function globalMenuItems(): MenuItem[] {
  return [
    {
      label: "Machines",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openMachinesScreen();
      },
    },
    submenuItem("Settings", (ctx) => ctx.stack.push(new WindowMenuLayer("Herdr settings", [wakeSettingItem()]))),
  ];
}

function wakeSettingItem(): MenuItem {
  return {
    label: "Wake glasses on blocked",
    description: "While the glasses are asleep, a pane that needs you wakes them and opens the hub with that pane selected.",
    onSelect: () => {
      setWakeOnBlocked(!wakeOnBlockedEnabled());
      render();
    },
    render: ({ image, x, y, width, selected }) =>
      drawToggleMenuItem(image, font(), x, y, width, "Wake glasses on blocked", wakeOnBlockedEnabled(), selected),
  };
}

function reconnectAllItem(): MenuItem | null {
  const retrying = Array.from(clients.values()).filter((client) => client.snapshot.phase === "retrying");
  if (!retrying.length) return null;
  return {
    label: "Reconnect now",
    onSelect: (ctx) => {
      ctx.stack.pop();
      for (const client of retrying) client.retryNow();
    },
  };
}

function hubMenuItems(): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: "Add machine by QR",
      onSelect: (ctx) => {
        ctx.stack.pop();
        beginSetup("hub");
        void scanBridge();
      },
    },
    {
      label: "Add machine by URL",
      onSelect: (ctx) => {
        ctx.stack.pop();
        beginSetup("hub");
        startUrlEdit();
      },
    },
  ];
  const reconnect = reconnectAllItem();
  if (reconnect) items.push(reconnect);
  items.push(...globalMenuItems());
  return items;
}

function workspaceMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  if (screen.kind === "workspace") {
    const group = currentWorkspaceGroup();
    const client = clients.get(screen.machineId);
    if (group && client && client.snapshot.phase !== "connected") {
      items.push({
        label: "Retry this machine",
        onSelect: (ctx) => {
          ctx.stack.pop();
          client.retryNow();
        },
      });
    }
  }
  const reconnect = reconnectAllItem();
  if (reconnect) items.push(reconnect);
  items.push(...globalMenuItems());
  return items;
}

function paneMenuItems(): MenuItem[] {
  const scope = readerScope();
  const ref = scope ? findRef(scope.machineId, scope.paneId) : undefined;
  if (!scope || !ref) return globalMenuItems();
  const view = viewForScope(scope);
  const client = clients.get(scope.machineId);
  const readOnly = screen.kind === "subagent";
  const items: MenuItem[] = [];
  if (readOnly) {
    items.push({
      label: "Back to pane",
      onSelect: (ctx) => {
        ctx.stack.pop();
        showScreen({ kind: "pane", machineId: scope.machineId, paneId: scope.paneId, fromHub: screen.kind === "subagent" ? screen.fromHub : false });
        renderNow();
      },
    });
    items.push(...globalMenuItems());
    return items;
  }
  const action = primaryAction(ref.pane, false);
  if (action === "answer" && view) {
    items.push({
      label: "Answer prompt…",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openAnswerMenu(ref, view);
      },
    });
  }
  if (ref.pane.status !== "blocked") {
    items.push({
      label: action === "command" ? "Run command…" : "Reply…",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openCompose(ref, action === "command" ? "command" : "message");
      },
    });
    items.push({
      label: "Reply by voice",
      onSelect: (ctx) => {
        ctx.stack.pop();
        if (window) post({ type: "start-voice-input", windowId: window.windowId });
      },
    });
    items.push({
      label: "Type without Enter…",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openCompose(ref, "type");
      },
    });
  }
  const guard = view ? answerGuard(ref, view) : null;
  items.push(
    submenuItem("Keys", (ctx) => {
      const keyItems: MenuItem[] = KEY_PALETTE.map((key) => ({
        label: key.label,
        onSelect: (inner) => {
          inner.stack.pop();
          if (ref.pane.status === "blocked" && guard) void submitAnswer(guard, key.keys, key.label);
          else void sendKeysDirect(ref, key.keys, key.label);
        },
      }));
      ctx.stack.push(new WindowMenuLayer("Keys", keyItems));
    }),
  );
  const snippets = client ? snippetActions(client.snapshot.snippets) : [];
  if (snippets.length) {
    items.push(
      submenuItem("Snippets", (ctx) => {
        const snippetItems: MenuItem[] = snippets.map((snippet) => ({
          label: snippet.label,
          onSelect: (inner) => {
            inner.stack.pop();
            void sendSnippet(ref, snippet);
          },
        }));
        ctx.stack.push(new WindowMenuLayer("Snippets", snippetItems));
      }),
    );
  }
  if (canEnterKeysMode(false, ref.pane.status === "blocked")) {
    items.push({
      label: keysMode ? "Leave Keys mode" : "Keys mode",
      description: keysMode ? "" : "Ring and watch send arrow keys; tap sends Enter; double tap leaves.",
      onSelect: (ctx) => {
        ctx.stack.pop();
        if (keysMode) exitKeysMode(true);
        else enterKeysMode(ref);
      },
    });
  }
  const subagents = view ? sortSubagents(view.subagents) : [];
  if (subagents.length) {
    items.push(
      submenuItem(`Subagents (${subagents.length})`, (ctx) => {
        const rows: MenuItem[] = subagents.map((subagent) => ({
          label: truncateText(font(), subRow(subagent), 220),
          onSelect: (inner) => {
            inner.stack.pop();
            openSubagent(ref, subagent);
          },
        }));
        ctx.stack.push(new WindowMenuLayer("Subagents", rows));
      }),
    );
  }
  const state = readerStateFor(viewKeyOf(scope));
  if (state.anchor || state.anchorLost) {
    items.push({
      label: "Jump to live",
      onSelect: (ctx) => {
        ctx.stack.pop();
        state.anchor = null;
        state.anchorBelow = 0;
        state.anchorLost = false;
        state.firstUnread = null;
        maybeMarkRead(ref);
        renderNow();
      },
    });
  }
  if (view?.hasOlder) {
    items.push({
      label: "Load earlier output",
      onSelect: (ctx) => {
        ctx.stack.pop();
        maybeRequestOlder(ref, view, state);
        renderNow();
      },
    });
  }
  if (isDoneUnseen(ref, readMarkers) || state.firstUnread) {
    items.push({
      label: "Mark read",
      onSelect: (ctx) => {
        ctx.stack.pop();
        markPaneRead(ref);
      },
    });
  }
  const queued = view?.queue ?? [];
  items.push(
    submenuItem(queued.length ? `Queued messages (${queued.length})` : "Queued messages", (ctx) => {
      const rows: MenuItem[] = queued.map((item) => ({
        label: truncateText(font(), `Remove: ${oneLine(item.text)}`, 220),
        onSelect: (inner) => {
          inner.stack.pop();
          void removeQueuedItem(ref, item.id);
        },
      }));
      if (!rows.length) rows.push({ label: "No queued messages", disabled: true, onSelect: () => {} });
      ctx.stack.push(new WindowMenuLayer("Queued messages", rows));
    }),
  );
  if (client && client.snapshot.phase !== "connected") {
    items.push({
      label: "Retry this machine",
      onSelect: (ctx) => {
        ctx.stack.pop();
        client.retryNow();
      },
    });
  }
  items.push(...globalMenuItems());
  return items;
}

function machineMenuItems(): MenuItem[] {
  return [
    {
      label: "Add machine by QR",
      onSelect: (ctx) => {
        ctx.stack.pop();
        beginSetup("machines");
        void scanBridge();
      },
    },
    {
      label: "Add machine by URL",
      onSelect: (ctx) => {
        ctx.stack.pop();
        beginSetup("machines");
        startUrlEdit();
      },
    },
    ...globalMenuItems(),
  ];
}

function setupMenuItems(): MenuItem[] {
  return [
    {
      label: "Scan bridge QR",
      onSelect: (ctx) => {
        ctx.stack.pop();
        void scanBridge();
      },
    },
    {
      label: "Enter URL",
      onSelect: (ctx) => {
        ctx.stack.pop();
        startUrlEdit();
      },
    },
    ...globalMenuItems(),
  ];
}

function draftMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  if (compose) {
    items.push({
      label: "Discard draft",
      onSelect: (ctx) => {
        ctx.stack.pop();
        discardDraft();
      },
    });
  }
  items.push(...globalMenuItems());
  return items;
}

// ---------------------------------------------------------------------------
// List items

function hubItems(): ListItem[] {
  const items: ListItem[] = [];
  const multi = multiMachine();
  for (const machine of machineRecords) {
    if (duplicates.has(machine.id)) continue;
    const name = nameOf(machine);
    if (!machine.enabled) {
      items.push({ key: `machine:${machine.id}`, kind: "heading", label: `${name}  (off)` });
      items.push({
        key: `machine-enable:${machine.id}`,
        kind: "action",
        label: "Connect",
        onSelect: () => setMachineEnabled(machine.id, true),
      });
      continue;
    }
    const client = clients.get(machine.id);
    if (!client || client.snapshot.phase === "connected") continue;
    items.push({ key: `machine:${machine.id}`, kind: "heading", label: `${name} · ${machinePhaseText(client)}` });
    const error = client.snapshot.lastError;
    if (error && !machinePhaseText(client).includes(error)) items.push({ key: `machine-error:${machine.id}`, kind: "tag", label: error });
    items.push({
      key: `retry:${machine.id}`,
      kind: "action",
      label: "Retry",
      right: client.snapshot.phase === "forbidden" ? "refused" : "offline",
      onSelect: () => client.retryNow(),
    });
  }
  const hub = currentHub();
  for (const row of hub.rows) {
    if (row.kind === "heading" || row.kind === "tag") {
      items.push({ key: row.key, kind: row.kind, label: row.label });
      continue;
    }
    if (row.kind === "pane") {
      const ref = row.ref;
      const summary = clients.get(ref.machineId)?.snapshot.queueSummaries.get(ref.pane.id);
      items.push({
        key: row.key,
        kind: "pane",
        label: rowLabel(ref, multi),
        right: queueSummaryText(summary) || undefined,
        marker: ref.pane.status === "blocked" ? "!" : isDoneUnseen(ref, readMarkers) ? "•" : undefined,
        markerValue: ref.pane.status === "blocked" ? 255 : 210,
        onSelect: () => openPane(ref.machineId, ref.pane.id, true),
      });
      continue;
    }
    const group = row.group;
    const blocked = group.refs.some((ref) => ref.pane.status === "blocked");
    const unread = group.refs.some((ref) => isDoneUnseen(ref, readMarkers));
    items.push({
      key: row.key,
      kind: "workspace",
      label: workspaceRowLabel(group, multi),
      marker: blocked ? "!" : unread ? "•" : undefined,
      markerValue: blocked ? 255 : 210,
      onSelect: () => {
        if (group.refs.length === 1) {
          const only = group.refs[0]!;
          openPane(only.machineId, only.pane.id, true);
        } else {
          openWorkspaceGroup(group);
        }
      },
    });
  }
  return items;
}

function workspaceItems(): ListItem[] {
  const group = currentWorkspaceGroup();
  const items: ListItem[] = [];
  if (!group) {
    items.push({ key: "empty", kind: "tag", label: "No panes here" });
    return items;
  }
  for (const ref of group.refs) {
    items.push({
      key: `pane:${refKey(ref)}`,
      kind: "pane",
      label: paneRowLabel(ref),
      right: queueSummaryText(clients.get(ref.machineId)?.snapshot.queueSummaries.get(ref.pane.id)) || undefined,
      marker: ref.pane.status === "blocked" ? "!" : isDoneUnseen(ref, readMarkers) ? "•" : undefined,
      markerValue: ref.pane.status === "blocked" ? 255 : 210,
      onSelect: () => openPane(ref.machineId, ref.pane.id),
    });
  }
  return items;
}

function machineItems(): ListItem[] {
  const items: ListItem[] = [];
  for (const machine of machineRecords) {
    const client = clients.get(machine.id);
    const phase = !machine.enabled ? "off" : machinePhaseText(client);
    items.push({
      key: `m:${machine.id}`,
      kind: "action",
      label: nameOf(machine) + (duplicates.has(machine.id) ? "  (duplicate URL)" : ""),
      right: phase,
      submenu: true,
      onSelect: () => openMachineActions(machine),
    });
  }
  items.push({
    key: "add-qr",
    kind: "action",
    label: "Add machine by QR",
    onSelect: () => {
      beginSetup("machines");
      void scanBridge();
    },
  });
  items.push({
    key: "add-url",
    kind: "action",
    label: "Add machine by URL",
    onSelect: () => {
      beginSetup("machines");
      startUrlEdit();
    },
  });
  items.push({ key: "done", kind: "action", label: "Done", onSelect: () => showScreen({ kind: "hub" }) });
  return items;
}

function setupItems(): ListItem[] {
  if (screen.kind !== "setup") return [];
  const items: ListItem[] = [];
  items.push({
    key: "scan",
    kind: "action",
    label: scanning ? "Scanning…" : "Scan bridge QR",
    onSelect: () => {
      if (!scanning) void scanBridge();
    },
  });
  if (screen.editingUrl) {
    items.push({
      key: "use-url",
      kind: "action",
      label: "Use this URL",
      right: getStringSetting(HERDR_URL_DRAFT_KEY, "") ? "" : "empty",
      onSelect: () => submitBridgeUrl(getStringSetting(HERDR_URL_DRAFT_KEY, "")),
    });
    items.push({ key: "cancel-url", kind: "action", label: "Cancel URL entry", onSelect: () => cancelUrlEdit() });
  } else {
    items.push({
      key: "enter-url",
      kind: "action",
      label: "Enter URL",
      onSelect: () => startUrlEdit(),
    });
  }
  if (machineRecords.length) {
    items.push({ key: "machines", kind: "action", label: "Machines", onSelect: () => openMachinesScreen() });
  }
  return items;
}

function composeItems(): ListItem[] {
  if (!compose) return [];
  const items: ListItem[] = [
    {
      key: "review",
      kind: "action",
      label: compose.kind === "type" ? "Review and insert" : "Review and send",
      right: "or tap on the phone",
      onSelect: () => openReview(),
    },
    {
      key: "voice",
      kind: "action",
      label: "Say it…",
      onSelect: () => {
        if (window) post({ type: "start-voice-input", windowId: window.windowId });
      },
    },
    {
      key: "edit",
      kind: "action",
      label: "Edit on phone",
      onSelect: () => startDraftEdit(),
    },
    {
      key: "discard",
      kind: "action",
      label: "Discard draft",
      onSelect: () => discardDraft(),
    },
  ];
  return items;
}

function reviewItems(): ListItem[] {
  if (!compose) return [];
  const ref = composeRef();
  const problem = draftProblem();
  const items: ListItem[] = [];
  const target = ref
    ? `${ref.machine} / ${ref.pane.workspace} (${ref.pane.id})`
    : `${compose.draft.target.machine} / pane gone`;
  items.push({ key: "target", kind: "heading", label: `To: ${target}` });
  const width = Math.max(120, (window?.viewportWidth ?? 280) - LIST_LEFT - LIST_RIGHT - 30);
  for (const line of wrapText(font(), compose.draft.text || "(empty)", width).slice(0, 200)) {
    items.push({ key: `text:${items.length}`, kind: "text", label: line });
  }
  if (problem) items.push({ key: "problem", kind: "tag", label: problemText(problem) });
  if (deliveryUnknown && deliveryUnknown.machineId === compose.machineId && deliveryUnknown.paneId === compose.paneId) {
    items.push({
      key: "check-output",
      kind: "action",
      label: "Check output",
      right: "no auto-retry",
      onSelect: () => {
        deliveryUnknown = null;
        if (!compose) return;
        showScreen({ kind: "pane", machineId: compose.machineId, paneId: compose.paneId, fromHub: compose.fromHub });
        renderNow();
      },
    });
  }
  if (problem === "terminal_changed" || problem === "session_changed") {
    items.push({ key: "retarget", kind: "action", label: "Use this pane", onSelect: () => retargetDraft() });
  }
  if (problem === "offline") {
    items.push({
      key: "reconnect",
      kind: "action",
      label: "Retry this machine",
      onSelect: () => clients.get(compose!.machineId)?.retryNow(),
    });
  }
  if (!problem) {
    if (compose.kind !== "type" && queueRecommended()) {
      items.push({ key: "review:queue", kind: "action", label: "Queue until idle", right: "recommended", onSelect: () => void submitDraft(true) });
    }
    items.push({
      key: "review:send",
      kind: "action",
      label: compose.kind === "type" ? "Insert text" : compose.kind === "command" ? "Run command" : ref ? sendNowLabel(ref.pane) : "Send message",
      onSelect: () => void submitDraft(false),
    });
  }
  items.push({
    key: "edit",
    kind: "action",
    label: "Edit",
    onSelect: () => {
      showScreen({ kind: "compose", machineId: compose!.machineId, paneId: compose!.paneId });
      startDraftEdit();
      renderNow();
    },
  });
  items.push({
    key: "cancel",
    kind: "action",
    label: "Cancel",
    onSelect: () => {
      if (!compose) return;
      const draftTargetScreen = compose;
      showScreen({ kind: "pane", machineId: draftTargetScreen.machineId, paneId: draftTargetScreen.paneId, fromHub: draftTargetScreen.fromHub });
      renderNow();
    },
  });
  return items;
}

function openMachineActions(machine: HerdrMachine): void {
  const client = clients.get(machine.id);
  const items: MenuItem[] = [];
  const status = !machine.enabled ? "off" : machinePhaseText(client);
  items.push({ label: status, disabled: true, onSelect: () => {} });
  if (machine.enabled) {
    items.push({
      label: "Disconnect",
      onSelect: (ctx) => {
        ctx.stack.pop();
        setMachineEnabled(machine.id, false);
      },
    });
  } else {
    items.push({
      label: "Connect",
      onSelect: (ctx) => {
        ctx.stack.pop();
        setMachineEnabled(machine.id, true);
      },
    });
  }
  if (client) {
    items.push({
      label: "Retry now",
      onSelect: (ctx) => {
        ctx.stack.pop();
        client.retryNow();
      },
    });
  }
  items.push({
    label: `Remove ${nameOf(machine)}`,
    onSelect: (ctx) => {
      ctx.stack.pop();
      removeMachine(machine.id);
      syncClients();
      render();
    },
  });
  openWindowMenu(items, nameOf(machine));
}

function list(): Menu<ListItem> {
  listMenu ??= new Menu<ListItem>({
    wrap: false,
    rowGap: 1,
    getHeight: () => listRowHeight(font()),
    isSelectable: (item) => Boolean(item.onSelect),
    onSelect: (item) => item.onSelect?.(),
    draw: drawListRow,
  });
  return listMenu;
}

function activeSelectionKey(): string | null {
  switch (screen.kind) {
    case "hub":
      return hubSelectionKey;
    case "workspace":
      return workspaceSelections.get(workspaceKey(screen.machineId, screen.session, screen.workspace)) ?? null;
    case "machines":
      return machinesSelectionKey;
    case "review":
      return reviewSelectionKey;
    case "compose":
      return composeSelectionKey;
    default:
      return null;
  }
}

function setActiveSelectionKey(key: string | null): void {
  switch (screen.kind) {
    case "hub":
      hubSelectionKey = key;
      return;
    case "workspace":
      workspaceSelections.set(workspaceKey(screen.machineId, screen.session, screen.workspace), key ?? "");
      return;
    case "machines":
      machinesSelectionKey = key;
      return;
    case "review":
      reviewSelectionKey = key;
      return;
    case "compose":
      composeSelectionKey = key;
      return;
    default:
  }
}

function selectionIndex(items: readonly ListItem[]): number | undefined {
  const key = activeSelectionKey();
  if (!key) return undefined;
  const index = items.findIndex((item) => item.key === key);
  return index >= 0 ? index : undefined;
}

// ---------------------------------------------------------------------------
// Painting

function drawListRow({ image, item, x, y, width, height, selected }: MenuDrawArgs<ListItem>): void {
  const f = font();
  const textY = y + Math.max(0, Math.floor((height - f.lineHeight) / 2));
  if (item.kind === "heading") {
    image.drawText(f, x + 4, textY, truncateText(f, item.label, width - 8), selected ? 255 : 150);
    return;
  }
  if (item.kind === "tag") {
    image.drawText(f, x + 4, textY, truncateText(f, item.label, width - 8), selected ? 220 : 120);
    return;
  }
  if (item.kind === "text") {
    image.drawText(f, x + 4, textY, truncateText(f, item.label, width - 8), selected ? 255 : 195);
    return;
  }
  const value = selected ? 255 : 200;
  const markerWidth = item.marker ? 16 : 0;
  if (item.marker) image.drawText(f, x + 4, textY, item.marker, selected ? 255 : item.markerValue ?? value);
  const right = item.right ? truncateText(f, item.right, Math.floor(width * 0.4)) : "";
  const rightWidth = right ? f.measureText(right) + 10 : 0;
  const submenuWidth = item.submenu ? 16 : 0;
  const labelX = x + 4 + markerWidth;
  image.drawText(f, labelX, textY, truncateText(f, item.label, Math.max(10, width - (labelX - x) - rightWidth - submenuWidth - 6)), value);
  if (right) image.drawText(f, x + width - 4 - submenuWidth - f.measureText(right), textY, right, selected ? 200 : 120);
  if (item.submenu) drawSubmenuIndicator(image, f, x, y, width, height, value);
}

function paint(win: AppWindow): Plane[] {
  return windowMenu(win).paint();
}

function paintContent(win: AppWindow): GrayImage {
  switch (screen.kind) {
    case "setup":
      return paintSetup(win);
    case "hub":
      return paintHub(win);
    case "workspace":
      return paintWorkspace(win);
    case "machines":
      return paintMachines(win);
    case "pane":
    case "subagent":
      return paintReader(win);
    case "compose":
      return paintCompose(win);
    case "review":
      return paintReview(win);
  }
}

function paintListScreen(
  win: AppWindow,
  title: string,
  right: string,
  items: ListItem[],
  options: { help?: string[]; footer?: string[] } = {},
): GrayImage {
  const image = new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const f = font();
  const step = lineStep(f);
  const width = win.viewportWidth - TITLE_X * 2;
  image.drawText(f, TITLE_X, TITLE_Y, truncateText(f, title, width), 225);
  if (right) {
    const rightWidth = f.measureText(right);
    image.drawText(f, win.viewportWidth - TITLE_X - rightWidth, TITLE_Y, truncateText(f, right, Math.floor(width * 0.55)), 150);
  }
  let top = TITLE_Y + step + 8;
  for (const line of options.help ?? []) {
    image.drawText(f, TITLE_X, top, truncateText(f, line, width), 160);
    top += step;
  }
  if (options.help?.length) top += 4;
  const footer = options.footer ?? [];
  const footerHeight = footer.length ? footer.length * step + 6 : 0;
  const listTop = top;
  const listHeight = win.viewportHeight - 6 - listTop - footerHeight;
  const menu = list();
  menu.setItems(items, selectionIndex(items));
  setActiveSelectionKey(menu.selectedItem?.key ?? activeSelectionKey());
  menu.paint(image, { x: LIST_LEFT, y: listTop - 2, width: win.viewportWidth - LIST_LEFT - LIST_RIGHT, height: listHeight }, win.focused);
  menu.drawScrollbar(image, win.viewportWidth - 10, listTop, listHeight - 4);
  footer.forEach((line, index) => {
    image.drawText(f, TITLE_X, win.viewportHeight - footerHeight + index * step, truncateText(f, line, width), line.startsWith("Can't") || line.includes("not") ? 220 : 170);
  });
  return image;
}

function paintSetup(win: AppWindow): GrayImage {
  if (screen.kind !== "setup") return new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const help = wrapText(
    font(),
    "Start the bridge on a computer that runs Herdr, then scan its pairing QR code or type its https URL here. The phone must be on the same tailnet.",
    win.viewportWidth - TITLE_X * 2,
  );
  const footer: string[] = [];
  if (screen.busy) footer.push(screen.busy);
  if (screen.error) footer.push(screen.error);
  else if (screen.editingUrl) footer.push(`URL: ${getStringSetting(HERDR_URL_DRAFT_KEY, "") || "(type on the phone)"}`);
  return paintListScreen(win, "Herdr setup", activeNotice(), setupItems(), { help, footer });
}

function paintHub(win: AppWindow): GrayImage {
  const hub = currentHub();
  const needs = needingCount(hub);
  const right = activeNotice() || (needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "");
  return paintListScreen(win, APP_TITLE, right, hubItems());
}

function paintWorkspace(win: AppWindow): GrayImage {
  if (screen.kind !== "workspace") return new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const machine = findMachine(screen.machineId);
  const name = machine ? machineDisplayName(machine) : screen.machineId;
  const client = clients.get(screen.machineId);
  const status = client && client.snapshot.phase !== "connected" ? machinePhaseText(client) : "";
  return paintListScreen(win, `${name}/${screen.workspace}`, activeNotice() || status, workspaceItems());
}

function paintMachines(win: AppWindow): GrayImage {
  return paintListScreen(win, "Herdr machines", activeNotice(), machineItems());
}

function paintReader(win: AppWindow): GrayImage {
  const image = new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const f = font();
  const { step, bodyTop, width } = bodyMetrics(win);
  const scope = readerScope();
  const ref = scope ? findRef(scope.machineId, scope.paneId) : undefined;
  const client = scope ? clients.get(scope.machineId) : undefined;
  const live = scope ? viewForScope(scope) : undefined;
  const state = scope ? readerStateFor(viewKeyOf(scope)) : null;
  const reading = screen.kind === "subagent" ? screen.subagent : undefined;
  if (live && state && live.source !== null) {
    state.cache = live;
    state.cacheKey = ref ? fullPaneKey(ref) : state.cacheKey;
  }
  const cached = state && ref && state.cache && state.cacheKey === fullPaneKey(ref) ? state.cache : undefined;
  const view = live && live.source !== null ? live : cached ?? live;

  const header = reading ? subHeader(reading, ref, multiMachine()) : ref ? `${chatHeader(ref, multiMachine())} · ${ref.pane.tab || ref.pane.paneId}` : `${scope?.machineId ?? ""} · pane gone`;
  image.drawText(f, BODY_LEFT, 6, truncateText(f, header, width), 225);

  const activity = view ? latestActivity(view.entries) : "";
  if (activity) image.drawText(f, BODY_LEFT, 6 + step, truncateText(f, activity, width), 140);

  const offline = client !== undefined && client.snapshot.phase !== "connected";
  let third = "";
  let thirdValue = 150;
  if (keysMode && ref) {
    third = keysModeBanner(ref.machine, paneLabel(ref));
    thirdValue = 255;
  } else if (offline && client) {
    const age = ref && state ? contentAge(view, state) : "";
    third = `Offline · ${machinePhaseText(client)}${age ? ` · content ${age}` : ""}`;
    thirdValue = 205;
  }
  if (third) image.drawText(f, BODY_LEFT, 6 + step * 2, truncateText(f, third, width), thirdValue);
  image.drawLine(BODY_LEFT - 2, bodyTop - 5, win.viewportWidth - BODY_RIGHT + 2, bodyTop - 5, 40);

  if (!ref) {
    image.drawText(f, BODY_LEFT, bodyTop, truncateText(f, "This pane is gone. Double tap to go back.", width), 150);
    return image;
  }
  if (!view) {
    const message = client ? (client.snapshot.phase === "connected" ? "Loading pane…" : machinePhaseText(client)) : "This machine is off.";
    image.drawText(f, BODY_LEFT, bodyTop, truncateText(f, message, width), 150);
    return image;
  }
  if (!state) return image;
  if (live && live.source !== null) reconcileReader(state, live);
  const metrics = readerMetrics(win, ref, view, state);
  if (state.needsFreeze && state.anchor) {
    const line = lineForAnchor(metrics.lines, state.anchor);
    if (line === null) {
      state.anchorLost = true;
      state.needsFreeze = false;
    } else {
      state.anchorBelow = Math.max(0, metrics.lines.length - line);
      state.needsFreeze = false;
    }
  }
  if (state.anchor && metrics.maxFirst === 0) {
    state.anchor = null;
    state.anchorBelow = 0;
  } else if (state.anchor && lineForAnchor(metrics.lines, state.anchor) === null) {
    state.anchorLost = true;
  }
  const first = state.anchor && !state.anchorLost ? metrics.first : state.anchorLost ? 0 : metrics.maxFirst;
  for (let row = 0; row < metrics.visible; row++) {
    const line = metrics.lines[first + row];
    if (!line?.text) continue;
    image.drawText(f, BODY_LEFT + line.indent, bodyTop + row * step, truncateText(f, line.text, Math.max(10, width - line.indent)), line.value);
  }
  if (metrics.maxFirst > 0) {
    const track = metrics.visible * step;
    const thumb = Math.max(8, Math.floor((track * metrics.visible) / Math.max(1, metrics.lines.length)));
    image.fillRect(win.viewportWidth - 8, bodyTop + Math.floor(((track - thumb) * first) / Math.max(1, metrics.maxFirst)), 2, thumb, 110);
  }

  // Footer: what a tap does, the new-output marker, or why reading is limited.
  const footerY = win.viewportHeight - step - 6;
  const action = primaryAction(ref.pane, reading !== undefined);
  const actionLabel = keysMode
    ? KEYS_MODE_HINT
    : reading
      ? "read-only"
      : action === "answer"
        ? "answer"
        : action === "command"
          ? "command"
          : action === "compose"
            ? "reply"
            : "read";
  const left = keysMode ? "KEYS" : `${GESTURE_CLICK} ${actionLabel}`;
  image.drawText(f, BODY_LEFT, footerY, truncateText(f, left, Math.floor(width * 0.3)), 110);
  const newLines = state.anchor && !state.anchorLost ? newOutputCount(metrics.lines, state.anchor, state.anchorBelow) : 0;
  let right = "";
  let rightValue = 150;
  if (state.anchorLost) {
    right = "Older output unavailable · Jump to live in menu";
    rightValue = 220;
  } else if (state.loadingOlder) {
    right = "Loading earlier output…";
    rightValue = 150;
  } else if (newLines > 0) {
    right = `↓ ${newLines} new · menu: Jump to live`;
    rightValue = 210;
  }
  if (right) {
    const text = truncateText(f, right, Math.floor(width * 0.68));
    image.drawText(f, win.viewportWidth - BODY_RIGHT - f.measureText(text), footerY, text, rightValue);
  }

  if (!keysMode && reading === undefined && !state.anchor) maybeMarkRead(ref);
  return image;
}

function contentAge(view: ViewState | undefined, state: ReaderState): string {
  const last = view?.entries[view.entries.length - 1];
  return formatAge(last?.ts ?? state.lastDataAt, Date.now());
}

function paintCompose(win: AppWindow): GrayImage {
  const image = new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const f = font();
  const step = lineStep(f);
  const width = win.viewportWidth - TITLE_X * 2;
  const titles: Record<ComposeKind, string> = { message: "Compose message", command: "Run command", type: "Type without Enter" };
  if (!compose) {
    image.drawText(f, TITLE_X, TITLE_Y, "Compose", 220);
    return image;
  }
  image.drawText(f, TITLE_X, TITLE_Y, titles[compose.kind], 225);
  const noticeText = activeNotice();
  if (noticeText) image.drawText(f, TITLE_X + f.measureText(titles[compose.kind]) + 14, TITLE_Y, truncateText(f, noticeText, Math.floor(width * 0.5)), 150);

  const ref = composeRef();
  const target = ref
    ? `${ref.machine} / ${ref.pane.workspace} (${ref.pane.paneId}) · ${statusLabel(ref.pane.status)}`
    : `${compose.draft.target.machine} / pane gone`;
  image.drawText(f, TITLE_X, TITLE_Y + step + 6, truncateText(f, target, width), 160);

  const actions = composeItems();
  const actionHeight = Math.min(actions.length, 4) * listRowHeight(f) + 8;
  const textTop = TITLE_Y + 2 * step + 14;
  const textBottom = win.viewportHeight - actionHeight - 6;
  const problem = draftProblem();
  const available = Math.max(1, Math.floor((textBottom - textTop) / step));
  const textLines = wrapText(f, compose.draft.text || "(type on the phone or say it)", width - 6);
  const shown = textLines.slice(0, available);
  shown.forEach((line, index) => image.drawText(f, TITLE_X, textTop + index * step, truncateText(f, line, width), compose.draft.text ? 220 : 120));
  if (textLines.length > shown.length) {
    image.drawText(f, TITLE_X, textTop + shown.length * step, `… ${textLines.length - shown.length} more lines`, 120);
  }
  if (problem) {
    const problemLine = problemText(problem);
    image.drawText(f, TITLE_X, textBottom - step, truncateText(f, problemLine, width), 220);
  }

  const menu = list();
  menu.setItems(composeItems(), selectionIndex(composeItems()));
  menu.paint(image, { x: LIST_LEFT, y: win.viewportHeight - actionHeight - 2, width: win.viewportWidth - LIST_LEFT - LIST_RIGHT, height: actionHeight }, win.focused);
  return image;
}

function paintReview(win: AppWindow): GrayImage {
  const items = reviewItems();
  const right = activeNotice();
  return paintListScreen(win, "Review", right, items);
}

// ---------------------------------------------------------------------------
// Rendering

function scheduleRender(): void {
  const win = window;
  if (!win || win.renderTimer) return;
  win.renderTimer = setTimeout(() => {
    win.renderTimer = null;
    render();
  }, DATA_RENDER_COALESCE_MS);
}

function render(): void {
  if (window?.foreground && screenOn) renderNow();
}

function renderNow(inputFrameId = 0): void {
  const win = window;
  if (!win || !win.foreground || !screenOn) {
    if (inputFrameId) frameTimings.finishFrame(inputFrameId, "discarded: herdr window not visible");
    return;
  }
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${win.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () => frameTimings.runWithFrame(frameId, () => paint(win)));
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === win.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: herdr content unchanged");
      return;
    }
    const communicator = getActiveDisplay();
    if (!communicator) {
      frameTimings.finishFrame(frameId, "discarded: no active display");
      return;
    }
    const { image, draws } = frameTimings.span(frameId, "flatten", () => flattenPlanesWithDraws(planes));
    const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
    communicator.submitSurfaceFrame(
      buffer.buffer,
      win.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
      frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws)),
    );
    win.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: herdr render failed");
    console.error(`herdr worker render failed: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Tools

function toolMachines(): Array<{ machine: HerdrMachine; client: HerdrMachineClient }> {
  const result: Array<{ machine: HerdrMachine; client: HerdrMachineClient }> = [];
  for (const machine of machineRecords) {
    if (!machine.enabled || duplicates.has(machine.id)) continue;
    const client = clients.get(machine.id);
    if (client) result.push({ machine, client });
  }
  return result;
}

function paneLine(machine: HerdrMachine, ref: PaneRef): string {
  const queue = clients.get(machine.id)?.snapshot.queueSummaries.get(ref.pane.id);
  const extras = [ref.pane.terminalId ? `terminal ${ref.pane.terminalId}` : "", ref.pane.subagents ? `${ref.pane.subagents} sub` : "", queueSummaryText(queue)]
    .filter(Boolean)
    .join(", ");
  return `- ${nameOf(machine)} / ${ref.pane.workspace} / ${ref.pane.agent ?? (ref.pane.title || "shell")} (${ref.pane.status}${extras ? `; ${extras}` : ""}) id ${ref.pane.id}`;
}

function resolvePane(args: any): PaneMatch | { error: string } {
  const machineQuery = typeof args?.machine === "string" ? args.machine.trim().toLowerCase() : "";
  const paneQuery = typeof args?.pane === "string" ? args.pane.trim() : "";
  const workspaceQuery = typeof args?.workspace === "string" ? args.workspace.trim().toLowerCase() : "";
  const machines = toolMachines();
  const chosen = machineQuery
    ? machines.filter(
        (entry) =>
          entry.machine.id.toLowerCase() === machineQuery ||
          nameOf(entry.machine).toLowerCase() === machineQuery ||
          nameOf(entry.machine).toLowerCase().includes(machineQuery) ||
          entry.machine.id.toLowerCase().includes(machineQuery),
      )
    : machines;
  if (!chosen.length) {
    return {
      error: machineQuery
        ? `No connected machine matches "${args.machine}". Machines: ${machines.map((entry) => nameOf(entry.machine)).join(", ") || "none"}.`
        : "No Herdr machine is connected right now.",
    };
  }
  const matches: PaneMatch[] = [];
  for (const entry of chosen) {
    if (entry.client.snapshot.phase !== "connected") continue;
    for (const ref of refsFor(entry.machine.id)) {
      const pane = ref.pane;
      const needle = paneQuery.toLowerCase();
      const matchesPane =
        !paneQuery ||
        pane.id === paneQuery ||
        pane.paneId === paneQuery ||
        pane.id.toLowerCase().includes(needle) ||
        pane.paneId.toLowerCase().includes(needle) ||
        pane.workspace.toLowerCase().includes(needle) ||
        pane.title.toLowerCase().includes(needle);
      const matchesWorkspace = !workspaceQuery || pane.workspace.toLowerCase().includes(workspaceQuery);
      if (matchesPane && matchesWorkspace) matches.push({ client: entry.client, ref });
    }
  }
  if (!matches.length) {
    const available = chosen.flatMap((entry) => refsFor(entry.machine.id).map((ref) => (ref.pane.terminalId ? `${nameOf(entry.machine)} ${ref.pane.id} (${ref.pane.workspace})` : `${nameOf(entry.machine)} ${ref.pane.id}`)));
    return {
      error: `No pane matches "${paneQuery || workspaceQuery}". Panes: ${available.slice(0, 12).join("; ") || "none connected"}.`,
    };
  }
  if (paneQuery) {
    const exact = matches.filter((match) => match.ref.pane.id === paneQuery || match.ref.pane.paneId === paneQuery);
    if (exact.length === 1) return exact[0]!;
  }
  if (matches.length === 1) return matches[0]!;
  return {
    error: `"${paneQuery}" matches ${matches.length} panes: ${matches
      .slice(0, 6)
      .map((match) => `${match.ref.machine}/${match.ref.pane.workspace}/${match.ref.pane.id}`)
      .join("; ")}. Add machine or the exact pane id.`,
  };
}

async function handleHerdrTool(name: string, args: any): Promise<ToolResult> {
  switch (name) {
    case "list_panes": {
      const lines: string[] = [];
      for (const machine of machineRecords) {
        if (!machine.enabled || duplicates.has(machine.id)) continue;
        const client = clients.get(machine.id);
        if (!client) continue;
        if (client.snapshot.phase !== "connected") {
          lines.push(`- ${nameOf(machine)}: ${machinePhaseText(client)}`);
          continue;
        }
        for (const ref of refsFor(machine.id)) lines.push(paneLine(machine, ref));
      }
      return { ok: true, content: lines.length ? lines.join("\n") : "No Herdr machines are configured." };
    }
    case "read_pane": {
      const match = resolvePane(args);
      if ("error" in match) return { ok: false, error: match.error };
      const subagent = typeof args?.subagent === "string" && args.subagent.trim() ? args.subagent.trim() : undefined;
      try {
        return { ok: true, content: await readPaneText(match, subagent) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    }
    case "send_text": {
      const text = String(args?.text ?? "");
      if (!text.trim()) return { ok: false, error: "send_text needs text." };
      const match = resolvePane(args);
      if ("error" in match) return { ok: false, error: match.error };
      const pane = match.ref.pane;
      if (pane.status === "blocked") return { ok: false, error: "This agent is blocked; answer its prompt with send_keys instead." };
      const kind: ComposeKind = pane.agent ? "message" : "command";
      const queued = args?.queue === true && kind === "message" && canQueue(pane, false);
      const result = await match.client.sendText(pane, kind, text, { queue: queued, terminalId: pane.terminalId });
      if (result.status === "ok") {
        return {
          ok: true,
          content: `${queued ? "Queued for" : "Sent to"} ${match.ref.machine} / ${pane.workspace} / ${pane.id}.`,
        };
      }
      return { ok: false, error: writeFailureText(result) };
    }
    case "send_keys": {
      const raw = Array.isArray(args?.keys) ? args.keys : [];
      const keys = raw.map((key: unknown) => String(key));
      if (!keys.length) return { ok: false, error: "send_keys needs keys, e.g. [\"enter\"]." };
      const invalid = keys.find((key: string) => !isAllowedKey(key));
      if (invalid) return { ok: false, error: `Key not allowed: ${invalid}.` };
      const match = resolvePane(args);
      if ("error" in match) return { ok: false, error: match.error };
      const pane = match.ref.pane;
      const view = viewForScope({ machineId: match.ref.machineId, paneId: pane.id });
      const revision = pane.status === "blocked" && pane.terminalId && view?.prompt ? promptRevision(pane.terminalId, pane.stateSeq, view.prompt) : undefined;
      const result = revision ? await match.client.answer(pane, keys, revision) : await match.client.sendKeys(pane.id, keys, pane.terminalId);
      if (result.status === "ok") return { ok: true, content: `Sent ${keys.join(" ")} to ${match.ref.machine} / ${pane.workspace} / ${pane.id}.` };
      return { ok: false, error: writeFailureText(result) };
    }
    case "queue_list": {
      const lines: string[] = [];
      const machineFilter = typeof args?.machine === "string" ? args.machine.trim().toLowerCase() : "";
      for (const entry of toolMachines()) {
        if (machineFilter && !nameOf(entry.machine).toLowerCase().includes(machineFilter) && !entry.machine.id.toLowerCase().includes(machineFilter)) continue;
        for (const [paneId, summary] of entry.client.snapshot.queueSummaries) {
          if (!summary.pending && !summary.undelivered) continue;
          lines.push(`- ${nameOf(entry.machine)} ${paneId}: ${summary.pending} queued, ${summary.undelivered} undelivered`);
        }
        const scope = readerScope();
        const view = scope && scope.machineId === entry.machine.id ? viewForScope(scope) : undefined;
        if (view && scope) {
          for (const item of view.queue) lines.push(`  ${nameOf(entry.machine)} ${scope.paneId} item ${item.id} (${formatAge(item.ts, Date.now())}): ${oneLine(item.text)}`);
          for (const outcome of view.outcomes) {
            if (outcome.outcome === "undelivered" || outcome.outcome === "canceled") {
              lines.push(`  ${nameOf(entry.machine)} ${scope.paneId} ${outcome.outcome}${outcome.reason ? ` (${outcome.reason})` : ""}: ${oneLine(outcome.text)}`);
            }
          }
        }
      }
      return { ok: true, content: lines.length ? lines.join("\n") : "No queued messages." };
    }
    case "queue_remove": {
      const match = resolvePane(args);
      if ("error" in match) return { ok: false, error: match.error };
      const view = viewForScope({ machineId: match.ref.machineId, paneId: match.ref.pane.id });
      let itemId = typeof args?.item === "string" ? args.item.trim() : "";
      if (!itemId) {
        if (view && view.queue.length === 1) itemId = view.queue[0]!.id;
        else {
          const available = view?.queue.map((item) => `${item.id} "${oneLine(item.text)}"`).join("; ") ?? "";
          return { ok: false, error: `queue_remove needs the item id.${available ? ` Queued: ${available}.` : " Open the pane on the glasses to see its queue."}` };
        }
      }
      const result = await match.client.unqueue(match.ref.pane.id, itemId);
      if (result.status === "ok") return { ok: true, content: `Removed ${itemId} from ${match.ref.machine} / ${match.ref.pane.id}.` };
      if (result.status === "error" && result.code === "unknown_item") return { ok: false, error: "Too late: the bridge is already delivering that item." };
      return { ok: false, error: writeFailureText(result) };
    }
    default:
      return { ok: false, error: `Unknown Herdr tool: ${name}` };
  }
}

function entriesText(entries: readonly ChatEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries.slice(-40)) {
    const text = entry.text.trim();
    if (!text) continue;
    lines.push(`${entry.kind}: ${text.length > 1200 ? `${text.slice(0, 1200)}…` : text}`);
  }
  return lines.join("\n");
}

/** Read a pane from the live view, or a short-lived socket that does not change the visible pane. */
async function readPaneText(match: PaneMatch, subagent: string | undefined): Promise<string> {
  const scope = readerScope();
  const live =
    scope && scope.machineId === match.ref.machineId && scope.paneId === match.ref.pane.id && (scope.subagentId ?? undefined) === (subagent ?? undefined)
      ? viewForScope(scope)
      : undefined;
  let view: ViewState | undefined = live;
  let temporary: HerdrMachineClient | null = null;
  if (!view || view.source === null) {
    const machine = findMachine(match.ref.machineId);
    if (!machine) throw new Error("That machine is no longer configured.");
    temporary = new HerdrMachineClient({
      machine: { id: machine.id, label: machine.label, url: machine.url },
      createSocket: socketFactory,
      log: () => {},
    });
    temporary.start();
    temporary.openView(match.ref.pane.id, subagent);
    const deadline = Date.now() + 9_000;
    try {
      while (Date.now() < deadline) {
        const snapshot: ClientSnapshot = temporary.snapshot;
        if (snapshot.phase === "forbidden" || snapshot.phase === "unreachable") throw new Error(machinePhaseText(temporary));
        const candidate = snapshot.view;
        if (candidate && candidate.source !== null) {
          view = candidate;
          break;
        }
        await wait(100);
      }
    } finally {
      temporary.stop();
    }
  }
  if (!view || view.source === null) throw new Error(view?.error || "Timed out reading the pane.");
  if (view.error) throw new Error(view.error);
  const header = `"${match.ref.machine} / ${match.ref.pane.workspace}" ${match.ref.pane.id} — ${match.ref.pane.agent ?? (match.ref.pane.title || "shell")}, ${match.ref.pane.status}${subagent ? `, subagent ${subagent}` : ""}.`;
  const lines = [header];
  if (view.prompt) lines.push(`PROMPT: ${view.prompt}`);
  const body = entriesText(cleanEntries(trimEntries(view.entries, 800)));
  if (body) lines.push(body);
  else lines.push("(no recent output)");
  if (view.queue.length) lines.push(`Queued: ${view.queue.map((item) => oneLine(item.text)).join(" | ")}`);
  return lines.join("\n");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Startup (last, so every module-level binding above is initialized)

// Spawned without a window (by the app's boot hook) for the widget or wake watch.
if (hasHerdrBackgroundWork()) syncClients();
